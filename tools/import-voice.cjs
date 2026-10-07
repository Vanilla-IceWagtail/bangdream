/*!
 * 语音导入：把「全音频」里的角色台词挑出来，做成游戏要用的 3 类语音
 *
 *   node tools/import-voice.cjs [音源目录] [输出目录]
 *   默认：音源 ../全音频（桌面），输出 assets/voice/
 *
 * 挑词规则（可复现：同一个音源跑多少次结果都一样）
 *   drop-<级>-N   释放玩偶 → 选**最短**的几句（短促、当音效用不拖沓）
 *   merge-<级>-N  合成玩偶 → 选带「开心/加油」关键词的短句
 *   scene-<级>    「名场面」模式用 → 选带「名台词」关键词的中等长度句子
 *
 * 输出：
 *   assets/voice/drop-1-1.mp3 … merge-11-2.mp3 … scene-11.mp3
 *   assets/voice/manifest.json   机器可读：每级用了哪些台词
 *   assets/voice/台词清单.md     人可读：上面那些文件对应的原台词，方便替换
 *
 * 注意：不会改动音源目录，只复制需要的文件（几十个，几 MB）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'js', 'config.js'));

const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.env.USERPROFILE || '', 'Desktop', '全音频');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'assets', 'voice');

/* 关键词表：命中越多分越高 */
const KEYS = {
  drop: ['行こう', 'いこう', 'いくよ', 'はい', 'よし', 'スタート', 'それ', 'がんば', '頑張', 'やる', 'きた', '来た'],
  merge: ['やった', 'すごい', '最高', '嬉しい', 'うれしい', '楽しい', 'ありがと', 'キラキラ', 'ドキドキ', '大好き', 'がんば', '頑張', '行こう', 'いこう', 'できた', 'やる'],
  scene: ['キラキラドキドキ', 'ポピパ', '最高', 'ありがとう', 'みんな', '歌', 'ライブ', 'バンド', '大好き', '夢', '約束', '一緒', '未来', '輝']
};

const LIMITS = {
  dropMaxBytes: 30 * 1024, // 释放：只挑很短的
  dropMinTextLen: 6, // 释放：至少要是 6 个字的短句（「？」「えっ」这种不要）
  mergeMinBytes: 4 * 1024,
  mergeMaxBytes: 46 * 1024,
  sceneMinBytes: 30 * 1024, // 名场面：要有点「一句话」的长度
  sceneMaxBytes: 110 * 1024,
  hardMaxBytes: 160 * 1024, // 再长就不要了（当音效太拖）
  dropVariants: 2, // 每个角色每个用途几条
  mergeVariants: 2,
  sceneVariants: 1
};

const clean = (name) =>
  !/\(\d+\)/.test(name) && // 去掉 (1)(2) 这种重复文件
  !/^\s*$/.test(name) &&
  name.length <= 40; // 台词太长的不适合当音效（文件名就是台词）

function listVoices(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.mp3$/i.test(f) && clean(f))
    .map((f) => ({ file: f, text: f.replace(/\.mp3$/i, ''), bytes: fs.statSync(path.join(dir, f)).size }));
}

const score = (text, keys) => keys.reduce((n, k) => n + (text.indexOf(k) >= 0 ? 1 : 0), 0);

function pickDrop(list) {
  return (
    list
      /* 「？」「えっ」这种单字语气词当释放音太怪，要求是真正的短句 */
      .filter((v) => v.bytes <= LIMITS.dropMaxBytes && v.text.length >= 6)
      .map((v) => ({ v, s: score(v.text, KEYS.drop) }))
      .sort((a, b) => b.s - a.s || a.v.bytes - b.v.bytes || a.v.text.localeCompare(b.v.text))
      .slice(0, LIMITS.dropVariants)
      .map((x) => x.v)
  );
}

function pickMerge(list) {
  const pool = list.filter((v) => v.bytes >= LIMITS.mergeMinBytes && v.bytes <= LIMITS.mergeMaxBytes);
  return pool
    .map((v) => ({ v, s: score(v.text, KEYS.merge) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.v.bytes - b.v.bytes || a.v.text.localeCompare(b.v.text))
    .slice(0, LIMITS.mergeVariants)
    .map((x) => x.v);
}

function pickScene(list) {
  const pool = list.filter((v) => v.bytes >= LIMITS.sceneMinBytes && v.bytes <= LIMITS.sceneMaxBytes);
  return pool
    .map((v) => ({ v, s: score(v.text, KEYS.scene) }))
    .filter((x) => x.s >= 3) // 至少命中三个关键词才算「名场面」
    .sort((a, b) => b.s - a.s || b.v.bytes - a.v.bytes || a.v.text.localeCompare(b.v.text))
    .slice(0, LIMITS.sceneVariants)
    .map((x) => x.v);
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('找不到音源目录：' + SRC);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const tiers = CFG.TIERS.filter((t) => t.tier >= 1);
  const folders = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const manifest = { source: SRC, items: [], missing: [], totalBytes: 0 };
  const lines = ['# 语音台词清单', '', '音源：`' + SRC + '`', '', '> 文件名就是台词。想换某一句，直接替换 `assets/voice/` 里对应文件即可（保持文件名不变）。', ''];

  const seen = new Set(); // 同一个角色不要重复用同一句
  tiers.forEach((t) => {
    const name = t.name;
    const dir = path.join(SRC, name);
    const row = { tier: t.tier, name, files: [] };
    if (!folders.includes(name) || !fs.existsSync(dir)) {
      manifest.missing.push({ tier: t.tier, name });
      lines.push('## ' + t.tier + ' 级 · ' + name + '（**音源里没有这个角色**，该级退回合成音）', '');
      manifest.items.push(row);
      return;
    }
    const all = listVoices(dir);
    let drops = pickDrop(all).filter((v) => !seen.has(name + v.text));
    drops.forEach((v) => seen.add(name + v.text));
    let merges = pickMerge(all).filter((v) => !seen.has(name + v.text));
    merges.forEach((v) => seen.add(name + v.text));
    let scenes = pickScene(all).filter((v) => !seen.has(name + v.text));
    scenes.forEach((v) => seen.add(name + v.text));

    lines.push('## ' + t.tier + ' 级 · ' + name, '');
    lines.push('| 输出文件 | 用途 | 台词 | 大小 |', '| --- | --- | --- | --- |');

    const copy = (v, outName, role) => {
      fs.copyFileSync(path.join(dir, v.file), path.join(OUT, outName));
      const bytes = v.bytes;
      manifest.totalBytes += bytes;
      row.files.push({ out: outName, role, text: v.text, bytes });
      lines.push('| `' + outName + '` | ' + role + ' | ' + v.text.replace(/\|/g, '｜') + ' | ' + (bytes / 1024).toFixed(1) + ' KB |');
    };

    /*
     * 命名必须和 js/audio.js 的 fileListFor 完全一致：
     *   variants > 1 → drop-<级>-1.mp3 / drop-<级>-2.mp3 …
     *   variants = 1 → scene-<级>.mp3（不带 -1 后缀！）
     */
    const outName = (key, i, count) => key + '-' + t.tier + (count > 1 ? '-' + (i + 1) : '') + '.mp3';
    drops.forEach((v, i) => copy(v, outName('drop', i, drops.length), '释放'));
    merges.forEach((v, i) => copy(v, outName('merge', i, merges.length), '合成'));
    scenes.forEach((v, i) => copy(v, outName('scene', i, scenes.length), '名场面'));
    if (!row.files.length) lines.push('| （没挑到合适的） | —— | —— | —— |');
    lines.push('');
    manifest.items.push(row);
  });

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, '台词清单.md'), lines.join('\n') + '\n', 'utf8');

  /* 报告 */
  const done = manifest.items.filter((i) => i.files.length);
  console.log('音源：' + SRC);
  console.log('输出：' + OUT);
  console.log('  有语音的角色：' + done.length + ' / ' + tiers.length + ' 级');
  if (manifest.missing.length) {
    console.log('  音源里没有、会退回合成音的：');
    manifest.missing.forEach((m) => console.log('    · ' + m.tier + ' 级 ' + m.name));
  }
  done.forEach((i) => {
    const n = i.files.length;
    console.log('  ' + String(i.tier).padStart(2) + ' 级 ' + i.name.padEnd(6) + ' ' + n + ' 条语音：' + i.files.map((f) => f.out).join(' '));
  });
  console.log('  合计 ' + (manifest.totalBytes / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  清单：assets/voice/台词清单.md（想换台词直接替换同名文件）');
}

main();
