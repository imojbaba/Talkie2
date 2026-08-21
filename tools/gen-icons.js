#!/usr/bin/env node
'use strict';

/*
 * Generates the PWA icons (walkie-talkie glyph on a navy tile) as PNGs with
 * no image-library dependency: pixels are painted with signed-distance
 * functions and encoded with node's zlib.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

// ------------------------------------------------------------- png encoding
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- painting
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

// coverage from a signed distance, with ~1px anti-aliasing at the given scale
function cov(d, aa) {
  return Math.min(1, Math.max(0, 0.5 - d / aa));
}

/**
 * Paint one subpixel at unit coords (u, v).
 * opts: { rounded: transparent rounded-square tile, safe: glyph scale }
 * Returns [r, g, b, a] with 0..1 channels.
 */
function paint(u, v, opts) {
  const aa = opts.aa;
  let r = 0, g = 0, b = 0, a = 0;

  // tile
  const tile = opts.rounded ? cov(sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.21), aa) : 1;
  if (tile > 0) {
    // navy base with a soft glow behind the glyph
    const glow = Math.exp(-(((u - 0.5) ** 2 + (v - 0.44) ** 2) / 0.09));
    r = mix(0x0e / 255, 0x1f / 255, glow * 0.55);
    g = mix(0x17 / 255, 0x2e / 255, glow * 0.55);
    b = mix(0x29 / 255, 0x4d / 255, glow * 0.55);
    a = tile;
  }

  // glyph in unit coords, scaled about the center
  const s = opts.safe;
  const gu = (u - 0.5) / s + 0.5;
  const gv = (v - 0.5) / s + 0.5;
  const gaa = aa / s;

  // body
  const dBody = sdRoundRect(gu, gv, 0.5, 0.565, 0.17, 0.27, 0.07);
  // antenna
  const dAnt = sdRoundRect(gu, gv, 0.385, 0.21, 0.028, 0.09, 0.028);
  const dOrange = Math.min(dBody, dAnt);
  const cO = cov(dOrange, gaa);
  if (cO > 0) {
    const t = Math.min(1, Math.max(0, (gv - 0.28) / 0.56));
    const or = mix(0xfb / 255, 0xea / 255, t);
    const og = mix(0x92 / 255, 0x58 / 255, t);
    const ob = mix(0x3c / 255, 0x0c / 255, t);
    r = mix(r, or, cO);
    g = mix(g, og, cO);
    b = mix(b, ob, cO);
    a = Math.max(a, cO);
  }

  // dark details on the body: speaker grill + screen
  let dark = 0;
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const d = sdCircle(gu, gv, 0.44 + gx * 0.06, 0.395 + gy * 0.06, 0.017);
      dark = Math.max(dark, cov(d, gaa));
    }
  }
  dark = Math.max(dark, cov(sdRoundRect(gu, gv, 0.5, 0.64, 0.1, 0.048, 0.024), gaa));
  // side PTT button
  dark = Math.max(dark, 0.55 * cov(sdRoundRect(gu, gv, 0.316, 0.53, 0.013, 0.055, 0.013), gaa));
  dark *= cO;
  if (dark > 0) {
    r = mix(r, 0x14 / 255, dark);
    g = mix(g, 0x1c / 255, dark);
    b = mix(b, 0x2e / 255, dark);
  }

  return [r, g, b, a];
}

function renderIcon(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1 / size;
  const SS = 2; // 2x2 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [pr, pg, pb, pa] = paint(u, v, { ...opts, aa });
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round((r / n) * 255);
      rgba[i + 1] = Math.round((g / n) * 255);
      rgba[i + 2] = Math.round((b / n) * 255);
      rgba[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { rounded: true, safe: 0.78 }],
  ['icon-512.png', 512, { rounded: true, safe: 0.78 }],
  ['icon-512-maskable.png', 512, { rounded: false, safe: 0.6 }],
  ['apple-touch-icon.png', 180, { rounded: false, safe: 0.72 }],
  ['favicon-32.png', 32, { rounded: true, safe: 0.95 }],
];
for (const [name, size, opts] of jobs) {
  const png = renderIcon(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
