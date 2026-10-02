/*!
 * 合成邦高祖！！！ · 单文件打包脚本
 *
 * 把 index.html + css/style.css + vendor/matter.min.js + js/*.js
 * 全部内联成一个可以直接双击、也可以直接发给别人的 HTML 文件。
 *
 * 用法（在这个目录下）：
 *   node tools/build-single.cjs
 * 产物：
 *   合成邦高祖！！！-单文件版.html
 *
 * 注意：单文件版里没有共享排行榜服务器，所以成绩只保存在本机；
 * 要多个人进同一张榜，仍然要用「启动游戏.cmd / 启动共享榜.cmd」那套（文件夹版）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, '合成邦高祖！！！-单文件版.html');

/** 内联进 <script> 的内容里如果出现 </script 会把标签提前闭合，转义掉（JS 里 <\/script 等价） */
function safeForScriptTag(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

function read(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error('缺少文件：' + rel);
  return fs.readFileSync(file, 'utf8');
}

function build() {
  let html = fs.readFileSync(SRC, 'utf8');
  const inlined = [];

  // 1) 样式表
  html = html.replace(/[ \t]*<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>\s*/i, (m, rawHref) => {
    const href = rawHref.split('?')[0]; // index.html 里带 ?v=版本号（缓存击穿），取路径时要剥掉
    const css = read(href);
    inlined.push(href);
    return '<style>\n/* ===== ' + href + ' ===== */\n' + css + '\n</style>\n';
  });

  // 2) 外部脚本（保持原顺序：matter → config → … → game）
  html = html.replace(/[ \t]*<script src="([^"]+)"><\/script>\s*/gi, (m, rawSrc) => {
    const src = rawSrc.split('?')[0]; // 同样剥掉 ?v=
    const js = read(src);
    inlined.push(src);
    return '<script>\n/* ===== ' + src + ' ===== */\n' + safeForScriptTag(js) + '\n</script>\n';
  });

  // 3) 打个标记，让页面知道自己跑在单文件版里（排行榜会说明「只在本机」）
  html = html.replace(
    /(<script>\s*\/\/ 启动阶段如果出错)/,
    '<script>\n      window.SUIKA_STANDALONE = true; // 单文件版标记（由 tools/build-single.cjs 注入）\n    </script>\n    $1'
  );

  // 4) 标题 + 生成时间
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  html = html.replace(/<title>[^<]*<\/title>/, '<title>合成邦高祖！！！ · 单文件版</title>');
  html = html.replace(
    /<!doctype html>/i,
    '<!doctype html>\n<!--\n  合成邦高祖！！！ · 单文件版（自动生成，请勿手改）\n' +
      '  生成时间：' +
      stamp +
      '\n  来源：' +
      inlined.join(' + ') +
      '\n  重新生成：node tools/build-single.cjs\n-->'
  );

  fs.writeFileSync(OUT, html, 'utf8');

  const size = fs.statSync(OUT).size;
  const left = [];
  if (/<script src=/i.test(html)) left.push('还有外部 script');
  if (/<link[^>]*stylesheet/i.test(html)) left.push('还有外部样式表');
  console.log('✅ 已生成：' + path.basename(OUT));
  console.log('   大小：' + (size / 1024).toFixed(0) + ' KB');
  console.log('   内联文件：' + inlined.join(', '));
  console.log(left.length ? '   ⚠️ ' + left.join('；') : '   自检：没有任何外部依赖 ✔');
  return OUT;
}

if (require.main === module) build();

module.exports = { build, OUT };
