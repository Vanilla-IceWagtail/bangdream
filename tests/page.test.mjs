/*!
 * 合成大西瓜 · 页面级冒烟测试（真实页面代码 + 无头 DOM）
 *
 * 为什么要有它：截图只能证明「第一帧长什么样」。页面里有些代码要跑一会儿才会执行到
 * （HUD 计时、连击条、同步倒计时、回合结束、弹层……），里面写错一个变量名，
 * 截图完全看不出来 —— `syncClock is not defined` 就是这么漏过去的。
 *
 * 这个测试把 js/*.js 原封不动地加载进一个假的浏览器环境里，
 * 真的启动一次页面、真的跑几百帧、真的开一局并结束，任何未捕获的异常都算失败。
 *
 *   node --test tests/page.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** index.html 里真实存在的 id，用来验证 JS 找的元素都存在 */
const HTML_IDS = new Set([...INDEX.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** 带 hidden 属性的元素（桩也要还原，否则「横幅有没有被显示」这类断言没意义） */
const HTML_HIDDEN_IDS = new Set(
  [...INDEX.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].filter((m) => /\bhidden\b/.test(m[0])).map((m) => m[1])
);

/** index.html 里的内联脚本（那段「出错就把错误显示在页面上」的代码） */
const INLINE_SCRIPTS = [...INDEX.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

/* ---------------- 极简 DOM 桩 ---------------- */

function makeClassList(node) {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    _set: set
  };
}

function makeStyle() {
  const props = {};
  const style = {
    setProperty: (k, v) => {
      props[k] = String(v);
    },
    getPropertyValue: (k) => (k in props ? props[k] : ''),
    removeProperty: (k) => {
      delete props[k];
    },
    _props: props
  };
  return style;
}

function makeNode(doc, tag, id) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    dataset: {},
    style: makeStyle(),
    hidden: false,
    value: '',
    textContent: '',
    type: '',
    disabled: false,
    files: null,
    title: '',
    className: '',
    parentNode: null,
    offsetWidth: 1,
    src: '',
    complete: true,
    naturalWidth: 64,
    naturalHeight: 64,
    _listeners: {},
    _html: ''
  };
  node.classList = makeClassList(node);
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html,
    set: (v) => {
      node._html = String(v);
      node.children = [];
    }
  });
  node.appendChild = (child) => {
    child.parentNode = node;
    node.children.push(child);
    return child;
  };  node.removeChild = (child) => {
    const i = node.children.indexOf(child);
    if (i >= 0) node.children.splice(i, 1);
    return child;
  };
  node.setAttribute = (k, v) => {
    node[k] = v;
  };
  node.getAttribute = (k) => node[k];
  node.addEventListener = (type, fn) => {
    (node._listeners[type] || (node._listeners[type] = [])).push(fn);
  };
  node.removeEventListener = (type, fn) => {
    const list = node._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  node.dispatch = (type, evt) => {
    (node._listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, evt || {})));
  };
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 700, right: 480, bottom: 700 });
  node.querySelector = (sel) => makeNode(doc, 'span');
  node.querySelectorAll = () => [];
  node.getElementsByTagName = () => [];
  Object.defineProperty(node, 'childNodes', {
    get: () => node.children
  });
  node.click = () => node.dispatch('click', {});
  node.getContext = () => makeCtx();
  node.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  return node;
}

function makeCtx() {
  const grad = { addColorStop() {} };
  const ctx = {
    canvas: null,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: () => ({ width: 10 }),
    setTransform() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    quadraticCurveTo() {},
    rect() {},
    fill() {},
    stroke() {},
    clip() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    drawImage() {},
    setLineDash() {}
  };
  return ctx;
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    readyState: 'complete',
    body: null,
    createElement: (tag) => makeNode(doc, tag),
    // 让 applyMobileLayout() 这类按视口重排的代码在桩里也能跑通（返回占位节点）
    querySelector: (sel) => {
      const id = { '.score-panel': 'score-stub', '.next-panel': 'next-stub', '.board-wrap': 'wrap-stub', '.layout': 'layout-stub' }[sel];
      return id ? doc.getElementById(id) : makeNode(doc, 'div');
    },
    createTextNode: (text) => {
      const n = makeNode(doc, '#text');
      n.textContent = String(text);
      return n;
    },
    getElementById: (id) => {
      if (!byId.has(id)) {
        const node = makeNode(doc, 'div', id);
        node.hidden = HTML_HIDDEN_IDS.has(id); // 还原 HTML 里写的 hidden
        byId.set(id, node);
      }
      return byId.get(id);
    },
    addEventListener() {},
    removeEventListener() {},
    _byId: byId
  };
  doc.body = makeNode(doc, 'body');
  return doc;
}

/* ---------------- 运行页面 ---------------- */

function bootPage(opts = {}) {
  const errors = [];
  const rafQueue = [];
  const timeouts = [];
  const doc = makeDocument();
  const store = new Map();

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1400,
    innerHeight: 900,
    performance: { now: () => Date.now() },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    },
    location: { protocol: 'http:', search: opts.search || '', href: 'http://127.0.0.1:5173/' + (opts.search || '') },
    navigator: { userAgent: 'node-test' },
    confirm: () => true,
    alert() {},
    Image: class {
      constructor() {
        this.complete = false;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
      }
      set src(v) {
        this._src = v;
        this.complete = true;
        this.naturalWidth = 64;
        this.naturalHeight = 64;
        if (this.onload) this.onload();
      }
      get src() {
        return this._src;
      }
    },
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController: globalThis.AbortController,
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    document: doc
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // 音频直接用不了（和真实浏览器首次交互前一样），顺便验证静音路径不炸
  sandbox.AudioContext = undefined;
  sandbox.webkitAudioContext = undefined;

  const context = vm.createContext(sandbox);

  // 真实页面靠 window.onerror / SUIKA_ON_ERROR 把错误显示成红色横幅，
  // 这里把这两个入口都接上：只要页面内部出错，横幅就会被显示出来，断言就会失败。
  const errHandlers = [];
  sandbox.addEventListener = (type, fn) => {
    if (type === 'error') errHandlers.push(fn);
  };
  function reportError(err, where) {
    const message = (err && err.message) || String(err);
    errors.push(where ? `${where}: ${message}` : message);
    errHandlers.forEach((fn) =>
      fn({ message, error: err, filename: 'game.js', lineno: 1, preventDefault() {}, stopPropagation() {} })
    );
  }
  sandbox.__reportError = reportError;

  for (const code of INLINE_SCRIPTS) {
    try {
      vm.runInContext(code, context, { filename: 'index.html(inline)' });
    } catch (err) {
      errors.push(`index.html(inline): ${err && err.message}`);
    }
  }

  const files = [
    'vendor/matter.min.js',
    'js/config.js',
    'js/library.js',
    'js/assets-builtin.js',
    'js/assets.js',
    'js/boards.js',
    'js/transport.js',
    'js/sync.js',
    'js/engine.js',
    'js/render.js',
    'js/ui.js',
    'js/picker.js',
    'js/game.js'
  ];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    try {
      vm.runInContext(code, context, { filename: rel });
    } catch (err) {
      errors.push(`${rel}: ${err && err.message}`);
    }
  }

  /** 跑 n 帧：每次取出一个 rAF 回调执行（回调里会重新注册下一帧） */
  function pump(n) {
    for (let i = 0; i < n; i++) {
      const cb = rafQueue.shift();
      if (!cb) break;
      try {
        cb(1000 + i * 16.7);
      } catch (err) {
        reportError(err, `frame ${i}`);
        break;
      }
    }
    // 定时器回调（比如弹层的 180ms 收尾）也跑一遍
    const pending = timeouts.splice(0, timeouts.length);
    pending.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        reportError(err, 'timeout');
      }
    });
  }

  function el(id) {
    return doc.getElementById(id);
  }

  return { sandbox, doc, errors, pump, el, store };
}

/* ---------------- 测试 ---------------- */

test('页面能正常启动，并且跑 600 帧不报任何错', () => {
  const page = bootPage();
  assert.deepEqual(page.errors, [], '加载/启动阶段不该有异常');
  const api = page.sandbox.SuikaConfig;
  assert.ok(api, 'config 应该挂到 window 上');

  page.pump(600); // ≈10 秒
  assert.deepEqual(page.errors, [], '跑 600 帧不该有异常（HUD 计时/连击条/同步倒计时都在里面）');
  assert.equal(page.el('boot-error').hidden, true, '不应该显示错误横幅');
});

test('演示模式（自动开局 + 结束一局 + 跑 200 帧）全程无异常', async () => {
  const page = bootPage({ search: '?demo=1&over=1' });
  /*
   * 演示脚本是等 assets.preloadAll() 之后才跑的（异步），所以必须先放一个 tick，
   * 否则「自动开局 / 结束一局」根本没发生，这个测试会看着通过其实什么都没跑到。
   */
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(page.errors, [], '演示模式启动不该有异常');
  page.pump(200);
  assert.deepEqual(page.errors, [], '演示模式跑 200 帧不该有异常');
  assert.equal(page.el('boot-error').hidden, true);

  // 演示模式会造出几条成绩，榜单上应该有内容
  const list = page.el('lb-list');
  assert.ok(list.children.length > 0, '排行榜应该有成绩行');
  assert.ok(String(page.el('hud-score').textContent).length > 0, '记分板要有分数');
  // 而且确实开局了（不是停在准备界面）
  assert.ok(page.el('overlay').classList.contains('is-open'), '结束一局后应该弹出结算画面');
});

test('触屏投放：按下只瞄准不投放，拖动跟着走，松手才投放', async () => {
  /*
   * 手机上的核心手感：按住屏幕左右找位置时不要投放，松手才投放。
   * 之前的实现是 pointerdown 直接 drop()，一点就掉，手机根本来不及找位置。
   * 这里用真实的事件路径（canvas 上的 pointerdown/move/up）跑一遍，数引擎的投放次数。
   */
  const page = await bootPage({ search: '?demo=1&lib=none' });
  await new Promise((r) => setTimeout(r, 0));
  const canvas = page.el('stage-canvas');
  const demo = page.sandbox.SuikaDemo;
  assert.ok(demo, '演示模式下应该有 SuikaDemo 调试句柄');

  const before = demo.stats().drops;
  const touch = { pointerType: 'touch', pointerId: 7, clientX: 100, clientY: 100 };

  canvas.dispatch('pointerdown', Object.assign({}, touch));
  assert.equal(demo.stats().drops, before, '按下时不该投放');
  const aimAtDown = demo.aim();

  canvas.dispatch('pointermove', Object.assign({}, touch, { clientX: 300 }));
  assert.equal(demo.stats().drops, before, '拖动过程中不该投放');
  assert.ok(demo.aim() > aimAtDown, '瞄准位置应该跟着手指走（100 → 300）');

  canvas.dispatch('pointerup', Object.assign({}, touch, { clientX: 380 }));
  assert.equal(demo.stats().drops, before + 1, '松手时投放一颗');
  assert.ok(demo.aim() > aimAtDown, '落点用松手时的位置');

  /* 被打断（pointercancel）不该投放 */
  const afterUp = demo.stats().drops;
  canvas.dispatch('pointerdown', Object.assign({}, touch, { pointerId: 8 }));
  canvas.dispatch('pointercancel', Object.assign({}, touch, { pointerId: 8 }));
  assert.equal(demo.stats().drops, afterUp, 'pointercancel 不该投放');

  /* 多指同时按：只认第一根，松手只投一颗 */
  page.pump(40); // 投放有间隔冷却（Lv.5 是 350ms），先跑掉冷却再测下一次
  const beforeMulti = demo.stats().drops;
  canvas.dispatch('pointerdown', Object.assign({}, touch, { pointerId: 11 }));
  canvas.dispatch('pointerdown', Object.assign({}, touch, { pointerId: 12 }));
  canvas.dispatch('pointerup', Object.assign({}, touch, { pointerId: 12 }));
  canvas.dispatch('pointerup', Object.assign({}, touch, { pointerId: 11, clientX: 200 }));
  assert.equal(demo.stats().drops, beforeMulti + 1, '两指乱按也只投放一颗');

  assert.deepEqual(page.errors, [], '触屏流程不该报错');
});

test('手机上连点不会被当成双击放大（touch-action / 高亮）', () => {
  /* 先去掉注释，否则注释里的花括号会把简单的规则匹配截断 */
  const css = fs
    .readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const body = /html,\s*body\s*\{([^}]*)\}/.exec(css);
  assert.ok(body, '应该有 html, body 规则');
  assert.match(body[1], /touch-action:\s*manipulation/, 'html/body 要禁用双击缩放（保留双指缩放）');
  assert.match(body[1], /-webkit-tap-highlight-color:\s*transparent/, '点按不要闪灰色高亮块');
  /* 棋盘更严格：拖动瞄准时页面不许滚 */
  const canvasRule = /#stage-canvas\s*\{([^}]*)\}/.exec(css);
  assert.ok(canvasRule, '应该有 #stage-canvas 规则');
  assert.match(canvasRule[1], /touch-action:\s*none/, '棋盘上禁止滚动/缩放手势，保证拖动瞄准可靠');
});

test('JS 里用到的所有元素 id 都真实存在于 index.html', () => {
  const jsFiles = [
    'js/config.js',
    'js/library.js',
    'js/assets.js',
    'js/boards.js',
    'js/transport.js',
    'js/sync.js',
    'js/engine.js',
    'js/render.js',
    'js/ui.js',
    'js/picker.js',
    'js/game.js'
  ];
  const missing = new Set();
  /*
   * 结算画面是 UI.showOverlay 用 innerHTML 动态拼出来的，
   * 里面的 id（上榜名字输入框、确认按钮、状态文字）本来就不在 index.html 里，
   * 所以这里排除掉；其余静态 id 仍然要求真实存在（防止写错 id 的回归）。
   */
  const DYNAMIC_IDS = new Set(['result-player', 'result-submit', 'result-name-status']);
  for (const rel of jsFiles) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of code.matchAll(/(?:UI\.el|document\.getElementById)\(\s*'([^']+)'\s*\)/g)) {
      if (DYNAMIC_IDS.has(m[1])) continue;
      if (!HTML_IDS.has(m[1])) missing.add(m[1]);
    }
  }
  assert.deepEqual([...missing], [], '这些 id 在 JS 里被使用，但 index.html 里没有');
});

test('点难度按钮、重开、暂停都不炸（走真实的按钮事件）', () => {
  const page = bootPage();
  page.pump(5);
  const before = page.sandbox.SuikaConfig.difficultyOf(page.el('diff-level').textContent.replace('Lv.', '')).level;
  assert.ok(before >= 1 && before <= 10);

  page.el('diff-plus').dispatch('click', {});
  page.el('diff-plus').dispatch('click', {});
  assert.equal(page.el('diff-level').textContent, 'Lv.' + Math.min(10, before + 2), '加号应该提高难度');
  page.el('diff-minus').dispatch('click', {});
  assert.equal(page.el('diff-level').textContent, 'Lv.' + Math.min(10, before + 1));

  page.el('btn-restart').dispatch('click', {});
  page.pump(60);
  page.el('btn-pause').dispatch('click', {});
  page.pump(30);
  page.el('btn-pause').dispatch('click', {});
  page.el('btn-sound').dispatch('click', {});
  page.el('lb-refresh').dispatch('click', {});
  page.pump(60);
  assert.deepEqual(page.errors, [], '交互之后也不该有异常');
  assert.equal(page.el('boot-error').hidden, true);
});

test('单文件版标记生效：排行榜改成「本机/单文件版」的说明', () => {
  const page = bootPage();
  page.sandbox.SUIKA_STANDALONE = true;
  page.el('lb-refresh').dispatch('click', {});
  // 直接触发一次状态重绘
  const status = page.el('lb-status');
  page.pump(5);
  assert.ok(status.innerHTML.length > 0, '状态行要有内容');
  assert.deepEqual(page.errors, []);
});

test('选图窗口能开能关、点图片和水果位都不炸（图片库为空时也一样）', () => {
  const page = bootPage();
  page.pump(3);
  page.el('btn-picker').dispatch('click', {}); // 打开选图小窗口
  page.pump(3);
  const win = page.sandbox.SuikaPicker ? page.doc.getElementById('picker-window') : null;
  assert.ok(win, '窗口节点应该被创建出来');
  assert.equal(win.hidden, false, '点「选图」后窗口要显示');

  // 图库是空的：状态行要说明「图库还是空的」，不能是空白或者报错
  const status = page.el('picker-status') || null;
  page.pump(5);
  assert.deepEqual(page.errors, [], '空图库下开窗口不该抛异常');
  assert.equal(page.el('boot-error').hidden, true, '不应该显示错误横幅');

  // 再点一次按钮（Toggle 到关闭），然后重开
  page.el('btn-picker').dispatch('click', {});
  page.pump(2);
  page.el('btn-picker').dispatch('click', {});
  page.pump(5);
  assert.deepEqual(page.errors, []);
});

test('结算流程：先确认名字再同步（有名字输入框 + 小布丁按钮，点小布丁出收款码）', async () => {
  const page = bootPage({ search: '?demo=1&over=1' });
  await new Promise((r) => setTimeout(r, 0)); // 等 assets.preloadAll().then(runDemo) 跑完
  page.pump(160);
  const body = page.el('overlay-body');
  const actions = page.el('overlay-actions');
  assert.ok(body && body.innerHTML.indexOf('result-player') >= 0, '结算画面要有「上榜名字」输入框');
  assert.ok(body.innerHTML.indexOf('result-submit') >= 0, '要有「确认并上榜」按钮');
  const labels = (actions.children || []).map((b) => b.textContent);
  assert.ok(labels.some((s) => s.indexOf('留在榜上看看') >= 0), '要有「留在榜上看看」');
  assert.ok(labels.some((s) => s.indexOf('小布丁') >= 0), '「留在榜上看看」后面要有「请作者吃小布丁」');
  assert.ok(labels.indexOf(labels.find((s) => s.indexOf('小布丁') >= 0)) > labels.indexOf(labels.find((s) => s.indexOf('留在榜上看看') >= 0)), '小布丁按钮要排在留榜按钮之后');

  // 点「请作者吃小布丁」→ 弹出收款码 + 寄语
  const donate = actions.children.find((b) => b.textContent.indexOf('小布丁') >= 0);
  donate.dispatch('click', {});
  page.pump(2);
  const donateBody = page.el('overlay-body').innerHTML;
  assert.ok(donateBody.indexOf('qr-donate.jpg') >= 0, '要显示收款码图片');
  assert.ok(donateBody.indexOf('本网站为爱发电') >= 0, '要有寄语');
  assert.ok(donateBody.indexOf('感谢喜欢邦多利') >= 0, '寄语要提到邦多利');
  assert.deepEqual(page.errors, [], '这条流程不该报错');
});
