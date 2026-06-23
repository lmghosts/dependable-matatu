#!/usr/bin/env node
/**
 * Generates PWA icons at 192x192 and 512x512.
 * Design: dark Afrofuturist — deep bg, flame-orange "M" monogram,
 * geometric matatu-route accent line beneath.
 */
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/icons');
mkdirSync(OUT, { recursive: true });

function makeSvg(size) {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;

  // Scale factors relative to 512
  const k = s / 512;

  // Rounded rect radius
  const r = Math.round(80 * k);

  // "M" glyph params — drawn as a filled path
  const mW  = Math.round(280 * k);
  const mH  = Math.round(260 * k);
  const mX  = cx - mW / 2;
  const mY  = cy - mH / 2 - Math.round(20 * k);
  const mB  = mY + mH;
  const mMid = mY + Math.round(120 * k);  // apex of the M valley
  const strokeW = Math.round(52 * k);
  const hw = strokeW / 2;

  // Left leg, left diagonal, right diagonal, right leg
  // Using polygon for a clean geometric M
  const pts = [
    [mX,              mB],
    [mX,              mY],
    [cx,              mMid],
    [mX + mW,        mY],
    [mX + mW,        mB],
    [mX + mW - strokeW, mB],
    [mX + mW - strokeW, mY + strokeW * 1.1],
    [cx,              mMid + strokeW * 1.2],
    [mX + strokeW,   mY + strokeW * 1.1],
    [mX + strokeW,   mB],
  ].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  // Accent bar — a short horizontal line below the M
  const barW  = Math.round(160 * k);
  const barH  = Math.round(14 * k);
  const barY  = cy + Math.round(168 * k);
  const barX  = cx - barW / 2;

  // Small dot accent (top-right quadrant, Afrofuturist feel)
  const dotR  = Math.round(18 * k);
  const dotCx = cx + Math.round(108 * k);
  const dotCy = mY - Math.round(22 * k);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141619"/>
      <stop offset="100%" stop-color="#0E0F12"/>
    </linearGradient>
    <linearGradient id="flame" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FF7A3D"/>
      <stop offset="100%" stop-color="#E84000"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${s}" height="${s}" rx="${r}" ry="${r}" fill="url(#bg)"/>

  <!-- Subtle inner border ring -->
  <rect x="${Math.round(3*k)}" y="${Math.round(3*k)}"
        width="${s - Math.round(6*k)}" height="${s - Math.round(6*k)}"
        rx="${r - Math.round(3*k)}" ry="${r - Math.round(3*k)}"
        fill="none" stroke="#FF572215" stroke-width="${Math.round(2*k)}"/>

  <!-- M monogram -->
  <polygon points="${pts}" fill="url(#flame)"/>

  <!-- Accent bar -->
  <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}"
        width="${barW}" height="${barH}"
        rx="${Math.round(barH/2)}" fill="#FF572260"/>

  <!-- Dot accent -->
  <circle cx="${dotCx.toFixed(1)}" cy="${dotCy.toFixed(1)}"
          r="${dotR}" fill="#FF5722"/>
</svg>`;
}

async function generate(size) {
  const svg = makeSvg(size);
  const dest = join(OUT, `icon-${size}.png`);
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(dest);
  console.log(`[icons] ${dest} (${size}x${size})`);
}

await generate(192);
await generate(512);
console.log('[icons] Done.');
