/*!
 * 合成大西瓜 · 服务器测试（node --test）
 *
 *   node --test "C:\Users\极光\Desktop\合成大西瓜\tests\server.test.mjs"
 *
 * 真起服务器（listen(0) 随机端口）+ 真发 HTTP 请求，只依赖 Node 内置模块。
 * 数据目录用 SUIKA_DATA 指向 os.tmpdir() 下的临时目录，绝不碰真实的 data/。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

// 必须在 require server.cjs 之前指定数据目录
const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'suika-scores-'));
process.env.SUIKA_DATA = TMP;
process.env.SUIKA_NO_OPEN = '1';

const SRV = require(path.join(ROOT, 'server.cjs'));

let server;
let base;

function url(p) {
  return `http://127.0.0.1:${server.address().port}${p}`;
}

function jpost(p, payload, raw) {
  const body = raw === undefined ? JSON.stringify(payload) : raw;
  return fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
}

function entry(over) {
  return Object.assign(
    {
      id: 'id-' + Math.random().toString(36).slice(2),
      player: '小明',
      score: 100,
      maxTier: 6,
      merges: 12,
      durationMs: 30000,
      difficulty: 5,
      at: Date.now()
    },
    over || {}
  );
}

/** 发一个「不经过客户端规范化」的原始请求，用来直接试探路径（fetch 会自己把 /../ 抹平） */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method: 'GET', path: rawPath },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const scoresFile = () => path.join(TMP, 'scores.json');
const readScores = () => JSON.parse(fs.readFileSync(scoresFile(), 'utf8'));

before(async () => {
  server = SRV.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fsp.rm(TMP, { recursive: true, force: true });
});

/* ---------------- 1. 静态首页 ---------------- */
test('GET / 返回首页 HTML', async () => {
  const res = await fetch(url('/'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(await res.text(), /合成大西瓜/);
});

/* ---------------- 2. 静态资源与 404 ---------------- */

test('静态资源 MIME 正确、不存在的路径 404', async () => {
  const js = await fetch(url('/js/config.js'));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.match(await js.text(), /TIERS/);

  const missing = await fetch(url('/js/does-not-exist.js'));
  assert.equal(missing.status, 404);

  const missingPage = await fetch(url('/no-such-dir/'));
  assert.equal(missingPage.status, 404);
});

/* ---------------- 3. 目录穿越防护 ---------------- */

test('目录穿越被挡住', async () => {
  const cases = [
    { raw: '/%2e%2e/AGENTS.md', leaked: /Voyager/i, label: '父目录的 AGENTS.md' },
    { raw: '/..%2f..%2fWindows/win.ini', leaked: /\[fonts\]/i, label: '系统 win.ini' },
    { raw: '/%2e%2e%2f%2e%2e%2fWindows%2fwin.ini', leaked: /\[fonts\]/i, label: '全编码的 win.ini' }
  ];
  for (const c of cases) {
    const res = await rawGet(c.raw);
    assert.ok(res.status === 403 || res.status === 404, `${c.raw} 应返回 403 或 404，实际 ${res.status}`);
    assert.doesNotMatch(res.text, c.leaked, `${c.raw} 不能泄露${c.label}`);
  }
});

/* ---------------- 4. 空榜单 ---------------- */

test('GET /api/scores 空榜单', async () => {
  const res = await fetch(url('/api/scores'));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 0);
  assert.deepEqual(data.entries, []);
  assert.equal(data.updatedAt, 0);
});

/* ---------------- 5. 单条提交 ---------------- */

test('POST 单条成绩 → 200、accepted=1、rank=1，GET 能读回', async () => {
  const e = entry({ id: 'solo-1', player: '小红', score: 4321, maxTier: 9, difficulty: 7 });
  const res = await jpost('/api/scores', e);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.accepted, 1);
  assert.equal(data.duplicated, 0);
  assert.equal(data.rejected, 0);
  assert.equal(data.rank, 1);
  assert.equal(data.count, 1);
  assert.equal(data.entries[0].id, 'solo-1');
  assert.equal(data.entries[0].score, 4321);

  const got = await (await fetch(url('/api/scores'))).json();
  assert.equal(got.count, 1);
  assert.equal(got.entries[0].player, '小红');
  assert.equal(got.entries[0].difficulty, 7);
  assert.ok(got.updatedAt > 0);
});

/* ---------------- 6. 多条提交与排序 ---------------- */

test('POST 多条成绩，按分数降序、同分最高级降序排列', async () => {
  const res = await jpost('/api/scores', {
    entries: [
      entry({ id: 'm-low', player: '小刚', score: 500, maxTier: 3 }),
      entry({ id: 'm-top', player: '小美', score: 9000, maxTier: 10 }),
      entry({ id: 'm-tie-a', player: 'A', score: 2000, maxTier: 5 }),
      entry({ id: 'm-tie-b', player: 'B', score: 2000, maxTier: 8 })
    ]
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.accepted, 4);
  assert.equal(data.rejected, 0);
  assert.equal(data.rank, 1); // 9000 分那条是榜首
  assert.equal(data.count, 5); // 4 条新的 + 上一条 solo-1

  const ids = data.entries.map((e) => e.id);
  assert.deepEqual(ids, ['m-top', 'solo-1', 'm-tie-b', 'm-tie-a', 'm-low']);

  const got = await (await fetch(url('/api/scores'))).json();
  assert.deepEqual(got.entries.map((e) => e.id), ids);
  for (let i = 1; i < got.entries.length; i++) {
    const prev = got.entries[i - 1];
    const cur = got.entries[i];
    assert.ok(prev.score > cur.score || (prev.score === cur.score && prev.maxTier >= cur.maxTier), '排序必须是分数降序、同分高级在前');
  }
});

/* ---------------- 7. 重复 id 被跳过 ---------------- */

test('重复 id 的第二次 POST 被跳过', async () => {
  const before = await (await fetch(url('/api/scores'))).json();
  const res = await jpost('/api/scores', entry({ id: 'solo-1', player: '冒名者', score: 999999 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.accepted, 0);
  assert.equal(data.duplicated, 1);
  assert.equal(data.count, before.count);
  assert.equal(data.rank, null); // 没有新写入
  const kept = data.entries.find((e) => e.id === 'solo-1');
  assert.equal(kept.score, 4321, '旧成绩不能被覆盖');
  assert.equal(kept.player, '小红');
});

/* ---------------- 8. 字段校验 ---------------- */

test('非法条目被拒绝、超范围被夹住、超长玩家名被截断', async () => {
  // 全部非法 → 400 invalid-entry
  const allBad = await jpost('/api/scores', {
    entries: [entry({ id: 'bad-1', score: '很高' }), entry({ id: 'bad-2', score: 123456789 }), { player: '没有 id' }]
  });
  assert.equal(allBad.status, 400);
  assert.deepEqual(await allBad.json(), { ok: false, error: 'invalid-entry' });

  // 混合：只写合法的
  const mixed = await jpost('/api/scores', {
    entries: [
      entry({ id: 'ok-1', player: '合法的', score: 1500, maxTier: 12, difficulty: 99, merges: -5 }),
      entry({ id: 'bad-3', score: 'abc' }),
      entry({ id: 'bad-4', score: 100000000 }),
      entry({ id: '', score: 10 }),
      entry({ id: 'ok-2', player: '名字'.repeat(20), score: 0 })
    ]
  });
  assert.equal(mixed.status, 200);
  const data = await mixed.json();
  assert.equal(data.accepted, 2);
  assert.equal(data.rejected, 3);
  assert.equal(data.duplicated, 0);

  const ok1 = data.entries.find((e) => e.id === 'ok-1');
  assert.equal(ok1.maxTier, 11, 'maxTier=12 夹到 11');
  assert.equal(ok1.difficulty, 10, 'difficulty=99 夹到 10');
  assert.equal(ok1.merges, 0, 'merges=-5 夹到 0');

  const ok2 = data.entries.find((e) => e.id === 'ok-2');
  assert.equal(ok2.score, 0, '0 分是合法成绩');
  assert.equal(ok2.player.length, 24, '玩家名截断到 24 字符');
});

/* ---------------- 9. 坏 body / 超大 body ---------------- */

test('坏 JSON → 400 bad-json，超过 256KB → 413', async () => {
  const bad = await jpost('/api/scores', null, '{"entries": [');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: 'bad-json' });

  const noEntries = await jpost('/api/scores', { entries: [] });
  assert.equal(noEntries.status, 400);
  assert.deepEqual(await noEntries.json(), { ok: false, error: 'no-entries' });

  const notJson = await jpost('/api/scores', null, 'hello suika');
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error, 'bad-json');

  const huge = JSON.stringify({ entries: [entry({ id: 'huge-1', note: 'x'.repeat(300 * 1024) })] });
  assert.ok(Buffer.byteLength(huge) > 256 * 1024);
  const big = await jpost('/api/scores', null, huge);
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { ok: false, error: 'too-large' });
});

/* ---------------- 10. 持久化与损坏文件 ---------------- */

test('成绩落盘可重新读出，损坏的 scores.json 当空榜单处理', async () => {
  const e = entry({ id: 'persist-1', player: '持久化', score: 7777, maxTier: 7 });
  const posted = await (await jpost('/api/scores', e)).json();
  assert.equal(posted.accepted, 1);

  // 直接读盘
  const onDisk = readScores();
  assert.ok(onDisk.entries.some((x) => x.id === 'persist-1' && x.score === 7777));

  // 模块级 loadScores 重新读文件
  const loaded = SRV.loadScores();
  assert.ok(loaded.entries.some((x) => x.id === 'persist-1'));

  // 换一个全新的 server 实例（模拟「重启服务器」）也能读到
  const fresh = SRV.createServer();
  await new Promise((r) => fresh.listen(0, '127.0.0.1', r));
  const port = fresh.address().port;
  const freshGot = await (await fetch(`http://127.0.0.1:${port}/api/scores`)).json();
  assert.equal(freshGot.ok, true);
  assert.ok(freshGot.entries.some((x) => x.id === 'persist-1'));
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.service, 'suika-scores');
  assert.equal(health.count, freshGot.count);
  await new Promise((r) => fresh.close(r));

  // 把文件写成垃圾 → 仍然 200 且空榜单，不崩
  fs.writeFileSync(scoresFile(), '这不是 JSON {{{ \u0000 坏掉了', 'utf8');
  const broken = await fetch(url('/api/scores'));
  assert.equal(broken.status, 200);
  const brokenData = await broken.json();
  assert.equal(brokenData.ok, true);
  assert.equal(brokenData.count, 0);
  assert.deepEqual(brokenData.entries, []);
  assert.equal(SRV.loadScores().entries.length, 0);

  // 坏文件之后还能继续写（不是空榜单也要能恢复）
  const after = await (await jpost('/api/scores', entry({ id: 'recover-1', score: 42 }))).json();
  assert.equal(after.accepted, 1);
  assert.equal(after.rank, 1);
});

/* ---------------- 11. CORS / OPTIONS ---------------- */

test('OPTIONS /api/scores 返回 204 且带 CORS 头，其它接口响应也带', async () => {
  const res = await fetch(url('/api/scores'), { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods') || '', /GET/);
  assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(res.headers.get('access-control-allow-methods') || '', /OPTIONS/);
  assert.match(res.headers.get('access-control-allow-headers') || '', /Content-Type/i);
  assert.equal(await res.text(), '');

  const get = await fetch(url('/api/scores'));
  assert.equal(get.headers.get('access-control-allow-origin'), '*');
  const health = await fetch(url('/api/health'));
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  const post = await jpost('/api/scores', entry({ id: 'cors-1', score: 1 }));
  assert.equal(post.headers.get('access-control-allow-origin'), '*');

  const unknown = await fetch(url('/api/nope'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await unknown.json(), { ok: false, error: 'not-found' });
});

/* ---------------- 12. 纯函数 ---------------- */

test('纯函数：normalizeEntry / sortEntries / mergeEntries / rankOf', () => {
  const now = 1700000000000;
  const ok = SRV.normalizeEntry({ id: 'a', score: 10 }, now);
  assert.equal(ok.at, now);
  assert.equal(ok.player, '玩家');
  assert.equal(ok.maxTier, 1);
  assert.equal(ok.merges, 0);
  assert.equal(ok.durationMs, 0);
  assert.equal(ok.difficulty, 5);

  // roundId 兜底
  assert.equal(SRV.normalizeEntry({ roundId: 'r1', score: 5 }, now).id, 'r1');
  assert.equal(SRV.normalizeEntry({ id: 'x' }, now), null);
  assert.equal(SRV.normalizeEntry({ id: 'x', score: 1.7 }, now).score, 1, '小数向下取整');
  assert.equal(SRV.normalizeEntry(null, now), null);
  assert.equal(SRV.normalizeEntry([], now), null);

  const sorted = SRV.sortEntries([
    { id: 'b', score: 10, maxTier: 1, at: 2 },
    { id: 'a', score: 10, maxTier: 5, at: 3 },
    { id: 'c', score: 99, maxTier: 1, at: 1 }
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['c', 'a', 'b']);

  const merged = SRV.mergeEntries([{ id: 'a', score: 1, maxTier: 1, at: 1 }], [
    { id: 'a', score: 999, maxTier: 1, at: 2 },
    { id: 'b', score: 50, maxTier: 1, at: 3 }
  ]);
  assert.equal(merged.accepted, 1);
  assert.equal(merged.duplicated, 1);
  assert.deepEqual(merged.entries.map((e) => e.id), ['b', 'a']);
  assert.equal(merged.entries[1].score, 1, '同 id 不覆盖旧成绩');

  assert.equal(SRV.rankOf(merged.entries, 'b'), 1);
  assert.equal(SRV.rankOf(merged.entries, 'a'), 2);
  assert.equal(SRV.rankOf(merged.entries, 'zzz'), null);
  assert.equal(SRV.MAX_ENTRIES, 100);
});

/* ---------------- 13. 启动参数解析 ---------------- */

test('parseArgs 认识 --lan / --port，且默认只监听本机', () => {
  const plain = SRV.parseArgs([]);
  assert.equal(plain.lan, false);
  assert.equal(plain.port, null);
  assert.equal(plain.error, null);

  const lan = SRV.parseArgs(['--lan', '--port', '5180']);
  assert.equal(lan.lan, true);
  assert.equal(lan.port, 5180);
  assert.equal(SRV.parseArgs(['--port=5181']).port, 5181);
  assert.ok(SRV.parseArgs(['--port', 'abc']).error, '端口非法要报错');
  assert.ok(SRV.parseArgs(['--nope']).error, '未知参数要报错');
  assert.equal(SRV.START_PORT, Number(process.env.PORT) || 5173);
});

/* ---------------- 14. 榜单容量上限 ---------------- */

test('最多只保留 100 条', async () => {
  await fsp.rm(scoresFile(), { force: true });
  const many = [];
  for (let i = 0; i < 50; i++) many.push(entry({ id: 'cap-a-' + i, score: 1000 + i }));
  const first = await (await jpost('/api/scores', { entries: many })).json();
  assert.equal(first.accepted, 50);
  assert.equal(first.count, 50);

  const more = [];
  for (let i = 0; i < 50; i++) more.push(entry({ id: 'cap-b-' + i, score: 5000 + i }));
  const second = await (await jpost('/api/scores', { entries: more })).json();
  assert.equal(second.accepted, 50);
  assert.equal(second.count, 100, '正好 100 条');

  const third = await (await jpost('/api/scores', entry({ id: 'cap-c', score: 999999 }))).json();
  assert.equal(third.accepted, 1);
  assert.equal(third.count, 100, '超出后仍然只有 100 条');
  assert.equal(third.entries.length, 100);
  assert.equal(third.entries[0].id, 'cap-c');
  assert.equal(third.rank, 1);
  assert.equal(readScores().entries.length, 100, '落盘也只有 100 条');
  assert.equal(base, `http://127.0.0.1:${server.address().port}`);
});

/* ---------------- 15. 并发提交（多人同时玩） ---------------- */

test('并发提交：同时打进来的成绩一条都不能丢', async () => {
  await fsp.rm(scoresFile(), { force: true });

  // 8 个人同时提交（不 await 上一条），这是「同时间其他人也在玩」的场景
  const shots = [];
  for (let i = 0; i < 8; i++) {
    shots.push(jpost('/api/scores', { entries: [entry({ id: 'race-' + i, player: 'P' + i, score: 100 + i })] }).then((r) => r.json()));
  }
  const results = await Promise.all(shots);
  assert.equal(
    results.reduce((a, r) => a + r.accepted, 0),
    8,
    '8 条并发提交应该全部被接受'
  );

  const board = await (await fetch(url('/api/scores'))).json();
  const mine = board.entries.filter((e) => e.id.startsWith('race-'));
  assert.equal(mine.length, 8, '并发提交不能互相覆盖，8 条都要在榜上');
  assert.equal(board.count, 8);
  assert.equal(readScores().entries.length, 8, '落盘也要是 8 条');
  assert.deepEqual(
    board.entries.map((e) => e.score),
    [107, 106, 105, 104, 103, 102, 101, 100],
    '并发写入后依然按分数排序'
  );
});
