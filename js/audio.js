/*!
 * 合成邦多利皇帝 · 音频加载器（可选的文件音效）
 *
 * 设计原则：**零配置、缺文件不报错**
 *   · 把音频按约定命名丢进 assets/audio/ 就会被自动使用；
 *   · 没有文件（或浏览器不支持、file:// 打开取不到）就返回 null，
 *     调用方（js/game.js 的 createSfx）自动退回 WebAudio 现场合成的那套音。
 *   · 懒加载：第一次要播才去取那个文件，不会开机就把几十个音频全解码了。
 *   · 格式回退：按 AUDIO.formats 的顺序试（建议 opus → m4a → mp3），
 *     记住第一个成功的扩展名，后面直接用，不会每个音都试三遍。
 *   · 限流复用 js/config.js 的 createAudioLimiter（并发 8 / 全局 18ms / 同音 45ms）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SuikaAudio = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* 工厂函数里拿不到外层的 root，这里自己取一份（浏览器 / node 都能跑） */
  var GLOBAL = typeof window !== 'undefined' ? window : globalThis;

  function create(opts) {
    var CFG = (opts && opts.config) || (typeof window !== 'undefined' ? window.SuikaConfig : null);
    var conf = (CFG && CFG.AUDIO) || {};
    var base = (opts && opts.base) || conf.base || 'assets/audio/';
    var formats = (opts && opts.formats) || conf.formats || ['opus', 'm4a', 'mp3'];
    var sounds = (opts && opts.sounds) || conf.sounds || {};
    var fetchFn = (opts && opts.fetch) || (typeof fetch === 'function' ? fetch : null);

    var ctx = null;
    var buffers = {}; // key -> AudioBuffer（已解码）
    var rawCache = {}; // name -> ArrayBuffer（已下载、未解码；加载页预取用）
    var retryable = {}; // name -> true（网络原因失败，可以再补一轮）
    var bufferOrder = []; // 解码缓存的 LRU 顺序（防止切很多角色后内存无限涨）
    var absent = {}; // key -> true（确定没有这个文件，别再试）
    var pending = {}; // key -> Promise
    var workingExt = null; // 记住第一个成功的扩展名
    var limiter = CFG && CFG.createAudioLimiter ? CFG.createAudioLimiter() : null;
    var played = 0;
    var failed = 0;

    /*
     * 解码队列：并发解码会卡主线程（游戏循环也在主线程上），
     * 所以限制同时只解一两个，其它排队；空闲时再继续。
     */
    var decodeQueue = [];
    var decoding = 0;
    var MAX_DECODE = 2;
    var MAX_BUFFERS = Math.max(4, Number(opts && opts.maxBuffers) || 64); // 解码缓存上限（每个约 0.2MB）

    function ensure() {
      if (ctx) return ctx;
      var AC = GLOBAL.AudioContext || GLOBAL.webkitAudioContext;
      if (!AC) return null;
      try {
        /* latencyHint: 'interactive' —— 让浏览器用最小的音频缓冲，降低发声延迟 */
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        try {
          ctx = new AC();
        } catch (e2) {
          ctx = null;
        }
      }
      return ctx;
    }

    /** 把解码任务排队（并发上限之内立刻开工） */
    function enqueueDecode(name) {
      if (decoding >= MAX_DECODE) {
        if (decodeQueue.indexOf(name) < 0) decodeQueue.push(name);
        return;
      }
      decoding += 1;
      loadFile(name).then(function () {
        decoding -= 1;
        var next = decodeQueue.shift();
        if (next) enqueueDecode(next);
      });
    }

    /** 解码缓存满了就丢最早用过的（正在播的 source 自己持有引用，安全） */
    function rememberBuffer(name, buf) {
      if (!buffers[name]) bufferOrder.push(name);
      buffers[name] = buf;
      while (bufferOrder.length > MAX_BUFFERS) {
        var old = bufferOrder.shift();
        if (old !== name) delete buffers[old];
      }
    }

    /** 音效配置：{ files:[...] } 或 { perTier:true, pattern:'merge-{tier}' } */
    function defOf(key) {
      var d = sounds[key];
      if (!d) return null;
      return typeof d === 'string' ? { files: [d] } : d;
    }

    function fileListFor(key, tier, id) {
      var d = defOf(key);
      if (!d) return null;
      /* 按玩偶 ID：assets/voice/<id>/drop-1.mp3 …（玩家换阵容也跟着换） */
      if (d.perDoll) {
        if (!id) return null;
        var dir = String(d.dir || '{id}/').replace('{id}', id);
        var cnt = Math.max(1, Number(d.count) || 1);
        var list = [];
        for (var k = 1; k <= cnt; k++) list.push(dir + String(d.pattern || key + '-{n}').replace('{n}', String(k)));
        return list;
      }
      if (d.perTier) {
        var pat = d.pattern || key + '-{tier}';
        var t = String(tier == null ? 1 : tier);
        var n = Math.max(1, Number(d.variants) || 1);
        var out = [];
        if (n === 1) out.push(pat.replace('{tier}', t));
        else for (var i = 1; i <= n; i++) out.push(pat.replace('{tier}', t) + '-' + i);
        /* 该级没有语音时，允许退回通用候选（比如 drop-1/2/3） */
        return out.concat(d.files || []);
      }
      return d.files || null;
    }

    /** 取一个文件并解码；失败就标记 absent 并返回 null */
    function loadFile(name) {
      if (buffers[name]) return Promise.resolve(buffers[name]);
      if (absent[name]) return Promise.resolve(null);
      if (pending[name]) return pending[name];
      if (!fetchFn) {
        absent[name] = true;
        return Promise.resolve(null);
      }
      var ac = ensure();
      if (!ac) {
        absent[name] = true;
        return Promise.resolve(null);
      }
      /*
       * 内联数据优先：语音试听页会加载 assets/voice-inline.js，把语音做成 data URL。
       * 这样**双击 HTML**（file://）也能发声 —— 浏览器不允许 file:// 页面 fetch 本地文件。
       * 正式页（有服务器）不走这条，仍按扩展名顺序取真实文件。
       */
      var inline = GLOBAL.SUIKA_VOICE_DATA;
      if (inline && inline[name]) {
        pending[name] = fetchFn(inline[name])
          .then(function (res) {
            return res.arrayBuffer();
          })
          .then(function (buf) {
            return new Promise(function (resolve, reject) {
              var ret = ac.decodeAudioData(buf, resolve, reject);
              if (ret && ret.then) ret.then(resolve, reject);
            });
          })
          .then(function (audioBuf) {
            rememberBuffer(name, audioBuf);
            return audioBuf;
          })
          .catch(function () {
            absent[name] = true;
            return null;
          })
          .then(function (b) {
            delete pending[name];
            return b;
          });
        return pending[name];
      }

      /*
       * 已经有原始字节（加载页预取过）就直接解码，不再走网络 ——
       * 这样「所有语音都预取好、按需解码」既能保证不缺音，又不会把内存吃光。
       */
      if (rawCache[name]) {
        pending[name] = new Promise(function (resolve) {
          resolve(rawCache[name]);
        })
          .then(function (buf) {
            return new Promise(function (resolve, reject) {
              var ret = ac.decodeAudioData(buf, resolve, reject);
              if (ret && ret.then) ret.then(resolve, reject);
            });
          })
          .then(function (audioBuf) {
            rememberBuffer(name, audioBuf);
            return audioBuf;
          })
          .catch(function () {
            absent[name] = true;
            return null;
          })
          .then(function (b) {
            delete pending[name];
            return b;
          });
        return pending[name];
      }

      var order = workingExt ? [workingExt].concat(formats.filter(function (f) { return f !== workingExt; })) : formats;
      var i = 0;
      var tryNext = function () {
        if (i >= order.length) {
          absent[name] = true;
          failed += 1;
          return Promise.resolve(null);
        }
        var url = base + name + '.' + order[i++];
        return fetchFn(url)
          .then(function (res) {
            if (!res || !res.ok) throw new Error('http ' + (res && res.status));
            return res.arrayBuffer();
          })
          .then(function (buf) {
            return new Promise(function (resolve, reject) {
              /* 老 Safari 只有回调版 decodeAudioData */
              var ret = ac.decodeAudioData(buf, resolve, reject);
              if (ret && ret.then) ret.then(resolve, reject);
            });
          })
          .then(function (audioBuf) {
            rememberBuffer(name, audioBuf);
            workingExt = order[i - 1];
            return audioBuf;
          })
          .catch(tryNext);
      };
      pending[name] = tryNext().then(function (b) {
        delete pending[name];
        return b;
      });
      return pending[name];
    }

    function playBuffer(buf, key, volume) {
      var ac = ensure();
      if (!ac || !buf) return false;
      var src = ac.createBufferSource();
      var gain = ac.createGain();
      src.buffer = buf;
      var vol = volume == null ? (defOf(key) && defOf(key).volume) || 0.6 : volume;
      gain.gain.value = vol;
      src.connect(gain);
      gain.connect(ac.destination);
      src.start(0);
      played += 1;
      /*
       * 播完必须把声部还回限流器！
       * 不还的话：播过 maxVoices(8) 次文件音之后，限流器就认为声部被占满，
       * 之后**所有**声音（连合成音一起）都会被永久挡死 ——
       * 表现就是「玩一会儿之后偶尔/一直没声音」。真踩过这个坑。
       */
      if (limiter && limiter.release) {
        var done = function () {
          limiter.release();
        };
        if (src.onended !== undefined) src.onended = done;
        else if (GLOBAL.setTimeout) GLOBAL.setTimeout(done, ((buf.duration || 0.5) + 0.1) * 1000);
      }
      return true;
    }

    /**
     * 播一个音：能拿到文件就放文件，否则返回 false（调用方退回合成音）。
     * 注意：第一次调用是「异步取文件」，所以这一次一定返回 false —— 也就是说
     * 某个音第一次触发会先用合成音顶上，之后再触发就是文件音了（听感上察觉不到）。
     */
    function play(key, o) {
      o = o || {};
      var d = defOf(key);
      if (!d) return false;
      var list = fileListFor(key, o.tier, o.id);
      if (!list || !list.length) return false;
      var vol = o.volume == null ? d.volume : o.volume;

      /* 候选里排除已经确定没有的，优先用已经解码好的（多变体时随机挑一条） */
      var usable = list.filter(function (n) {
        return !absent[n];
      });
      if (!usable.length) return false;
      var ready = usable.filter(function (n) {
        return !!buffers[n];
      });
      var pool = ready.length ? ready : usable;
      var name = pool[Math.floor(Math.random() * pool.length)];

      if (buffers[name]) {
        var ac = ensure();
        var now = ac ? ac.currentTime * 1000 : 0;
        if (limiter && !limiter.allow(key + name, now)) return true; // 限流挡下：算「已处理」，不要再退回合成了
        return playBuffer(buffers[name], key, vol);
      }
      /* 还没加载：后台取一次（排队解码，别卡住这一帧），这次先让合成音顶上 */
      enqueueDecode(name);
      return false;
    }

    /**
     * 预加载（失败无所谓）。
     *   preload(['warn', 'over'])                     —— 固定名字的音效
     *   preload(['drop', 'merge'], { id: 'roselia-01' }) —— 某个角色的语音池
     * 已经预热过的组合会记住，不会重复发请求。
     */
    var preloaded = {};
    function preload(keys, o) {
      var id = o && o.id;
      (keys || []).forEach(function (k) {
        var list = fileListFor(k, 1, id) || [];
        list.forEach(function (name) {
          if (preloaded[name]) return;
          preloaded[name] = true;
          enqueueDecode(name);
        });
      });
    }

    /** 列出某个 key（可带 id）会用到哪些文件 —— 加载页要用它算总数 */
    function nameList(keys, o) {
      var out = [];
      (keys || []).forEach(function (k) {
        (fileListFor(k, o && o.tier, o && o.id) || []).forEach(function (n) {
          if (out.indexOf(n) < 0) out.push(n);
        });
      });
      return out;
    }

    /**
     * 批量预加载（加载页用）：把清单里的文件全部取下来并解码，边做边报进度。
     * 并发仍受 MAX_DECODE 限制，避免解码把主线程卡住。
     */
    function preloadMany(names, onProgress) {
      var queue = (names || []).slice();
      var total = queue.length;
      var done = 0;
      if (!total) return Promise.resolve({ total: 0, done: 0 });
      function worker() {
        if (!queue.length) return Promise.resolve();
        var name = queue.shift();
        return loadFile(name).then(function () {
          done += 1;
          if (onProgress) {
            try {
              onProgress(done, total);
            } catch (e) {
              /* 进度回调的异常不该影响加载 */
            }
          }
          return worker();
        });
      }
      var workers = [];
      for (var i = 0; i < MAX_DECODE; i++) workers.push(worker());
      return Promise.all(workers).then(function () {
        return { total: total, done: done };
      });
    }

    /**
     * 只下载、不解码（加载页把「所有语音」都拉下来时用）。
     *
     * 为什么不直接解码全部：解码后是 Float32 PCM 常驻内存，
     * 一条 2~3 秒的语音就 ≈1MB，全部 300 条 ≈ 几百 MB，手机会直接崩。
     * 所以策略是：**全部下载**（合计约 7MB，随便放）+ **按需解码**（LRU 上限内）。
     */
    function prefetchFile(name) {
      if (rawCache[name]) return Promise.resolve(rawCache[name]);
      if (absent[name]) return Promise.resolve(null);
      if (!fetchFn) {
        absent[name] = true;
        return Promise.resolve(null);
      }
      if (typeof pending['raw:' + name] !== 'undefined') return pending['raw:' + name];
      /* 注意：必须是**本次调用**的局部变量 —— 4 个并发下载共用一个标志时，
         别的文件 404 会把本文件也误判成 404，该重试的语音就被永久跳过了（真踩过） */
      var was404 = false;
      var order = workingExt ? [workingExt].concat(formats.filter(function (f) { return f !== workingExt; })) : formats;
      var i = 0;
      var tryNext = function () {
        if (i >= order.length) {
          /*
           * 全部扩展名都失败：要分清两种情况 ——
           *   · 真的没有这个文件（404）→ 记 absent，以后不再试；
           *   · 网络问题（断网/超时/5xx）→ 记 retryable，等会儿还能补一轮。
           * 手机上网络抖动很常见，混为一谈的话语音就会「缺一块」且永远补不回来。
           */
          if (was404) absent[name] = true;
          else retryable[name] = true;
          return null;
        }
        var url = base + name + '.' + order[i++];
        return fetchFn(url)
          .then(function (res) {
            if (!res || !res.ok) {
              was404 = !!res && res.status === 404;
              throw new Error('http ' + (res && res.status));
            }
            return res.arrayBuffer();
          })
          .then(function (buf) {
            rawCache[name] = buf;
            workingExt = order[i - 1];
            delete retryable[name];
            return buf;
          })
          .catch(tryNext);
      };
      pending['raw:' + name] = tryNext().then(function (b) {
        delete pending['raw:' + name];
        return b;
      });
      return pending['raw:' + name];
    }

    /**
     * 补一轮：把「因为网络原因没拿到」的再试一次，返回还剩几条第不到。
     * 加载页用它来确保「真加载完了才消失」。
     */
    function retryMissing(names) {
      var missing = (names || []).filter(function (n) {
        return !rawCache[n] && !absent[n];
      });
      if (!missing.length) return Promise.resolve({ remaining: 0 });
      missing.forEach(function (n) {
        delete retryable[n];
      });
      return prefetchMany(missing).then(function () {
        var left = missing.filter(function (n) {
          return !rawCache[n] && !absent[n];
        });
        return { remaining: left.length };
      });
    }

    /** 批量预取（下载）。并发放宽到 4（下载是 I/O，不像解码那样占主线程） */
    function prefetchMany(names, onProgress) {
      var queue = (names || []).slice();
      var total = queue.length;
      var done = 0;
      if (!total) return Promise.resolve({ total: 0, done: 0 });
      function worker() {
        if (!queue.length) return Promise.resolve();
        var name = queue.shift();
        return prefetchFile(name).then(function () {
          done += 1;
          if (onProgress) {
            try {
              onProgress(done, total);
            } catch (e) {
              /* 忽略 */
            }
          }
          return worker();
        });
      }
      var workers = [];
      for (var k = 0; k < 4; k++) workers.push(worker());
      return Promise.all(workers).then(function () {
        return { total: total, done: done, bytes: 0 };
      });
    }

    return {
      play: play,
      preload: preload,
      preloadMany: preloadMany,
      prefetchMany: prefetchMany,
      retryMissing: retryMissing,
      nameList: nameList,
      rawCount: function () {
        return Object.keys(rawCache).length;
      },
      /** 某个 key 的音频是否已经就绪（测试/自检用） */
      isReady: function (key, tier, id) {
        var list = fileListFor(key, tier, id) || [];
        return list.some(function (n) {
          return !!buffers[n];
        });
      },
      loadedCount: function () {
        return Object.keys(buffers).length;
      },
      stats: function () {
        return {
          loaded: Object.keys(buffers).length,
          absent: Object.keys(absent).length,
          played: played,
          failed: failed,
          ext: workingExt,
          queued: decodeQueue.length + decoding,
          baseLatency: ctx && ctx.baseLatency != null ? Math.round(ctx.baseLatency * 1000) : null,
          outputLatency: ctx && ctx.outputLatency != null ? Math.round(ctx.outputLatency * 1000) : null
        };
      },
      context: function () {
        return ctx;
      },
      unlock: function () {
        var ac = ensure();
        if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
        return !!ac;
      },
      suspend: function () {
        if (ctx && ctx.state === 'running' && ctx.suspend) ctx.suspend();
      },
      resume: function () {
        if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
      },
      /** 仅供测试：塞一个已经解码好的 buffer */
      _put: function (name, buf) {
        buffers[name] = buf;
      }
    };
  }

  return { create: create };
});
