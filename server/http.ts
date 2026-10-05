import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzip, gzipSync } from 'node:zlib';
import type { ApiError } from '../shared/types.ts';

export type ErrorCode = ApiError['error']['code'];

export class HttpError extends Error {
  status: number;
  code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalid = (message: string): HttpError => new HttpError(400, 'invalid', message);

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The JSON body of a POST. An empty object if the request has no body. */
  body: Record<string, unknown>;
}

/** Returns the JSON body of the answer. Returns undefined if it wrote the answer itself. */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

const BODY_LIMIT = 5 * 1024 * 1024;
const GZIP_MIN = 1024;
// A small body takes less time to compress here than to send to a worker thread and back.
const GZIP_ASYNC_MIN = 32 * 1024;

/** True if the Accept-Encoding header of the request permits the encoding. */
export function accepts(req: IncomingMessage, encoding: string): boolean {
  const header = req.headers['accept-encoding'];
  if (typeof header !== 'string') return false;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== encoding) continue;
    return !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p));
  }
  return false;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The rest of a body that is too large is read and dropped. If the server closed the
    // connection in the middle of the body, the client would not get the answer.
    const tooLarge = (): void => {
      req.removeAllListeners('data');
      req.resume();
      reject(new HttpError(413, 'invalid', 'The request body is too large'));
    };
    if (Number(req.headers['content-length']) > BODY_LIMIT) {
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) tooLarge();
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    // The client went away in the middle of the body, which a phone with a bad network does often.
    // That is not an error of the server, so it must not go to the log as one.
    req.on('error', () => reject(invalid('The request body is not complete')));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (!hasBody) return {};
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw invalid('Content-Type must be application/json');
  const raw = await readBody(req);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid('The body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('The body must be a JSON object');
  return value as Record<string, unknown>;
}

export async function sendJson(input: {
  req: IncomingMessage;
  res: ServerResponse;
  status?: number;
  body: unknown;
}): Promise<void> {
  const { req, res } = input;
  let payload: Buffer = Buffer.from(JSON.stringify(input.body));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (payload.length > GZIP_MIN && accepts(req, 'gzip')) {
    payload =
      payload.length < GZIP_ASYNC_MIN
        ? gzipSync(payload, { level: 5 })
        : await new Promise<Buffer>((resolve, reject) =>
            gzip(payload, { level: 5 }, (error, out) => (error ? reject(error) : resolve(out))),
          );
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
  }
  res.setHeader('Content-Length', payload.length);
  res.statusCode = input.status ?? 200;
  res.end(payload);
}

export interface Router {
  add(method: 'GET' | 'POST', path: string, handler: Handler): void;
  /** Answers the request if a route matches. Returns false if no route has this path. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export function createRouter(options: {
  /** Public address of the server. An Origin header with this value is accepted too. */
  publicOrigin: string | null;
  onError: (error: unknown, req: IncomingMessage) => void;
}): Router {
  const routes = new Map<string, Handler>();

  // A page of a different site must not be able to make a request with the cookie of the person.
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      // 'null' and other values that are not an address do not match.
    }
    if (host !== null && host === req.headers.host?.toLowerCase()) return;
    if (options.publicOrigin !== null && origin === options.publicOrigin) return;
    throw new HttpError(403, 'forbidden', 'The request comes from a different origin');
  }

  async function fail(req: IncomingMessage, res: ServerResponse, error: unknown): Promise<void> {
    const known = error instanceof HttpError ? error : null;
    if (!known) options.onError(error, req);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    await sendJson({
      req,
      res,
      status: known ? known.status : 500,
      body: { error: { code: known ? known.code : 'server', message: known ? known.message : 'Internal error' } },
    });
  }

  return {
    add(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },

    async handle(req, res, url) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const handler = routes.get(`${method} ${url.pathname}`);
      try {
        if (!handler) {
          if (!url.pathname.startsWith('/api/')) return false;
          throw new HttpError(404, 'not_found', 'No such route');
        }
        let body: Record<string, unknown> = {};
        if (method === 'POST') {
          checkOrigin(req);
          body = await readJson(req);
        }
        const result = await handler({ req, res, url, body });
        if (result !== undefined) await sendJson({ req, res, body: result });
      } catch (error) {
        await fail(req, res, error);
      }
      return true;
    },
  };
}

/** Reads a text field of a JSON body. Throws 'invalid' with the name of the field. */
export function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw invalid(`"${key}" must be text`);
  return value;
}
