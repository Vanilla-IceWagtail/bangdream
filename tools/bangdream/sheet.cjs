/*!
 * 合成邦高祖！！！ · 玩偶素材验收拼图
 *
 * 把整批图片的「右下角放大」或「抠图结果」拼成一张大图，方便一眼验收：
 *   · corner 模式：每张只取右下角（水印所在位置）放大 → 检查「AI生成」有没有清干净
 *   · cut 模式：每张的完整抠图 → 检查抠图质量、有没有把玩偶切坏
 *
 * 用法：
 *   node tools/bangdream/sheet.cjs <图片目录> <输出.png> [corner|cut] [--cols 7] [--tile 200]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./prepare.cjs');

/* 只画数字的迷你点阵字体（5x7），用来给拼图编号 */
const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

function drawNumber(buf, W, H, value, x0, y0, scale, color) {
  const text = String(value);
  let cx = x0;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cx + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const o = (py * W + px) * 4;
            buf[o] = color[0];
            buf[o + 1] = color[1];
            buf[o + 2] = color[2];
            buf[o + 3] = 255;
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function blank(W, H, rgb) {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = rgb[0];
    buf[i * 4 + 1] = rgb[1];
    buf[i * 4 + 2] = rgb[2];
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function blit(dst, DW, DH, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sxp = Math.min(src.width - 1, sx + Math.floor((x * sw) / dw));
      const syp = Math.min(src.height - 1, sy + Math.floor((y * sh) / dh));
      const so = (syp * src.width + sxp) * 4;
      const a = src.data[so + 3] / 255;
      const px = dx + x;
      const py = dy + y;
      if (px < 0 || py < 0 || px >= DW || py >= DH) continue;
      const o = (py * DW + px) * 4;
      /* 半透明像素往「深灰棋盘」上合成，方便看清水印残留 */
      const bg = ((px >> 3) + (py >> 3)) % 2 === 0 ? 52 : 74;
      dst[o] = Math.round(bg * (1 - a) + src.data[so] * a);
      dst[o + 1] = Math.round((bg + 4) * (1 - a) + src.data[so + 1] * a);
      dst[o + 2] = Math.round((bg + 10) * (1 - a) + src.data[so + 2] * a);
      dst[o + 3] = 255;
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  const outPath = argv[1];
  const mode = argv[2] === 'cut' ? 'cut' : 'corner';
  let cols = 7;
  let tile = 200;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--cols') cols = parseInt(argv[++i], 10);
    if (argv[i] === '--tile') tile = parseInt(argv[++i], 10);
  }
  if (!dir || !outPath) {
    console.log('用法：node tools/bangdream/sheet.cjs <图片目录> <输出.png> [corner|cut] [--cols 7] [--tile 200]');
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort();
  const rows = Math.ceil(files.length / cols);
  const labelH = 16;
  const gap = 6;
  const cellW = tile + gap;
  const cellH = tile + labelH + gap;
  const W = cols * cellW + gap;
  const H = rows * cellH + gap;
  const sheet = blank(W, H, [26, 32, 42]);

  const report = [];
  files.forEach((file, idx) => {
    const raw = fs.readFileSync(path.join(dir, file));
    const original = P.decodePng(raw);
    const img = { width: original.width, height: original.height, data: Buffer.from(original.data) };
    /* 新一批图没有水印，不做去水印处理（避免误伤玩偶身上的浅色细节） */
    P.removeBackground(img, {});
    P.cleanComponents(img, {});
    const box = P.contentBox(img, 24);
    const cut = box
      ? P.cropAndScale(img, box, mode === 'cut' ? tile : 2400)
      : { width: 1, height: 1, data: Buffer.alloc(4) };

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x0 = gap + col * cellW;
    const y0 = gap + row * cellH;

    if (mode === 'corner') {
      /* 右下角那一块：宽 62%、高 30%（水印就在这里） */
      const cw = Math.max(24, Math.round(cut.width * 0.62));
      const chh = Math.max(16, Math.round(cut.height * 0.3));
      const region = P.cropRegion(cut, cut.width - cw, cut.height - chh, cw, chh);
      blit(sheet, W, H, region, 0, 0, region.width, region.height, x0, y0 + labelH, tile, tile);
    } else {
      const s = Math.min(tile / cut.width, tile / cut.height);
      const dw = Math.max(1, Math.round(cut.width * s));
      const dh = Math.max(1, Math.round(cut.height * s));
      blit(
        sheet,
        W,
        H,
        cut,
        0,
        0,
        cut.width,
        cut.height,
        x0 + Math.round((tile - dw) / 2),
        y0 + labelH + Math.round((tile - dh) / 2),
        dw,
        dh
      );
    }
    drawNumber(sheet, W, H, idx + 1, x0 + 2, y0 + 2, 2, [255, 209, 102]);
    report.push(
      `${String(idx + 1).padStart(2)} ${file}  裁剪 ${cut.width}x${cut.height}`
    );
  });

  fs.writeFileSync(outPath, P.encodePng(W, H, sheet));
  console.log(`拼图已生成：${outPath}  (${W}x${H}, ${files.length} 张, ${mode})`);
  console.log('编号对应：');
  report.forEach((line) => console.log('  ' + line));
}

if (require.main === module) main();
module.exports = { main };
