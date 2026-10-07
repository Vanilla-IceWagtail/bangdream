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
    var absent = {}; // key -> true（确定没有这个文件，别再试）
    var pending = {}; // key -> Promise
    var workingExt = null; // 记住第一个成功的扩展名
    var limiter = CFG && CFG.createAudioLimiter ? CFG.createAudioLimiter() : null;
    var played = 0;
    var failed = 0;

    function ensure() {
      if (ctx) return ctx;
      var AC = GLOBAL.AudioContext || GLOBAL.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch (e) {
        ctx = null;
      }
      return ctx;
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
            buffers[name] = audioBuf;
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
      /* 还没加载：后台取一次，这次先让合成音顶上 */
      loadFile(name);
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
          loadFile(name);
        });
      });
    }

    return {
      play: play,
      preload: preload,
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
        return { loaded: Object.keys(buffers).length, absent: Object.keys(absent).length, played: played, failed: failed, ext: workingExt };
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
