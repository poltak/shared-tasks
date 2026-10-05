// Runs after 'vite build'. Gives the service worker its file list and its version, and writes
// compressed copies of the text files, so the server does not compress at request time.
// Usage: node scripts/postbuild.ts [folder]. The folder is web/dist if not given.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'web/dist'));

const TEXT = /\.(html|js|css|svg|json|webmanifest)$/;
const MIN_COMPRESS_BYTES = 1024;
const FIRST_SCREEN_BUDGET = 90_000;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

/** Writes the .br and .gz copies. Returns the gzip size, or the plain size for a file that stays as it is. */
function compress(file: string, data: Buffer): number {
  if (!TEXT.test(file) || data.length <= MIN_COMPRESS_BYTES) return data.length;
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = gzipSync(data, { level: 9 });
  writeFileSync(`${file}.br`, br);
  writeFileSync(`${file}.gz`, gz);
  return gz.length;
}

// The worker file, the compressed copies, and the source maps are not for the cache of the worker.
// A dot file such as .DS_Store can come from web/public on a Mac.
const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !/\.(br|gz|map)$/.test(entry.name))
  .map((entry) => path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  .filter((file) => file !== 'sw.js')
  .sort();

let plainBytes = 0;
const gzipBytes = new Map<string, number>();
const hashes: string[] = [];
for (const file of files) {
  const data = readFileSync(path.join(dist, file));
  plainBytes += data.length;
  hashes.push(`${file} ${sha256(data)}`);
  gzipBytes.set(file, compress(path.join(dist, file), data));
}

// The template comes from web/public, not from the folder, so a second run on the same folder is correct.
// Its text is a part of the version: a change to the worker alone must also make a new cache.
const template = readFileSync(path.join(root, 'web/public/sw.js'), 'utf8');
const version = sha256([template, ...hashes].join('\n')).slice(0, 12);
const values = [
  { mark: "'__VERSION__'", value: version },
  { mark: '/* __FILES__ */ []', value: files.map((file) => `/${file}`) },
];
let worker = template;
for (const { mark, value } of values) {
  if (!worker.includes(mark)) throw new Error(`web/public/sw.js does not have the placeholder ${mark}`);
  // A function, because a '$' in a replacement string has a special meaning.
  worker = worker.replace(mark, () => JSON.stringify(value));
}
writeFileSync(path.join(dist, 'sw.js'), worker);
compress(path.join(dist, 'sw.js'), Buffer.from(worker));

// SPEC.md section 1 limits the JavaScript of the first screen. That is each script that index.html names.
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const firstScreen = files
  .filter((file) => file.endsWith('.js') && html.includes(`/${file}"`))
  .reduce((sum, file) => sum + gzipBytes.get(file)!, 0);

const total = [...gzipBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
console.log(`postbuild: ${files.length} files for the service worker, version ${version}`);
console.log(`postbuild: ${kB(plainBytes)} in all, ${kB(total)} to download with gzip`);
console.log(`postbuild: first screen JavaScript ${kB(firstScreen)} gzip, limit ${kB(FIRST_SCREEN_BUDGET)}`);
if (firstScreen > FIRST_SCREEN_BUDGET) console.warn('postbuild: WARNING: the first screen JavaScript is over the limit');
