/*!
 * 合成大西瓜 · 玩偶图片预处理工具
 *
 * 把「白底 + 水印」的玩偶 PNG 处理成游戏能用的素材：
 *   1. 自己解码 PNG（Node 内置 zlib，不依赖任何第三方库）
 *   2. 从四边泛洪抠掉白底（只抠连通到边框的白，玩偶身上的白色部分不会被吃掉）
 *   3. 丢掉零碎小连通块（右下角的「AI生成」水印就是这么去掉的）
 *   4. 按轮廓裁剪、等比缩放到目标尺寸
 *   5. 按轮廓拟合一组圆（碰撞体就是这些圆，而不是一个包住整只玩偶的大球）
 *   6. 输出：处理后的图片 + 形状数据 JSON + 一张对照预览图（原图 / 抠图 / 碰撞体）
 *
 * 用法：
 *   node tools/bangdream/prepare.cjs <图片路径> [--out 输出目录] [--size 512] [--max-circles 18]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 解码 / 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterLine(filter, line, prev, bpp) {
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = line[i];
    if (filter === 1) v = (v + a) & 0xff;
    else if (filter === 2) v = (v + b) & 0xff;
    else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
    else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
    line[i] = v;
  }
}

/** 解 8bit 的灰度/RGB/RGBA 非隔行 PNG，返回 { width, height, data(RGBA) } */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行(Adam7) PNG');
      if (bitDepth !== 8 && bitDepth !== 16) throw new Error('只支持 8/16bit PNG，当前 ' + bitDepth + 'bit');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 PNG 颜色类型 ' + colorType + '（调色板图请先转成 RGB/RGBA）');
  const bps = bitDepth / 8; // 16bit 时每通道 2 字节，取高字节即可（等价于 /257 的近似）
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels * bps;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const line = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    if (filter) unfilterLine(filter, line, prev, channels * bps);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels * bps;
      if (channels === 4) {
        out[o] = line[i];
        out[o + 1] = line[i + bps];
        out[o + 2] = line[i + bps * 2];
        out[o + 3] = line[i + bps * 3];
      } else if (channels === 3) {
        out[o] = line[i];
        out[o + 1] = line[i + bps];
        out[o + 2] = line[i + bps * 2];
        out[o + 3] = 255;
      } else if (channels === 1) {
        out[o] = out[o + 1] = out[o + 2] = line[i];
        out[o + 3] = 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[i];
        out[o + 3] = line[i + bps];
      }
    }
    prev = line;
  }
  return { width, height, data: out, bitDepth: bitDepth };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 抠图 ---------------- */

/** 白底判定：够亮、且三通道接近（避免把玩偶身上偏白的阴影也吃掉） */
function isWhiteish(r, g, b, tol) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= tol && max - min <= 26;
}

/**
 * 从四边泛洪抠背景：只删除「和图像边框连通」的白色，
 * 所以玩偶身上被包围的白色（袜子、衣服）会保留。
 */
function removeBackground(img, opts) {
  const { width: w, height: h, data } = img;
  const tol = opts.whiteTolerance == null ? 232 : opts.whiteTolerance;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;

  function push(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (visited[p]) return;
    const o = p * 4;
    if (data[o + 3] < 8) {
      // 本来就是透明的，直接算背景
      visited[p] = 2;
      queue[qt++] = p;
      return;
    }
    if (!isWhiteish(data[o], data[o + 1], data[o + 2], tol)) return;
    visited[p] = 2;
    queue[qt++] = p;
  }

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % w;
    const y = (p - x) / w;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  // 背景置透明
  for (let p = 0; p < w * h; p++) {
    if (visited[p] === 2) data[p * 4 + 3] = 0;
  }
  return visited;
}

/**
 * 连通块分析 + 清理：
 *   · 「AI生成」水印：位于图片右下角、面积远小于玩偶 → 按「角落 + 面积」两条规则一起判定
 *   · 零星毛边噪点：面积太小的一律丢掉
 * 返回保留下来的块信息，方便核对到底删掉了什么。
 */
function cleanComponents(img, opts) {
  const { width: w, height: h, data } = img;
  const minRatio = opts.minComponentRatio == null ? 0.08 : opts.minComponentRatio;
  const cornerW = (opts.watermarkCornerW == null ? 0.42 : opts.watermarkCornerW) * w;
  const cornerH = (opts.watermarkCornerH == null ? 0.26 : opts.watermarkCornerH) * h;
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || data[start * 4 + 3] < 8) continue;
    const id = comps.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let size = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    while (sp > 0) {
      const p = stack[--sp];
      size += 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (let i = 0; i < 4; i++) {
        const q = nb[i];
        if (q < 0 || label[q] !== -1 || data[q * 4 + 3] < 8) continue;
        label[q] = id;
        stack[sp++] = q;
      }
    }
    comps.push({ id, size, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  if (!comps.length) return { kept: [], dropped: [], components: 0, watermark: 0, noise: 0 };

  const largest = comps.reduce((a, b) => (b.size > a.size ? b : a), comps[0]);
  const kept = [];
  const dropped = [];
  let watermark = 0;
  let noise = 0;
  comps.forEach((c) => {
    if (c.id === largest.id) {
      kept.push(c);
      return;
    }
    const inCorner = c.x >= w - cornerW && c.y >= h - cornerH;
    const tiny = c.size < largest.size * minRatio || c.size < 64;
    if (inCorner && c.size < largest.size * 0.5) {
      dropped.push(Object.assign({ why: 'watermark' }, c));
      watermark += 1;
    } else if (tiny) {
      dropped.push(Object.assign({ why: 'noise' }, c));
      noise += 1;
    } else {
      kept.push(c);
    }
  });

  const keepIds = new Set(kept.map((c) => c.id));
  let removedPixels = 0;
  for (let p = 0; p < w * h; p++) {
    const id = label[p];
    if (id >= 0 && !keepIds.has(id)) {
      data[p * 4 + 3] = 0;
      removedPixels += 1;
    }
  }
  return { kept, dropped, components: comps.length, watermark, noise, removedPixels, largest };
}

/** 裁一块区域出来（用于预览放大，检查水印有没有清干净） */
function cropRegion(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const sx = Math.min(img.width - 1, Math.max(0, x + xx));
      const sy = Math.min(img.height - 1, Math.max(0, y + yy));
      const so = (sy * img.width + sx) * 4;
      const o = (yy * w + xx) * 4;
      out[o] = img.data[so];
      out[o + 1] = img.data[so + 1];
      out[o + 2] = img.data[so + 2];
      out[o + 3] = img.data[so + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** 最近邻放大（检查像素级残留用，不要平滑） */
function scaleNearest(img, factor) {
  const w = Math.round(img.width * factor);
  const h = Math.round(img.height * factor);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / factor));
      const sy = Math.min(img.height - 1, Math.floor(y / factor));
      const so = (sy * img.width + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = img.data[so];
      out[o + 1] = img.data[so + 1];
      out[o + 2] = img.data[so + 2];
      out[o + 3] = img.data[so + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** 轮廓外接框（带一点内缩，忽略极少量毛边） */
function contentBox(img, alphaThreshold) {
  const { width: w, height: h, data } = img;
  const th = alphaThreshold == null ? 24 : alphaThreshold;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < th) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 裁剪 + 面积平均缩放（保留透明度） */
function cropAndScale(img, box, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(box.w, box.h));
  const outW = Math.max(1, Math.round(box.w * scale));
  const outH = Math.max(1, Math.round(box.h * scale));
  const out = Buffer.alloc(outW * outH * 4);
  const sx = box.w / outW;
  const sy = box.h / outH;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const x0 = Math.floor(box.x + x * sx);
      const x1 = Math.max(x0 + 1, Math.floor(box.x + (x + 1) * sx));
      const y0 = Math.floor(box.y + y * sy);
      const y1 = Math.max(y0 + 1, Math.floor(box.y + (y + 1) * sy));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          n += 1;
        }
      }
      const o2 = (y * outW + x) * 4;
      const aa = n ? a / n : 0;
      if (aa > 0.001) {
        out[o2] = Math.round(r / a);
        out[o2 + 1] = Math.round(g / a);
        out[o2 + 2] = Math.round(b / a);
      }
      out[o2 + 3] = Math.round(Math.min(1, aa) * 255);
    }
  }
  return { width: outW, height: outH, data: out };
}

/* ---------------- 碰撞形状（一组圆） ---------------- */

/**
 * 把轮廓拟合成一组圆（这就是碰撞体）：
 *   1. 缩到网格上算「每个格子到背景的距离」（chamfer 距离变换）
 *   2. 贪心铺圆：每次挑「还没被盖住、且离背景最远」的格子放一个圆，
 *      并且**限制这个圆超出轮廓的比例**（不然玩偶会提前撞到别的东西）
 *   3. 剩下的零碎区域用小圆补齐
 *   4. 剪掉「去掉也不影响覆盖」的冗余圆，零件越少物理越稳
 * 返回归一化坐标：中心为原点，单位是「外接框较长边 = 1」（游戏里按水果直径缩放）。
 */
function fitCircles(img, opts) {
  const grid = opts.grid || 72;
  const maxCircles = opts.maxCircles || 16;
  const minCoverage = opts.minCoverage == null ? 0.95 : opts.minCoverage;
  const maxOverhang = opts.maxOverhang == null ? 0.12 : opts.maxOverhang;
  const w = img.width;
  const h = img.height;
  const long = Math.max(w, h);
  const gw = Math.max(6, Math.round((w / long) * grid));
  const gh = Math.max(6, Math.round((h / long) * grid));
  const mask = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx * w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / gw));
      const y0 = Math.floor((gy * h) / gh);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / gh));
      let solid = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (img.data[(y * w + x) * 4 + 3] > 110) solid += 1;
          total += 1;
        }
      }
      mask[gy * gw + gx] = total && solid / total > 0.5 ? 1 : 0;
    }
  }
  let solidCount = 0;
  for (let i = 0; i < mask.length; i++) solidCount += mask[i];
  if (!solidCount) return { circles: [], coverage: 0, solidCount: 0 };

  // 距离变换：每个实心格到最近背景格的距离（单位：格）
  const INF = 1e6;
  const dist = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) dist[i] = mask[i] ? INF : 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) d = Math.min(d, dist[i - gw] + 1);
      if (x > 0 && y > 0) d = Math.min(d, dist[i - gw - 1] + 1.414);
      if (x < gw - 1 && y > 0) d = Math.min(d, dist[i - gw + 1] + 1.414);
      dist[i] = d;
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (x < gw - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < gh - 1) d = Math.min(d, dist[i + gw] + 1);
      if (x < gw - 1 && y < gh - 1) d = Math.min(d, dist[i + gw + 1] + 1.414);
      if (x > 0 && y < gh - 1) d = Math.min(d, dist[i + gw - 1] + 1.414);
      dist[i] = d;
    }
  }

  const cell = long / grid; // 一格多少像素
  const circles = [];

  function cellsInside(cx, cy, r, fn) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(gw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(gh - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) fn(y * gw + x, x, y);
      }
    }
  }

  /** 圆超出轮廓的面积占比（越界也算超出） */
  function overhang(cx, cy, r) {
    let total = 0;
    let out = 0;
    const steps = 10;
    for (let sy = 0; sy <= steps; sy++) {
      for (let sx = 0; sx <= steps; sx++) {
        const dx = (sx / steps) * 2 - 1;
        const dy = (sy / steps) * 2 - 1;
        if (dx * dx + dy * dy > 1) continue;
        total += 1;
        const x = Math.floor(cx + dx * r);
        const y = Math.floor(cy + dy * r);
        if (x < 0 || y < 0 || x >= gw || y >= gh || !mask[y * gw + x]) out += 1;
      }
    }
    return total ? out / total : 1;
  }

  const covered = new Uint8Array(gw * gh);
  let coveredSolid = 0;

  function place(cx, cy, r) {
    circles.push({ cx: cx, cy: cy, r: r });
    cellsInside(cx, cy, r, (i) => {
      if (mask[i] && !covered[i]) {
        covered[i] = 1;
        coveredSolid += 1;
      }
    });
  }

  // 第一步：贪心铺大圆（优先盖住「最粗」的地方）
  while (circles.length < maxCircles && coveredSolid / solidCount < minCoverage) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < gw * gh; i++) {
      if (!mask[i] || covered[i]) continue;
      if (dist[i] > bestScore) {
        bestScore = dist[i];
        best = i;
      }
    }
    if (best < 0) break;
    const bx = best % gw;
    const by = (best - bx) / gw;
    let r = Math.max(1.15, dist[best]);
    while (r > 1.15 && overhang(bx + 0.5, by + 0.5, r) > maxOverhang) r -= 0.35;
    place(bx + 0.5, by + 0.5, r);
  }

  // 第二步：把没盖到的小块补上（每块一个小圆，别让它溢出太多）
  for (let guard = 0; guard < maxCircles * 2 && coveredSolid / solidCount < 0.995; guard++) {
    let seed = -1;
    for (let i = 0; i < gw * gh; i++) {
      if (mask[i] && !covered[i]) {
        seed = i;
        break;
      }
    }
    if (seed < 0) break;
    // 从这块往外扩，量出它有多大
    const sx = seed % gw;
    const sy = (seed - sx) / gw;
    let r = 1.1;
    let grown = true;
    while (grown && r < 6) {
      grown = false;
      cellsInside(sx + 0.5, sy + 0.5, r + 0.5, (i) => {
        if (mask[i] && !covered[i]) grown = true;
      });
      if (grown) r += 0.5;
    }
    const rr = Math.max(1.1, Math.min(r, 3.2));
    const before = coveredSolid;
    place(sx + 0.5, sy + 0.5, rr);
    if (coveredSolid === before) {
      // 补不动了（半径太小或都盖过了），直接标记避免死循环
      covered[seed] = 1;
      coveredSolid += 1;
    }
  }

  // 第三步：剪掉冗余圆（拿掉它覆盖率几乎不掉的就不要了）
  for (let i = circles.length - 1; i >= 0 && circles.length > 4; i--) {
    const c = circles[i];
    let exclusive = 0;
    cellsInside(c.cx, c.cy, c.r, (idx) => {
      if (!mask[idx]) return;
      let onlyThis = true;
      for (let j = 0; j < circles.length; j++) {
        if (j === i) continue;
        const o = circles[j];
        if (Math.hypot(idx % gw + 0.5 - o.cx, ((idx - (idx % gw)) / gw) + 0.5 - o.cy) <= o.r) {
          onlyThis = false;
          break;
        }
      }
      if (onlyThis) exclusive += 1;
    });
    if (exclusive / solidCount < 0.004) circles.splice(i, 1);
  }

  // 覆盖率的最终核算（按格子重新算一遍）
  const finalCovered = new Uint8Array(gw * gh);
  let finalCount = 0;
  circles.forEach((c) => {
    cellsInside(c.cx, c.cy, c.r, (i) => {
      if (mask[i] && !finalCovered[i]) {
        finalCovered[i] = 1;
        finalCount += 1;
      }
    });
  });

  const out = circles.map((c) => ({
    x: (c.cx * (w / gw) - w / 2) / long,
    y: (c.cy * (h / gh) - h / 2) / long,
    r: (c.r * cell) / long
  }));
  return { circles: out, coverage: finalCount / solidCount, solidCount: solidCount, grid: { gw, gh } };
}

/**
 * 找「AI生成」水印的位置。
 *
 * 试过两种思路都不稳：灰块检测会被玩偶的浅色部位误判；半透明块检测会被轮廓抗锯齿边干扰。
 * 最后用**文字行特征**：水印永远是一行 4 个字（AI生成），
 *   浅灰、细长条（宽高比 2.4~9）、位于右下角一带。
 * 先标记「浅灰」像素，再做**横向膨胀**把字之间的空隙连起来，然后找连通块筛出这一行。
 */
function findWatermark(img, opts) {
  const { width: w, height: h, data } = img;
  const zoneX = Math.floor(w * (opts.watermarkZoneX == null ? 0.35 : opts.watermarkZoneX));
  const zoneY = Math.floor(h * (opts.watermarkZoneY == null ? 0.55 : opts.watermarkZoneY));
  const bridge = opts.watermarkBridge == null ? 6 : opts.watermarkBridge;

  const flags = new Uint8Array(w * h);
  for (let y = zoneY; y < h; y++) {
    for (let x = zoneX; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3];
      if (a < 24) continue;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min <= 42 && min >= 120 && max <= 252) flags[y * w + x] = 1;
    }
  }

  const dilated = new Uint8Array(w * h);
  for (let y = zoneY; y < h; y++) {
    for (let x = zoneX; x < w; x++) {
      let any = 0;
      for (let dx = -bridge; dx <= bridge && !any; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        if (flags[y * w + nx]) any = 1;
      }
      dilated[y * w + x] = any;
    }
  }

  const seen = new Uint8Array(w * h);
  const stack = [];
  const found = [];
  for (let y = zoneY; y < h; y++) {
    for (let x = zoneX; x < w; x++) {
      const p = y * w + x;
      if (!dilated[p] || seen[p]) continue;
      stack.length = 0;
      stack.push(p);
      seen[p] = 1;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let count = 0;
      while (stack.length) {
        const q = stack.pop();
        count += 1;
        const qx = q % w;
        const qy = (q - qx) / w;
        if (qx < minX) minX = qx;
        if (qy < minY) minY = qy;
        if (qx > maxX) maxX = qx;
        if (qy > maxY) maxY = qy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx;
            const ny = qy + dy;
            if (nx < zoneX || ny < zoneY || nx >= w || ny >= h) continue;
            const np = ny * w + nx;
            if (!dilated[np] || seen[np]) continue;
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
      found.push({ minX: minX, minY: minY, maxX: maxX, maxY: maxY, count: count });
    }
  }

  const pad = opts.watermarkPad == null ? 6 : opts.watermarkPad;
  const boxes = found
    .filter((b) => {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      const ratio = bw / Math.max(1, bh);
      if (b.count < 40) return false;
      if (ratio < 2.4 || ratio > 9) return false;
      if (bh > h * 0.09 || bw > w * 0.42) return false;
      if (b.minX < w * 0.55 || b.minY < h * 0.6) return false;
      return true;
    })
    .map((b) => {
      const x = Math.max(0, b.minX - pad);
      const y = Math.max(0, b.minY - pad);
      return {
        x: x,
        y: y,
        w: Math.min(w, b.maxX + pad + 1) - x,
        h: Math.min(h, b.maxY + pad + 1) - y,
        area: (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1),
        raw: b
      };
    });

  /*
   * 从候选里挑出真正的水印：
   * 「AI生成」角标是 ~3:1 的圆角横条，离右下角各留 ~50~60px，
   * 而且比玩偶身上的小灰块（阴影、缝线，只有二三十像素宽）大一个数量级。
   * 所以按「形状 + 贴角 + 面积最大」挑，**只清它一个** —— 别的小灰块是玩偶的细节，不能碰。
   */
  const badges = boxes.filter((b) => {
    const ratio = b.w / Math.max(1, b.h);
    if (ratio < 2.2 || ratio > 4.6) return false;
    if (b.w < w * 0.055) return false;
    if (b.area < 600) return false;
    if (w - (b.x + b.w) > w * 0.16) return false;
    if (h - (b.y + b.h) > h * 0.16) return false;
    return true;
  });
  if (badges.length) {
    badges.sort((a, b) => b.area - a.area);
    return [badges[0]];
  }

  /*
   * 兜底：这批图是同一批生成的，水印的相对位置和尺寸基本一致
   * （右留白 ~4.9% 宽 / 下留白 ~4.0% 高 / 尺寸 ~12.6% 宽 × 3.5% 高）。
   * 检测不出来时，就在这个默认位置放框 —— 但要先确认框里确实有「水印那种浅灰像素」，
   * 而且**不能有太多玩偶本体的深色像素**（避免在玩偶身上挖洞）。
   */
  const fx = opts.watermarkFallbackX == null ? 0.049 : opts.watermarkFallbackX;
  const fy = opts.watermarkFallbackY == null ? 0.04 : opts.watermarkFallbackY;
  const fw = opts.watermarkFallbackW == null ? 0.126 : opts.watermarkFallbackW;
  const fh = opts.watermarkFallbackH == null ? 0.035 : opts.watermarkFallbackH;
  const bw2 = Math.max(24, Math.round(w * fw));
  const bh2 = Math.max(12, Math.round(h * fh));
  const bx = Math.max(0, Math.round(w - w * fx - bw2));
  const by = Math.max(0, Math.round(h - h * fy - bh2));
  let gray = 0;
  let dark = 0;
  let total = 0;
  for (let y = by; y < Math.min(h, by + bh2); y++) {
    for (let x = bx; x < Math.min(w, bx + bw2); x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3];
      total += 1;
      if (a < 8) continue;
      const max = Math.max(data[o], data[o + 1], data[o + 2]);
      const min = Math.min(data[o], data[o + 1], data[o + 2]);
      if (max - min <= 42 && min >= 120) gray += 1;
      else if (min < 96 && a >= 250) dark += 1;
    }
  }
  if (gray >= 40 && dark <= total * 0.5) {
    return [{ x: bx, y: by, w: bw2, h: bh2, fallback: true, gray: gray, dark: dark }];
  }
  return [];
}

/**
 * 按找到的区域去掉水印。
 *
 * 关键点（踩过坑）：水印压在玩偶**深色部位**时，如果直接把这些像素抠成透明，
 * 深色鞋面上就会出现字形空洞 —— 看起来还是「AI生」。
 * 所以按「这个像素在玩偶内部还是轮廓边界」分开处理：
 *   · 框外正上/正下都是玩偶 → 在内部 → **用框外的颜色补上**（深色鞋底是纯色，补完看不出）
 *   · 否则 → 在边界/背景上 → 直接抠掉
 */
function removeWatermark(img, opts) {
  const boxes = findWatermark(img, opts);
  const { width: w, data } = img;
  if (!boxes.length) return { removed: 0, box: null, candidates: 0 };
  let removed = 0;
  let patched = 0;
  const used = [];

  const opaque = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= img.height) return false;
    return data[(y * w + x) * 4 + 3] >= 200;
  };

  boxes.forEach((b) => {
    used.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    const yUp = b.y - 1;
    const yDown = b.y + b.h;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const o = (y * w + x) * 4;
        const a = data[o + 3];
        if (a === 0) continue;
        const r = data[o];
        const g = data[o + 1];
        const bl = data[o + 2];
        const max = Math.max(r, g, bl);
        const min = Math.min(r, g, bl);
        const looksWatermark = a < 250 || (max - min <= 46 && min >= 96) || min >= 232;
        if (!looksWatermark) continue;

        // 判定「内部还是边界」：正上方和正下方（都在框外）都是玩偶 → 内部
        const insideDoll = opaque(x, yUp) && opaque(x, yDown);
        if (insideDoll) {
          const so = (yUp * w + x) * 4;
          data[o] = data[so];
          data[o + 1] = data[so + 1];
          data[o + 2] = data[so + 2];
          patched += 1;
        } else {
          data[o + 3] = 0;
          removed += 1;
        }
      }
    }
  });
  return { removed: removed, patched: patched, box: used[0], boxes: used, candidates: boxes.length };
}

function drawPreview(panels, outPath, opts) {
  const pad = 12;
  const labelH = 22;
  const cellW = Math.max.apply(
    null,
    panels.map((p) => p.img.width)
  );
  const cellH = Math.max.apply(
    null,
    panels.map((p) => p.img.height)
  );
  const W = pad + panels.length * (cellW + pad);
  const H = pad + labelH + cellH + pad;
  const out = Buffer.alloc(W * H * 4);
  // 深色背景
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = 22;
    out[i * 4 + 1] = 28;
    out[i * 4 + 2] = 38;
    out[i * 4 + 3] = 255;
  }
  panels.forEach((panel, idx) => {
    const ox = pad + idx * (cellW + pad);
    const oy = pad + labelH;
    const img = panel.img;
    // 棋盘格底（看透明度）
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const checker = ((x >> 3) + (y >> 3)) % 2 === 0 ? 44 : 58;
        const o = ((oy + y) * W + (ox + x)) * 4;
        out[o] = checker;
        out[o + 1] = checker + 4;
        out[o + 2] = checker + 10;
        out[o + 3] = 255;
      }
    }
    // 贴图
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const so = (y * img.width + x) * 4;
        const a = img.data[so + 3] / 255;
        if (a <= 0.002) continue;
        const o = ((oy + y) * W + (ox + x)) * 4;
        out[o] = Math.round(out[o] * (1 - a) + img.data[so] * a);
        out[o + 1] = Math.round(out[o + 1] * (1 - a) + img.data[so + 1] * a);
        out[o + 2] = Math.round(out[o + 2] * (1 - a) + img.data[so + 2] * a);
      }
    }
    // 叠加圆
    if (panel.circles && panel.circles.length) {
      const long = Math.max(img.width, img.height);
      panel.circles.forEach((c) => {
        const cx = ox + img.width / 2 + c.x * long;
        const cy = oy + img.height / 2 + c.y * long;
        const r = c.r * long;
        for (let y = Math.max(0, Math.floor(cy - r) - 1); y <= Math.min(H - 1, Math.ceil(cy + r) + 1); y++) {
          for (let x = Math.max(0, Math.floor(cx - r) - 1); x <= Math.min(W - 1, Math.ceil(cx + r) + 1); x++) {
            const d = Math.hypot(x - cx, y - cy);
            const o = (y * W + x) * 4;
            if (d > r) continue;
            if (d > r - 1.6) {
              out[o] = 255;
              out[o + 1] = 209;
              out[o + 2] = 102;
            } else {
              out[o] = Math.round(out[o] * 0.72 + 255 * 0.28);
              out[o + 1] = Math.round(out[o + 1] * 0.72 + 140 * 0.28);
              out[o + 2] = Math.round(out[o + 2] * 0.72 + 40 * 0.28);
            }
          }
        }
      });
    }
  });
  fs.writeFileSync(outPath, encodePng(W, H, out));
  return { width: W, height: H };
}

/* ---------------- 主流程 ---------------- */

function processFile(file, opts) {
  const raw = fs.readFileSync(file);
  const original = decodePng(raw);
  const img = { width: original.width, height: original.height, data: Buffer.from(original.data) };

  // 先去水印（在抠背景之前做：水印是半透明覆盖层，先摘掉它再去背景更干净）
  const wm = removeWatermark(img, opts);
  removeBackground(img, opts);
  const comp = cleanComponents(img, opts);
  const box = contentBox(img, opts.alphaThreshold);
  if (!box) throw new Error('抠完图什么都没剩下：' + file);

  const sized = cropAndScale(img, box, opts.size);
  // 抠图后按边长缩放到统一尺寸，再裁掉空白，保证碰撞形状与显示一致
  const box2 = contentBox(sized, 12) || { x: 0, y: 0, w: sized.width, h: sized.height };
  const tight = cropAndScale(sized, box2, opts.size);
  const shape = fitCircles(tight, opts);

  // 右下角放大图：专门用来核对「AI生成」水印有没有清干净
  const cw = Math.min(tight.width, Math.max(48, Math.round(tight.width * 0.42)));
  const chh = Math.min(tight.height, Math.max(32, Math.round(tight.height * 0.22)));
  const corner = scaleNearest(
    cropRegion(tight, tight.width - cw, tight.height - chh, cw, chh),
    Math.max(1.5, Math.min(4, 300 / cw))
  );

  return {
    original,
    cut: tight,
    corner: corner,
    box: box2,
    components: comp,
    shape,
    meta: {
      file: path.basename(file),
      bitDepth: original.bitDepth || 8,
      sourceSize: { w: original.width, h: original.height },
      cutSize: { w: tight.width, h: tight.height },
      circles: shape.circles.length,
      coverage: shape.coverage,
      components: comp.components,
      watermarkRemoved: comp.watermark,
      noiseRemoved: comp.noise,
      removedPixels: comp.removedPixels,
      watermarkPixels: wm.removed,
      watermarkBox: wm.box
    }
  };
}

function parseArgs(argv) {
  const opts = {
    size: 512,
    grid: 64,
    maxCircles: 18,
    out: path.join(__dirname, '..', '..', 'assets', 'library-bangdream', 'preview'),
    whiteTolerance: 232,
    minComponentRatio: 0.08,
    alphaThreshold: 24
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--size') opts.size = parseInt(argv[++i], 10);
    else if (a === '--max-circles') opts.maxCircles = parseInt(argv[++i], 10);
    else if (a === '--grid') opts.grid = parseInt(argv[++i], 10);
    else if (a === '--tol') opts.whiteTolerance = parseInt(argv[++i], 10);
    else if (!a.startsWith('--')) files.push(a);
  }
  return { opts, files };
}

if (require.main === module) {
  const { opts, files } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.log('用法：node tools/bangdream/prepare.cjs <图片路径…> [--out 目录] [--size 512] [--max-circles 18]');
    process.exit(1);
  }
  fs.mkdirSync(opts.out, { recursive: true });
  files.forEach((file) => {
    try {
      const r = processFile(file, opts);
      const base = path.basename(file).replace(/\.[^.]+$/, '');
      const cutPath = path.join(opts.out, base + '.cut.png');
      const prevPath = path.join(opts.out, base + '.preview.png');
      fs.writeFileSync(cutPath, encodePng(r.cut.width, r.cut.height, r.cut.data));
      const scale = Math.min(1, 360 / Math.max(r.original.width, r.original.height));
      const originalSmall = cropAndScale(
        { width: r.original.width, height: r.original.height, data: r.original.data },
        { x: 0, y: 0, w: r.original.width, h: r.original.height },
        Math.round(Math.max(r.original.width, r.original.height) * scale)
      );
      drawPreview(
        [
          { img: originalSmall, label: '原图' },
          { img: r.cut, label: '抠图' },
          { img: r.cut, circles: r.shape.circles, label: '碰撞体' },
          { img: r.corner, label: '右下角放大(查水印)' }
        ],
        prevPath
      );
      console.log(
        `${path.basename(file)}\n` +
          `   原始 ${r.meta.sourceSize.w}×${r.meta.sourceSize.h}（${r.meta.bitDepth}bit）→ 裁剪后 ${r.meta.cutSize.w}×${r.meta.cutSize.h}\n` +
          `   水印：清除 ${r.meta.watermarkPixels} 像素` + (r.meta.watermarkBox ? `（区域 ${r.meta.watermarkBox.w}×${r.meta.watermarkBox.h} @${r.meta.watermarkBox.x},${r.meta.watermarkBox.y}）` : `（未检出）`) + `\n` +
          `   连通块 ${r.meta.components} 个 · 删掉落单块 ${r.meta.watermarkRemoved + r.meta.noiseRemoved} 个 · 清掉 ${r.meta.removedPixels} 像素\n` +
          `   碰撞体 ${r.meta.circles} 个圆 · 覆盖率 ${(r.meta.coverage * 100).toFixed(1)}%\n` +
          `   预览：${prevPath}`
      );
    } catch (err) {
      console.error(`处理失败 ${path.basename(file)}：${err.message}`);
    }
  });
}

module.exports = { decodePng, encodePng, removeBackground, findWatermark, removeWatermark, cleanComponents, contentBox, cropAndScale, cropRegion, scaleNearest, fitCircles, processFile };
