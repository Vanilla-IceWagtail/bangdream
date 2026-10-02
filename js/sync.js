/*!
 * 合成邦多利皇帝 · 全球排行榜同步
 *
 * 一张榜单 = 一份 JSON 文档（结构见 js/boards.js），存在第三方免费 KV 上（见 js/transport.js）。
 * 这个文件负责「怎么用得稳」：
 *
 *   · 本地缓存：每次读写都存一份到 localStorage，界面永远有东西可显示（离线也能看）；
 *   · 待上传队列：提交失败就存起来，联网后自动补传，不丢成绩；
 *   · 自愈合并：远端文档与本地缓存合并取优 —— 有人把榜单刷没了、或者并发写丢了一次，
 *               任何一个还留着缓存的客户端下次读写就会把它修回来；
 *   · 两个榜：实时榜（最近 20 次提交，打开面板就拉最新）+ 总榜（历史前 100，每 30 分钟自动刷新）；
 *   · 防覆盖写入：提交时先读最新、合并、再写，写完再读一次确认自己那条真的进去了，没进去就重试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SuikaSync = factory(root);
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
  var TRANSPORT = root.SuikaTransport || tryRequire('./transport.js');

  var LIVE_SHOW = 20; // 实时榜显示多少条
  var CACHE_KEY = 'suika.board.v1';
  var CACHE_AT_KEY = 'suika.board.v1.at';
  var PENDING_KEY = 'suika.pending.v1';

  function isStale(fetchedAt, now, refreshMs) {
    if (!fetchedAt) return true;
    return now - fetchedAt >= refreshMs;
  }

  function nextRefreshAt(fetchedAt, refreshMs) {
    return (Number(fetchedAt) || 0) + (Number(refreshMs) || 0);
  }

  /** 自建服务器地址：显式配置优先；http(s) 打开时用同源 /api/scores；file:// 没有 */
  function resolveEndpoint(cfg, loc) {
    var conf = cfg || (CFG ? CFG.BOARD_SYNC : {}) || {};
    if (conf.endpoint) return String(conf.endpoint);
    var l = loc || root.location || {};
    var proto = String(l.protocol || '');
    if (proto === 'http:' || proto === 'https:') return conf.path || '/api/scores';
    return null;
  }

  function create(opts) {
    opts = opts || {};
    var conf = (CFG && CFG.BOARD_SYNC) || {};
    var storage = opts.storage || null;
    var now =
      opts.now ||
      function () {
        return Date.now();
      };
    var refreshMs = opts.refreshMs || conf.refreshMs || 30 * 60 * 1000; // 总榜自动刷新周期
    var liveThrottleMs = opts.liveThrottleMs || conf.liveThrottleMs || 20000; // 实时榜最短重复拉取间隔
    var pushTries = opts.pushTries || conf.pushTries || 3;

    var transport =
      opts.transport ||
      TRANSPORT.resolve(opts.provider || null, {
        endpoint: opts.endpoint,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        location: opts.location
      });

    var listeners = [];
    var timer = null;
    var status = transport.name === 'local' ? 'local' : 'idle';
    var lastError = null;
    var inflightPull = null;
    var inflightPush = null;
    var lastLivePullAt = 0;

    function readJson(key, fallback) {
      try {
        var raw = storage && storage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        if (storage) storage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* 存不下不影响玩 */
      }
    }

    var cache = BOARDS.normalizeDoc(readJson(CACHE_KEY, null));
    var pending = readJson(PENDING_KEY, []);
    if (!Array.isArray(pending)) pending = [];
    pending = pending
      .map(function (p) {
        return BOARDS.normalizeRec(p && p.rec ? p.rec : p);
      })
      .filter(Boolean);
    var fetchedAt = Number(readJson(CACHE_AT_KEY, 0)) || 0;

    function saveCache() {
      writeJson(CACHE_KEY, cache);
      writeJson(CACHE_AT_KEY, fetchedAt);
    }

    function savePending() {
      var max = conf.maxPending || 50;
      var list = pending.slice(-max);
      writeJson(
        PENDING_KEY,
        list.map(function (r) {
          return { rec: r };
        })
      );
    }

    function notify() {
      var info = self.info();
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](info);
        } catch (e) {
          /* noop */
        }
      }
    }

    function findRec(rec) {
      var key = BOARDS.recKey(rec);
      var all = cache.top.concat(cache.live);
      for (var i = 0; i < all.length; i++) {
        if (BOARDS.recKey(all[i]) === key) return true;
      }
      return false;
    }

    /* ---------------- 拉取 ---------------- */

    function pull(force) {
      var t = now();
      if (transport.name === 'local') {
        status = 'local';
        notify();
        return Promise.resolve({ ok: false, error: 'local-only', doc: cache, fromCache: true });
      }
      if (!force && !isStale(fetchedAt, t, refreshMs)) {
        return Promise.resolve({ ok: true, doc: cache, fromCache: true });
      }
      if (inflightPull) return inflightPull;

      status = 'loading';
      notify();
      inflightPull = transport
        .pull()
        .then(function (res) {
          if (!res || !res.ok) {
            status = 'error';
            lastError = (res && res.error) || 'pull-failed';
            notify();
            return { ok: false, error: lastError, doc: cache, fromCache: true };
          }
          // 自愈：远端 + 本地缓存合并取优；如果合并结果比远端更全，顺手把修复后的文档写回去
          var merged = BOARDS.mergeDocs(res.doc, cache);
          var repaired = BOARDS.docSize(merged) > BOARDS.docSize(res.doc);
          cache = merged;
          fetchedAt = now();
          status = 'online';
          lastError = null;
          saveCache();
          notify();
          if (repaired && pending.length === 0) {
            transport.push(cache).catch(function () {
              /* 修不回去就算了，下次再说 */
            });
          }
          return { ok: true, doc: cache, fromCache: false, repaired: repaired };
        })
        .then(function (out) {
          inflightPull = null;
          return out;
        });
      return inflightPull;
    }

    /* ---------------- 提交 ---------------- */

    /**
     * 真正把成绩写上去：读最新 → 与本地合并 → 加入自己这条 → 写回 → 再读一次确认。
     * 第三方 KV 没有事务，所以靠「读-合并-写-确认」+ 重试来尽量避免丢成绩。
     */
    function pushRec(rec, maxTries) {
      var tries = maxTries || pushTries;
      if (transport.name === 'local') {
        status = 'local';
        notify();
        return Promise.resolve({ ok: false, error: 'local-only', queued: true });
      }

      function attemptOnce() {
        status = 'uploading';
        notify();
        return transport
          .pull()
          .then(function (res) {
            var base = res && res.ok ? BOARDS.mergeDocs(res.doc, cache) : cache;
            var next = BOARDS.addScore(base, rec, now());
            return transport.push(next, [rec]).then(function (pushed) {
              if (!pushed || !pushed.ok) throw new Error((pushed && pushed.error) || 'push-failed');
              cache = BOARDS.normalizeDoc(pushed.doc || next);
              if (!findRec(rec)) cache = BOARDS.addScore(cache, rec, now());
              saveCache();
              // 再读一次，确认自己的成绩真的在**远端**（本地缓存不算数：
              // 只看本地的话，服务器悄悄丢写也会被误判成成功）
              return transport.pull().then(function (check) {
                if (check && check.ok) {
                  var remote = BOARDS.normalizeDoc(check.doc);
                  var remoteAll = remote.top.concat(remote.live);
                  var onRemote = false;
                  for (var i = 0; i < remoteAll.length; i++) {
                    if (BOARDS.recKey(remoteAll[i]) === BOARDS.recKey(rec)) onRemote = true;
                  }
                  cache = BOARDS.mergeDocs(remote, cache);
                  fetchedAt = now();
                  saveCache();
                  if (!onRemote) throw new Error('verify-missing');
                }
                return { ok: true };
              });
            });
          });
      }

      var n = 0;
      function loop() {
        n += 1;
        return attemptOnce().catch(function (err) {
          if (n >= tries) {
            status = 'error';
            lastError = String((err && err.message) || err);
            notify();
            return { ok: false, error: lastError, queued: true };
          }
          return new Promise(function (r) {
            setTimeout(r, 400 * n + Math.random() * 300);
          }).then(loop);
        });
      }
      return loop();
    }

    function submit(rec) {
      var r = BOARDS.normalizeRec(rec);
      if (!r) return Promise.resolve({ ok: false, error: 'bad-record' });
      if (!r.t) r.t = now();
      // 先本地落一份：界面立刻能看到自己这条（标记待确认），同时进待上传队列
      cache = BOARDS.addScore(cache, r, now());
      saveCache();
      if (transport.name !== 'local') {
        pending.push(r);
        savePending();
      }
      notify();
      if (inflightPush) return inflightPush;
      inflightPush = pushRec(r).then(function (out) {
        inflightPush = null;
        if (out && out.ok) {
          pending = pending.filter(function (x) {
            return BOARDS.recKey(x) !== BOARDS.recKey(r);
          });
          savePending();
          status = 'online';
          lastError = null;
          notify();
          return { ok: true, rank: BOARDS.rankOf(r, cache.top), doc: cache, queued: false };
        }
        notify();
        return out;
      });
      return inflightPush;
    }

    /** 把待上传队列里的成绩都补传一遍 */
    function flush() {
      if (transport.name === 'local' || !pending.length) {
        return Promise.resolve({ ok: true, sent: 0, remaining: pending.length });
      }
      var list = pending.slice(0, 10);
      var i = 0;
      var sent = 0;
      function next() {
        if (i >= list.length) return Promise.resolve({ ok: true, sent: sent, remaining: pending.length });
        var rec = list[i++];
        return pushRec(rec).then(function (out) {
          if (out && out.ok) {
            sent += 1;
            // 补传成功的要从队列里删掉，否则每次同步都会重发一遍
            pending = pending.filter(function (x) {
              return BOARDS.recKey(x) !== BOARDS.recKey(rec);
            });
            savePending();
            notify();
          }
          return next();
        });
      }
      return next();
    }

    function start() {
      if (timer || transport.name === 'local') return;
      timer = setInterval(function () {
        flush().then(function () {
          return pull(true);
        });
      }, refreshMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    var self = {
      name: transport.name,
      provider: transport.name,
      endpoint: transport.endpoint,
      refreshMs: refreshMs,
      transport: transport,
      pull: pull,
      submit: submit,
      flush: flush,
      start: start,
      stop: stop,
      onChange: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      /** 打开榜单面板时调用：实时榜「一打开就是最新的」，但别太频繁 */
      pullLive: function () {
        var t = now();
        if (t - lastLivePullAt < liveThrottleMs) return Promise.resolve({ ok: true, doc: cache, fromCache: true });
        lastLivePullAt = t;
        return pull(true);
      },
      /** 取榜单：live = 最近 20 次提交（按分数排），top = 历史前 100 */
      view: function (kind) {
        if (kind === 'top') return cache.top.slice(0, BOARDS.TOP_MAX);
        return BOARDS.sortTop(cache.live.slice(0, LIVE_SHOW));
      },
      doc: function () {
        return cache;
      },
      pendingRecords: function () {
        return pending.slice();
      },
      pendingCount: function () {
        return pending.length;
      },
      isPending: function (rec) {
        var r = BOARDS.normalizeRec(rec);
        if (!r) return false;
        var key = BOARDS.recKey(r);
        for (var i = 0; i < pending.length; i++) {
          if (BOARDS.recKey(pending[i]) === key) return true;
        }
        return false;
      },
      info: function () {
        var t = now();
        return {
          mode: transport.name === 'local' ? 'local' : 'shared',
          provider: transport.name,
          endpoint: transport.endpoint,
          status: status,
          error: lastError,
          fetchedAt: fetchedAt,
          nextRefreshAt: nextRefreshAt(fetchedAt, refreshMs),
          stale: isStale(fetchedAt, t, refreshMs),
          pendingCount: pending.length,
          liveCount: cache.live.length,
          topCount: cache.top.length,
          updatedAt: cache.u || 0
        };
      },
      cachedEntries: function () {
        return cache.top.slice();
      },
      /** 清空本机保存的榜单（只在 local 模式下给「清空」按钮用） */
      clearCache: function () {
        cache = BOARDS.emptyDoc();
        pending = [];
        fetchedAt = 0;
        saveCache();
        savePending();
        notify();
        return cache;
      },
      reloadCache: function () {
        cache = BOARDS.normalizeDoc(readJson(CACHE_KEY, null));
        pending = (readJson(PENDING_KEY, []) || [])
          .map(function (p) {
            return BOARDS.normalizeRec(p && p.rec ? p.rec : p);
          })
          .filter(Boolean);
        fetchedAt = Number(readJson(CACHE_AT_KEY, 0)) || 0;
        return cache;
      }
    };

    return self;
  }

  return {
    create: create,
    isStale: isStale,
    nextRefreshAt: nextRefreshAt,
    resolveEndpoint: resolveEndpoint,
    LIVE_SHOW: LIVE_SHOW,
    CACHE_KEY: CACHE_KEY,
    PENDING_KEY: PENDING_KEY
  };
});
