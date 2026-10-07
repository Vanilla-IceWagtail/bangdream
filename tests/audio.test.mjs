/*!
 * 音频加载器测试（node --test）
 *
 *   node --test tests/audio.test.mjs
 *
 * 测的是真实行为：格式回退顺序、缺文件不报错、懒加载只取一次、
 * 每级合成音取对应文件、限流生效、切后台挂起/恢复。
 * 全用假的 fetch + 假的 AudioContext，不依赖任何真实音频文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const CFG = require(path.join(ROOT, 'js/config.js'));
const AUDIO = require(path.join(ROOT, 'js/audio.js'));

/** 假的音频上下文：只记「真的 start 了几次」 */
function makeFakeCtx() {
  const started = [];
  const ctx = {
    state: 'running',
    currentTime: 1,
    destination: {},
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start() {
          started.push(this.buffer && this.buffer.name);
        }
      };
    },
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    },
    decodeAudioData(buf) {
      return Promise.resolve({ name: 'decoded', bytes: buf && buf.byteLength });
    },
    suspend() {
      ctx.state = 'suspended';
      return Promise.resolve();
    },
    resume() {
      ctx.state = 'running';
      return Promise.resolve();
    }
  };
  ctx._started = started;
  return ctx;
}

/** 假的 fetch：按 `serve` 决定哪些文件存在（基名 -> 存在的扩展名数组） */
function makeFetch(serve, log) {
  return function (url) {
    log.push(url);
    const m = /([^/]+)\.([a-z0-9]+)$/i.exec(url);
    const base = m ? m[1] : url;
    const ext = m ? m[2].toLowerCase() : '';
    const ok = serve[base] && serve[base].indexOf(ext) >= 0;
    return Promise.resolve(
      ok
        ? { ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)) }
        : { ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }
    );
  };
}

/** 建一个加载器；返回时 AudioContext 已经装好 */
function makeLoader(serve) {
  const log = [];
  const ctx = makeFakeCtx();
  const realAC = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    return ctx;
  };
  const audio = AUDIO.create({ config: CFG, fetch: makeFetch(serve, log) });
  const restore = () => {
    globalThis.AudioContext = realAC;
  };
  return { audio, ctx, log, restore };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('没有 fetch（或浏览器不支持）时：所有音都退回合成音，不报错', async () => {
  const audio = AUDIO.create({ config: CFG, fetch: null });
  assert.equal(audio.play('drop'), false, '取不到文件时应返回 false，让调用方退回合成音');
  assert.equal(audio.isReady('drop'), false);
  assert.doesNotThrow(() => audio.preload(['drop', 'merge', 'warn']));
  assert.deepEqual(audio.stats().loaded, 0);
});

test('懒加载：第一次触发先用合成音，取到之后就走文件', async () => {
  const env = makeLoader({ 'drop-1': ['opus'], 'drop-2': ['opus'], 'drop-3': ['opus'] });
  try {
    assert.equal(env.audio.play('drop'), false, '第一次还没文件，应退回合成音');
    /* drop 有三个候选文件，会随机选；多试几次（每次都等一拍让它加载）直到命中 */
    let played = false;
    for (let i = 0; i < 40 && !played; i++) {
      played = env.audio.play('drop') === true;
      await tick();
    }
    assert.ok(played, '取到文件后应该能播文件音');
    assert.ok(env.ctx._started.length >= 1, '真的播了一次');
    /* 同一个文件不该反复请求（记住可用扩展名与已解码缓存） */
    const dropReqs = env.log.filter((u) => /drop-\d\.opus/.test(u));
    assert.equal(new Set(dropReqs).size, dropReqs.length, '同一个文件不该反复请求：' + dropReqs.join(', '));
  } finally {
    env.restore();
  }
});

test('preload：多候选文件会一起预热（drop-1/2/3 都会取）', async () => {
  const env = makeLoader({ 'drop-1': ['opus'], 'drop-2': ['opus'], 'drop-3': ['opus'] });
  try {
    env.audio.preload(['drop']);
    await tick();
    await tick();
    ['drop-1', 'drop-2', 'drop-3'].forEach((n) => {
      assert.ok(env.log.some((u) => u.indexOf('/' + n + '.') >= 0), '应该预热 ' + n + '：' + env.log.join(', '));
    });
  } finally {
    env.restore();
  }
});

test('格式回退：opus 缺失就用 m4a，并记住这个扩展名给后面的音用', async () => {
  /* 用单文件音效（ui-warn / ui-over）来测，避免 drop 那种多候选随机选中别的文件 */
  const env = makeLoader({ 'ui-warn': ['m4a'], 'ui-over': ['m4a'] });
  try {
    env.audio.play('warn');
    await tick();
    assert.equal(env.audio.stats().ext, 'm4a', '应该回退到 m4a');
    assert.ok(env.log[0].endsWith('ui-warn.opus'), '先试 opus：' + env.log[0]);
    assert.ok(env.log[1].endsWith('ui-warn.m4a'), '再试 m4a：' + env.log[1]);

    /* 下一个音应该直接用记住的 m4a，不再白试一次 opus */
    env.log.length = 0;
    env.audio.play('over');
    await tick();
    assert.equal(env.log.length, 1, '只该请求一次，实际 ' + env.log.join(', '));
    assert.ok(env.log[0].endsWith('ui-over.m4a'), '应直接用 m4a：' + env.log[0]);
  } finally {
    env.restore();
  }
});

test('三种格式都没有：标记缺失，之后不再反复请求', async () => {
  const env = makeLoader({});
  try {
    assert.equal(env.audio.play('over'), false);
    await tick();
    const afterFirst = env.log.length;
    assert.ok(afterFirst >= 3, '应该把 opus/m4a/mp3 都试过，实际 ' + afterFirst + ' 次');
    assert.equal(env.audio.stats().absent >= 1, true, '应记进「缺失」');
    env.audio.play('over');
    env.audio.play('over');
    await tick();
    assert.equal(env.log.length, afterFirst, '确定缺失之后不该再请求（别刷 404）');
    assert.equal(env.audio.isReady('over'), false);
  } finally {
    env.restore();
  }
});

test('每级一个合成音：merge 会去取 merge-<级别>', async () => {
  const env = makeLoader({ 'merge-7-1': ['opus'], 'merge-7-2': ['opus'] });
  try {
    env.audio.play('merge', { tier: 7 });
    await tick();
    assert.ok(env.log.some((u) => /merge-7-[12]\./.test(u)), '应该按多变体命名请求 merge-7-1/2：' + env.log.join(', '));
    assert.equal(env.audio.isReady('merge', 7), true, '有语音的级别应该就绪');
    assert.equal(env.audio.isReady('merge', 8), false, '没放的级别不该被认为就绪');
  } finally {
    env.restore();
  }
});

test('限流：同一个音太密时不会再叠着播（但算「已处理」，不退回合成音）', async () => {
  const env = makeLoader({ 'ui-warn': ['opus'] });
  try {
    env.audio.play('warn');
    await tick();
    env.ctx._started.length = 0;
    const now = env.ctx.currentTime;
    assert.equal(env.audio.play('warn'), true, '有文件时算已处理');
    assert.equal(env.audio.play('warn'), true, '紧接着再来一次也算已处理');
    env.ctx.currentTime = now; // 时间没走，限流应该挡住第二次
    env.audio.play('warn');
    assert.equal(env.ctx._started.length, 1, '并行/连击时不该叠着播，实际播了 ' + env.ctx._started.length + ' 次');

    /* 时间往前走：限流放行 */
    env.ctx.currentTime += 1; // 1000ms
    env.audio.play('warn');
    assert.equal(env.ctx._started.length, 2, '过了最短间隔应该能再播');
  } finally {
    env.restore();
  }
});

test('解锁 / 挂起 / 恢复：切后台省电靠这三个', async () => {
  const env = makeLoader({ 'drop-1': ['opus'] });
  try {
    assert.equal(env.audio.unlock(), true, 'unlock 应创建音频上下文');
    assert.equal(env.ctx.state, 'running');
    env.audio.suspend();
    assert.equal(env.ctx.state, 'suspended', '切后台应挂起');
    env.audio.resume();
    assert.equal(env.ctx.state, 'running', '切回来应恢复');
    assert.equal(typeof env.audio.context(), 'object');
  } finally {
    env.restore();
  }
});

test('配置齐全性：清单里的命名规则与加载器一致（防止改了 config 忘了改加载器）', () => {
  assert.ok(CFG.AUDIO, 'config 里应该有 AUDIO 配置');
  assert.ok(Array.isArray(CFG.AUDIO.formats) && CFG.AUDIO.formats.length >= 1, '要给出格式回退顺序');
  assert.equal(CFG.AUDIO.formats[0], 'opus', '建议优先 opus（体积最小）');
  assert.ok(CFG.AUDIO.base && CFG.AUDIO.base.endsWith('/'), 'base 要以 / 结尾，拼 URL 才不会错');
  const s = CFG.AUDIO.sounds;
  assert.ok(s.merge && s.merge.perTier, 'merge 应该是「每级一个」');
  assert.equal(s.merge.pattern, 'merge-{tier}');
  assert.ok(Array.isArray(s.drop.files) && s.drop.files.length >= 1, 'drop 至少要有一个文件名');
  ['combo', 'warn', 'over', 'click', 'mergeBig'].forEach((k) => {
    assert.ok(s[k], '缺少音效：' + k);
  });
  /* 每个音的 volume 都在 0~1 之间 */
  Object.keys(s).forEach((k) => {
    if (s[k].volume != null) assert.ok(s[k].volume > 0 && s[k].volume <= 1, k + ' 的 volume 应在 0~1');
  });
});

test('index.html 真的加载了 audio.js（且排在 config 之后）', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const iCfg = html.indexOf('js/config.js');
  const iAudio = html.indexOf('js/audio.js');
  const iGame = html.indexOf('js/game.js');
  assert.ok(iAudio > 0, 'index.html 应加载 js/audio.js');
  assert.ok(iCfg >= 0 && iAudio > iCfg, 'audio.js 要在 config.js 之后');
  assert.ok(iGame > iAudio, 'game.js 要在 audio.js 之后（它要用 SuikaAudio）');
});

test('多变体命名：variants=2 时按 drop-<级>-1 / -2 取（语音导入用的就是这套）', async () => {
  const env = makeLoader({ 'drop-3-1': ['mp3'], 'drop-3-2': ['mp3'] });
  try {
    env.audio.preload(['drop']);
    await tick();
    await tick();
    assert.ok(env.log.some((u) => /drop-1-1\./.test(u)), '应该按新命名取 drop-1-1：' + env.log.join(', '));
    assert.ok(env.log.some((u) => /drop-1-2\./.test(u)), '应该按新命名取 drop-1-2');
    let played = false;
    for (let i = 0; i < 30 && !played; i++) {
      played = env.audio.play('drop', { tier: 3 }) === true;
      await tick();
    }
    assert.ok(played, '有语音的级别应该能放出语音');
  } finally {
    env.restore();
  }
});

test('名场面（scene）也是一级一个：scene-<级>', async () => {
  const env = makeLoader({ 'scene-11': ['mp3'] });
  try {
    env.audio.play('scene', { tier: 11 });
    await tick();
    assert.ok(env.log.some((u) => /scene-11\./.test(u)), '应该请求 scene-11（单变体不带后缀）：' + env.log.join(', '));
    assert.equal(env.audio.isReady('scene', 11), true);
    assert.equal(env.audio.isReady('scene', 5), false, '没配音的级别不算就绪（会退回合成音）');
  } finally {
    env.restore();
  }
});
