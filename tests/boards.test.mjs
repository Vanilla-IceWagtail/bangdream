/*!
 * 合成大西瓜 · 榜单文档测试（js/boards.js）
 *
 * 这是「做法 C」的地基：整张榜就是一份 JSON 文档，存在第三方免费 KV 上。
 * 没有服务端校验，所以纯函数这边的职责是：
 *   · 把外面拿到的任何脏数据洗成合法文档；
 *   · 合并时**取优而不是覆盖**（自愈：别人把榜刷没了，客户端能修回来）；
 *   · 排序/截断/名次都稳定，且文档不能无限膨胀（第三方 KV 有限制）。
 *
 *   node --test tests/boards.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const B = require(path.join(ROOT, 'js/boards.js'));

const rec = (n, s, extra = {}) => Object.assign({ n, s, d: 5, m: 6, c: 2, t: 1000 }, extra);

test('文档结构：只有总榜 top 和实时榜 live，没有个人排行表（需求第 3 条）', () => {
  const doc = B.emptyDoc();
  assert.deepEqual(Object.keys(doc).sort(), ['live', 'top', 'u', 'v']);
  const filled = B.addScore(B.emptyDoc(), rec('甲', 100, { t: 5 }), 6);
  assert.deepEqual(Object.keys(filled).sort(), ['live', 'top', 'u', 'v']);
  assert.ok(!('personal' in filled), '文档里不允许有个人历史表');
  assert.ok(!('players' in filled), '也不能按玩家攒记录');
});

test('脏数据一律能洗成合法文档（第三方 KV 什么都可能返回）', () => {
  assert.deepEqual(B.normalizeDoc(null).top, []);
  assert.deepEqual(B.normalizeDoc('').top, []);
  assert.deepEqual(B.normalizeDoc('不是 json').top, []);
  assert.deepEqual(B.normalizeDoc(12345).top, []);
  assert.deepEqual(B.normalizeDoc([]).top, []);

  // 双重编码：textdb 会把值当 JSON 字符串存，读回来是「套了一层引号」的 JSON
  const inner = JSON.stringify({ v: 1, top: [rec('甲', 300)], live: [] });
  const outer = JSON.stringify(inner);
  const parsed = B.normalizeDoc(outer);
  assert.equal(parsed.top.length, 1, '双重编码要能解开');
  assert.equal(parsed.top[0].s, 300);

  // 字段乱来：分数超范围/负数/字符串、名字带控制字符、等级越界
  const messy = B.normalizeDoc({
    top: [
      rec('正常', 100),
      rec('负分', -5),
      rec('超范围', 1e12),
      { n: 'x', s: '不是数字' },
      null,
      'string',
      { n: '带\u0000控制\u001f字符的名字实在太长了超过十二个字', s: 50, m: 99, d: 99 }
    ]
  });
  assert.equal(messy.top.length, 2, '7 条里只有 2 条合法（负分、超范围、非数字、null、字符串都要丢掉）');
  const weird = messy.top.find((r) => r.s === 50);
  assert.equal(weird.m, 11, '等级夹到 1~11');
  assert.equal(weird.d, 10, '难度夹到 1~10');
  assert.ok(weird.n.length <= B.NAME_MAX, '名字要截断');
  assert.ok(!/[\u0000-\u001f]/.test(weird.n), '名字里的控制字符要清掉');
});

test('总榜排序：分数降序 → 同分难度高的靠前 → 再同先达成的靠前', () => {
  const list = B.sortTop([
    rec('低', 100, { t: 5 }),
    rec('高分', 300, { t: 9 }),
    rec('同分先到', 200, { d: 3, t: 1 }),
    rec('同分后到', 200, { d: 3, t: 8 }),
    rec('同分高难', 200, { d: 9, t: 7 })
  ]);
  assert.deepEqual(
    list.map((r) => r.n),
    ['高分', '同分高难', '同分先到', '同分后到', '低']
  );
});

test('实时榜排序：最近提交的在前，最多留 40 条；显示时取最近 20 条按分数排', () => {
  let doc = B.emptyDoc();
  for (let i = 1; i <= 60; i++) doc = B.addScore(doc, rec('玩家' + i, i, { t: i * 1000 }), i * 1000);
  assert.equal(doc.live.length, B.LIVE_MAX, '实时榜最多 40 条');
  assert.equal(doc.live[0].n, '玩家60', '最新提交的在最前');
  assert.equal(doc.live[B.LIVE_MAX - 1].n, '玩家' + (60 - B.LIVE_MAX + 1), '老的被挤出去');

  const shown = B.sortTop(doc.live.slice(0, 20));
  assert.equal(shown.length, 20);
  assert.equal(shown[0].s, 60, '实时榜按分数显示时，最近 20 条里最高的在最前');
});

test('总榜最多留 100 条，且保留的是分数最高的那批', () => {
  let doc = B.emptyDoc();
  for (let i = 1; i <= 150; i++) doc = B.addScore(doc, rec('P' + i, i, { t: i }), i);
  assert.equal(doc.top.length, B.TOP_MAX);
  assert.equal(doc.top[0].s, 150);
  assert.equal(doc.top[B.TOP_MAX - 1].s, 51, '第 100 名是 51 分，50 分及以下被挤掉');
});

test('合并取优（自愈）：远端被刷没了，本地缓存能把它修回来', () => {
  const local = {
    v: 1,
    u: 100,
    top: [rec('高手', 900, { t: 10 }), rec('中手', 500, { t: 20 })],
    live: [rec('高手', 900, { t: 10 })]
  };
  const wipedRemote = B.emptyDoc(); // 有人把远端清空了
  const merged = B.mergeDocs(wipedRemote, local);
  assert.equal(merged.top.length, 2, '本地缓存里的成绩要被合并回来');
  assert.equal(merged.top[0].n, '高手');

  // 两边各有对方没有的成绩 → 合并后都在
  const a = { v: 1, u: 1, top: [rec('A', 800, { t: 1 })], live: [] };
  const b = { v: 1, u: 2, top: [rec('B', 700, { t: 2 })], live: [] };
  const both = B.mergeDocs(a, b);
  assert.deepEqual(
    both.top.map((r) => r.n),
    ['A', 'B']
  );
  assert.equal(both.u, 2, '文档时间取较新的');
});

test('合并去重：同一个人/同一秒/同一分数只算一条', () => {
  const one = rec('甲', 500, { t: 777 });
  const merged = B.mergeDocs({ v: 1, top: [one], live: [one] }, { v: 1, top: [Object.assign({}, one)], live: [] });
  assert.equal(merged.top.length, 1);
  assert.equal(merged.live.length, 1);
});

test('名次：考虑并列，同分先达成的排前面', () => {
  const top = B.sortTop([rec('甲', 500, { t: 1 }), rec('乙', 500, { t: 2 }), rec('丙', 400, { t: 3 })]);
  assert.equal(B.rankOf(rec('甲', 500, { t: 1 }), top), 1);
  assert.equal(B.rankOf(rec('乙', 500, { t: 2 }), top), 2);
  assert.equal(B.rankOf(rec('丁', 450, { t: 9 }), top), 3);
  assert.equal(B.rankOf(rec('戊', 10, { t: 9 }), top), 4);
  assert.equal(B.rankOf({ n: 'x', s: -1 }, top), 0, '非法记录没有名次');
});

test('文档体积可控：超限时先砍实时榜、再砍总榜尾巴', () => {
  let doc = B.emptyDoc();
  for (let i = 1; i <= 100; i++) doc = B.addScore(doc, rec('玩家名字可以挺长' + i, 1000 - i, { t: i }), i);
  for (let i = 1; i <= 40; i++) doc = B.addScore(doc, rec('实时榜记录' + i, i, { t: 100000 + i }), 100000 + i);

  const full = B.docSize(doc);
  assert.ok(full > 4000, '先确认这份文档确实不小：' + full);
  const trimmed = B.trimDoc(doc, 4000);
  assert.ok(B.docSize(trimmed) <= 4000, '裁剪后必须落到上限以内：' + B.docSize(trimmed));
  assert.ok(trimmed.top.length >= 10, '总榜至少要保住前 10 名');
  assert.ok(trimmed.live.length <= doc.live.length, '先牺牲实时榜');

  // 正常体积不该被裁
  const small = B.addScore(B.emptyDoc(), rec('甲', 100, { t: 1 }), 1);
  assert.equal(B.trimDoc(small, 60000).top.length, 1);
  assert.equal(B.trimDoc(small, 60000).live.length, 1);
});

test('addScore：一条成绩同时进实时榜和总榜候选，时间戳可自动补', () => {
  const doc = B.addScore(B.emptyDoc(), { n: '甲', s: 321, d: 7, m: 9, c: 4 }, 123456);
  assert.equal(doc.live.length, 1);
  assert.equal(doc.top.length, 1);
  assert.equal(doc.top[0].t, 123456, '没给时间就补当前时间');
  assert.equal(doc.u, 123456);
  assert.equal(doc.top[0].d, 7);
  assert.equal(doc.top[0].m, 9);
  assert.equal(doc.top[0].c, 4);
});
