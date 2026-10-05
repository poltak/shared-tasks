// Renders the PNG icons from the SVG files with the Chromium of Playwright.
// Run 'pnpm icons' after a change to an SVG file. The PNG files stay in Git, so a build needs no browser.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const dir = path.resolve(import.meta.dirname, '../web/public/icons');

interface Output {
  file: string;
  source: string;
  size: number;
  /** Makes the drawing larger around its center. The edges are cut off. */
  zoom?: number;
}

const outputs: Output[] = [
  { file: 'icon-192.png', source: 'icon.svg', size: 192 },
  { file: 'icon-512.png', source: 'icon.svg', size: 512 },
  { file: 'favicon-48.png', source: 'icon.svg', size: 48 },
  { file: 'maskable-512.png', source: 'maskable.svg', size: 512 },
  // iOS shows black where an icon is transparent, so this one comes from the full square.
  // iOS has no safe zone: the zoom gives the mark the size that it has in icon.svg.
  { file: 'apple-touch-icon.png', source: 'maskable.svg', size: 180, zoom: 1 / 0.84 },
  { file: 'badge-96.png', source: 'badge.svg', size: 96 },
  { file: 'shortcut-new-192.png', source: 'shortcut-new.svg', size: 192 },
];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// A screenshot from Chromium is a PNG made for speed: 112 kB for the 512 px icon. Chromium also adds
// noise to a gradient, and that noise compresses best with no row filter. This gives 21 kB.
function encodePng({ rgba, size }: { rgba: number[]; size: number }): Buffer {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) opaque &&= rgba[i] === 255;
  const channels = opaque ? 3 : 4;
  // Each row starts with its filter type. 0 is no filter.
  const rowLength = size * channels + 1;
  const rows = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < channels; c++) rows[y * rowLength + 1 + x * channels + c] = rgba[(y * size + x) * 4 + c]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  // 8 bits for each channel, then the color type: 2 is RGB, 6 is RGB with alpha.
  header.set([8, opaque ? 2 : 6], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, source, size, zoom = 1 } of outputs) {
  const svg = readFileSync(path.join(dir, source), 'utf8');
  const rgba = await page.evaluate(
    async ({ svg, size, zoom }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const context = new OffscreenCanvas(size, size).getContext('2d')!;
      const drawn = size * zoom;
      context.drawImage(image, (size - drawn) / 2, (size - drawn) / 2, drawn, drawn);
      return Array.from(context.getImageData(0, 0, size, size).data);
    },
    { svg, size, zoom },
  );
  const png = encodePng({ rgba, size });
  writeFileSync(path.join(dir, file), png);
  console.log(`${file}: ${size} px from ${source}, ${png.length} bytes`);
}
await browser.close();
