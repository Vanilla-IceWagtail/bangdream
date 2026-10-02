/*!
 * 合成邦多利皇帝 · 界面层
 * 只做「把数据画成 DOM」和「弹提示」，游戏逻辑不在这里。
 */
(function (root) {
  'use strict';

  var CFG = root.SuikaConfig;

  function el(id) {
    return document.getElementById(id);
  }

  /* ---------------- 小工具 ---------------- */

  function formatDuration(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function timeAgo(ts) {
    var d = Date.now() - (Number(ts) || 0);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(Number(ts));
    return dt.getMonth() + 1 + '/' + dt.getDate();
  }

  function toast(msg, kind) {
    var wrap = el('toast-wrap');
    if (!wrap) return;
    var node = document.createElement('div');
    node.className = 'toast' + (kind ? ' toast-' + kind : '');
    node.textContent = msg;
    wrap.appendChild(node);
    setTimeout(function () {
      node.classList.add('is-out');
    }, 2400);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 3000);
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 400);
  }

  /* ---------------- 玩偶小图标 ---------------- */

  /** 一颗玩偶的小圆片：有贴图用贴图，没有就画个 emoji 圆 */
  function fruitChip(tier, assets, sizePx) {
    var def = CFG.tierByNumber(tier);
    var node = document.createElement('span');
    node.className = 'fruit-chip';
    var size = Math.max(18, Math.round(sizePx));
    node.style.width = size + 'px';
    node.style.height = size + 'px';
    node.style.fontSize = Math.round(size * 0.62) + 'px';
    if (!def) return node;
    var img = assets ? assets.imageOf(tier) : null;
    if (img) {
      var im = document.createElement('img');
      im.src = img.src;
      im.alt = assets.labelOf ? assets.labelOf(tier) : def.name;
      node.appendChild(im);
      node.classList.add('has-image');
    } else {
      node.style.background = 'radial-gradient(circle at 32% 28%, ' + root.SuikaRender.lighten(def.color, 0.5) + ', ' + def.color + ' 62%, ' + def.edge + ')';
      node.textContent = def.emoji;
    }
    node.title = 'Lv.' + def.tier + ' ' + (assets && assets.labelOf ? assets.labelOf(tier) : def.name) + '（直径 ' + def.r * 2 + 'px）';
    return node;
  }

  function paintPreview(container, tier, assets, scale) {
    if (!container) return;
    container.innerHTML = '';
    var def = CFG.tierByNumber(tier);
    if (!def) {
      var dash = document.createElement('span');
      dash.className = 'preview-empty';
      dash.textContent = '—';
      container.appendChild(dash);
      return;
    }
    var size = Math.max(22, def.r * (scale || 0.52));
    container.appendChild(fruitChip(tier, assets, size));
    var label = document.createElement('span');
    label.className = 'preview-name';
    label.textContent = assets && assets.labelOf ? assets.labelOf(tier) : def.name;
    container.appendChild(label);
  }

  /* ---------------- 玩偶进化表 ---------------- */

  function buildChain(container, assets) {
    if (!container) return;
    container.innerHTML = '';
    CFG.TIERS.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'chain-row';
      li.dataset.tier = t.tier;

      var swatch = document.createElement('span');
      swatch.className = 'chain-swatch';
      swatch.appendChild(fruitChip(t.tier, assets, 28));

      var name = document.createElement('span');
      name.className = 'chain-name';
      name.textContent = assets && assets.labelOf ? assets.labelOf(t.tier) : t.name;

      var size = document.createElement('span');
      size.className = 'chain-size';
      size.textContent = '⌀' + t.r * 2;

      var score = document.createElement('span');
      score.className = 'chain-score';
      score.textContent = t.tier === 1 ? '掉落' : '+' + (t.score || 0);

      var count = document.createElement('span');
      count.className = 'chain-count';
      count.dataset.role = 'count';
      count.textContent = '';

      li.appendChild(swatch);
      li.appendChild(name);
      li.appendChild(size);
      li.appendChild(score);
      li.appendChild(count);
      container.appendChild(li);
    });
  }

  function updateChain(container, maxTier, counts) {
    if (!container) return;
    var rows = container.querySelectorAll('.chain-row');
    for (var i = 0; i < rows.length; i++) {
      var tier = Number(rows[i].dataset.tier);
      rows[i].classList.toggle('is-reached', tier <= (maxTier || 1));
      var c = rows[i].querySelector('[data-role="count"]');
      if (c) {
        var n = counts && counts[tier] ? counts[tier] : 0;
        c.textContent = n ? '×' + n : '';
      }
    }
  }

  /* ---------------- 排行榜 ---------------- */

  function renderLeaderboard(container, list, opts) {
    opts = opts || {};
    if (!container) return;
    container.innerHTML = '';
    if (!list || !list.length) {
      var empty = document.createElement('li');
      empty.className = 'lb-empty';
      empty.textContent = '还没有成绩，玩一局就会出现在这里';
      container.appendChild(empty);
      return;
    }
    list.forEach(function (entry, i) {
      // 记录格式：{ n:昵称, s:分数, d:难度, m:最大玩偶等级, c:最高连击, t:提交时间 }
      var pending = opts.isPending ? !!opts.isPending(entry) : !!entry.pending;
      var key = entry.n + '|' + entry.t + '|' + entry.s;
      var def = CFG.tierByNumber(entry.m) || CFG.tierByNumber(1);
      var li = document.createElement('li');
      li.className = 'lb-item';
      if (key === opts.highlightKey) li.classList.add('is-new');
      if (pending) li.classList.add('is-pending');
      if (i < 3) li.classList.add('lb-top' + (i + 1));

      var rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = pending ? '?' : String(i + 1);

      var name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = entry.n;
      if (entry.d) {
        var diff = document.createElement('span');
        diff.className = 'lb-diff';
        diff.textContent = 'Lv.' + entry.d;
        name.appendChild(diff);
      }

      var fruit = fruitChip(entry.m, opts.assets, 22);
      fruit.classList.add('lb-fruit');

      var score = document.createElement('span');
      score.className = 'lb-score';
      score.textContent = CFG.formatScore(entry.s);

      var when = document.createElement('span');
      when.className = 'lb-when';
      when.textContent = pending ? '待确认' : timeAgo(entry.t);

      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(fruit);
      li.appendChild(score);
      li.appendChild(when);
      li.title =
        '最大棉花娃娃：' +
        def.name +
        ' · 难度 Lv.' +
        (entry.d || '-') +
        (entry.c ? ' · 最高连击 ×' + entry.c : '') +
        ' · ' +
        (pending ? '成绩已提交，等下次同步确认名次' : timeAgo(entry.t));
      container.appendChild(li);
    });
  }

  /* ---------------- 覆盖层 ---------------- */

  var hideTimer = null; // 「延迟隐藏」定时器：见 hideOverlay 的说明

  function showOverlay(opts) {
    var overlay = el('overlay');
    var title = el('overlay-title');
    var body = el('overlay-body');
    var actions = el('overlay-actions');
    if (!overlay) return;
    if (title) title.innerHTML = opts.title || '';
    if (body) body.innerHTML = opts.body || '';
    if (actions) {
      actions.innerHTML = '';
      (opts.actions || []).forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.kind === 'primary' ? 'btn-primary' : a.kind === 'ghost' ? 'btn-ghost' : '');
        b.textContent = a.label;
        b.addEventListener('click', function () {
          a.onClick && a.onClick();
        });
        actions.appendChild(b);
      });
    }
    // 上一次关闭留下的「延迟隐藏」要撤销，否则它会把这次刚打开的遮罩又藏起来
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    overlay.hidden = false;
    overlay.classList.add('is-open');
    markOverlayOpen(true);
  }

  /**
   * 弹窗开关时给 <body> 挂/摘标记，手机端棋盘里的浮动「即将投放」靠它让位。
   *
   * 为什么不只靠 z-index：实测把 .overlay 提到 z-index:30（浮动层是 6）之后，
   * 带 backdrop-filter 的遮罩在 Firefox 里**仍然**被浮层的玩偶图标压住，
   * 所以这里加一道确定性的保险：弹窗期间直接不让那个浮层显示。
   */
  function markOverlayOpen(on) {
    if (typeof document === 'undefined' || !document.body || !document.body.classList) return;
    document.body.classList.toggle('has-overlay', !!on);
  }

  function hideOverlay() {
    var overlay = el('overlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    /*
     * 这里故意延迟 180ms 再真正 hidden（等淡出动画放完）。
     * 但「开始游戏」这类流程 hide 完紧接着又会 show（比如本局结束弹结算），
     * 所以定时器要能被 showOverlay 取消，触发时也要再确认没被重新打开 ——
     * 否则结算画面会被上一次的定时器偷偷藏掉。
     */
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (!overlay.classList.contains('is-open')) {
        overlay.hidden = true;
        /* 真正藏掉之后，才让浮动「即将投放」回来（淡出期间先别闪一下） */
        markOverlayOpen(false);
      }
    }, 180);
  }


  /* ---------------- 对外 ---------------- */

  root.SuikaUI = {
    el: el,
    toast: toast,
    download: download,
    formatDuration: formatDuration,
    formatBytes: formatBytes,
    timeAgo: timeAgo,
    fruitChip: fruitChip,
    paintPreview: paintPreview,
    buildChain: buildChain,
    updateChain: updateChain,
    renderLeaderboard: renderLeaderboard,
    showOverlay: showOverlay,
    hideOverlay: hideOverlay
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
