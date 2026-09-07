import fs from 'node:fs';
import zlib from 'node:zlib';

const src = process.argv[2];
const dest = process.argv[3];

function parsePng(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('not png');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  const idats = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth}`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`colorType ${colorType}`);
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const raw = Buffer.alloc(height * stride);
  let srcOff = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[srcOff];
    srcOff += 1;
    const row = inflated.subarray(srcOff, srcOff + stride);
    srcOff += stride;
    const out = raw.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + Math.floor((a + b) / 2)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      out[i] = v;
    }
    prev = Buffer.from(out);
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += bpp) {
    const o = i * 4;
    rgba[o] = raw[p];
    rgba[o + 1] = raw[p + 1];
    rgba[o + 2] = raw[p + 2];
    rgba[o + 3] = bpp === 4 ? raw[p + 3] : 255;
  }
  return { width, height, rgba };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crcBuf = Buffer.concat([Buffer.from(type), data]);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

function writePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function isBg(r, g, b, a) {
  if (a < 18) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max < 42 && sat < 0.28) return true;
  return sat < 0.1 && max > 150 && min > 130;
}

const { width, height, rgba } = parsePng(fs.readFileSync(src));
const visited = new Uint8Array(width * height);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = y * width + x;
  if (visited[i]) return;
  const o = i * 4;
  if (!isBg(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3])) return;
  visited[i] = 1;
  stack.push(i);
};
for (let x = 0; x < width; x += 1) {
  push(x, 0);
  push(x, height - 1);
}
for (let y = 0; y < height; y += 1) {
  push(0, y);
  push(width - 1, y);
}
while (stack.length) {
  const i = stack.pop();
  const x = i % width;
  const y = (i / width) | 0;
  rgba[i * 4 + 3] = 0;
  push(x - 1, y);
  push(x + 1, y);
  push(x, y - 1);
  push(x, y + 1);
}

fs.writeFileSync(dest, writePng(width, height, rgba));
console.log('saved', dest, width, height);
