/*!
 * 合成邦多利皇帝 · 榜单文档（纯函数）
 *
 * 做法 C：没有自己的服务器，把「一张榜单」当成一个 JSON 文档存在第三方免费 KV 上。
 * 文档结构（字段名故意取短，整份文档要控制在 10KB 以内）：
 *
 *   {
 *     v: 1,                    // 结构版本
 *     u: 1767225600000,        // 文档最后更新时间
 *     top:  [记录, ...],       // 总榜：历史最佳前 100 名（分数降序）
 *     live: [记录, ...]        // 实时榜：最近 40 次提交（时间降序）
 *   }
 *
 *   记录：{ n:昵称, s:分数, d:难度, m:最大玩偶等级, c:最高连击, t:提交时间 }
 *
 * 两个关键设计：
 *   1. **自愈合并**：每个客户端本地都缓存一份，读回来的文档会和本地缓存合并后取优。
 *      所以哪怕有人把远端的文档刷没了、或者两个人同时写导致丢了一次更新，
 *      任何一个还留着缓存的客户端下一次读写就会把它修回来。
 *   2. 第三方 KV 没有服务端校验（谁都能改），所以这里做的是「尽力而为 + 可恢复」，
 *      而不是「防作弊」。要真正防作弊只能上自己的服务器（见 README 的方案 A/B）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SuikaBoards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DOC_VERSION = 1;
  var TOP_MAX = 100;
  var LIVE_MAX = 40;
  var NAME_MAX = 12;
  var MAX_SCORE = 99999999;
  var MAX_TIER = 11;
  var MAX_DIFFICULTY = 10;

  function clampInt(v, min, max, fallback) {
    var n = Math.floor(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function cleanName(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s) s = '匿名玩家';
    return s.slice(0, NAME_MAX);
  }

  /** 一条成绩记录；非法返回 null */
  function normalizeRec(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var score = Number(raw.s);
    if (!isFinite(score) || score < 0 || score > MAX_SCORE) return null;
    return {
      n: cleanName(raw.n),
      s: Math.round(score),
      d: clampInt(raw.d, 1, MAX_DIFFICULTY, 5),
      m: clampInt(raw.m, 1, MAX_TIER, 1),
      c: clampInt(raw.c, 0, 10000, 0),
      t: clampInt(raw.t, 0, 4102444800000, 0)
    };
  }

  /** 一条记录的身份：同一个人、同一秒、同一个分数算同一条（去重用） */
  function recKey(rec) {
    return rec.n + '|' + rec.t + '|' + rec.s;
  }

  function concat(lists) {
    var out = [];
    for (var i = 0; i < lists.length; i++) {
      var l = lists[i];
      if (Array.isArray(l)) out = out.concat(l);
    }
    return out;
  }

  /** 去重 + 清洗；同 key 保留信息更全的那条 */
  function dedupe(list) {
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var rec = normalizeRec(list[i]);
      if (!rec) continue;
      var k = recKey(rec);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(rec);
    }
    return out;
  }

  /** 总榜排序：分数高的在前；同分先达成的在前；再同就看难度高的 */
  function sortTop(list) {
    return list.slice().sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      if (b.d !== a.d) return b.d - a.d;
      return a.t - b.t;
    });
  }

  /** 实时榜排序：最近提交的在前 */
  function sortLive(list) {
    return list.slice().sort(function (a, b) {
      return b.t - a.t;
    });
  }

  function emptyDoc() {
    return { v: DOC_VERSION, u: 0, top: [], live: [] };
  }

  /**
   * 把远端拿到的任意东西整理成合法文档。
   * 第三方 KV 可能返回：JSON 字符串套 JSON（双重编码）、空、被写坏的内容 —— 都要能扛住。
   */
  function normalizeDoc(raw, depth) {
    var d = depth || 0;
    if (raw == null) return emptyDoc();
    if (typeof raw === 'string') {
      var text = raw.trim();
      if (!text) return emptyDoc();
      if (d >= 2) return emptyDoc(); // 最多解两层，防死循环
      try {
        return normalizeDoc(JSON.parse(text), d + 1);
      } catch (e) {
        return emptyDoc();
      }
    }
    if (typeof raw !== 'object') return emptyDoc();

    // 兼容 {entries:[...]} 这种扁平形态（自建服务器的返回）
    var topRaw = raw.top;
    var liveRaw = raw.live;
    if (!Array.isArray(topRaw) && Array.isArray(raw.entries)) topRaw = raw.entries;
    if (!Array.isArray(liveRaw) && Array.isArray(raw.entries)) liveRaw = raw.entries;

    var top = sortTop(dedupe(topRaw || [])).slice(0, TOP_MAX);
    var live = sortLive(dedupe(liveRaw || [])).slice(0, LIVE_MAX);
    // 实时榜里的记录也应当在总榜候选里（有些来源只给一份列表）
    if (!Array.isArray(raw.top) && Array.isArray(raw.entries)) {
      live = sortLive(dedupe(concat([top, live]))).slice(0, LIVE_MAX);
    }
    return { v: DOC_VERSION, u: clampInt(raw.u || raw.updatedAt, 0, 4102444800000, 0), top: top, live: live };
  }

  /**
   * 合并两份文档（远端 + 本地缓存）。
   * 这是「自愈」的核心：谁的一份更全就留下谁的成绩，而不是互相覆盖。
   */
  function mergeDocs(a, b) {
    var da = normalizeDoc(a);
    var db = normalizeDoc(b);
    var all = dedupe(concat([da.top, db.top, da.live, db.live]));
    var top = sortTop(all).slice(0, TOP_MAX);
    var live = sortLive(all).slice(0, LIVE_MAX);
    return { v: DOC_VERSION, u: Math.max(da.u, db.u), top: top, live: live };
  }

  /** 把一条新成绩加进文档（同时进实时榜和总榜候选） */
  function addScore(doc, rec, now) {
    var base = normalizeDoc(doc);
    var r = normalizeRec(rec);
    if (!r) return base;
    if (!r.t) r.t = clampInt(now, 0, 4102444800000, Date.now());
    var all = dedupe(concat([base.top, base.live, [r]]));
    return {
      v: DOC_VERSION,
      u: clampInt(now, 0, 4102444800000, Date.now()),
      top: sortTop(all).slice(0, TOP_MAX),
      live: sortLive(all).slice(0, LIVE_MAX)
    };
  }

  /** 名次（1 起）：考虑并列，同分先达成的排前面 */
  function rankOf(rec, topList) {
    var r = normalizeRec(rec);
    if (!r) return 0;
    var rank = 1;
    var list = topList || [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.s > r.s) rank++;
      else if (o.s === r.s && o.d > r.d) rank++;
      else if (o.s === r.s && o.d === r.d && o.t < r.t) rank++;
    }
    return rank;
  }

  /** 文档体积预估（第三方 KV 都有限制，超了要裁剪） */
  function docSize(doc) {
    try {
      return JSON.stringify(normalizeDoc(doc)).length;
    } catch (e) {
      return 0;
    }
  }

  /** 文档瘦身：按上限裁剪，必要时先砍实时榜 */
  function trimDoc(doc, maxChars) {
    var d = normalizeDoc(doc);
    var limit = maxChars || 60000;
    if (docSize(d) <= limit) return d;
    var live = d.live;
    while (live.length && docSize({ v: d.v, u: d.u, top: d.top, live: live }) > limit) {
      live = live.slice(0, live.length - 1);
    }
    d = { v: d.v, u: d.u, top: d.top, live: live };
    if (docSize(d) <= limit) return d;
    var top = d.top;
    while (top.length > 10 && docSize({ v: d.v, u: d.u, top: top, live: d.live }) > limit) {
      top = top.slice(0, top.length - 5);
    }
    return { v: d.v, u: d.u, top: top, live: d.live };
  }

  return {
    DOC_VERSION: DOC_VERSION,
    TOP_MAX: TOP_MAX,
    LIVE_MAX: LIVE_MAX,
    MAX_SCORE: MAX_SCORE,
    NAME_MAX: NAME_MAX,
    emptyDoc: emptyDoc,
    normalizeDoc: normalizeDoc,
    normalizeRec: normalizeRec,
    cleanName: cleanName,
    recKey: recKey,
    dedupe: dedupe,
    sortTop: sortTop,
    sortLive: sortLive,
    mergeDocs: mergeDocs,
    addScore: addScore,
    rankOf: rankOf,
    docSize: docSize,
    trimDoc: trimDoc
  };
});
