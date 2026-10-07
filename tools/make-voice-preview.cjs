/*!
 * 生成「语音试听页」：voice-preview.html
 *
 *   node tools/make-voice-preview.cjs
 *
 * 试听页 = index.html + 两行额外脚本：
 *   1. window.SUIKA_AUDIO_BASE = 'assets/voice/'   （正式页读 assets/audio/，所以互不影响）
 *   2. 如果是 file:// 打开（直接双击），再加载 assets/voice-inline.js ——
 *      浏览器不允许 file:// 页面 fetch 本地文件，所以那种情况下用内联的 data URL 发声。
 *      走 http 打开时不加载那 9MB，按需取真实文件。
 *
 * 检验满意要整合时：把 js/config.js 里 AUDIO.base 改成 'assets/voice/' 即可。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'voice-preview.html');
const VOICE_BASE = process.argv[2] || 'assets/voice/';

let html = fs.readFileSync(SRC, 'utf8');

const inject = [
  '    <!--',
  '      语音试听页（由 tools/make-voice-preview.cjs 生成，别手改；改了 index.html 就重跑一次）。',
  '      和正式页的区别只有下面两段：语音目录指向 ' + VOICE_BASE + '，',
  '      以及双击打开（file://）时补上内联语音数据。',
  '    -->',
  '    <script>',
  "      window.SUIKA_AUDIO_BASE = '" + VOICE_BASE + "';",
  "      if (location.protocol === 'file:') {",
  "        document.write('<script src=\"assets/voice-inline.js\"><\\/script>');",
  '      }',
  '    </script>',
  ''
].join('\n');

/* 插在所有 <script src=…> 之前（config.js 会读 SUIKA_AUDIO_BASE 决定音频目录） */
const firstScript = html.indexOf('    <script src=');
if (firstScript < 0) {
  console.log('index.html 里找不到 <script src= …>，无法生成');
  process.exit(1);
}
html = html.slice(0, firstScript) + inject + html.slice(firstScript);

/* 标题与品牌名标注「试听版」，免得和正式页混淆 */
html = html
  .replace(/<title>([^<]*)<\/title>/, '<title>$1 · 语音试听版</title>')
  .replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/, '$1$2<span class="try-badge">语音试听版 · 语音来自「全音频」</span>$3');

html = html.replace(
  '</head>',
  ['  <style>', '    .try-badge { font-size: 13px; font-weight: 400; color: #9a7a68; margin-left: 10px; }', '  </style>', '</head>'].join('\n')
);

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 voice-preview.html');
console.log('  语音目录：' + VOICE_BASE + '（正式页仍是 assets/audio/）');
console.log('  资源版本引用：' + ((html.match(/\?v=/g) || []).length) + ' 处');
console.log('  打开方式一（推荐，双击即可）：直接双击 voice-preview.html');
console.log('  打开方式二（走服务器）：node server.cjs 然后 http://127.0.0.1:5173/voice-preview.html');
