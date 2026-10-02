/*!
 * 合成邦高祖！！！ · 榜单传输层
 *
 * 把「榜单文档怎么存取」和「榜单怎么合并、怎么缓存」分开。
 * 目前两种实现：
 *
 *   textdb（默认，做法 C）—— 第三方免费 KV，免注册、CORS 全开，静态页面直接就能读写。
 *                            整张榜单当一个 JSON 文档存；没有服务端校验。
 *   rest              —— 自己那台 Node 服务器（server.cjs）的 /api/scores，
 *                            每条成绩单独提交、服务端去重并排序，更规矩但需要有人架服务器。
 *
 * 两者对上层暴露同样的接口：
 *   pull()                  -> { ok, doc, error }
 *   push(doc, newRecords)   -> { ok, doc, error }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SuikaTransport = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function tryRequire(path) {
    if (typeof require !== 'function') return null;
    try {
      return require(path);
    } catch (e) {
      return null;
    }
  }

  var CFG = root.SuikaConfig || tryRequire('./config.js');
  var BOARDS = root.SuikaBoards || tryRequire('./boards.js');

  var DEFAULT_TIMEOUT = 12000;

  function fetchOf(opts) {
    if (opts && opts.fetchImpl) return opts.fetchImpl;
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    return null;
  }

  function withTimeout(ms) {
    if (typeof AbortController !== 'function') return { signal: undefined, done: function () {} };
    var ac = new AbortController();
    var id = setTimeout(function () {
      ac.abort();
    }, ms);
    return {
      signal: ac.signal,
      done: function () {
        clearTimeout(id);
      }
    };
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** 重试 N 次（第三方免费服务偶尔抽风，值得重试一次） */
  function retryable(fn, tries, delayMs) {
    var n = 0;
    function attempt() {
      n += 1;
      return fn().catch(function (err) {
        if (n >= tries) throw err;
        return sleep(delayMs * n).then(attempt);
      });
    }
    return attempt();
  }

  /* ---------------- 第三方 KV（做法 C） ---------------- */

  function createTextdb(opts) {
    var conf = (CFG && CFG.BOARD_SYNC && CFG.BOARD_SYNC.textdb) || {};
    var endpoint = opts.endpoint || conf.endpoint;
    var timeout = opts.timeoutMs || conf.timeoutMs || DEFAULT_TIMEOUT;
    var fetchImpl = fetchOf(opts);

    function readText(res) {
      return res.text().then(function (text) {
        // 这个服务会把值当 JSON 字符串存，读回来是「套了一层引号」的 JSON —— 解到对象为止
        return BOARDS.normalizeDoc(text);
      });
    }

    function pull() {
      if (!endpoint || !fetchImpl) return Promise.resolve({ ok: false, error: 'no-endpoint', doc: BOARDS.emptyDoc() });
      return retryable(function () {
        var guard = withTimeout(timeout);
        return fetchImpl(endpoint, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: guard.signal
        })
          .then(function (res) {
            guard.done();
            if (!res.ok) throw new Error('http-' + res.status);
            return readText(res);
          })
          .catch(function (err) {
            guard.done();
            throw err;
          });
      }, 2, 600)
        .then(function (doc) {
          return { ok: true, doc: doc };
        })
        .catch(function (err) {
          return { ok: false, error: String((err && err.message) || err), doc: BOARDS.emptyDoc() };
        });
    }

    function push(doc) {
      if (!endpoint || !fetchImpl) return Promise.resolve({ ok: false, error: 'no-endpoint' });
      var payload;
      try {
        payload = JSON.stringify(BOARDS.trimDoc(doc, conf.maxChars || 60000));
      } catch (e) {
        return Promise.resolve({ ok: false, error: 'serialize' });
      }
      return retryable(function () {
        var guard = withTimeout(timeout);
        return fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          signal: guard.signal
        })
          .then(function (res) {
            guard.done();
            if (!res.ok) throw new Error('http-' + res.status);
            return { ok: true };
          })
          .catch(function (err) {
            guard.done();
            throw err;
          });
      }, 2, 600).catch(function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      });
    }

    return { name: 'textdb', endpoint: endpoint, pull: pull, push: push };
  }

  /* ---------------- 自己的 Node 服务器 ---------------- */

  /** 服务器返回的是长字段名（player/score/maxTier…），要映射成榜单文档里的短记录 */
  function recordFromServerEntry(e) {
    if (!e || typeof e !== 'object') return null;
    return BOARDS.normalizeRec({
      n: e.player != null ? e.player : e.n,
      s: e.score != null ? e.score : e.s,
      d: e.difficulty != null ? e.difficulty : e.d,
      m: e.maxTier != null ? e.maxTier : e.m,
      c: e.bestCombo != null ? e.bestCombo : e.c,
      t: e.at != null ? e.at : e.t
    });
  }

  /**
   * 由「昵称|时间|分数」算一个稳定的 id：同一条成绩重复提交时，
   * 服务器按 id 去重，不会在榜上出现两条一样的。
   */
  function stableId(r) {
    var s = BOARDS.recKey(r);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'r' + h.toString(36);
  }

  function docFromServer(data) {
    var raw = data && (Array.isArray(data.entries) ? data.entries : data.entries ? [data.entries] : null);
    if (!raw && data && Array.isArray(data)) raw = data;
    var records = (raw || []).map(recordFromServerEntry).filter(Boolean);
    return BOARDS.normalizeDoc({
      v: BOARDS.DOC_VERSION,
      u: (data && (data.updatedAt || data.u)) || 0,
      top: records,
      live: BOARDS.sortLive(records)
    });
  }

  function createRest(opts) {
    var conf = (CFG && CFG.BOARD_SYNC && CFG.BOARD_SYNC.rest) || {};
    var endpoint = opts.endpoint || conf.endpoint || (CFG ? CFG.BOARD_SYNC.rest.path : '/api/scores');
    var timeout = opts.timeoutMs || conf.timeoutMs || 8000;
    var fetchImpl = fetchOf(opts);

    function pull() {
      if (!endpoint || !fetchImpl) return Promise.resolve({ ok: false, error: 'no-endpoint', doc: BOARDS.emptyDoc() });
      var guard = withTimeout(timeout);
      return fetchImpl(endpoint, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: guard.signal })
        .then(function (res) {
          if (!res.ok) throw new Error('http-' + res.status);
          return res.json();
        })
        .then(function (data) {
          guard.done();
          return { ok: true, doc: docFromServer(data) };
        })
        .catch(function (err) {
          guard.done();
          return { ok: false, error: String((err && err.message) || err), doc: BOARDS.emptyDoc() };
        });
    }

    function push(doc, newRecords) {
      if (!endpoint || !fetchImpl) return Promise.resolve({ ok: false, error: 'no-endpoint' });
      // 自建服务器是按「每条成绩」收的（服务端自己去重、排序），所以这里只发新成绩
      var list = (newRecords || []).map(function (r) {
        return {
          id: stableId(r),
          player: r.n,
          score: r.s,
          maxTier: r.m,
          merges: 0,
          durationMs: 0,
          difficulty: r.d,
          bestCombo: r.c,
          at: r.t
        };
      });
      if (!list.length) return Promise.resolve({ ok: true, doc: BOARDS.normalizeDoc(doc) });
      var guard = withTimeout(timeout);
      return fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: list }),
        signal: guard.signal
      })
        .then(function (res) {
          if (!res.ok) throw new Error('http-' + res.status);
          return res.json();
        })
        .then(function (data) {
          guard.done();
          return { ok: true, doc: docFromServer(data) };
        })
        .catch(function (err) {
          guard.done();
          return { ok: false, error: String((err && err.message) || err) };
        });
    }

    return { name: 'rest', endpoint: endpoint, pull: pull, push: push };
  }

  /* ---------------- 只在本机 ---------------- */

  function createLocal() {
    return {
      name: 'local',
      endpoint: null,
      pull: function () {
        return Promise.resolve({ ok: false, error: 'local-only', doc: BOARDS.emptyDoc() });
      },
      push: function () {
        return Promise.resolve({ ok: false, error: 'local-only' });
      }
    };
  }

  /**
   * 选一个传输：
   *   - 显式 opts.provider（'textdb' | 'rest' | 'local'）优先；
   *   - ?board=xxx 可以临时覆盖（方便调试 / 截图）；
   *   - 默认 textdb（全球共享，不需要自己架服务器）。
   */
  function resolve(name, opts) {
    opts = opts || {};
    var conf = (CFG && CFG.BOARD_SYNC) || {};
    var chosen = name || opts.provider || conf.provider || 'textdb';
    if (chosen === 'auto') chosen = conf.provider || 'textdb';
    if (chosen === 'rest') return createRest(opts);
    if (chosen === 'local' || chosen === 'none' || chosen === 'off') return createLocal();
    return createTextdb(opts);
  }

  return {
    resolve: resolve,
    createTextdb: createTextdb,
    createRest: createRest,
    createLocal: createLocal,
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT
  };
});
