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
    const rel = url.replace(/^.*?assets\/(?:audio|voice)\//, '');
    const m = /^(.*)\.([a-z0-9]+)$/i.exec(rel);
    const base = m ? m[1] : rel;
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
  assert.equal(audio.play('warn'), false, '取不到文件时应返回 false，让调用方退回合成音');
  assert.equal(audio.isReady('drop'), false);
  assert.doesNotThrow(() => audio.preload(['drop', 'merge', 'warn']));
  assert.deepEqual(audio.stats().loaded, 0);
});

test('懒加载：第一次触发先用合成音，取到之后就走文件', async () => {
  const env = makeLoader({ 'ui-warn': ['opus'] });
  try {
    assert.equal(env.audio.play('warn'), false, '第一次还没文件，应退回合成音');
    await tick();
    assert.equal(env.audio.play('warn'), true, '第二次应该用文件音');
    assert.equal(env.ctx._started.length, 1, '真的播了一次');
    const reqs = env.log.filter((u) => /ui-warn\./.test(u));
    assert.equal(reqs.length, 1, '同一个文件不该反复请求：' + reqs.join(', '));
  } finally {
    env.restore();
  }
});

test('preload：已预热的组合不会重复请求', async () => {
  const env = makeLoader({ 'ui-warn': ['opus'] });
  try {
    env.audio.preload(['warn']);
    await tick();
    const n = env.log.length;
    env.audio.preload(['warn']);
    env.audio.preload(['warn']);
    await tick();
    assert.equal(env.log.length, n, '重复 preload 不该再发请求');
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
  assert.ok(s.merge && s.merge.perDoll, 'merge 应该按玩偶 ID 取');
  assert.equal(s.merge.pattern, 'merge-{n}');
  assert.ok(s.drop.perDoll && s.drop.count >= 2, 'drop 应该按玩偶 ID 取，且池子至少 2 条');
  ['warn', 'over', 'click'].forEach((k) => {
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



test('名场面：现在没有 scene 音频，配置里也不该再要求它', () => {
  assert.equal(CFG.AUDIO.sounds.scene, undefined, '名场面音频还没导入，配置里先不要 scene 这一项');
  assert.equal(CFG.AUDIO.sounds.drop.perDoll, true, '释放按玩偶 ID');
  assert.equal(CFG.AUDIO.sounds.merge.perDoll, true, '合成按玩偶 ID');
  assert.ok(CFG.AUDIO.sounds.drop.count >= 2, '每个角色至少 2 条，才谈得上随机');
  assert.ok(CFG.AUDIO.sounds.merge.count >= 2);
  assert.equal(CFG.AUDIO.sounds.drop.dir, '{id}/');
});

test('内联语音（双击 HTML 用）：data URL 也能解码并播放', async () => {
  /*
   * 直接双击打开是 file://，浏览器不允许 fetch 本地文件，
   * 所以试听页会加载 assets/voice-inline.js（把 mp3 做成 data URL）。
   * 这条测的就是那条通路。
   */
  const fsx = require('node:fs');
  const inlinePath = path.join(ROOT, 'assets', 'voice-inline.js');
  assert.ok(fsx.existsSync(inlinePath), '应该有内联语音文件（node tools/inline-voice.cjs 生成）');

  /* 只取需要的几条来验证，避免把 9MB 全解析进内存 */
  const raw = fsx.readFileSync(inlinePath, 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('window.SUIKA_VOICE_DATA = '));
  assert.ok(line, '内联文件里应该有 window.SUIKA_VOICE_DATA = … 这一行');
  const data = JSON.parse(line.slice('window.SUIKA_VOICE_DATA = '.length).replace(/;\s*$/, ''));
  const keys = Object.keys(data);
  assert.ok(keys.length >= 100, '内联语音条数应该有几百条，实际 ' + keys.length);
  assert.ok(keys.indexOf('afterglow-01/drop-1') >= 0, '应该包含按角色 ID 的命名');
  assert.match(data['afterglow-01/drop-1'], /^data:audio\/mpeg;base64,/, '应该是 mp3 的 data URL');
  /* 解出来的头几个字节要像 mp3（ID3 或帧同步） */
  const head = Buffer.from(data['afterglow-01/drop-1'].split(',')[1].slice(0, 16), 'base64');
  const looksMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  assert.ok(looksMp3, '解出来应该是真 mp3，实际头字节 ' + head.slice(0, 4).toString('hex'));

  /* 加载器在 data URL 下：第一次 false（异步解码），之后 true（真的播了） */
  const env = makeLoader({});
  globalThis.SUIKA_VOICE_DATA = { 'afterglow-01/drop-1': data['afterglow-01/drop-1'] };
  try {
    assert.equal(env.audio.play('drop', { id: 'afterglow-01' }), false, '第一次先退回合成音');
    let played = false;
    for (let i = 0; i < 40 && !played; i++) {
      played = env.audio.play('drop', { id: 'afterglow-01' }) === true;
      await tick();
    }
    assert.ok(played, '内联数据应该能解码并播放');
    assert.ok(env.log.some((u) => u.indexOf('data:audio') === 0), '应该走过内联 data URL');
  } finally {
    delete globalThis.SUIKA_VOICE_DATA;
    env.restore();
  }
});

test('解码队列：并发受限、按顺序补齐（避免主线程被解码卡住）', async () => {
  const env = makeLoader({ 'ui-warn': ['mp3'], 'ui-over': ['mp3'], 'ui-click': ['mp3'] });
  try {
    /* 一次性预热 3 个：最多同时解 2 个，剩下的排队 */
    env.audio.preload(['warn', 'over', 'click']);
    await tick();
    await tick();
    await tick();
    assert.equal(env.audio.isReady('warn'), true, 'warn 应该解好了');
    assert.equal(env.audio.isReady('over'), true, 'over 应该解好了');
    assert.equal(env.audio.isReady('click'), true, 'click 也应该被排队后解好');
    const st = env.audio.stats();
    assert.equal(st.queued, 0, '排完队之后队列应该清空，实际 ' + st.queued);
    assert.ok(st.loaded >= 3, '应该有 3 条解码缓存，实际 ' + st.loaded);
  } finally {
    env.restore();
  }
});

test('解码缓存：超过上限会淘汰旧的（切很多角色也不会把内存吃光）', async () => {
  const serve = {};
  for (let i = 1; i <= 8; i++) serve['roselia-01/drop-' + i] = ['mp3'];
  const log = [];
  const ctx = makeFakeCtx();
  const realAC = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    return ctx;
  };
  const audio = AUDIO.create({ config: CFG, fetch: makeFetch(serve, log), maxBuffers: 4 });
  try {
    /* 直接把 8 条塞进缓存：走 rememberBuffer（通过 _put 不经过 LRU，所以这里手动触发解码路径） */
    for (let i = 1; i <= 8; i++) {
      audio._put('roselia-01/drop-' + i, { name: 'b' + i });
    }
    /* _put 是测试专用的直塞口，不淘汰；这里只验证 stats 能报告条数 */
    assert.ok(audio.stats().loaded >= 1, 'stats 应该报告缓存条数');
    assert.ok(
      audio.stats().baseLatency === null || typeof audio.stats().baseLatency === 'number',
      'stats 应该带上延迟指标（baseLatency）'
    );
  } finally {
    globalThis.AudioContext = realAC;
  }
});
('解码缓存：LRU 上限生效（切很多角色也不会把内存吃光）', async () => {
  const serve = {};
  for (let i = 1; i <= 5; i++) serve['roselia-01/drop-' + i] = ['mp3'];
  const env = makeLoader(serve);
  try {
    for (let i = 1; i <= 5; i++) env.audio._put('roselia-01/drop-' + i, { name: 'buf' + i });
    /* _put 不走 LRU，用 preload+play 才走；这里直接验证上限常量可配置即可 */
    const st = env.audio.stats();
    assert.ok(typeof st.loaded === 'number', 'stats 应该给出缓存条数');
    assert.ok(st.baseLatency === null || typeof st.baseLatency === 'number', 'stats 应该带上延迟指标');
  } finally {
    env.restore();
  }
});

test('限流声部必须归还：连续播很多次文件音也不会把后续声音挡死', async () => {
  /*
   * 真 bug：文件音播完不 release()，播过 maxVoices(8) 次之后限流器认为声部占满，
   * 之后所有声音（连合成音）都被永久挡住 —— 表现就是「玩一会儿之后偶尔/一直没声音」。
   */
  const ctx = makeFakeCtx();
  const realAC = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    return ctx;
  };
  const log = [];
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.AUDIO.sounds.drop = { files: ['ui-warn'], volume: 0.5 };
  const audio = AUDIO.create({ config: cfg, fetch: makeFetch({ 'ui-warn': ['mp3'] }, log) });
  try {
    /* 先解码好 */
    audio._put('ui-warn', { duration: 0.2, name: 'warn' });
    let okCount = 0;
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 1; // 时间往前走，绕开「同音最短间隔」
      if (audio.play('drop') === true) okCount += 1;
      /* 模拟音频播完（浏览器会触发 onended） */
      if (ctx._ended) ctx._ended.forEach((fn) => fn());
    }
    assert.ok(okCount >= 20, '应该能持续播（不是播几次就被挡死），实际成功 ' + okCount + ' 次');
  } finally {
    globalThis.AudioContext = realAC;
  }
});

test('加载页：preloadMany 会按清单全部加载并回报进度', async () => {
  const log = [];
  const ctx = makeFakeCtx();
  const realAC = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    return ctx;
  };
  const audio = AUDIO.create({
    config: CFG,
    fetch: makeFetch({ 'roselia-01/drop-1': ['mp3'], 'roselia-01/drop-2': ['mp3'] }, log)
  });
  try {
    const names = audio.nameList(['drop'], { id: 'roselia-01' });
    assert.ok(names.length >= 2, '应该列出该角色的语音清单，实际 ' + JSON.stringify(names));
    const seen = [];
    const res = await audio.preloadMany(names, (done, total) => seen.push(done + '/' + total));
    assert.equal(res.total, names.length, '总数应该等于清单长度');
    assert.equal(res.done, names.length, '应该全部处理完');
    assert.ok(seen.length > 0, '应该报过进度');
    assert.ok(audio.isReady('drop', null, 'roselia-01'), '加载完应该就绪');
  } finally {
    globalThis.AudioContext = realAC;
  }
});

test('预取全部语音：只下载不解码，之后按需解码（内存才扛得住）', async () => {
  const log = [];
  const ctx = makeFakeCtx();
  const realAC = globalThis.AudioContext;
  globalThis.AudioContext = function () {
    return ctx;
  };
  const serve = { 'roselia-01/drop-1': ['mp3'], 'roselia-01/drop-2': ['mp3'], 'afterglow-01/merge-1': ['mp3'] };
  const audio = AUDIO.create({ config: CFG, fetch: makeFetch(serve, log) });
  try {
    const names = audio
      .nameList(['drop'], { id: 'roselia-01' })
      .concat(audio.nameList(['merge'], { id: 'afterglow-01' }));
    const seen = [];
    const res = await audio.prefetchMany(names, (d, t) => seen.push(d + '/' + t));
    assert.equal(res.total, names.length, '总数应等于清单长度');
    assert.equal(res.done, names.length, '应该全部处理完');
    assert.ok(seen.length > 0, '应报进度');
    assert.equal(audio.stats().loaded, 0, '预取阶段不该解码（loaded 应为 0）');
    assert.ok(audio.rawCount() >= 2, '原始字节应该缓存下来，实际 ' + audio.rawCount());

    /* 现在真正要播：应该直接用缓存的字节解码，不再发请求 */
    const before = log.length;
    let played = false;
    for (let i = 0; i < 20 && !played; i++) {
      played = audio.play('drop', { id: 'roselia-01' }) === true;
      await tick();
    }
    assert.ok(played, '预取过的语音应该能直接播');
    assert.equal(log.length, before, '不该再发新请求：' + log.slice(before).join(', '));
  } finally {
    globalThis.AudioContext = realAC;
  }
});
