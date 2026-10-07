/*!
 * 一键升版本号（发布用）
 *
 * GitHub Pages 会给 css/js 加约 10 分钟缓存 —— 改完看不到新东西，多半就是它在作怪。
 * index.html 里的资源都带 ?v=版本号，所以每次发布只要把版本号升一格，
 * 浏览器就会重新拉取（缓存击穿）。
 *
 * 用法：node tools/bump-version.cjs 0.4.2
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const next = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.log('用法：node tools/bump-version.cjs <x.y.z>');
  process.exit(1);
}

const cfgPath = path.join(ROOT, 'js', 'config.js');
const cfg = fs.readFileSync(cfgPath, 'utf8');
const m = cfg.match(/var VERSION = '([^']+)'/);
if (!m) {
  console.log('在 js/config.js 里找不到 VERSION');
  process.exit(1);
}
const prev = m[1];
if (prev === next) {
  console.log('版本号已经是 ' + next + '，没改动');
} else {
  fs.writeFileSync(cfgPath, cfg.replace("var VERSION = '" + prev + "'", "var VERSION = '" + next + "'"), 'utf8');
  console.log('js/config.js: ' + prev + ' → ' + next);
}

/*
 * Service Worker 的缓存名也要跟着版本走：
 * 否则发版后浏览器还在用旧缓存，玩家看到的还是上一版页面。
 */
const swPath = path.join(ROOT, 'sw.js');
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  const swNext = sw.replace(/var CACHE_VERSION = '[^']+'/, "var CACHE_VERSION = 'v" + next + "'");
  if (swNext !== sw) {
    fs.writeFileSync(swPath, swNext, 'utf8');
    console.log('sw.js: 缓存版本 → ' + next);
  }
}

const htmlPath = path.join(ROOT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const before = html;
html = html.split('?v=' + prev).join('?v=' + next);
/* 兼容「还没加过版本号」的情况：给 css/js 补上 */
if (!html.includes('?v=' + next)) {
  html = html.replace(/href="(css\/[^"]+)"/g, 'href="$1?v=' + next + '"');
  html = html.replace(/src="((?:js|vendor)\/[^"]+)"/g, 'src="$1?v=' + next + '"');
}
if (html !== before) {
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('index.html: 资源版本号 → ' + next + '（' + (html.match(/\?v=/g) || []).length + ' 处）');
} else {
  console.log('index.html 无需改动');
}
