import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { accepts } from './http.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
// The browser asks each time if the file changed. So a new version of the app shows at once.
const REVALIDATE = 'no-cache';

export interface StaticFiles {
  /** Answers a GET or HEAD request for a file of the client. */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void>;
  /** The Content-Security-Policy value for each response. */
  csp(): string;
}

async function fileStat(file: string): Promise<Stats | null> {
  try {
    const stats = await stat(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

export function createStatic(webDir: string): StaticFiles {
  const root = path.resolve(webDir);
  const indexFile = path.join(root, 'index.html');

  // index.html has a small inline script that sets the theme before the first paint. The policy
  // permits scripts of the app's own origin only, so that one script gets in by its hash.
  let policy = '';
  let policyMtime = -1;
  function refreshPolicy(mtimeMs: number): void {
    if (mtimeMs === policyMtime) return;
    policyMtime = mtimeMs;
    let hashes = '';
    try {
      const html = readFileSync(indexFile, 'utf8');
      for (const match of html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
        hashes += ` 'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`;
      }
    } catch {
      // No built client. The API works without it.
    }
    policy = [
      "default-src 'self'",
      `script-src 'self'${hashes}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  try {
    refreshPolicy(statSync(indexFile).mtimeMs);
  } catch {
    refreshPolicy(0);
  }

  /** The file for a URL path. null if the path does not name a file in the folder. */
  function resolve(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    // normalize() removes each '..' of a path that starts at the root, so the result stays in the folder.
    const file = path.join(root, path.normalize('/' + decoded));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    // Files with a dot at the start are not part of the client.
    if (path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'))) return null;
    return file;
  }

  async function serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed');
      return;
    }
    let file = resolve(pathname);
    let stats = file ? await fileStat(file) : null;
    if (!stats) {
      // A file name with a hash never changes, so a missing one is an error. An HTML answer for it
      // would stay in a cache as a script for one year.
      if (pathname.startsWith('/assets/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Not found');
        return;
      }
      // Each other path is a page of the app.
      file = indexFile;
      stats = await fileStat(file);
    }
    if (!file || !stats) {
      res
        .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        .end('The client is not built. Run "pnpm build".');
      return;
    }

    if (file === indexFile) {
      // A new build can have a different inline script. The page must get the policy of its own build.
      refreshPolicy(stats.mtimeMs);
      res.setHeader('Content-Security-Policy', policy);
    }
    const relative = path.relative(root, file).split(path.sep).join('/');
    const etag = `W/"${stats.size.toString(36)}-${Math.round(stats.mtimeMs).toString(36)}"`;
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', relative.startsWith('assets/') ? IMMUTABLE : REVALIDATE);
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }

    // The build makes a .br and a .gz copy of each text file.
    let size = stats.size;
    let encoding: string | null = null;
    for (const [name, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
      if (!accepts(req, name)) continue;
      const packed = await fileStat(file + suffix);
      if (!packed) continue;
      file += suffix;
      size = packed.size;
      encoding = name;
      break;
    }
    // The file is read in one piece. So the length in the header is the length of the body, also
    // when a new build replaces the file at this moment. The files of the client are small.
    const body = req.method === 'HEAD' ? null : await readFile(file);
    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body ? body.length : size);
    res.statusCode = 200;
    res.end(body ?? undefined);
  }

  return { serve, csp: () => policy };
}
