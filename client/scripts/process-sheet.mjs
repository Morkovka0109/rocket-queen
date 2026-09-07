import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const src = process.argv[2];
const dest = process.argv[3];

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
console.log('raw', width, height, info.channels);

const idx = (x, y) => (y * width + x) * 4;
const sat = (r, g, b) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

function isChecker(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const s = sat(r, g, b);
  // gray/white checkerboard squares
  return s < 0.12 && max > 140 && min > 120;
}

const visited = new Uint8Array(width * height);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = y * width + x;
  if (visited[i]) return;
  const o = i * 4;
  if (!isChecker(data[o], data[o + 1], data[o + 2])) return;
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
  const o = i * 4;
  data[o + 3] = 0;
  push(x - 1, y);
  push(x + 1, y);
  push(x, y - 1);
  push(x, y + 1);
}

// soften checker fringe
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const i = y * width + x;
    if (!visited[i]) continue;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (visited[ni]) continue;
        const o = ni * 4;
        if (isChecker(data[o], data[o + 1], data[o + 2])) {
          data[o + 3] = Math.min(data[o + 3], 40);
        }
      }
    }
  }
}

await sharp(data, { raw: { width, height, channels: 4 } })
  .resize(1024, 512, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
  .png({ compressionLevel: 9 })
  .toFile(dest);

const out = await sharp(dest).metadata();
console.log('output', out.width, out.height, out.channels, out.hasAlpha);
