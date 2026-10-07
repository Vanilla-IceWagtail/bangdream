/*!
 * 把 assets/voice/ 里的语音内联成一份 JS（data URL）
 *
 *   node tools/inline-voice.cjs
 *
 * 为什么需要：直接双击 HTML（file://）时浏览器**不允许 fetch 本地文件**，
 * 所以语音会加载失败、听不到。内联成 data URL 之后，双击打开也能正常发音，
 * 不需要起本地服务器。生成物：assets/voice-inline.js
 *
 * 代价：base64 比 mp3 大 1/3（约 7MB → 约 9MB）。所以只给「语音试听页」用，
 * 正式页（走服务器）继续按需加载真实文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'assets', 'voice');
const OUT = path.join(ROOT, 'assets', 'voice-inline.js');

function walk(dir, prefix, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, prefix + e.name + '/', out);
      return;
    }
    if (!/\.(mp3|m4a|opus|ogg|wav)$/i.test(e.name)) return;
    const base = prefix + e.name.replace(/\.[a-z0-9]+$/i, '');
    const ext = /\.([a-z0-9]+)$/i.exec(e.name)[1].toLowerCase();
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : ext === 'opus' ? 'audio/ogg' : 'audio/' + ext;
    out[base] = 'data:' + mime + ';base64,' + fs.readFileSync(full).toString('base64');
  });
}

const map = {};
if (fs.existsSync(DIR)) walk(DIR, '', map);
const keys = Object.keys(map);
const bytes = keys.reduce((n, k) => n + map[k].length, 0);

const js = [
  '/*!',
  ' * 自动生成，别手改：node tools/inline-voice.cjs',
  ' *',
  ' * 把 assets/voice/ 里的语音内联成 data URL，这样**双击 HTML**（file://）也能发声，',
  ' * 不需要本地服务器（浏览器不允许 file:// 页面 fetch 本地文件）。',
  ' * 语音条数：' + keys.length + '，内联后体积：' + (bytes / 1024 / 1024).toFixed(2) + ' MB',
  ' */',
  'window.SUIKA_VOICE_DATA = ' + JSON.stringify(map) + ';',
  ''
].join('\n');

fs.writeFileSync(OUT, js, 'utf8');
console.log('已生成 ' + path.relative(ROOT, OUT));
console.log('  语音条数：' + keys.length);
console.log('  文件体积：' + (Buffer.byteLength(js) / 1024 / 1024).toFixed(2) + ' MB（base64 比 mp3 大约 1/3）');
console.log('  用法：语音试听页会加载它，双击即可发声；正式页不需要它');
