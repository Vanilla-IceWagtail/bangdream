/*!
 * 合成邦多利皇帝 · 图片库（纯函数）
 *
 * 图片不再是「用户自己导入」，而是**内嵌在游戏里的一个图库**（`js/assets-builtin.js` 里的
 * `window.SUIKA_IMAGE_LIBRARY`），用户在「选图小窗口」里从图库里挑 11 张，分别放到 11 个玩偶位上。
 *
 * 图库结构：
 *   {
 *     version: 1,
 *     builtAt: '2026-01-01T00:00:00.000Z',
 *     groups:  [ { id:'g1', name:'第一组', desc:'给你看的分组说明' }, ... ],   // 分组由你（用户）来定
 *     images:  [ { id:'i01', file:'01-cherry.png', group:'g1', w:512, h:512, src:'data:image/webp;base64,...' }, ... ],
 *     defaults:{ '1':'i01', '2':'i02', ... }   // 默认图像：开局就用这几张，用户可以在窗口里换
 *   }
 *
 * 用户当前的选择存在浏览器本地（`suika.pick.v1`）：{ '1':'i07', ... }，换图不影响图库本身。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SuikaLibrary = factory(root);
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

  var TIER_COUNT = 11;

  function emptyLibrary() {
    return { version: 0, builtAt: null, fingerprint: '--------', groups: [], images: [], defaults: {} };
  }

  function isDataImage(s) {
    return typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif|avif|bmp);base64,/i.test(s);
  }

  /** 图库里的图片可以是内联 base64，也可以是仓库内的相对路径（玩偶版 45 张就是这么放的） */
  function isSafePath(s) {
    if (typeof s !== 'string' || !s) return false;
    if (/^[a-z]+:/i.test(s) && !/^data:/i.test(s)) return false; // 禁掉 http(s): 等外部协议
    if (s.indexOf('..') >= 0) return false;
    if (s.charAt(0) === '/' || s.charAt(0) === '\\') return false;
    return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(s);
  }

  function isUsableSrc(s) {
    return isDataImage(s) || isSafePath(s);
  }

  /** 图片库指纹：同一套图得到同样的 16 位指纹（用来确认「就是这个版本」） */
  function fingerprint(images) {
    var str = '';
    var list = (images || []).slice().sort(function (a, b) {
      return String(a.id).localeCompare(String(b.id));
    });
    for (var i = 0; i < list.length; i++) {
      str += list[i].id + '|' + (list[i].file || '') + '|' + String(list[i].src || '').length + '\n';
    }
    if (!str) return '--------';
    function fnv(text, seed) {
      var h = seed >>> 0;
      for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return ('00000000' + h.toString(16)).slice(-8);
    }
    return fnv(str, 2166136261) + fnv(str, 16777619);
  }

  function clampInt(v, min, max, fallback) {
    var n = Math.floor(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** 把外部数据洗成合法图库：id 唯一、分组存在、src 必须是内联图片 */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return emptyLibrary();
    var groups = [];
    var groupIds = {};
    var rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
    for (var i = 0; i < rawGroups.length; i++) {
      var g = rawGroups[i];
      if (!g || typeof g !== 'object') continue;
      var gid = String(g.id || 'g' + (i + 1));
      if (groupIds[gid]) continue;
      groupIds[gid] = true;
      groups.push({ id: gid, name: String(g.name || gid), desc: String(g.desc || '') });
    }

    var images = [];
    var seen = {};
    var rawImages = Array.isArray(raw.images) ? raw.images : [];
    for (var j = 0; j < rawImages.length; j++) {
      var it = rawImages[j];
      if (!it || typeof it !== 'object') continue;
      if (!isUsableSrc(it.src)) continue;
      var id = String(it.id || 'i' + (j + 1));
      if (seen[id]) continue;
      seen[id] = true;
      images.push({
        id: id,
        name: String(it.name || it.file || id),
        file: String(it.file || it.name || id),
        group: groupIds[String(it.group)] ? String(it.group) : groups.length ? groups[0].id : 'default',
        w: clampInt(it.w, 1, 8192, 0) || 0,
        h: clampInt(it.h, 1, 8192, 0) || 0,
        note: String(it.note || ''),
        src: it.src,
        thumb: isSafePath(it.thumb) || isDataImage(it.thumb) ? it.thumb : null,
        // 碰撞轮廓（玩偶版）：{ circles:[{x,y,r}], coverage } —— 归一化坐标
        shape: it.shape && Array.isArray(it.shape.circles) && it.shape.circles.length > 1 ? {
          circles: it.shape.circles.map(function (c) {
            return { x: Number(c.x) || 0, y: Number(c.y) || 0, r: Math.max(0.004, Number(c.r) || 0) };
          }),
          coverage: Number(it.shape.coverage) || 0
        } : null
      });
    }
    // 有图但没有分组时，补一个「未分组」，保证界面永远有东西可选
    if (images.length && !groups.length) {
      groups.push({ id: 'default', name: '未分组', desc: '' });
      images.forEach(function (img) {
        img.group = 'default';
      });
    }

    var defaults = {};
    var rawDefaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
    Object.keys(rawDefaults).forEach(function (k) {
      var tier = Math.round(Number(k));
      if (!(tier >= 1 && tier <= TIER_COUNT)) return;
      var imgId = String(rawDefaults[k]);
      if (seen[imgId]) defaults[tier] = imgId;
    });
    // 没给默认图就按顺序自动铺满，省得开局一批空位
    if (!Object.keys(defaults).length && images.length) {
      for (var t = 1; t <= TIER_COUNT; t++) {
        var pick = images[(t - 1) % images.length];
        if (pick) defaults[t] = pick.id;
      }
    }

    return {
      version: clampInt(raw.version, 0, 999, 1),
      builtAt: raw.builtAt ? String(raw.builtAt) : null,
      fingerprint: raw.fingerprint ? String(raw.fingerprint) : fingerprint(images),
      groups: groups,
      images: images,
      defaults: defaults
    };
  }

  function byId(lib, id) {
    var list = (lib && lib.images) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function groupsOf(lib) {
    var groups = (lib && lib.groups) || [];
    var images = (lib && lib.images) || [];
    return groups.map(function (g) {
      return {
        id: g.id,
        name: g.name,
        desc: g.desc,
        count: images.filter(function (im) {
          return im.group === g.id;
        }).length
      };
    });
  }

  function imagesOf(lib, groupId) {
    var images = (lib && lib.images) || [];
    if (!groupId || groupId === '*') return images.slice();
    return images.filter(function (im) {
      return im.group === groupId;
    });
  }

  /** 用户选择里指向已不存在的图片时丢掉（图库换版本之后不会错位） */
  function sanitizePick(lib, pick) {
    var out = {};
    if (!pick || typeof pick !== 'object') return out;
    Object.keys(pick).forEach(function (k) {
      var tier = Math.round(Number(k));
      if (!(tier >= 1 && tier <= TIER_COUNT)) return;
      var imgId = String(pick[k]);
      if (byId(lib, imgId)) out[tier] = imgId;
    });
    return out;
  }

  /** 某一级最终用哪张图：用户选的优先，其次默认图 */
  function resolve(lib, pick, tier) {
    var t = Math.round(Number(tier));
    if (!(t >= 1 && t <= TIER_COUNT)) return null;
    var clean = sanitizePick(lib, pick);
    var id = clean[t] || ((lib && lib.defaults) || {})[t];
    return id ? byId(lib, id) : null;
  }

  /** 11 个玩偶位：颜色 / 名字 / 直径 / 得分 —— 窗口里的槽位和图例都用它 */
  function slots() {
    var tiers = (CFG ? CFG.TIERS : []) || [];
    return tiers.map(function (t) {
      return {
        tier: t.tier,
        name: t.name,
        emoji: t.emoji,
        color: t.color,
        edge: t.edge,
        diameter: t.r * 2,
        radius: t.r,
        score: t.score,
        // 想让图看起来清楚，图片最长边最好是直径的 2 倍以上
        wantedEdge: t.r * 4
      };
    });
  }

  function slotOf(tier) {
    var list = slots();
    for (var i = 0; i < list.length; i++) {
      if (list[i].tier === Math.round(Number(tier))) return list[i];
    }
    return null;
  }

  /**
   * 尺寸质量提示：这张图放到这一级够不够清楚。
   * 图片在游戏里是按圆形等比铺满的，边太小的图放大会糊。
   */
  function qualityHint(img, tier) {
    var slot = slotOf(tier);
    if (!img || !slot) return null;
    var edge = Math.max(Number(img.w) || 0, Number(img.h) || 0);
    if (!edge) return { ok: true, ratio: 0, text: '尺寸未知' };
    var ratio = edge / slot.wantedEdge;
    if (ratio >= 1) return { ok: true, ratio: ratio, text: '清晰度足够' };
    if (ratio >= 0.6) return { ok: true, ratio: ratio, text: '略小，能用' };
    return { ok: false, ratio: ratio, text: '偏小，放大后会糊' };
  }

  function stats(lib) {
    var images = (lib && lib.images) || [];
    var bytes = images.reduce(function (n, im) {
      return n + Math.floor(String(im.src || '').length * 0.75);
    }, 0);
    return {
      groups: ((lib && lib.groups) || []).length,
      images: images.length,
      bytes: bytes,
      fingerprint: (lib && lib.fingerprint) || '--------',
      builtAt: (lib && lib.builtAt) || null,
      defaults: Object.keys((lib && lib.defaults) || {}).length
    };
  }

  /** 哪些玩偶位还没图（1 起的等级数组）；用来提示「还没选满 11 张」 */
  function missingSlots(lib, pick) {
    var out = [];
    for (var t = 1; t <= TIER_COUNT; t++) {
      if (!resolve(lib, pick, t)) out.push(t);
    }
    return out;
  }

  /** 选满了没有（图库是空的就不算「没选满」，免得一直弹提示） */
  function isComplete(lib, pick) {
    if (!lib || !(lib.images || []).length) return true;
    return missingSlots(lib, pick).length === 0;
  }

  return {
    TIER_COUNT: TIER_COUNT,
    emptyLibrary: emptyLibrary,
    normalize: normalize,
    fingerprint: fingerprint,
    isDataImage: isDataImage,
    isUsableSrc: isUsableSrc,
    isSafePath: isSafePath,
    byId: byId,
    groupsOf: groupsOf,
    imagesOf: imagesOf,
    sanitizePick: sanitizePick,
    resolve: resolve,
    slots: slots,
    slotOf: slotOf,
    qualityHint: qualityHint,
    stats: stats,
    missingSlots: missingSlots,
    isComplete: isComplete
  };
});
