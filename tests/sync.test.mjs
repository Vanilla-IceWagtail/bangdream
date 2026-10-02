/*!
 * 合成大西瓜 · 榜单同步测试（js/sync.js + js/transport.js）
 *
 * 三块：
 *   1. textdb 传输（做法 C 的默认通道）—— 假 fetch 验证「双重编码解包」「写入格式」「失败重试」；
 *   2. sync 编排 —— 缓存、待上传队列、自愈合并、双榜视图、30 分钟节奏、节流；
 *   3. 真集成 —— 用 'rest' 通道接真实的 server.cjs，确认自建服务器那条路也还是通的。
 *
 *   node --test tests/sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

// 必须在 require server.cjs 之前指定数据目录，别碰真实 data/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suika-sync-test-'));
process.env.SUIKA_DATA = TMP;

const SRV = require(path.join(ROOT, 'server.cjs'));
const SY = require(path.join(ROOT, 'js/sync.js'));
const B = require(path.join(ROOT, 'js/boards.js'));
const TR = require(path.join(ROOT, 'js/transport.js'));
const CFG = require(path.join(ROOT, 'js/config.js'));

const REFRESH_MS = CFG.BOARD_SYNC.refreshMs;

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
    _data: data
  };
}

const rec = (n, s, extra = {}) => Object.assign({ n, s, d: 5, m: 6, c: 2, t: 1000 }, extra);

/** 假的 textdb 服务：值和真实服务一样是「JSON 字符串」，读回来会双重编码 */
function fakeTextdb(initialDoc) {
  const state = { doc: initialDoc ? JSON.stringify(initialDoc) : '', puts: 0, gets: 0, failNext: 0 };
  const fetchImpl = (url, opts = {}) => {
    if (state.failNext > 0) {
      state.failNext -= 1;
      return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('') });
    }
    if ((opts.method || 'GET') === 'POST') {
      state.puts += 1;
      state.doc = String(opts.body);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(state.doc)) });
    }
    state.gets += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(state.doc ? JSON.stringify(state.doc) : '')
    });
  };
  return { state, fetchImpl };
}

/* ---------------- 传输层 ---------------- */

test('textdb 传输：读回来是「套了一层引号」的 JSON 也能解成文档', async () => {
  const doc = { v: 1, u: 5, top: [rec('甲', 500, { t: 9 })], live: [rec('甲', 500, { t: 9 })] };
  const fake = fakeTextdb(doc);
  const tr = TR.createTextdb({ endpoint: 'https://example.test/api/data/x', fetchImpl: fake.fetchImpl });
  const res = await tr.pull();
  assert.equal(res.ok, true);
  assert.equal(res.doc.top.length, 1);
  assert.equal(res.doc.top[0].s, 500);
});

test('textdb 传输：空内容当成空榜单，不会炸', async () => {
  const fake = fakeTextdb(null);
  const tr = TR.createTextdb({ endpoint: 'https://example.test/api/data/x', fetchImpl: fake.fetchImpl });
  const res = await tr.pull();
  assert.equal(res.ok, true);
  assert.deepEqual(res.doc.top, []);
});

test('textdb 传输：写入用 application/json，只写一份文档', async () => {
  const fake = fakeTextdb(null);
  const calls = [];
  const tr = TR.createTextdb({
    endpoint: 'https://example.test/api/data/x',
    fetchImpl: (url, opts) => {
      calls.push(opts);
      return fake.fetchImpl(url, opts);
    }
  });
  const doc = B.addScore(B.emptyDoc(), rec('甲', 123, { t: 7 }), 7);
  const res = await tr.push(doc);
  assert.equal(res.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(calls[0].body).top[0].s, 123);
});

test('textdb 传输：服务偶发 502 会自动重试一次', async () => {
  const fake = fakeTextdb(null);
  fake.state.failNext = 1;
  const tr = TR.createTextdb({ endpoint: 'https://example.test/api/data/x', fetchImpl: fake.fetchImpl });
  const res = await tr.pull();
  assert.equal(res.ok, true, '重试之后应该成功');
  assert.equal(fake.state.gets, 1);
});

test('transport.resolve：provider 名字决定用哪条通道，默认是全球榜', () => {
  assert.equal(TR.resolve('textdb', {}).name, 'textdb');
  assert.equal(TR.resolve('rest', {}).name, 'rest');
  assert.equal(TR.resolve('local', {}).name, 'local');
  assert.equal(TR.resolve(null, {}).name, 'textdb', '默认就是第三方 KV（全球榜）');
  assert.equal(CFG.BOARD_SYNC.provider, 'textdb');
  assert.ok(/^https:\/\//.test(CFG.BOARD_SYNC.textdb.endpoint), '默认榜单地址必须是 https');
});

test('rest 通道地址：http(s) 打开用同源 /api/scores，file:// 没有', () => {
  assert.equal(SY.resolveEndpoint({ path: '/api/scores' }, { protocol: 'http:' }), '/api/scores');
  assert.equal(SY.resolveEndpoint({ path: '/api/scores' }, { protocol: 'file:' }), null);
  assert.equal(SY.resolveEndpoint({ endpoint: 'https://x/api', path: '/api/scores' }, { protocol: 'file:' }), 'https://x/api');
});

/* ---------------- 同步编排 ---------------- */

test('半小时节奏：缓存没过期就用缓存，过期才算 stale', () => {
  const t0 = 1_000_000;
  assert.equal(SY.isStale(0, t0, REFRESH_MS), true);
  assert.equal(SY.isStale(t0, t0 + REFRESH_MS - 1, REFRESH_MS), false);
  assert.equal(SY.isStale(t0, t0 + REFRESH_MS, REFRESH_MS), true);
  assert.equal(SY.nextRefreshAt(t0, REFRESH_MS), t0 + REFRESH_MS);
  assert.equal(REFRESH_MS, 30 * 60 * 1000, '总榜刷新周期必须是 30 分钟');
});

test('提交：先本地可见（待确认），上传成功后变成正式成绩', async () => {
  const fake = fakeTextdb(null);
  const sync = SY.create({
    storage: fakeStorage(),
    transport: TR.createTextdb({ endpoint: 'https://example.test/x', fetchImpl: fake.fetchImpl })
  });

  const mine = rec('我', 777, { t: 100 });
  const p = sync.submit(mine);
  assert.equal(sync.view('live').length, 1, '本地立刻可见');
  assert.equal(sync.isPending(mine), true, '上传完成前算待确认');
  assert.equal(sync.pendingCount(), 1);

  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.rank, 1);
  assert.equal(sync.pendingCount(), 0, '上传成功后待上传队列清空');
  assert.equal(sync.isPending(mine), false);
  assert.equal(sync.view('top')[0].s, 777);
  assert.ok(fake.state.puts >= 1, '确实写到了远端');
  assert.equal(JSON.parse(fake.state.doc).top[0].n, '我');
});

test('提交失败：留在待上传队列里，恢复后补传成功', async () => {
  const fake = fakeTextdb(null);
  const storage = fakeStorage();
  const sync = SY.create({
    storage,
    transport: TR.createTextdb({ endpoint: 'https://example.test/x', fetchImpl: fake.fetchImpl }),
    pushTries: 1
  });

  fake.state.failNext = 99;
  const res = await sync.submit(rec('倒霉蛋', 300, { t: 11 }));
  assert.equal(res.ok, false);
  assert.equal(res.queued, true);
  assert.equal(sync.pendingCount(), 1, '成绩必须留在队列里');
  assert.equal(sync.info().status, 'error');

  const restarted = SY.create({
    storage,
    transport: TR.createTextdb({ endpoint: 'https://example.test/x', fetchImpl: fake.fetchImpl }),
    pushTries: 1
  });
  assert.equal(restarted.pendingCount(), 1, '队列要能从存储里恢复');

  fake.state.failNext = 0;
  const flushed = await restarted.flush();
  assert.equal(flushed.ok, true);
  assert.equal(restarted.pendingCount(), 0);
  assert.ok(JSON.parse(fake.state.doc).top.some((r) => r.n === '倒霉蛋'), '补传后真的在榜上');
});

test('自愈：远端被清空，本地带缓存的客户端读一次就把它修回来', async () => {
  const good = { v: 1, u: 10, top: [rec('老高手', 1234, { t: 1 })], live: [rec('老高手', 1234, { t: 1 })] };
  const fake = fakeTextdb(good);
  const a = SY.create({ storage: fakeStorage(), transport: TR.createTextdb({ endpoint: 'https://x/y', fetchImpl: fake.fetchImpl }) });
  await a.pull(true);
  assert.equal(a.view('top').length, 1);

  fake.state.doc = ''; // 有人把远端刷没了
  await a.pull(true);
  assert.equal(a.view('top').length, 1, '本地缓存兜住，界面不会突然空掉');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.state.doc.length > 0, '修复后的文档应该被写回远端');
  assert.equal(JSON.parse(fake.state.doc).top[0].n, '老高手', '远端被修回来了');
});

test('两个榜：live 是最近 20 次提交（按分数排），top 是历史全部（上限 100）', async () => {
  const fake = fakeTextdb(null);
  const sync = SY.create({
    storage: fakeStorage(),
    transport: TR.createTextdb({ endpoint: 'https://x/y', fetchImpl: fake.fetchImpl })
  });
  for (let i = 1; i <= 25; i++) await sync.submit(rec('P' + i, i * 10, { t: 1000 + i }));

  const live = sync.view('live');
  const top = sync.view('top');
  assert.equal(live.length, 20, '实时榜只显示最近 20 条');
  assert.equal(top.length, 25, '总榜保留全部（这里 25 条）');
  assert.equal(live[0].s, 250, '实时榜里分数最高的排最前');
  assert.equal(top[0].s, 250);
  assert.ok(
    live.every((r) => r.t > 1000),
    '实时榜里都是最近的提交'
  );
});

test('打开榜单时拉最新（实时榜），但有节流不会狂发请求', async () => {
  const fake = fakeTextdb(null);
  let nowMs = 100000;
  const sync = SY.create({
    storage: fakeStorage(),
    transport: TR.createTextdb({ endpoint: 'https://x/y', fetchImpl: fake.fetchImpl }),
    now: () => nowMs,
    liveThrottleMs: 20000
  });
  await sync.pullLive();
  const afterFirst = fake.state.gets;
  await sync.pullLive();
  assert.equal(fake.state.gets, afterFirst, '20 秒内重复打开不该再请求');
  nowMs += 21000;
  await sync.pullLive();
  assert.ok(fake.state.gets > afterFirst, '过了节流窗口要真的去拉');
});

test('本机模式（provider=local）：不算待确认、不发网络请求', async () => {
  const sync = SY.create({ storage: fakeStorage(), provider: 'local' });
  const res = await sync.submit(rec('本机玩家', 456, { t: 5 }));
  assert.equal(sync.info().mode, 'local');
  assert.equal(sync.pendingCount(), 0, '本机模式不往上传队列塞东西');
  assert.equal(sync.view('top')[0].n, '本机玩家');
  assert.equal(sync.isPending(rec('本机玩家', 456, { t: 5 })), false, '本机成绩不算待确认');
  assert.equal(res.ok, false, '本机模式没有远端可写');
});

test('清空：只清本机缓存，不碰远端', () => {
  const sync = SY.create({ storage: fakeStorage(), provider: 'local' });
  sync.submit(rec('甲', 100, { t: 1 }));
  assert.equal(sync.view('top').length, 1);
  sync.clearCache();
  assert.equal(sync.view('top').length, 0);
  assert.equal(sync.pendingCount(), 0);
});

/* ---------------- 真集成：自建服务器通道 ---------------- */

async function startServer() {
  const server = SRV.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('集成（rest 通道）：成绩提交到自己的服务器，再拉回来能看到', async () => {
  const { server, base } = await startServer();
  try {
    const sync = SY.create({
      storage: fakeStorage(),
      provider: 'rest',
      endpoint: `${base}/api/scores`,
      fetchImpl: globalThis.fetch
    });
    const empty = await sync.pull(true);
    assert.equal(empty.ok, true);
    assert.equal(sync.info().provider, 'rest');

    const res = await sync.submit(rec('自建服玩家', 654, { t: Date.now(), m: 8, d: 6, c: 3 }));
    assert.equal(res.ok, true, '提交应该成功');
    assert.equal(res.rank, 1);

    const again = SY.create({
      storage: fakeStorage(),
      provider: 'rest',
      endpoint: `${base}/api/scores`,
      fetchImpl: globalThis.fetch
    });
    const out = await again.pull(true);
    assert.equal(out.ok, true);
    assert.ok(
      out.doc.top.some((r) => r.n === '自建服玩家' && r.s === 654),
      '服务器上应该能读到这条成绩'
    );
  } finally {
    await stopServer(server);
  }
});

test('集成（rest 通道）：服务器关掉时成绩进队列，服务器回来能补传', async () => {
  const { server, base } = await startServer();
  const storage = fakeStorage();
  const endpoint = `${base}/api/scores`;
  try {
    const sync = SY.create({ storage, provider: 'rest', endpoint, fetchImpl: globalThis.fetch, pushTries: 1 });
    await sync.pull(true);
    await stopServer(server);

    const failed = await sync.submit(rec('断网玩家', 999, { t: Date.now() }));
    assert.equal(failed.ok, false);
    assert.equal(sync.pendingCount(), 1);

    const back = await startServer();
    const sync2 = SY.create({
      storage,
      provider: 'rest',
      endpoint: `${back.base}/api/scores`,
      fetchImpl: globalThis.fetch,
      pushTries: 1
    });
    assert.equal(sync2.pendingCount(), 1, '队列要能从存储里恢复');
    const flushed = await sync2.flush();
    assert.equal(flushed.ok, true);
    const out = await sync2.pull(true);
    assert.ok(out.doc.top.some((r) => r.n === '断网玩家'), '补传后真的上榜了');
    await stopServer(back.server);
  } finally {
    try {
      await stopServer(server);
    } catch (e) {
      /* 已经关了 */
    }
  }
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
