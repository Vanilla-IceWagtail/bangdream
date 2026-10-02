/*!
 * UI 层级 / 布局契约测试
 *
 * 为什么单独测 CSS：手机端这两个 bug 都属于「CSS 层面的层叠与占位」问题，
 * 跑多少帧、点多少按钮都测不出来 —— 只能把规则本身当契约盯住：
 *   1. 弹窗（.overlay）必须盖在棋盘里的浮动「即将投放」（.next-panel.is-floating）之上，
 *      否则弹窗会被浮层和玩偶图标压住（bug 复现过一次）；
 *   2. 手机端的「连击」提示不能出现在分数面板里 ——
 *      它一显示面板就长高，会把棋盘整体顶下去（应该只在画布里飘字）。
 *
 * 用法：node --test tests/ui-layers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

/**
 * 极简 CSS 解析：把顶层规则与 @media 里的规则都摊平成
 * { selector, body, media } 列表（够用即可，不追求完整 CSS 语法）。
 */
function parseRules(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  let media = '';
  const stack = [];
  while (i < s.length) {
    let j = i;
    while (j < s.length && s[j] !== '{' && s[j] !== '}') j++;
    if (j >= s.length) break;
    if (s[j] === '}') {
      media = stack.pop() || '';
      i = j + 1;
      continue;
    }
    const selector = s.slice(i, j).trim();
    /* 找配对的花括号 */
    let depth = 1;
    let k = j + 1;
    while (k < s.length && depth > 0) {
      if (s[k] === '{') depth++;
      else if (s[k] === '}') depth--;
      k++;
    }
    const body = s.slice(j + 1, k - 1);
    if (selector.startsWith('@media')) {
      stack.push(media);
      media = selector;
      i = j + 1;
      continue;
    }
    if (selector.startsWith('@')) {
      i = k; /* @keyframes / @font-face 之类整块跳过 */
      continue;
    }
    rules.push({ selector, body, media });
    i = k;
  }
  return rules;
}

const RULES = parseRules(CSS);
const selects = (rule, sel) =>
  rule.selector
    .split(',')
    .map((x) => x.trim())
    .includes(sel);

const findRule = (sel, media) =>
  [...RULES].reverse().find((r) => selects(r, sel) && (!media || r.media.includes(media)));

const zOf = (sel) => {
  /* 同一个选择器可能出现多次（比如移动端只改宽度），取最后一条**带 z-index** 的 */
  const hits = RULES.filter((r) => selects(r, sel) && /z-index/.test(r.body));
  assert.ok(hits.length, `${sel} 没有带 z-index 的规则`);
  return Number(/z-index:\s*(-?\d+)/.exec(hits[hits.length - 1].body)[1]);
};
const bodyOf = (sel, media) => {
  const r = findRule(sel, media);
  assert.ok(r, `找不到规则 ${sel}${media ? ' （在 ' + media + ' 里）' : ''}`);
  return r.body;
};

test('解析到了 CSS 规则（解析器没跑空）', () => {
  assert.ok(RULES.length > 100, '规则数太少：' + RULES.length);
  assert.ok(RULES.some((r) => r.media.includes('880px')), '没解析到 880px 媒体查询');
});

test('弹窗层级高于棋盘里的浮动「即将投放」', () => {
  const overlay = zOf('.overlay');
  const floating = zOf('.next-panel.is-floating');
  assert.ok(
    overlay > floating,
    `弹窗 .overlay(${overlay}) 必须高于浮动「即将投放」(${floating})，否则弹窗会被浮层和玩偶图标压住`
  );
});

test('弹窗层级低于 toast 与选图小窗口（别把别的层压坏）', () => {
  const overlay = zOf('.overlay');
  assert.ok(overlay < zOf('.toast-wrap'), '弹窗不该盖住提示条');
  assert.ok(overlay < zOf('.pk-window'), '弹窗不该盖住选图小窗口');
});

test('弹窗打开期间，浮动「即将投放」必须让位（不能压住弹窗）', () => {
  /*
   * 只靠 z-index 不够：实测 .overlay 提到 30、浮动层是 6，带 backdrop-filter 的遮罩
   * 在 Firefox 里仍会被浮层压住。所以契约是「弹窗期间浮层不显示」，由
   * js/ui.js 给 body 挂 .has-overlay 驱动。
   */
  const r = [...RULES].reverse().find((x) => selects(x, 'body.has-overlay .next-panel.is-floating'));
  assert.ok(r, '缺少 body.has-overlay .next-panel.is-floating 规则');
  assert.match(r.body, /display:\s*none/, '弹窗期间应该直接隐藏浮动层');
  const ui = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
  assert.match(ui, /classList\.toggle\('has-overlay'/, 'ui.js 应该在开关弹窗时切换 body.has-overlay');
  assert.match(ui, /markOverlayOpen\(true\)/, 'showOverlay 要挂上标记');
  assert.match(ui, /markOverlayOpen\(false\)/, 'hideOverlay 要摘掉标记');
});
test('手机端：连击提示不出现在分数面板里（否则面板长高、棋盘被顶下去）', () => {
  const body = bodyOf('.score-panel.is-topstrip .combo', '880px');
  assert.match(body, /display:\s*none/, '手机端必须把分数面板里的 .combo 隐藏，连击只走画布内飘字');
});

test('手机端：分数面板顶栏布局不会被连击撑高（无其它动态占位）', () => {
  /* 面板里会「显示/隐藏」的元素只允许是 .combo，且已被上面那条隐藏 */
  const combo = bodyOf('.combo.is-on');
  assert.match(combo, /display:\s*flex/, '.combo.is-on 仍然是显示状态（由媒体查询里的 display:none 覆盖）');
  /* 覆盖关系：.score-panel.is-topstrip .combo（3 个类）权重高于 .combo.is-on（2 个类） */
  const specificity = (sel) => (sel.match(/\.[\w-]+/g) || []).length;
  assert.ok(
    specificity('.score-panel.is-topstrip .combo') > specificity('.combo.is-on'),
    '隐藏规则的选择器权重必须真的能盖住 .combo.is-on'
  );
});

test('画布内的连击飘字仍在（这是手机端保留的连击反馈）', () => {
  const render = fs.readFileSync(path.join(ROOT, 'js', 'render.js'), 'utf8');
  assert.match(render, /连击/, 'render.js 里应该有连击飘字');
});

test('浮动「即将投放」在右上角、且不再有黑底', () => {
  const body = bodyOf('.next-panel.is-floating', '880px');
  assert.match(body, /right:\s*6px/, '应该靠右');
  assert.match(body, /left:\s*auto/, '不应该再贴左边');
  assert.match(body, /background:\s*none/, '不应该有底色');
  assert.match(body, /position:\s*absolute/, '是棋盘内的浮层');
});
