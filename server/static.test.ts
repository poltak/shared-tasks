import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { rawRequest, startTestServer } from './testkit.ts';
import type { RawReply, TestServer } from './testkit.ts';

const INLINE = "try { document.documentElement.dataset.theme = 'dark'; } catch (e) {}";
const INDEX = `<!doctype html><html><head><script>${INLINE}</script></head>
<body><div id="app"></div><script type="module" crossorigin src="/assets/index-a1b2c3.js"></script></body></html>`;
const APP_JS = `console.log(${JSON.stringify('app '.repeat(200))});`;
const SECRET = 'the database is not a file of the client';

let server: TestServer;
const get = (route: string, headers?: Record<string, string>, method = 'GET'): Promise<RawReply> =>
  rawRequest({ url: server.url, path: route, headers, method });

beforeAll(async () => {
  server = await startTestServer({ name: 'static' });
  const web = path.join(server.dir, 'web');
  mkdirSync(path.join(web, 'assets'));
  mkdirSync(path.join(web, 'icons'));
  writeFileSync(path.join(web, 'index.html'), INDEX);
  writeFileSync(path.join(web, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(path.join(web, 'manifest.webmanifest'), '{"name":"Shared Tasks"}');
  writeFileSync(path.join(web, 'icons', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(web, 'assets', 'index-a1b2c3.js'), APP_JS);
  writeFileSync(path.join(web, 'assets', 'index-a1b2c3.js.br'), brotliCompressSync(APP_JS));
  writeFileSync(path.join(web, 'assets', 'index-a1b2c3.js.gz'), gzipSync(APP_JS));
  writeFileSync(path.join(web, 'assets', 'style-d4e5f6.css'), 'body { margin: 0 }');
  writeFileSync(path.join(web, '.env'), SECRET);
  // Files next to the folder of the client, where a path with '..' would go.
  writeFileSync(path.join(server.dir, 'secret.txt'), SECRET);
  writeFileSync(path.join(server.dir, 'web-secret.txt'), SECRET);
});
afterAll(() => server.stop());

describe('pages', () => {
  test('the root and each path with no file get index.html', async () => {
    for (const route of ['/', '/index.html', '/lists/abc', '/some/deep/path?task=5', '/icons', '/assets']) {
      const reply = await get(route);
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(reply.headers['cache-control']).toBe('no-cache');
      expect(reply.body.toString()).toBe(INDEX);
    }
  });

  test('the policy permits the inline script of index.html by its hash, and no other inline script', async () => {
    const reply = await get('/');
    const hash = createHash('sha256').update(INLINE).digest('base64');
    const policy = reply.headers['content-security-policy'] as string;
    expect(policy).toContain(`script-src 'self' 'sha256-${hash}';`);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['x-frame-options']).toBe('DENY');
  });

  test('a new build gets the policy of its own inline script', async () => {
    const file = path.join(server.dir, 'web', 'index.html');
    const next = "document.documentElement.dataset.theme = 'light';";
    writeFileSync(file, INDEX.replace(INLINE, next));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const reply = await get('/');
    expect(reply.headers['content-security-policy']).toContain(`'sha256-${createHash('sha256').update(next).digest('base64')}'`);
    writeFileSync(file, INDEX);
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect((await get('/')).body.toString()).toBe(INDEX);
  });

  test('an unknown API path is not a page', async () => {
    const reply = await get('/api/unknown');
    expect(reply.status).toBe(404);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

describe('cache headers', () => {
  test('files under /assets/ never change', async () => {
    const js = await get('/assets/index-a1b2c3.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body.toString()).toBe(APP_JS);
    const css = await get('/assets/style-d4e5f6.css');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  test('a missing file under /assets/ is an error and not a page', async () => {
    const reply = await get('/assets/index-000000.js');
    expect(reply.status).toBe(404);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body.toString()).not.toContain('<html');
  });

  test('index.html, sw.js, and the manifest are checked each time', async () => {
    const expected: Record<string, string> = {
      '/index.html': 'text/html; charset=utf-8',
      '/sw.js': 'text/javascript; charset=utf-8',
      '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
      '/icons/icon.svg': 'image/svg+xml',
    };
    for (const [route, type] of Object.entries(expected)) {
      const reply = await get(route);
      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-cache');
      expect(reply.headers['content-type']).toBe(type);
    }
  });

  test('a file that did not change gives 304', async () => {
    const first = await get('/sw.js');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"[\w-]+"$/);
    const second = await get('/sw.js', { 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
    expect((await get('/sw.js', { 'If-None-Match': 'W/"other"' })).status).toBe(200);
  });
});

describe('compressed copies', () => {
  test('the server sends the .br or .gz copy when the client accepts it', async () => {
    const br = await get('/assets/index-a1b2c3.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.body.equals(brotliCompressSync(APP_JS))).toBe(true);
    expect(br.headers['content-length']).toBe(String(br.body.length));

    const gz = await get('/assets/index-a1b2c3.js', { 'Accept-Encoding': 'gzip, deflate' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body.equals(gzipSync(APP_JS))).toBe(true);

    for (const accept of [undefined, 'identity', 'br;q=0, gzip;q=0']) {
      const plain = await get('/assets/index-a1b2c3.js', accept ? { 'Accept-Encoding': accept } : {});
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body.toString()).toBe(APP_JS);
    }
  });

  test('a file with no copy goes out as it is', async () => {
    const reply = await get('/sw.js', { 'Accept-Encoding': 'gzip, br' });
    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(reply.body.toString()).toContain('addEventListener');
  });
});

describe('safety', () => {
  test('a path cannot leave the folder of the client', async () => {
    const attempts = [
      '/../secret.txt',
      '/../../secret.txt',
      '/assets/../../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/....//secret.txt',
      '//secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      // The name of the folder as the start of a different name.
      '/../web-secret.txt',
      '/..%2fweb-secret.txt',
      '/%00/../secret.txt',
      '/secret.txt%00.js',
      '/%zz',
    ];
    for (const route of attempts) {
      const reply = await get(route);
      expect(reply.body.toString()).not.toContain(SECRET);
      expect([200, 404]).toContain(reply.status);
      if (reply.status === 200) expect(reply.body.toString()).toBe(INDEX);
    }
  });

  test('a request line that is not a path is refused', async () => {
    const reply = await get('//');
    expect(reply.status).toBe(400);
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });

  test('a file with a dot at the start of its name is not served', async () => {
    const reply = await get('/.env');
    expect(reply.body.toString()).toBe(INDEX);
  });

  test('HEAD gives the headers and no body', async () => {
    const page = await get('/', {}, 'HEAD');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-length']).toBe(String(Buffer.byteLength(INDEX)));
    expect(page.body.length).toBe(0);

    const js = await get('/assets/index-a1b2c3.js', { 'Accept-Encoding': 'br' }, 'HEAD');
    expect(js.headers['content-encoding']).toBe('br');
    expect(js.headers['content-length']).toBe(String(brotliCompressSync(APP_JS).length));
    expect(js.body.length).toBe(0);

    const health = await get('/api/health', {}, 'HEAD');
    expect(health.status).toBe(200);
    expect(health.body.length).toBe(0);
  });

  test('only GET and HEAD read files', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const reply = await get('/index.html', {}, method);
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('GET, HEAD');
    }
  });

  test('with no built client, the server tells so and the API works', async () => {
    const empty = await startTestServer({ name: 'static-empty' });
    try {
      const page = await rawRequest({ url: empty.url, path: '/' });
      expect(page.status).toBe(404);
      expect(page.body.toString()).toContain('pnpm build');
      expect(page.headers['content-security-policy']).toContain("script-src 'self';");
      expect((await rawRequest({ url: empty.url, path: '/api/health' })).status).toBe(200);
    } finally {
      await empty.stop();
    }
  });
});
