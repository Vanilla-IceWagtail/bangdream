/*!
 * 音频清单自查：assets/audio/ 里有哪些音、缺哪些、总体积多少
 *
 * 用法：node tools/audio-check.cjs
 *
 * 缺文件不算错误（游戏会退回 WebAudio 合成音），所以退出码始终是 0 ——
 * 但如果想做「音频必须齐」的发布检查，加 --strict 就会在缺文件时返回 1。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'js', 'config.js'));
const AUDIO = CFG.AUDIO || {};
/* 可以用 --base assets/voice 检查别的目录（临时试听页用的就是 assets/voice/） */
const baseArg = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const DIR = path.join(ROOT, baseArg || AUDIO.base || 'assets/audio/');
const FORMATS = AUDIO.formats || ['opus', 'm4a', 'mp3'];
const strict = process.argv.includes('--strict');

/** 期望的文件名（不含扩展名），规则与 js/audio.js 的 fileListFor 保持一致 */
function expectedNames() {
  const names = [];
  Object.keys(AUDIO.sounds || {}).forEach((key) => {
    const d = AUDIO.sounds[key];
    if (!d) return;
    if (d.perDoll) {
      /* 按玩偶 ID：assets/voice/<id>/drop-1..N.mp3，id 来自图库清单 */
      const cnt = Math.max(1, Number(d.count) || 1);
      const dir = d.dir || '{id}/';
      let ids = [];
      try {
        require(path.join(ROOT, 'js', 'assets-builtin.js'));
        ids = (globalThis.SUIKA_IMAGE_LIBRARY.images || []).map((i) => i.id);
      } catch (e) {
        ids = [];
      }
      ids.forEach((id) => {
        for (let n = 1; n <= cnt; n++) {
          names.push({ key, name: dir.replace('{id}', id) + String(d.pattern || key + '-{n}').replace('{n}', String(n)), optional: true });
        }
      });
      return;
    }
    if (d.perTier) {
      const pat = d.pattern || key + '-{tier}';
      const variants = Math.max(1, Number(d.variants) || 1);
      for (let tier = 1; tier <= CFG.RULES.maxTier; tier++) {
        if (variants === 1) names.push({ key, name: pat.replace('{tier}', String(tier)) });
        else for (let i = 1; i <= variants; i++) names.push({ key, name: pat.replace('{tier}', String(tier)) + '-' + i });
      }
      /* perTier 的通用回退候选（比如 drop-1/2/3）算可选项 */
      (d.files || []).forEach((f) => names.push({ key, name: f, optional: true }));
    } else {
      (d.files || []).forEach((f) => names.push({ key, name: f }));
    }
  });
  return names;
}

/* 顶层文件 + 子目录（按玩偶 ID 的语音就放在子目录里） */
const existing = [];
const byBase = new Map(); // 「相对路径去扩展名」-> [扩展名...]
let totalBytes = 0;
function collect(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.isDirectory()) {
      collect(path.join(dir, e.name), prefix + e.name + '/');
      return;
    }
    const m = /^(.+)\.([a-z0-9]+)$/i.exec(e.name);
    if (!m) return;
    const ext = m[2].toLowerCase();
    if (FORMATS.indexOf(ext) < 0) return; // manifest.json / 台词清单.md 之类不算音频
    const key = prefix + m[1];
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(ext);
    existing.push(prefix + e.name);
    totalBytes += fs.statSync(path.join(dir, e.name)).size;
  });
}
collect(DIR, '');

const want = expectedNames();
const have = [];
const missing = [];
const missingOptional = [];
want.forEach((w) => {
  const exts = byBase.get(w.name);
  if (exts && exts.length) have.push({ ...w, exts });
  else (w.optional ? missingOptional : missing).push(w);
});

const usedExts = new Set();
byBase.forEach((exts) => exts.forEach((e) => usedExts.add(e)));
const extra = [...byBase.keys()].filter((b) => !want.some((w) => w.name === b));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('音频目录：' + path.relative(ROOT, DIR));
console.log('  已有文件：' + existing.filter((f) => !/^readme\.md$/i.test(f)).length + ' 个，合计 ' + kb(totalBytes));
console.log('  清单需要：' + want.length + ' 个（' + have.length + ' 个已有，' + missing.length + ' 个缺）');
console.log('  用到的格式：' + (usedExts.size ? [...usedExts].join(', ') : '（还没有文件）'));
console.log('  查找顺序：' + FORMATS.join(' → '));

if (have.length) {
  console.log('\n已有：');
  have.forEach((h) => console.log('  ✔ ' + h.name + '  [' + h.exts.join(', ') + ']  ← ' + h.key));
}
if (missing.length) {
  console.log('\n还缺（缺的会自动用合成音，不影响玩）：');
  const byKey = {};
  missing.forEach((m) => {
    (byKey[m.key] = byKey[m.key] || []).push(m.name);
  });
  Object.keys(byKey).forEach((k) => console.log('  · ' + k + '：' + byKey[k].join(', ')));
}
if (extra.length) {
  console.log('\n目录里有、但清单没提到的（不会加载，确认下是不是命名写错了）：');
  extra.forEach((e) => console.log('  ? ' + e + '.' + byBase.get(e).join('/')));
}

/* 体积提醒 */
const LIMIT = 1.2 * 1024 * 1024;
if (totalBytes > LIMIT) {
  console.log('\n⚠ 音频合计 ' + kb(totalBytes) + '，超过建议上限 ' + kb(LIMIT) + '：手机上首次加载会偏慢，建议压到 64~96kbps。');
} else if (totalBytes > 0) {
  console.log('\n✔ 体积在建议范围内（' + kb(totalBytes) + ' / 建议 ≤ 1.2 MB）');
}

if (strict && missing.length) {
  console.log('\n--strict：有 ' + missing.length + ' 个音频缺失，返回 1');
  process.exit(1);
}
