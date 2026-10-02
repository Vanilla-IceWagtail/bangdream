/*!
 * 合成邦多利皇帝 · 玩偶版：把 bangdream 的 45 张玩偶做成游戏图库
 *
 * 产出（都写到「玩偶版」新文件夹里，不动原版）：
 *   assets/dolls/img/<id>.png     384px 抠好的玩偶（透明底）
 *   assets/dolls/thumb/<id>.png    96px 缩略图（选图窗口里用，省流量）
 *   js/assets-builtin.js          图库清单：分组(乐队) / 名字 / 图片路径 / 碰撞形状 / 默认图
 *
 * 碰撞形状：把玩偶轮廓拟合成一组圆（归一化：中心为原点，单位 = 外接框较长边），
 * 游戏里按该级玩偶的直径缩放 —— 所以碰撞体积跟着玩偶实际大小走，而不是一个包住它的大球。
 *
 * 用法：node tools/bangdream/build-library.cjs <已转换的PNG目录> <输出根目录>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./prepare.cjs');

const SRC = process.argv[2];
const ROOT = process.argv[3];
if (!SRC || !ROOT) {
  console.log('用法：node tools/bangdream/build-library.cjs <PNG目录> <玩偶版根目录>');
  process.exit(1);
}

/* 乐队 → 稳定的英文 id（文件名用 ASCII，避免中文路径在 URL 里出问题） */
const GROUP_SLUG = {
  Afterglow: 'afterglow',
  'Ave Mujica': 'avemujica',
  'Ave Mujica（常服）': 'avemujica-casual',
  'Hallo Happy World': 'halloworld',
  'Mew Type': 'mewtype',
  'Mygo!!!!!': 'mygo',
  PastelPalettes: 'pastelpalettes',
  'Poppin‘Party': 'poppinparty',
  Roselia: 'roselia'
};

/* 乐队显示名（中文习惯叫法）+ 说明，用作选图窗口里的分组名 */
const GROUP_NAME = {
  afterglow: 'Afterglow',
  avemujica: 'Ave Mujica',
  'avemujica-casual': 'Ave Mujica（常服）',
  halloworld: 'Hello, Happy World!',
  mewtype: 'Mew Type',
  mygo: 'MyGO!!!!!',
  pastelpalettes: 'Pastel Palette',
  poppinparty: 'Poppin’Party',
  roselia: 'Roselia'
};

const GROUP_ORDER = [
  'poppinparty',
  'afterglow',
  'pastelpalettes',
  'roselia',
  'halloworld',
  'mygo',
  'avemujica',
  'avemujica-casual',
  'mewtype'
];

function main() {
  const imgDir = path.join(ROOT, 'assets', 'dolls', 'img');
  const thumbDir = path.join(ROOT, 'assets', 'dolls', 'thumb');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  const groups = [];
  const images = [];
  const report = [];

  for (const groupDir of fs.readdirSync(SRC).sort()) {
    const gp = path.join(SRC, groupDir);
    if (!fs.statSync(gp).isDirectory()) continue;
    const gid = GROUP_SLUG[groupDir] || groupDir.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    groups.push({ id: gid, name: GROUP_NAME[gid] || groupDir, desc: '' });

    const files = fs.readdirSync(gp).filter((f) => /\.png$/i.test(f)).sort();
    files.forEach((file, idx) => {
      const name = file.replace(/\.png$/i, '');
      const id = gid + '-' + String(idx + 1).padStart(2, '0');

      const original = P.decodePng(fs.readFileSync(path.join(gp, file)));
      const img = { width: original.width, height: original.height, data: Buffer.from(original.data) };
      P.removeBackground(img, { whiteTolerance: 226 });
      P.cleanComponents(img, { minComponentRatio: 0.02 });
      const box = P.contentBox(img, 24);
      if (!box) throw new Error('抠图后为空：' + groupDir + '/' + file);

      // 统一到 384px 长边（最大玩偶 ⌀250，2 倍余量足够清晰），再裁紧一次
      const sized = P.cropAndScale(img, box, 384);
      const tightBox = P.contentBox(sized, 12) || { x: 0, y: 0, w: sized.width, h: sized.height };
      const cut = P.cropAndScale(sized, tightBox, 384);

      // 碰撞形状（用 384px 的图算，和游戏里显示的完全一致）
      const shape = P.fitCircles(cut, { grid: 72, maxCircles: 16, minCoverage: 0.95 });

      // 缩略图：长边 96px
      const thumb = P.cropAndScale(cut, { x: 0, y: 0, w: cut.width, h: cut.height }, 96);

      fs.writeFileSync(path.join(imgDir, id + '.png'), P.encodePng(cut.width, cut.height, cut.data));
      fs.writeFileSync(path.join(thumbDir, id + '.png'), P.encodePng(thumb.width, thumb.height, thumb.data));

      images.push({
        id: id,
        name: name,
        group: gid,
        w: cut.width,
        h: cut.height,
        src: 'assets/dolls/img/' + id + '.png',
        thumb: 'assets/dolls/thumb/' + id + '.png',
        note: '',
        /* 碰撞体：归一化圆组，游戏里 ×(该级直径) 使用 */
        shape: {
          long: 1,
          circles: shape.circles.map((c) => ({
            x: Number(c.x.toFixed(4)),
            y: Number(c.y.toFixed(4)),
            r: Number(c.r.toFixed(4))
          })),
          coverage: Number(shape.coverage.toFixed(3))
        }
      });

      report.push(
        `${gid.padEnd(18)} ${name.padEnd(6)} ${String(cut.width).padStart(3)}x${String(cut.height).padStart(3)}  碰撞圆 ${String(shape.circles.length).padStart(2)} 个  覆盖 ${(shape.coverage * 100).toFixed(1)}%`
      );
    });
  }

  report.forEach((r) => console.log('  ' + r));

  /* 默认图像：每组挑一个（按 GROUP_ORDER 取前 11 个） */
  const defaults = {};
  const pickedForDefault = [];
  for (const gid of GROUP_ORDER) {
    const first = images.find((i) => i.group === gid);
    if (first) pickedForDefault.push(first.id);
  }
  const fallback = images.map((i) => i.id);
  for (let tier = 1; tier <= 11; tier++) {
    defaults[tier] = pickedForDefault[tier - 1] || fallback[(tier - 1) % fallback.length];
  }

  /* 用户指定：最大的那一级（第 11 级 = 玩偶位）默认用 户山香澄（邦高祖） */
  const DEFAULT_OVERRIDES = { 11: 'poppinparty-03' };
  Object.keys(DEFAULT_OVERRIDES).forEach(function (tier) {
    if (images.some(function (i) { return i.id === DEFAULT_OVERRIDES[tier]; })) defaults[tier] = DEFAULT_OVERRIDES[tier];
  });
  const builtAt = new Date().toISOString();
  const fingerprint = require('crypto')
    .createHash('sha1')
    .update(images.map((i) => i.id + i.w + i.h + i.shape.circles.length).join('|'))
    .digest('hex')
    .slice(0, 16);

  const manifest = {
    version: 1,
    builtAt: builtAt,
    fingerprint: fingerprint,
    groups: groups,
    images: images,
    defaults: defaults
  };

  const outFile = path.join(ROOT, 'js', 'assets-builtin.js');
  const body =
    '/*!\n' +
    ' * 合成邦多利皇帝 · 玩偶版 内置图库（自动生成，勿手改）\n' +
    ' *\n' +
    ' * 来源：桌面 bangdream 文件夹（9 支乐队 × 5 位角色 = ' + images.length + ' 张玩偶）\n' +
    ' * 处理：JPEG→PNG、去白底、裁剪、缩放到 384px、按轮廓拟合碰撞圆\n' +
    ' * 生成时间：' + builtAt + ' · 指纹：' + fingerprint + '\n' +
    ' *\n' +
    ' * 每张图的 shape.circles 是归一化碰撞体（中心为原点，单位 = 外接框较长边），\n' +
    ' * 游戏里按该级玩偶直径缩放 —— 碰撞体积贴合玩偶轮廓，不是一个大球。\n' +
    ' */\n' +
    '(function (root) {\n' +
    "  'use strict';\n" +
    '  root.SUIKA_IMAGE_LIBRARY = ' + JSON.stringify(manifest, null, 2) + ';\n' +
    '})(typeof globalThis !== \'undefined\' ? globalThis : this);\n';

  fs.writeFileSync(outFile, body, 'utf8');

  const totalBytes = images.reduce(
    (n, i) => n + fs.statSync(path.join(ROOT, i.src)).size + fs.statSync(path.join(ROOT, i.thumb)).size,
    0
  );
  const avgCircles = images.reduce((n, i) => n + i.shape.circles.length, 0) / images.length;
  console.log('');
  console.log(`图库已生成：${images.length} 张 / ${groups.length} 组`);
  console.log(`平均碰撞圆 ${avgCircles.toFixed(1)} 个/张，图片合计 ${(totalBytes / 1048576).toFixed(1)} MB（含缩略图）`);
  console.log(`清单：${outFile}`);
  console.log(`指纹：${fingerprint}`);
}

if (require.main === module) main();
module.exports = { main, GROUP_SLUG, GROUP_NAME, GROUP_ORDER };
