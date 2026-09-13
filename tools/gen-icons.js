'use strict';
/* MI icon generator — zero-dependency PNG icon builder (pure Node, uses zlib).
   Generates public/icon-192.png, public/icon-512.png and a maskable variant.
   Run: node tools/gen-icons.js */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------------- minimal PNG encoder (8-bit RGBA) ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0])); // filter: none
    rows.push(Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- tiny canvas helper ----------------
function canvas(w, h) {
  const px = Buffer.alloc(w * h * 4);
  return {
    w, h, px,
    set(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a == null ? 255 : a;
    },
    fillRect(x0, y0, x1, y1, col) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, col[0], col[1], col[2], col[3] == null ? 255 : col[3]);
    },
    fillRoundRect(x0, y0, x1, y1, rad, col) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const cx = x < x0 + rad ? x0 + rad : x > x1 - rad - 1 ? x1 - rad - 1 : x;
          const cy = y < y0 + rad ? y0 + rad : y > y1 - rad - 1 ? y1 - rad - 1 : y;
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= rad * rad) this.set(x, y, col[0], col[1], col[2], col[3] == null ? 255 : col[3]);
        }
      }
    },
    fillCircle(cx, cy, rad, col) {
      for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
        for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
          if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad) this.set(x, y, col[0], col[1], col[2], col[3] == null ? 255 : col[3]);
        }
      }
    },
  };
}

// ---------------- glyphs ("MI" as 7x7 bitmaps) ----------------
const GLYPH_M = [
  'X.....X',
  'X.....X',
  'XX...XX',
  'X.X.X.X',
  'X..X..X',
  'X.....X',
  'X.....X',
];
const GLYPH_I = [
  '..XXX..',
  '...X...',
  '...X...',
  '...X...',
  '...X...',
  '...X...',
  '..XXX..',
];

// ---------------- icon rendering ----------------
function renderIcon(size, maskable) {
  const cv = canvas(size, size);
  const top = [16, 26, 44, 255];      // #101a2c
  const bottom = [4, 7, 12, 255];     // #04070c
  const cyan = [34, 211, 238, 255];   // #22d3ee
  const green = [52, 211, 153, 255];  // #34d399
  const red = [244, 63, 94, 255];     // #f43f5e

  // vertical gradient background
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    cv.fillRect(0, y, size, y + 1, [r, g, b, 255]);
  }
  // rounded corner mask (transparent outside the rounded square)
  const margin = Math.round(size * 0.06);
  const rad = Math.round(size * 0.2);
  const mask = canvas(size, size);
  mask.fillRoundRect(margin, margin, size - margin, size - margin, rad, [0, 0, 0, 255]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask.px[(y * size + x) * 4 + 3] === 0) cv.px[(y * size + x) * 4 + 3] = 0;
    }
  }

  // glyph layout — maskable keeps content inside the 80% safe circle
  const padding = maskable ? Math.round(size * 0.18) : Math.round(size * 0.12);
  const totalCols = 15; // 7(M) + 1(gap) + 7(I)
  const cell = Math.floor((size - padding * 2) / (totalCols + 2));
  const glyphH = cell * 7;
  const startX = Math.round((size - totalCols * cell) / 2) + cell;
  const startY = Math.round((size - glyphH) / 2) - (maskable ? 0 : Math.round(cell * 0.4));

  [GLYPH_M, GLYPH_I].forEach((glyph, gi) => {
    const ox = startX + gi * 8 * cell;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        if (glyph[row][col] === 'X') {
          cv.fillRect(ox + col * cell + 1, startY + row * cell + 1, ox + col * cell + cell, startY + row * cell + cell, cyan);
        }
      }
    }
  });

  // accent bar (rising green bar under the monogram)
  const barW = Math.round(totalCols * cell * 0.66);
  const barX = Math.round((size - barW) / 2);
  const barY = startY + 7 * cell + Math.round(cell * 0.7);
  const barH = Math.max(2, Math.round(cell * 0.62));
  cv.fillRoundRect(barX, barY, barX + barW, barY + barH, Math.round(barH / 2), green);

  // live dot (top-right)
  if (!maskable) {
    const dR = Math.round(size * 0.045);
    cv.fillCircle(size - Math.round(size * 0.13), Math.round(size * 0.13), dR, red);
    cv.fillCircle(size - Math.round(size * 0.13), Math.round(size * 0.13), Math.max(1, Math.round(dR * 0.55)), [255, 255, 255, 255]);
  }

  return encodePNG(size, size, cv.px);
}

// ---------------- write files ----------------
const OUT = path.join(__dirname, '..', 'public');
const targets = [
  ['icon-192.png', renderIcon(192, false)],
  ['icon-512.png', renderIcon(512, false)],
  ['icon-maskable-512.png', renderIcon(512, true)],
];
for (const [name, buf] of targets) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  console.log('wrote', name, buf.length, 'bytes');
}
console.log('icons done');