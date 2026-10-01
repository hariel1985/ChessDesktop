'use strict';

// Generates the app icons from the official chess.com favicon (build/favicon.svg):
//   build/icon.png      1024x1024 transparent pawn (Windows .ico, Linux, dev)
//   build/icon-mac.png  1024x1024 macOS squircle: pawn on the chess.com dark
//                       background (macOS 26 greys out non-squircle icons)
//   build/icons/NxN.png Linux icon set
// Usage: npm run icons

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'favicon.svg'));
const SIZE = 1024;
const PAD = 0.1; // keep the pawn inside the macOS icon grid

async function render(size) {
  const inner = Math.round(size * (1 - 2 * PAD));
  const pawn = await sharp(svg, { density: 1200 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: pawn, gravity: 'center' }])
    .png()
    .toBuffer();
}

// Apple icon grid: 824px rounded square centred on a 1024 canvas.
async function renderMac() {
  const plate = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#312e2b"/></svg>`
  );
  const pawn = await sharp(svg, { density: 1200 })
    .resize(560, 560, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(plate).composite([{ input: pawn, gravity: 'center' }]).png().toBuffer();
}

(async () => {
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await render(SIZE));
  fs.writeFileSync(path.join(root, 'build', 'icon-mac.png'), await renderMac());
  const dir = path.join(root, 'build', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(dir, `${s}x${s}.png`), await render(s));
  }
  console.log('Icons written to build/');
})();
