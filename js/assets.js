/*!
 * 合成大西瓜 · 贴图运行时
 *
 * 图片**全部内嵌在图库里**（`js/assets-builtin.js` → `window.SUIKA_IMAGE_LIBRARY`），
 * 游戏不再提供「导入图片」的功能：用户在「选图小窗口」里从图库里挑 11 张。
 *
 * 这个文件只干三件事：
 *   1. 载入图库、记住用户的选择（存本地）、算出「第 N 级用哪张图」；
 *   2. 把选中的图片预加载成 Image 对象，供 canvas 渲染；
 *   3. 变化时通知界面重绘。
 *
 * 优先级：用户选择（localStorage） > 图库里的默认图像（defaults） > 没有（用 emoji 默认外观）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SuikaAssets = factory(root);
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
  var LIB = root.SuikaLibrary || tryRequire('./library.js');

  var PICK_KEY = 'suika.pick.v1';

  function create(opts) {
    opts = opts || {};
    var storage = opts.storage || null;

    var library = LIB.normalize(opts.library || root.SUIKA_IMAGE_LIBRARY || null);
    var pick = LIB.sanitizePick(library, readPick());
    var images = {}; // tier -> HTMLImageElement
    var listeners = [];

    function readPick() {
      try {
        var raw = storage && storage.getItem(PICK_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    }

    function savePick() {
      try {
        if (storage) storage.setItem(PICK_KEY, JSON.stringify(pick));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: 'storage' };
      }
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

    /* ---- 查询 ---- */

    /**
     * 把预加载的图片挂进隐藏容器。
     * 这样浏览器的 load 事件会等图片加载完 —— 截图 / 自动化 / 首屏检查才不会
     * 在「图还没到」的时候看到 emoji 兜底外观。
     */
    function attachToPool(img) {
      try {
        if (typeof document === 'undefined' || !document.body) return;
        var pool = document.getElementById('asset-pool');
        if (!pool) {
          pool = document.createElement('div');
          pool.id = 'asset-pool';
          pool.hidden = true;
          pool.setAttribute('aria-hidden', 'true');
          document.body.appendChild(pool);
        }
        if (img.parentNode !== pool) pool.appendChild(img);
      } catch (e) {
        /* 挂不上也不影响游戏 */
      }
    }

    function imageFor(tier) {
      return LIB.resolve(library, pick, tier);
    }

    /** 这一级的图是哪来的：'pick' 用户选的 / 'default' 图库默认 / 'none' 没有 */
    function sourceOf(tier) {
      var t = Math.round(Number(tier));
      var chosen = pick[t];
      if (chosen && LIB.byId(library, chosen)) return 'pick';
      if (library.defaults[t] && LIB.byId(library, library.defaults[t])) return 'default';
      return 'none';
    }

    function urlOf(tier) {
      var img = imageFor(tier);
      return img ? img.src : null;
    }

    /** 选图窗口里用小图（thumb），没有就退回原图 */
    function thumbOf(imgOrTier) {
      var img = typeof imgOrTier === 'object' ? imgOrTier : imageFor(imgOrTier);
      if (!img) return null;
      return img.thumb || img.src;
    }

    /** 这一级玩偶的碰撞轮廓（归一化圆组）；没有就返回 null → 引擎退回圆形碰撞 */
    function shapeOf(tier) {
      var img = imageFor(tier);
      return img && img.shape ? img.shape : null;
    }

    function imageOf(tier) {
      var url = urlOf(tier);
      if (!url) return null;
      var el = images[tier];
      if (el && el.__url === url && el.complete && el.naturalWidth) return el;
      return null;
    }

    function preload(tier) {
      var url = urlOf(tier);
      if (!url) {
        delete images[tier];
        return Promise.resolve(null);
      }
      var existing = images[tier];
      if (existing && existing.__url === url && existing.complete && existing.naturalWidth) {
        return Promise.resolve(existing);
      }
      return new Promise(function (resolve) {
        var img = new Image();
        img.__url = url;
        attachToPool(img);
        img.onload = function () {
          images[tier] = img;
          resolve(img);
        };
        img.onerror = function () {
          resolve(null);
        };
        img.src = url;
      });
    }

    function preloadAll() {
      var list = [];
      for (var t = 1; t <= LIB.TIER_COUNT; t++) list.push(preload(t));
      return Promise.all(list);
    }

    /* ---- 修改选择 ---- */

    /** 把某张图放到某一级（imgId 传 null 表示清空，回到默认图） */
    function setTier(tier, imgId) {
      var t = Math.round(Number(tier));
      if (!(t >= 1 && t <= LIB.TIER_COUNT)) return Promise.resolve({ ok: false, error: 'bad-tier' });
      if (imgId == null) {
        delete pick[t];
      } else {
        var img = LIB.byId(library, String(imgId));
        if (!img) return Promise.resolve({ ok: false, error: 'no-such-image' });
        pick[t] = img.id;
      }
      savePick();
      return preload(t).then(function () {
        notify();
        return { ok: true, tier: t, id: imgId ? String(imgId) : null };
      });
    }

    /** 一键恢复默认图像 */
    function resetToDefaults() {
      pick = {};
      savePick();
      return preloadAll().then(function () {
        notify();
        return { ok: true };
      });
    }

    /** 用一批选择整体替换 */
    function setPick(next) {
      pick = LIB.sanitizePick(library, next);
      savePick();
      return preloadAll().then(function () {
        notify();
        return { ok: true, count: Object.keys(pick).length };
      });
    }

    /** 某一级现在用的是图库里的哪张图（没有就是 null） */
    function idOf(tier) {
      var img = imageFor(tier);
      return img ? img.id : null;
    }

    function filledCount() {
      var n = 0;
      for (var t = 1; t <= LIB.TIER_COUNT; t++) if (imageFor(t)) n += 1;
      return n;
    }

    var self = {
      library: library,
      onChange: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      imageFor: imageFor,
      imageOf: imageOf,
      urlOf: urlOf,
      thumbOf: thumbOf,
      shapeOf: shapeOf,
      idOf: idOf,
      sourceOf: sourceOf,
      preload: preload,
      preloadAll: preloadAll,
      setTier: setTier,
      setPick: setPick,
      resetToDefaults: resetToDefaults,
      pick: function () {
        return Object.assign({}, pick);
      },
      /** 界面用：图库与当前选择的状态 */
      info: function () {
        var st = LIB.stats(library);
        return {
          groups: st.groups,
          libraryImages: st.images,
          libraryBytes: st.bytes,
          fingerprint: st.fingerprint,
          builtAt: st.builtAt,
          defaultCount: st.defaults,
          filled: filledCount(),
          total: LIB.TIER_COUNT,
          picked: Object.keys(pick).length,
          empty: st.images === 0
        };
      }
    };

    // 首次进来先把图片加载好；就绪前渲染层会用 emoji 默认外观
    setTimeout(function () {
      preloadAll().then(notify);
    }, 0);

    return self;
  }

  return { create: create, PICK_KEY: PICK_KEY };
});
