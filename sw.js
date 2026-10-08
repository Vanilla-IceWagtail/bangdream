/*!
 * 合成邦多利皇帝 · Service Worker
 *
 * 为什么需要：线上是 GitHub Pages，响应头是它固定的（静态资源只给 max-age=600），
 * 语音 + 玩偶图加起来十几 MB，每次过期都要重新回源。Service Worker 让浏览器
 * 把资源存在本地：第二次打开基本是「本地直出」，秒开，还能离线玩。
 *
 * 策略（保守、以「不给出旧页面」为第一优先）：
 *   · 页面导航（HTML）→ 网络优先，失败才回缓存。这样每次发版刷新就能拿到新的。
 *   · 其它同源 GET（js/css/图片/语音）→ 缓存优先，命中直接返回，没命中再取网络并存起来。
 *   · 跨域（排行榜 KV）和 /api/* 一律不碰，直接走网络（那些是动态数据）。
 *   · CACHE_VERSION 由 tools/bump-version.cjs 跟着版本号一起改，
 *     这样每次发版都会换一个新缓存，旧的在 activate 里删掉。
 */
'use strict';

var CACHE_VERSION = 'v0.4.28';
var CACHE_NAME = 'suika-doll-' + CACHE_VERSION;

/* 安装时先缓存「打开页面就要用的壳」，语音不预缓存（太大，用到了再存） */
var SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/config.js',
  'js/audio.js',
  'js/library.js',
  'js/assets-builtin.js',
  'js/assets.js',
  'js/boards.js',
  'js/transport.js',
  'js/sync.js',
  'js/engine.js',
  'js/render.js',
  'js/ui.js',
  'js/picker.js',
  'js/game.js',
  'vendor/matter.min.js',
  'assets/icons/bgm.png',
  'assets/icons/bgm-white.png',
  'assets/loading-poster.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        /* 单个失败不影响整体安装（某个文件暂时 404 也不至于装不上） */
        return Promise.all(
          SHELL.map(function (url) {
            return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
              return null;
            });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            /* 只清自己这个前缀的旧版本，别动别人的缓存 */
            if (k.indexOf('suika-doll-') === 0 && k !== CACHE_NAME) return caches.delete(k);
            return null;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  /* 跨域（排行榜 KV 等）和本地 API 一律不接管 */
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  /* 页面导航：网络优先，拿不到再回缓存（保证发版后刷新即更新） */
  var isPage =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0 ||
    /\/$|\.html$/.test(url.pathname);
  if (isPage) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) {
            c.put(req, copy);
          });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('index.html');
          });
        })
    );
    return;
  }

  /* 其它静态资源：缓存优先 */
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        /* 只存成功的同源响应；带 query 的（?v=0.4.24）也照存，反正版本号变了 URL 就变了 */
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) {
            c.put(req, copy);
          });
        }
        return res;
      });
    })
  );
});
