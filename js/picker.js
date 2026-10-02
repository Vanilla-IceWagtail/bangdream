/*!
 * 合成大西瓜 · 选图小窗口
 *
 * 需求（用户提的）：
 *   1. 单独开一个小窗口，从图库里自由挑 11 张；
 *   2. 图库按「分组」分类展示（分组由用户定义，写在内嵌图库的 groups 里）；
 *   3. 图库里有「默认图像」，窗口里能一键恢复默认；
 *   4. 不做「导入图片」——图片全内嵌，这里只负责挑；
 *   5. 颜色代表水果（西瓜/菠萝/樱桃…），尺寸直接标在图和水果位上（🍉西瓜 ⌀250）。
 *
 * 交互：
 *   · 点图片库里的图 → 选中；再点左边的水果位 → 放上去（也可以直接把图拖到水果位上）；
 *   · 水果位右边的 ✕ 表示清空，回到图库默认图；
 *   · 窗口可以拖动（按住标题栏）和折叠，方便一边看游戏一边挑图；
 *   · 没选满 11 个位子就关窗口时会弹一句提醒（图库是空的就不烦人）。
 */
(function (root) {
  'use strict';

  var CFG = root.SuikaConfig;
  var LIB = root.SuikaLibrary;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function create(opts) {
    var assets = opts.assets;
    var ui = opts.ui || root.SuikaUI;
    var onChanged = opts.onChanged || function () {};

    var state = {
      open: false,
      collapsed: false,
      group: '*',
      selectedId: null,
      lastTier: 0,
      askedIncomplete: false
    };

    /* ---------------- DOM ---------------- */

    var win = el('div', 'pk-window');
    win.id = 'picker-window';
    win.hidden = true;

    var bar = el('header', 'pk-bar');
    var title = el('span', 'pk-title', '🖼 选图窗口');
    var subtitle = el('span', 'pk-subtitle', '从图库里挑 11 张放到棉花娃娃位上');
    var barActions = el('div', 'pk-bar-actions');
    var btnCollapse = el('button', 'btn btn-mini btn-ghost', '折叠');
    btnCollapse.type = 'button';
    var btnDefaults = el('button', 'btn btn-mini', '恢复默认');
    btnDefaults.type = 'button';
    var btnClose = el('button', 'btn btn-mini', '关闭');
    btnClose.type = 'button';
    barActions.appendChild(btnCollapse);
    barActions.appendChild(btnDefaults);
    barActions.appendChild(btnClose);
    bar.appendChild(title);
    bar.appendChild(subtitle);
    bar.appendChild(barActions);

    var body = el('div', 'pk-body');

    // 左：11 个水果位
    var colSlots = el('section', 'pk-col pk-col-slots');
    var slotsHead = el('div', 'pk-col-head');
    slotsHead.appendChild(el('b', null, '11 个棉花娃娃位'));
    slotsHead.appendChild(el('span', 'pk-head-hint', '颜色 = 棉花娃娃 = 大小'));
    var slotList = el('ol', 'pk-slots');
    colSlots.appendChild(slotsHead);
    colSlots.appendChild(slotList);

    // 右：图片库
    var colLib = el('section', 'pk-col pk-col-lib');
    var libHead = el('div', 'pk-col-head');
    libHead.appendChild(el('b', null, '图片库'));
    var libStat = el('span', 'pk-head-hint', '');
    libHead.appendChild(libStat);
    var groupTabs = el('div', 'pk-groups');
    var tileList = el('ol', 'pk-tiles');
    colLib.appendChild(libHead);
    colLib.appendChild(groupTabs);
    colLib.appendChild(tileList);

    body.appendChild(colSlots);
    body.appendChild(colLib);

    // 「还没选满」的提醒（贴在窗口里，不另外弹系统对话框）
    var confirmBox = el('div', 'pk-confirm');
    confirmBox.hidden = true;
    var confirmCard = el('div', 'pk-confirm-card');
    var confirmTitle = el('b', 'pk-confirm-title', '');
    var confirmNote = el('span', 'pk-confirm-note', '没选的位子会沿用图库默认图（没有默认图就用 emoji 外观）。');
    var confirmActions = el('div', 'pk-confirm-actions');
    var btnKeepPicking = el('button', 'btn btn-primary', '继续选图');
    btnKeepPicking.type = 'button';
    var btnCloseAnyway = el('button', 'btn btn-ghost', '就这样关掉');
    btnCloseAnyway.type = 'button';
    confirmActions.appendChild(btnKeepPicking);
    confirmActions.appendChild(btnCloseAnyway);
    confirmCard.appendChild(confirmTitle);
    confirmCard.appendChild(confirmNote);
    confirmCard.appendChild(confirmActions);
    confirmBox.appendChild(confirmCard);

    win.appendChild(bar);
    win.appendChild(body);
    win.appendChild(confirmBox);
    document.body.appendChild(win);

    /* ---------------- 拖动 / 折叠 ---------------- */

    var drag = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.tagName === 'BUTTON') return;
      var rect = win.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      win.style.right = 'auto';
      bar.setPointerCapture && bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var x = Math.max(0, Math.min((window.innerWidth || 1400) - 120, e.clientX - drag.dx));
      var y = Math.max(0, Math.min((window.innerHeight || 900) - 40, e.clientY - drag.dy));
      win.style.left = x + 'px';
      win.style.top = y + 'px';
    });
    bar.addEventListener('pointerup', function () {
      drag = null;
    });

    btnCollapse.addEventListener('click', function () {
      state.collapsed = !state.collapsed;
      win.classList.toggle('is-collapsed', state.collapsed);
      btnCollapse.textContent = state.collapsed ? '展开' : '折叠';
    });
    btnClose.addEventListener('click', function () {
      self.close();
    });
    btnDefaults.addEventListener('click', function () {
      assets.resetToDefaults().then(function () {
        state.selectedId = null;
        self.render();
        onChanged('reset');
        ui && ui.toast && ui.toast('已恢复图库里的默认图像', 'ok');
      });
    });

    btnKeepPicking.addEventListener('click', function () {
      confirmBox.hidden = true;
    });
    btnCloseAnyway.addEventListener('click', function () {
      confirmBox.hidden = true;
      state.askedIncomplete = true;
      self.close(true);
    });

    /* ---------------- 分组标签 ---------------- */

    function renderGroups() {
      groupTabs.textContent = '';
      var groups = LIB.groupsOf(assets.library);
      var all = el('button', 'pk-group', '全部');
      all.type = 'button';
      all.addEventListener('click', function () {
        state.group = '*';
        self.render();
      });
      groupTabs.appendChild(all);
      groups.forEach(function (g) {
        var b = el('button', 'pk-group', g.name);
        b.type = 'button';
        b.title = g.desc || '';
        b.addEventListener('click', function () {
          state.group = g.id;
          self.render();
        });
        groupTabs.appendChild(b);
      });
      var buttons = groupTabs.children;
      for (var i = 0; i < buttons.length; i++) {
        var gid = i === 0 ? '*' : groups[i - 1] && groups[i - 1].id;
        buttons[i].classList.toggle('is-on', gid === state.group);
      }
    }

    /* ---------------- 11 个水果位 ---------------- */

    function tierOfImage(imgId) {
      for (var t = 1; t <= LIB.TIER_COUNT; t++) {
        if (assets.idOf(t) === imgId) return t;
      }
      return 0;
    }

    function renderSlots() {
      slotList.textContent = '';
      LIB.slots().forEach(function (s) {
        var li = el('li', 'pk-slot');
        li.dataset.tier = String(s.tier);
        li.style.setProperty('--c', s.color);
        li.style.setProperty('--e', s.edge);

        var colorBar = el('i', 'pk-slot-color');
        var info = el('div', 'pk-slot-info');
        var line1 = el('div', 'pk-slot-line1');
        line1.appendChild(el('b', null, assets.labelOf(s.tier)));
        line1.appendChild(el('span', 'pk-slot-size', '⌀' + s.diameter));
        var line2 = el('div', 'pk-slot-line2');
        var img = assets.imageFor(s.tier);
        var src = assets.sourceOf(s.tier);
        line2.appendChild(el('span', 'pk-slot-file', img ? img.file : '这个位子还没选图'));
        if (src === 'default') line2.appendChild(el('span', 'pk-slot-tag', '默认'));
        if (src === 'pick') line2.appendChild(el('span', 'pk-slot-tag is-pick', '已选'));
        info.appendChild(line1);
        info.appendChild(line2);

        var thumbSize = Math.max(26, Math.min(64, s.diameter * 0.24));
        var thumb = el('div', 'pk-slot-thumb');
        thumb.style.width = thumbSize + 'px';
        thumb.style.height = thumbSize + 'px';
        var chip = ui && ui.fruitChip ? ui.fruitChip(s.tier, assets, thumbSize) : null;
        if (chip) thumb.appendChild(chip);

        var hint = null;
        if (img) {
          var q = LIB.qualityHint(img, s.tier);
          if (q && !q.ok) hint = el('span', 'pk-slot-warn', '⚠ ' + q.text);
        }

        var clearBtn = el('button', 'pk-slot-clear', '✕');
        clearBtn.type = 'button';
        clearBtn.title = '清空这一级（回到图库默认图）';
        clearBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          assets.setTier(s.tier, null).then(function () {
            onChanged('clear');
            self.render();
          });
        });

        li.appendChild(colorBar);
        li.appendChild(thumb);
        li.appendChild(info);
        if (hint) li.appendChild(hint);
        li.appendChild(clearBtn);

        li.addEventListener('click', function () {
          if (!state.selectedId) {
            ui && ui.toast && ui.toast('先在右边点一张图片，再点这里放上去');
            return;
          }
          applyTo(s.tier, state.selectedId);
        });
        li.addEventListener('dragover', function (e) {
          e.preventDefault();
          li.classList.add('is-over');
        });
        li.addEventListener('dragleave', function () {
          li.classList.remove('is-over');
        });
        li.addEventListener('drop', function (e) {
          e.preventDefault();
          li.classList.remove('is-over');
          var id = e.dataTransfer && e.dataTransfer.getData('text/plain');
          if (id) applyTo(s.tier, id);
        });
        if (state.lastTier === s.tier) li.classList.add('is-flash');

        slotList.appendChild(li);
      });
    }

    function applyTo(tier, imgId) {
      assets.setTier(tier, imgId).then(function (res) {
        if (!res.ok) {
          ui && ui.toast && ui.toast('放不上去：' + res.error, 'bad');
          return;
        }
        state.lastTier = tier;
        state.selectedId = null;
        onChanged('assign');
        self.render();
      });
    }

    /* ---------------- 图片库 ---------------- */

    function renderTiles() {
      tileList.textContent = '';
      var images = LIB.imagesOf(assets.library, state.group);
      libStat.textContent = images.length === (assets.library.images || []).length ? '' : images.length + ' 张';
      if (!images.length) {
        var empty = el('li', 'pk-empty');
        empty.textContent = assets.library.images.length
          ? '这个分组里还没有图片'
          : '图片库还是空的 —— 等你把图片给我，我内嵌进来这里就满了（现在游戏用 emoji 默认外观）';
        tileList.appendChild(empty);
        return;
      }
      images.forEach(function (img) {
        var tier = tierOfImage(img.id);
        var li = el('li', 'pk-tile');
        li.dataset.img = img.id;
        li.draggable = true;
        li.title = img.file + (img.w ? '（' + img.w + '×' + img.h + '）' : '');
        if (tier) {
          var slot = LIB.slotOf(tier);
          li.style.setProperty('--c', slot.color);
          li.style.setProperty('--e', slot.edge);
          li.classList.add('is-assigned');
        }
        if (state.selectedId === img.id) li.classList.add('is-selected');

        var pic = el('img', 'pk-tile-pic');
        pic.src = assets.thumbOf ? assets.thumbOf(img) : img.src;
        pic.alt = img.file;
        pic.draggable = false;

        li.appendChild(pic);
        if (tier) {
          // 颜色 + 水果 + 大小都标在图上：颜色 = 水果 = 这一级的大小
          var slot2 = LIB.slotOf(tier);
          var badge = el('span', 'pk-tile-badge', '⌀' + slot2.diameter);
          badge.style.background = slot2.color;
          badge.style.color = '#fff';
          li.appendChild(badge);
          var q = LIB.qualityHint(img, tier);
          if (q && !q.ok) li.classList.add('is-warn');
        }

        li.addEventListener('click', function () {
          state.selectedId = state.selectedId === img.id ? null : img.id;
          self.render();
        });
        li.addEventListener('dblclick', function () {
          // 双击 = 放到第一个空位（没有空位就放最后一级）
          var target = 0;
          for (var t = 1; t <= LIB.TIER_COUNT; t++) {
            if (!assets.imageFor(t)) {
              target = t;
              break;
            }
          }
          applyTo(target || LIB.TIER_COUNT, img.id);
        });
        li.addEventListener('dragstart', function (e) {
          e.dataTransfer.setData('text/plain', img.id);
          e.dataTransfer.effectAllowed = 'copy';
        });

        tileList.appendChild(li);
      });
    }

    /* ---------------- 提示 ---------------- */

    function renderHeaderHint() {
      if (state.selectedId) {
        var img = LIB.byId(assets.library, state.selectedId);
        subtitle.textContent = '已选中 ' + (img ? img.file : '') + ' → 点左边的棉花娃娃位放上去';
        subtitle.classList.add('is-active');
      } else {
        subtitle.textContent = '从图库里挑 11 张放到棉花娃娃位上';
        subtitle.classList.remove('is-active');
      }
    }

    function askIfIncomplete() {
      // 图库是空的就不烦人（还没内嵌图片的时候，关窗口不该一直弹提示）
      if (LIB.isComplete(assets.library, assets.pick())) return false;
      var missing = LIB.missingSlots(assets.library, assets.pick());
      if (!missing.length) return false;
      var names = missing.map(function (t) {
        return '⌀' + LIB.slotOf(t).diameter;
      });
      confirmTitle.textContent = '还有 ' + missing.length + ' 个棉花娃娃位没选图：' + names.join('、');
      confirmBox.hidden = false;
      return true;
    }

    /* ---------------- 对外 ---------------- */

    var self = {
      render: function () {
        renderGroups();
        renderSlots();
        renderTiles();
        renderHeaderHint();
        return self;
      },
      open: function () {
        state.open = true;
        confirmBox.hidden = true;
        win.hidden = false;
        if (!win.style.left) {
          // 默认停靠右侧，尽量不挡住游戏
          var w = Math.min(820, (window.innerWidth || 1400) - 40);
          win.style.width = w + 'px';
          win.style.left = Math.max(12, (window.innerWidth || 1400) - w - 24) + 'px';
          win.style.top = '74px';
        }
        self.render();
        return self;
      },
      /** close(true) = 强制关闭（用户已经确认过「就这样关掉」） */
      close: function (force) {
        if (!force && state.open && !state.askedIncomplete && askIfIncomplete()) {
          return self; // 先让用户看到「还没选满」的提醒
        }
        state.open = false;
        confirmBox.hidden = true;
        win.hidden = true;
        return self;
      },
      toggle: function () {
        return state.open ? self.close() : self.open();
      },
      isOpen: function () {
        return state.open;
      },
      /** 有没有没选满（给测试和别处用） */
      missing: function () {
        return LIB.missingSlots(assets.library, assets.pick());
      },
      destroy: function () {
        if (win.parentNode) win.parentNode.removeChild(win);
      }
    };

    return self;
  }

  /* ---------------- 演示图库（临时用：还没有真图时也能看窗口效果） ---------------- */

  /**
   * 生成一个「多分组 + 不同尺寸」的占位图库，用来验证选图窗口。
   * 真图片内嵌进来之后这个函数就不再被用到（只有 ?demo=1 才会调）。
   */
  function buildDemoLibrary() {
    var groups = [
      { id: 'g1', name: '圆润系', desc: '演示分组一：圆的、好认的' },
      { id: 'g2', name: '写实系', desc: '演示分组二：带描边的' },
      { id: 'g3', name: '扁平系', desc: '演示分组三：扁平的' }
    ];
    var palette = ['#e8483f', '#f2536b', '#8e5ad6', '#f79331', '#8bbf3f', '#e8402f', '#f7a6a0', '#e8c53f', '#c69a6d', '#c9e07a', '#3fae5a'];
    var sizes = [128, 160, 192, 224, 256, 320, 384, 512];
    var images = [];
    var n = 0;
    var i;

    function push(canvas, file, group, w, h) {
      n += 1;
      images.push({ id: 'demo-' + n, file: file, group: group, w: w, h: h, src: canvas.toDataURL('image/png') });
    }

    for (i = 0; i < 8; i++) {
      var s1 = sizes[i % sizes.length];
      var c1 = document.createElement('canvas');
      c1.width = s1;
      c1.height = s1;
      var g1 = c1.getContext('2d');
      g1.fillStyle = palette[i % palette.length];
      g1.beginPath();
      g1.arc(s1 / 2, s1 / 2, s1 / 2 - 1, 0, Math.PI * 2);
      g1.fill();
      g1.fillStyle = 'rgba(255,255,255,0.85)';
      g1.font = '700 ' + Math.round(s1 * 0.42) + 'px sans-serif';
      g1.textAlign = 'center';
      g1.textBaseline = 'middle';
      g1.fillText('圆' + (i + 1), s1 / 2, s1 / 2 + s1 * 0.02);
      push(c1, '圆润-' + String(i + 1).padStart(2, '0') + '.png', 'g1', s1, s1);
    }
    for (i = 0; i < 8; i++) {
      var s2 = sizes[(i + 3) % sizes.length];
      var c2 = document.createElement('canvas');
      c2.width = s2;
      c2.height = s2;
      var g2 = c2.getContext('2d');
      g2.fillStyle = '#ffffff';
      g2.fillRect(0, 0, s2, s2);
      g2.fillStyle = palette[(i + 4) % palette.length];
      g2.beginPath();
      g2.arc(s2 / 2, s2 / 2, s2 / 2 - Math.max(3, s2 * 0.06), 0, Math.PI * 2);
      g2.fill();
      g2.lineWidth = Math.max(2, s2 * 0.05);
      g2.strokeStyle = 'rgba(0,0,0,0.35)';
      g2.stroke();
      g2.fillStyle = '#fff';
      g2.font = '700 ' + Math.round(s2 * 0.34) + 'px sans-serif';
      g2.textAlign = 'center';
      g2.textBaseline = 'middle';
      g2.fillText('实' + (i + 1), s2 / 2, s2 / 2 + s2 * 0.02);
      push(c2, '写实-' + String(i + 1).padStart(2, '0') + '.png', 'g2', s2, s2);
    }
    for (i = 0; i < 6; i++) {
      var w3 = [160, 220, 300, 360, 440, 520][i % 6];
      var h3 = Math.round(w3 * 0.75); // 故意做成非正方形，验证等比裁切
      var c3 = document.createElement('canvas');
      c3.width = w3;
      c3.height = h3;
      var g3 = c3.getContext('2d');
      g3.fillStyle = palette[(i + 7) % palette.length];
      g3.beginPath();
      g3.moveTo(w3 / 2, 4);
      g3.lineTo(w3 - 4, h3 - 4);
      g3.lineTo(4, h3 - 4);
      g3.closePath();
      g3.fill();
      g3.fillStyle = 'rgba(255,255,255,0.9)';
      g3.font = '700 ' + Math.round(h3 * 0.3) + 'px sans-serif';
      g3.textAlign = 'center';
      g3.textBaseline = 'middle';
      g3.fillText('扁' + (i + 1), w3 / 2, h3 * 0.62);
      push(c3, '扁平-' + String(i + 1).padStart(2, '0') + '.png', 'g3', w3, h3);
    }

    // 默认图像：只给前 8 级（演示「几张图当默认图像」的效果，顺便能看到没选满的提示）
    var defaults = {};
    for (var t = 1; t <= 8; t++) defaults[t] = images[(t - 1) % images.length].id;
    var lib = LIB.normalize({ version: 1, builtAt: new Date().toISOString(), groups: groups, images: images, defaults: defaults });
    root.SUIKA_IMAGE_LIBRARY = lib;
    return lib;
  }

  root.SuikaPicker = { create: create, buildDemoLibrary: buildDemoLibrary };
})(typeof globalThis !== 'undefined' ? globalThis : this);
