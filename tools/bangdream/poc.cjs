/*!
 * 合成邦多利皇帝 · 「按玩偶轮廓做碰撞体」概念验证
 *
 * 输出一张对照图，四格：
 *   1. 抠掉白底后的玩偶（透明背景）
 *   2. 缩放到玩偶大小（⌀250）+ 拟合出的碰撞圆（黄色）+ 老式「一个包住整只玩偶的大球」（白色虚线）
 *   3. 缩放到中间某级（⌀84）
 *   4. 缩放到玩偶大小（⌀40）
 * 并打印：碰撞圆个数、轮廓覆盖率、以及「大球方案」浪费掉的空白比例。
 *
 * 用法：node tools/bangdream/poc.cjs <一张已转好的 PNG> [输出.png]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./prepare.cjs');

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

function checkerboard(dst, DW, DH, x0, y0, w, h, shade) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x0 + x;
      const py = y0 + y;
      if (px < 0 || py < 0 || px >= DW || py >= DH) continue;
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? shade : shade + 14;
      const o = (py * DW + px) * 4;
      dst[o] = c;
      dst[o + 1] = c + 3;
      dst[o + 2] = c + 9;
      dst[o + 3] = 255;
    }
  }
}

function blitOver(dst, DW, DH, src, dx, dy, scale, alpha) {
  const sw = Math.max(1, Math.round(src.width * scale));
  const sh = Math.max(1, Math.round(src.height * scale));
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const sxp = Math.min(src.width - 1, Math.floor((x * src.width) / sw));
      const syp = Math.min(src.height - 1, Math.floor((y * src.height) / sh));
      const so = (syp * src.width + sxp) * 4;
      const a = (src.data[so + 3] / 255) * (alpha == null ? 1 : alpha);
      if (a <= 0.003) continue;
      const px = dx + x;
      const py = dy + y;
      if (px < 0 || py < 0 || px >= DW || py >= DH) continue;
      const o = (py * DW + px) * 4;
      dst[o] = Math.round(dst[o] * (1 - a) + src.data[so] * a);
      dst[o + 1] = Math.round(dst[o + 1] * (1 - a) + src.data[so + 1] * a);
      dst[o + 2] = Math.round(dst[o + 2] * (1 - a) + src.data[so + 2] * a);
    }
  }
  return { w: sw, h: sh };
}

function circle(dst, DW, DH, cx, cy, r, rgb, thickness, dashed) {
  const step = dashed ? 6 : 0.5;
  for (let ang = 0; ang < Math.PI * 2; ang += dashed ? 0.05 : 0.01) {
    if (dashed && Math.floor((ang / (Math.PI * 2)) * 40) % 2 === 1) continue;
    for (let t = -thickness; t <= thickness; t += 0.5) {
      const x = Math.round(cx + Math.cos(ang) * (r + t));
      const y = Math.round(cy + Math.sin(ang) * (r + t));
      if (x < 0 || y < 0 || x >= DW || y >= DH) continue;
      const o = (y * DW + x) * 4;
      dst[o] = rgb[0];
      dst[o + 1] = rgb[1];
      dst[o + 2] = rgb[2];
    }
  }
}

function fillCircle(dst, DW, DH, cx, cy, r, rgb, alpha) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      if (x < 0 || y < 0 || x >= DW || y >= DH) continue;
      const o = (y * DW + x) * 4;
      dst[o] = Math.round(dst[o] * (1 - alpha) + rgb[0] * alpha);
      dst[o + 1] = Math.round(dst[o + 1] * (1 - alpha) + rgb[1] * alpha);
      dst[o + 2] = Math.round(dst[o + 2] * (1 - alpha) + rgb[2] * alpha);
    }
  }
}

/** 轮廓的「实心外接框面积」占比：用来算老式大球方案浪费多少空间 */
function solidRatio(img) {
  let solid = 0;
  for (let p = 0; p < img.width * img.height; p++) if (img.data[p * 4 + 3] > 110) solid++;
  return solid / (img.width * img.height);
}

function main() {
  const src = process.argv[2];
  const out = process.argv[3] || path.join(__dirname, '..', '..', 'assets', 'library-bangdream', '_验证-碰撞体.png');
  if (!src) {
    console.log('用法：node tools/bangdream/poc.cjs <图片.png> [输出.png]');
    process.exit(1);
  }

  const original = P.decodePng(fs.readFileSync(src));
  const img = { width: original.width, height: original.height, data: Buffer.from(original.data) };
  P.removeBackground(img, { whiteTolerance: 226 });
  P.cleanComponents(img, { minComponentRatio: 0.02 });
  const box = P.contentBox(img, 24);
  const cut = P.cropAndScale(img, box, 512);
  const box2 = P.contentBox(cut, 12);
  const tight = P.cropAndScale(cut, box2, 512);
  const shape = P.fitCircles(tight, { grid: 72, maxCircles: 16 });
  const ratio = solidRatio(tight);

  const pad = 14;
  const labelH = 18;
  const panels = [
    { size: 300, circles: false, sphere: false, cap: '1 抠图（透明底）' },
    { size: 300, circles: true, sphere: true, cap: '2 玩偶 ⌀250' },
    { size: 170, circles: true, sphere: true, cap: '3 中级 ⌀84' },
    { size: 110, circles: true, sphere: true, cap: '4 玩偶 ⌀40' }
  ];
  const W = pad + panels.reduce((a, p) => a + p.size + pad, 0);
  const H = pad + labelH + 300 + pad + 40;
  const sheet = blank(W, H, [24, 30, 40]);

  let x = pad;
  panels.forEach((panel) => {
    const s = panel.size;
    const y = pad + labelH;
    checkerboard(sheet, W, H, x, y, s, 300, 46);
    const scale = s / Math.max(tight.width, tight.height);
    const drawn = blitOver(sheet, W, H, tight, x + Math.round((s - tight.width * scale) / 2), y + Math.round((300 - tight.height * scale) / 2), scale);
    const cx = x + s / 2;
    const cy = y + 150;
    if (panel.sphere) {
      // 老方案：一个直径 = 玩偶直径的大球（虚线）
      circle(sheet, W, H, cx, cy, s / 2, [255, 255, 255], 1.5, true);
    }
    if (panel.circles) {
      const long = Math.max(tight.width, tight.height) * scale;
      shape.circles.forEach((c) => {
        const px = cx + c.x * long;
        const py = cy + c.y * long;
        const pr = c.r * long;
        fillCircle(sheet, W, H, px, py, pr, [255, 170, 40], 0.22);
        circle(sheet, W, H, px, py, pr, [255, 209, 102], 1, false);
      });
    }
    x += s + pad;
  });

  fs.writeFileSync(out, P.encodePng(W, H, sheet));
  console.log(`验证图：${out}`);
  console.log(`  源图 ${original.width}x${original.height} → 抠图裁剪 ${tight.width}x${tight.height}`);
  console.log(`  碰撞体：${shape.circles.length} 个圆，轮廓覆盖率 ${(shape.coverage * 100).toFixed(1)}%`);
  console.log(`  玩偶实心占比 ${(ratio * 100).toFixed(1)}%（外接框内）`);
  console.log(`  老式「单个大球」方案：球面积是外接框的 ${((Math.PI / 4) * 100).toFixed(1)}%，其中约 ${(100 - (ratio / (Math.PI / 4)) * 100).toFixed(0)}% 是空气`);
  console.log(`  参考：${JSON.stringify(shape.circles.slice(0, 4).map((c) => ({ x: +c.x.toFixed(3), y: +c.y.toFixed(3), r: +c.r.toFixed(3) })))} …`);
}

if (require.main === module) main();
module.exports = { main };
