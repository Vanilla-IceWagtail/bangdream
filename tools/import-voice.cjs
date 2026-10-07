/*!
 * 语音导入（按「玩偶 ID」）
 *
 *   node tools/import-voice.cjs [音源目录] [输出目录]
 *   默认：音源 = 桌面\全音频，输出 = assets/voice/
 *
 * 为什么按 ID 而不是按等级：
 *   玩家可以在「选图小窗口」里把任意玩偶放到任意等级，所以语音必须跟着**玩偶**走。
 *   输出 assets/voice/<玩偶ID>/drop-1..N.mp3、merge-1..N.mp3，
 *   游戏里用 assets.idOf(等级) 查出「这一级现在是谁」，再随机播这个角色的一条。
 *
 * 挑词规则（可复现，同一个音源跑多少次结果都一样）
 *   释放 drop-N ：最短的、**成句**的台词（「？」「えっ」这种单字语气词不要）
 *   合成 merge-N：命中「开心/加油」关键词的短句
 *   —— 两个用途之间不会重复用同一句
 *
 * 音源里没有的角色直接跳过（游戏里自动退回合成音）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 图库清单：id / name 对应关系 */
require(path.join(ROOT, 'js', 'assets-builtin.js'));
const LIB = globalThis.SUIKA_IMAGE_LIBRARY;

const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(process.env.USERPROFILE || '', 'Desktop', '全音频');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'assets', 'voice');

const KEYS = {
  drop: ['行こう', 'いこう', 'いくよ', 'はい', 'よし', 'スタート', 'それ', 'がんば', '頑張', 'やる', 'きた', '来た', 'いざ'],
  merge: ['やった', 'すごい', '最高', '嬉しい', 'うれしい', '楽しい', 'ありがと', 'キラキラ', 'ドキドキ', '大好き', 'がんば', '頑張', 'できた', 'やる', '完璧']
};

const LIMITS = {
  perRole: 5, // 每个角色每个用途几条（随机播的池子大小）
  dropMaxBytes: 32 * 1024,
  mergeMaxBytes: 44 * 1024,
  minTextLen: 6, // 至少要是 6 个字的成句
  hardMaxBytes: 80 * 1024 // 再长就不要了（当音效太拖、也占内存）
};

const clean = (name) => !/\(\d+\)/.test(name) && name.length <= 40;
const score = (text, keys) => keys.reduce((n, k) => n + (text.indexOf(k) >= 0 ? 1 : 0), 0);
const bySizeAsc = (a, b) => a.bytes - b.bytes || a.text.localeCompare(b.text);

function listVoices(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.mp3$/i.test(f) && clean(f))
    .map((f) => ({ file: f, text: f.replace(/\.mp3$/i, ''), bytes: fs.statSync(path.join(dir, f)).size }))
    .filter((v) => v.bytes <= LIMITS.hardMaxBytes && v.text.length >= LIMITS.minTextLen);
}

function pick(list, role, taken, n) {
  const keys = KEYS[role];
  const max = role === 'drop' ? LIMITS.dropMaxBytes : LIMITS.mergeMaxBytes;
  return list
    .filter((v) => v.bytes <= max && !taken.has(v.text))
    .map((v) => ({ v, s: score(v.text, keys) }))
    .sort((a, b) => b.s - a.s || bySizeAsc(a.v, b.v))
    .slice(0, n)
    .map((x) => x.v);
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('找不到音源目录：' + SRC);
    process.exit(1);
  }
  if (!LIB || !LIB.images) {
    console.log('读不到图库清单 js/assets-builtin.js');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  /* 清掉上一版按等级命名留下的文件，免得新旧混在一起 */
  fs.readdirSync(OUT).forEach((f) => {
    if (/^(drop|merge|scene)-\d/.test(f)) {
      fs.rmSync(path.join(OUT, f), { force: true });
      console.log('  （清掉旧命名文件：' + f + '）');
    }
  });

  const folders = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const manifest = { source: SRC, perRole: LIMITS.perRole, items: [], missing: [], totalBytes: 0, files: 0 };
  const lines = [
    '# 语音台词清单（按玩偶 ID）',
    '',
    '音源：`' + SRC + '`',
    '',
    '> 文件名就是台词。想换某一句，直接替换 `assets/voice/<玩偶ID>/` 里对应文件即可（保持文件名不变）。',
    '> 每个角色每个用途 ' + LIMITS.perRole + ' 条，游戏里**随机播一条**。',
    ''
  ];

  LIB.images.forEach((img) => {
    const row = { id: img.id, name: img.name, group: img.group, files: [] };
    const dir = path.join(SRC, img.name);
    if (!folders.includes(img.name) || !fs.existsSync(dir)) {
      manifest.missing.push({ id: img.id, name: img.name });
      manifest.items.push(row);
      return;
    }
    const all = listVoices(dir);
    const taken = new Set();
    const drops = pick(all, 'drop', taken, LIMITS.perRole);
    drops.forEach((v) => taken.add(v.text));
    const merges = pick(all, 'merge', taken, LIMITS.perRole);
    merges.forEach((v) => taken.add(v.text));

    const outDir = path.join(OUT, img.id);
    fs.mkdirSync(outDir, { recursive: true });
    lines.push('## ' + img.name + '（`' + img.id + '`）', '');
    lines.push('| 输出文件 | 用途 | 台词 | 大小 |', '| --- | --- | --- | --- |');
    const copy = (v, role, i) => {
      const outName = role + '-' + (i + 1) + '.mp3';
      fs.copyFileSync(path.join(dir, v.file), path.join(outDir, outName));
      manifest.totalBytes += v.bytes;
      manifest.files += 1;
      row.files.push({ out: img.id + '/' + outName, role, text: v.text, bytes: v.bytes });
      lines.push(
        '| `' + img.id + '/' + outName + '` | ' + (role === 'drop' ? '释放' : '合成') + ' | ' + v.text.replace(/\|/g, '｜') + ' | ' + (v.bytes / 1024).toFixed(1) + ' KB |'
      );
    };
    drops.forEach((v, i) => copy(v, 'drop', i));
    merges.forEach((v, i) => copy(v, 'merge', i));
    if (!row.files.length) lines.push('| （没挑到合适的） | —— | —— | —— |');
    lines.push('');
    manifest.items.push(row);
  });

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, '台词清单.md'), lines.join('\n') + '\n', 'utf8');

  const done = manifest.items.filter((i) => i.files.length);
  const missingNames = manifest.missing.map((m) => m.name).filter((v, i, a) => a.indexOf(v) === i);
  console.log('音源：' + SRC);
  console.log('输出：' + OUT);
  console.log('  配到语音的玩偶：' + done.length + ' / ' + LIB.images.length);
  console.log('  语音文件：' + manifest.files + ' 个，合计 ' + (manifest.totalBytes / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  每个角色 ' + LIMITS.perRole + ' 条释放 + ' + LIMITS.perRole + ' 条合成，游戏内随机播一条');
  console.log('  没配到语音的（退回合成音）：' + missingNames.join('、'));
  console.log('  清单：assets/voice/台词清单.md');
}

main();
