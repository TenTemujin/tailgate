// Renders assets/logo.svg to PNGs and a multi-size Windows .ico (PNG-compressed entries).
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const svg = readFileSync('assets/logo.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
writeFileSync('assets/icon-256.png', pngs[pngs.length - 1]);

const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0);
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
writeFileSync('assets/icon.ico', Buffer.concat([head, ...dir, ...pngs]));
console.log('wrote assets/icon.ico + icon-256.png');
