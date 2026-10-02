/*!
 * 合成大西瓜 · 主流程
 * 把引擎、渲染、界面、音效、排行榜串起来：开局 → 投放 → 合成计分 → 结束 → 上榜。
 */
(function (root) {
  'use strict';

  var CFG = root.SuikaConfig;
  var AS = root.SuikaAssets;
  var BOARDS = root.SuikaBoards;
  var EN = root.SuikaEngine;
  var RD = root.SuikaRender;
  var UI = root.SuikaUI;
  var SY = root.SuikaSync;
  var D = root.document;
  var BOARD = CFG.BOARD;

  function safeStorage() {
    try {
      var s = root.localStorage;
      s.setItem('__suika_probe__', '1');
      s.removeItem('__suika_probe__');
      return s;
    } catch (e) {
      return null;
    }
  }

  var storage = safeStorage();
  var assets;
  var game;
  var render;
  var dom = {};
  var phase = 'ready'; // ready | playing | paused | over
  var round = null;
  var currentTier = null;
  var nextTier = 1;
  var cooldown = 0;
  var aimX = BOARD.width / 2;
  var lastFrame = 0;
  var hudClock = 0;
  var best = 0;
  var prefs = { sound: true, player: '玩家', difficulty: CFG.DEFAULT_DIFFICULTY };
  var sfx;
  var picker = null;
  var demoMode = false;
  var sync = null;
  var syncClock = 0; // 每 200ms 加一，累计到 75（≈15 秒）刷新一次同步倒计时
  var diffPending = false; // 游戏进行中改难度 → 下一局生效
  var boardKind = 'live'; // 排行榜页签：'live' 实时 | 'top' 总榜
  var lastRecKey = null; // 本局成绩在榜单里的身份，用来高亮

  /* ---------------- 存档 ---------------- */

  function loadJson(key, fallback) {
    try {
      var raw = storage && storage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    if (demoMode) return; // 演示模式不写存档
    try {
      if (storage) storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ---------------- 音效（WebAudio 合成，无需素材） ---------------- */

  function createSfx() {
    var ctx = null;

    function ensure() {
      if (ctx) return ctx;
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch (e) {
        ctx = null;
      }
      return ctx;
    }

    function tone(freq, dur, type, vol, delay) {
      if (!prefs.sound) return;
      var ac = ensure();
      if (!ac) return;
      var t0 = ac.currentTime + (delay || 0);
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol == null ? 0.07 : vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    return {
      unlock: function () {
        var ac = ensure();
        if (ac && ac.state === 'suspended') ac.resume();
      },
      drop: function () {
        tone(300, 0.08, 'triangle', 0.045);
      },
      merge: function (tier, combo) {
        var c = Math.max(1, combo || 1);
        // 连击越高音越亮，给连击一个听觉反馈
        var f = 260 * Math.pow(1.085, Math.max(0, tier)) * Math.pow(1.06, c - 1);
        tone(f, 0.15, 'sine', 0.085);
        tone(f * 1.5, 0.11, 'sine', 0.035, 0.015);
        if (c >= 3) tone(f * 2, 0.1, 'triangle', 0.03, 0.05);
      },
      warn: function () {
        tone(180, 0.18, 'sawtooth', 0.035);
      },
      over: function () {
        tone(420, 0.22, 'sine', 0.07);
        tone(300, 0.26, 'sine', 0.07, 0.14);
        tone(190, 0.42, 'sine', 0.07, 0.28);
      }
    };
  }

  /* ---------------- HUD ---------------- */

  function playerName() {
    var v = dom.player && dom.player.value ? String(dom.player.value).trim() : '';
    return v ? v.slice(0, 12) : '玩家';
  }

  function syncHud() {
    var st = game.getState();
    if (dom.score) dom.score.textContent = CFG.formatScore(st.score);
    if (dom.best) dom.best.textContent = CFG.formatScore(Math.max(best, st.score));
    if (dom.merges) dom.merges.textContent = String(st.merges);
    if (dom.maxtier) {
      var def = CFG.tierByNumber(st.maxTier);
      dom.maxtier.textContent = def ? def.emoji + ' ' + def.name : '—';
    }
    UI.paintPreview(dom.current, currentTier, assets, 0.5);
    UI.paintPreview(dom.next, nextTier, assets, 0.5);
    UI.updateChain(dom.chain, st.maxTier, st.tierCounts);
    if (dom.pause) dom.pause.textContent = phase === 'paused' ? '▶ 继续' : '⏸ 暂停';
    if (dom.sound) {
      dom.sound.textContent = prefs.sound ? '🔊 音效' : '🔇 静音';
      dom.sound.setAttribute('aria-pressed', String(!!prefs.sound));
    }
  }

  function showDelta(gained, combo) {
    if (!dom.delta || !gained) return;
    dom.delta.textContent = '+' + gained + (combo >= 2 ? '　连击×' + combo : '');
    dom.delta.classList.remove('is-pop');
    void dom.delta.offsetWidth;
    dom.delta.classList.add('is-pop');
    if (dom.score) {
      dom.score.classList.remove('is-bump');
      void dom.score.offsetWidth;
      dom.score.classList.add('is-bump');
    }
  }

  /** 连击条：combo >= 2 时显示，ratio 是连击窗口的剩余比例 */
  function setComboHud(combo, multiplier, ratio) {
    var c = Math.max(0, Math.floor(Number(combo) || 0));
    var on = c >= 2;
    if (dom.combo) {
      dom.combo.classList.toggle('is-on', on);
      dom.combo.classList.toggle('is-hot', c >= 4);
    }
    if (dom.comboCount) dom.comboCount.textContent = on ? '×' + c : '';
    if (dom.comboMult) dom.comboMult.textContent = on ? '得分 ×' + String(multiplier.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '') : '';
    if (dom.comboBar) dom.comboBar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio || 0)) + ')';
  }

  /* ---------------- 难度 ---------------- */

  function roundDiff() {
    return CFG.difficultyOf(game.getDifficulty());
  }

  function syncDiffUi() {
    var def = CFG.difficultyOf(prefs.difficulty);
    if (dom.diffLevel) dom.diffLevel.textContent = 'Lv.' + def.level;
    if (dom.diffName) dom.diffName.textContent = def.name;
    if (dom.diffBar) dom.diffBar.style.width = (def.level / CFG.DIFFICULTY.length) * 100 + '%';
    if (dom.diffMinus) dom.diffMinus.disabled = def.level <= 1;
    if (dom.diffPlus) dom.diffPlus.disabled = def.level >= CFG.DIFFICULTY.length;
    if (dom.diffHint) {
      dom.diffHint.textContent =
        '掉落权重 ' +
        def.spawnWeights.join('/') +
        ' · 投放间隔 ' +
        def.dropCooldownMs +
        'ms · 危险线 ' +
        def.dangerY +
        'px' +
        (diffPending ? '（下一局生效）' : '');
    }
  }

  function changeDifficulty(delta) {
    var next = CFG.clampDifficulty(prefs.difficulty + delta);
    if (next === prefs.difficulty) return;
    prefs.difficulty = next;
    saveJson(CFG.STORAGE_KEYS.prefs, prefs);
    if (phase === 'playing' || phase === 'paused') {
      diffPending = true;
      UI.toast('难度调到 Lv.' + next + '（' + CFG.difficultyOf(next).name + '），下一局生效');
    } else {
      diffPending = false;
      game.setDifficulty(next);
      UI.toast('难度：Lv.' + next + ' ' + CFG.difficultyOf(next).name);
    }
    syncDiffUi();
  }

  /* ---------------- 排行榜视图（全球榜 / 自建服务器 / 本机） ---------------- */

  function isShared() {
    return !!(sync && sync.info().mode === 'shared');
  }

  /** 当前显示的是哪个榜：'live' 实时（最近 20 次提交） | 'top' 总榜（前 100） */
  function boardView(kind) {
    return sync.view(kind || boardKind);
  }

  function paintTabs() {
    if (dom.lbTabLive) dom.lbTabLive.classList.toggle('is-on', boardKind === 'live');
    if (dom.lbTabTop) dom.lbTabTop.classList.toggle('is-on', boardKind === 'top');
  }

  function setBoardKind(kind) {
    var next = kind === 'top' ? 'top' : 'live';
    if (next === boardKind) {
      // 已经在这个页签上就当作「手动刷新」
      if (isShared()) sync.pullLive().then(function () { renderBoardView(); });
      return;
    }
    boardKind = next;
    paintTabs();
    renderBoardView();
    if (boardKind === 'live' && isShared()) {
      // 实时榜：一打开就去拉最新的，这样才是「实时」
      sync.pullLive().then(function () {
        renderBoardView();
      });
    }
  }

  function renderBoardView(highlightKey) {
    var list = boardView();
    UI.renderLeaderboard(dom.lbList, list, {
      assets: assets,
      highlightKey: highlightKey,
      isPending: function (rec) {
        return isShared() ? sync.isPending(rec) : false;
      }
    });
    renderSyncStatus();
  }

  function clockText(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function renderSyncStatus() {
    if (!dom.lbStatus || !sync) return;
    var info = sync.info();
    var global = info.provider === 'textdb';
    if (dom.lbLive) {
      dom.lbLive.textContent = info.mode === 'local' ? '本机' : global ? '全球' : '自建';
      dom.lbLive.classList.toggle('is-local', info.mode === 'local');
    }
    if (info.mode === 'local') {
      dom.lbStatus.innerHTML =
        '<b>本机模式</b>：成绩只保存在这台电脑上。' +
        '（网址后面加 <code>?board=textdb</code> 可以接回全球榜）';
      return;
    }
    var mins = Math.max(0, Math.ceil((info.nextRefreshAt - Date.now()) / 60000));
    var stateMap = {
      online: '已连接',
      loading: '正在读取…',
      uploading: '正在上传…',
      error: '暂时连不上，先显示本地缓存',
      idle: '待同步'
    };
    var parts = [(global ? '全球榜' : '自建服务器') + ' · ' + (stateMap[info.status] || info.status)];
    if (info.fetchedAt) {
      parts.push('上次更新 ' + clockText(info.fetchedAt));
      parts.push('总榜下次自动更新 ' + clockText(info.nextRefreshAt) + '（' + mins + ' 分钟后）');
    } else {
      parts.push('还没同步过');
    }
    parts.push(boardKind === 'live' ? '实时榜 ' + info.liveCount + ' 条' : '总榜 ' + info.topCount + ' 条');
    if (info.pendingCount) parts.push('待上传 ' + info.pendingCount + ' 条');
    dom.lbStatus.innerHTML =
      parts.join(' · ') +
      '<br /><span class="muted">实时榜 = 全世界最近提交的成绩，打开就拉最新；总榜 = 历史前 100，每 ' +
      Math.round(sync.refreshMs / 60000) +
      ' 分钟自动刷新。' +
      (global ? '榜单存在第三方免费服务上、没有服务端校验，谁都能改，别太当真 😅' : '') +
      '</span>';
  }

  /* ---------------- 投放 ---------------- */

  function clampAim(x) {
    var tier = currentTier == null ? nextTier : currentTier;
    var r = CFG.radiusOf(tier) || 20;
    var lo = BOARD.wall + r + BOARD.aimPadding;
    var hi = BOARD.width - BOARD.wall - r - BOARD.aimPadding;
    if (hi <= lo) return BOARD.width / 2;
    return Math.min(hi, Math.max(lo, x));
  }

  function setAim(x) {
    if (!isFinite(x)) return;
    aimX = clampAim(x);
  }

  function drop() {
    if (phase !== 'playing' || currentTier == null || cooldown > 0) return;
    var body = game.drop(currentTier, aimX);
    if (!body) return;
    render.addDrop(body.position.x, currentTier);
    sfx.drop();
    currentTier = null;
    cooldown = roundDiff().dropCooldownMs;
    syncHud();
  }

  function tickCooldown(dt) {
    if (cooldown <= 0) return;
    cooldown -= dt;
    if (cooldown <= 0) {
      cooldown = 0;
      currentTier = nextTier;
      nextTier = game.pickTier();
      aimX = clampAim(aimX);
      syncHud();
    }
  }

  /* ---------------- 一局流程 ---------------- */

  function startRound() {
    UI.hideOverlay();
    sfx.unlock();
    // 难度在一局开始时定下来（中途改难度会在下一局生效）
    diffPending = false;
    game.setDifficulty(prefs.difficulty);
    game.reset();
    render.clearEffects();
    round = { id: 'r' + Date.now().toString(36), rank: 0 };
    currentTier = game.pickTier();
    nextTier = game.pickTier();
    cooldown = 0;
    aimX = clampAim(BOARD.width / 2);
    phase = 'playing';
    if (dom.delta) dom.delta.textContent = '';
    setComboHud(0, 1, 0);
    syncDiffUi();
    renderBoardView();
    syncHud();
  }

  function endRound(summary) {
    phase = 'over';
    render.addBurst(BOARD.width / 2, game.getState().dangerY + 30);
    sfx.over();
    setComboHud(0, 1, 0);

    // 榜单记录（字段名故意短：整张榜要塞进一份 JSON 文档里）
    var rec = {
      n: playerName(),
      s: summary.score,
      d: summary.difficulty,
      m: summary.maxTier,
      c: summary.bestCombo || 1,
      t: Date.now()
    };
    lastRecKey = rec.n + '|' + rec.t + '|' + rec.s;

    // 先本地落一份并渲染（自己这条会先显示成「待确认」），上传在后台进行
    renderBoardView(lastRecKey);
    if (isShared()) {
      sync.submit(rec).then(function (res) {
        if (!res.ok) UI.toast('成绩没能立刻上传，已放进待上传队列，下次自动重试', 'bad');
        else UI.toast('已提交到全球榜：第 ' + (res.rank || '-') + ' 名', 'ok');
        renderBoardView(lastRecKey);
        renderRoundResult(summary, { uploaded: !!res.ok, rank: res.rank || 0, shared: true });
      });
      renderRoundResult(summary, { uploaded: false, rank: BOARDS.rankOf(rec, sync.view('top')), shared: true, provisional: true });
    } else {
      var localRank = BOARDS.rankOf(rec, sync.view('top'));
      renderBoardView(lastRecKey);
      renderRoundResult(summary, {
        uploaded: false,
        rank: localRank,
        shared: false,
        limit: BOARDS.TOP_MAX
      });
    }
  }

  function renderRoundResult(summary, submitted) {
    var def = CFG.tierByNumber(summary.maxTier) || CFG.tierByNumber(1);
    var diff = CFG.difficultyOf(summary.difficulty);
    var rankText;
    if (submitted.shared) {
      if (submitted.provisional) {
        rankText = '正在提交到全球榜…（本地暂列第 <b>' + (submitted.rank || '-') + '</b> 名）';
      } else {
        rankText = submitted.uploaded
          ? '已提交到全球榜，暂列第 <b>' + (submitted.rank || '-') + '</b> 名'
          : '已存入待上传队列，联网后自动上榜';
      }
    } else {
      rankText = '本机榜暂列第 <b>' + (submitted.rank || '-') + '</b> 名（当前是本机模式）';
    }
    var rows =
      '<div class="result-score">' +
      CFG.formatScore(summary.score) +
      '<span>分</span></div>' +
      '<div class="result-grid">' +
      '<div><span class="k">最大水果</span><b>' +
      def.emoji +
      ' ' +
      def.name +
      '</b></div>' +
      '<div><span class="k">合成次数</span><b>' +
      summary.merges +
      '</b></div>' +
      '<div><span class="k">最高连击</span><b>×' +
      (summary.bestCombo || 1) +
      '</b></div>' +
      '<div><span class="k">本局用时</span><b>' +
      UI.formatDuration(summary.durationMs) +
      '</b></div>' +
      '<div><span class="k">难度</span><b>Lv.' +
      diff.level +
      ' ' +
      diff.name +
      '</b></div>' +
      '<div><span class="k">投放水果</span><b>' +
      summary.drops +
      '</b></div>' +
      '</div>' +
      '<p class="result-rank">' +
      rankText +
      '</p>' +
      '<p class="result-note">按当前需求，本局成绩<b>不写入个人排行表</b>；' +
      (submitted.shared
        ? '实时榜打开即最新，总榜每 ' + Math.round(sync.refreshMs / 60000) + ' 分钟自动刷新。'
        : '当前是本机模式（看榜单右下角的说明可以切回全球榜）。') +
      '</p>';

    UI.showOverlay({
      title: '本局结束',
      body: rows,
      actions: [
        { label: '再来一局', kind: 'primary', onClick: startRound },
        {
          label: '留在榜上看看',
          kind: 'ghost',
          onClick: function () {
            UI.hideOverlay();
          }
        }
      ]
    });
  }

  function togglePause(force) {
    if (phase === 'playing' || force === true) {
      phase = 'paused';
      syncHud();
      UI.showOverlay({
        title: '已暂停',
        body: '<p>水果们先歇一会儿。</p>',
        actions: [
          {
            label: '继续游戏',
            kind: 'primary',
            onClick: function () {
              phase = 'playing';
              UI.hideOverlay();
              syncHud();
            }
          },
          { label: '重新开始', kind: 'ghost', onClick: startRound }
        ]
      });
    } else if (phase === 'paused') {
      phase = 'playing';
      UI.hideOverlay();
      syncHud();
    }
  }

  /* ---------------- 画面 ---------------- */

  function buildFrame() {
    var st = game.getState();
    var aiming = phase === 'playing' || phase === 'paused';
    var tier = currentTier == null ? nextTier : currentTier;
    var cd = roundDiff().dropCooldownMs || BOARD.dropCooldownMs;
    return {
      fruits: game.fruits(),
      aim: {
        visible: aiming,
        x: aimX,
        tier: tier,
        ready: currentTier != null,
        progress: currentTier == null && cd ? 1 - cooldown / cd : 1
      },
      dangerRatio: st.dangerRatio,
      dangerY: st.dangerY,
      warning: st.dangerMs >= CFG.RULES.dangerWarnMs,
      assets: assets,
      paused: phase === 'paused'
    };
  }

  /**
   * 单帧逻辑。
   * 抽成独立函数是为了让「演示 / 自检」模式能同步跑很多帧：
   * HUD 计时、连击条、同步倒计时这些代码要跑一会儿才会执行到，
   * 只在 load 时截一张图是抓不到它们里面的报错的。
   */
  function frame(ts) {
    var dt = lastFrame ? ts - lastFrame : 16.7;
    lastFrame = ts;
    if (!isFinite(dt) || dt <= 0) dt = 16.7;
    dt = Math.min(dt, 60);

    if (phase === 'playing') {
      tickCooldown(dt);
      game.step(dt);
      var live = game.getState();
      if (live.combo >= 2) setComboHud(live.combo, CFG.comboMultiplier(live.combo), live.comboRatio);
    }
    render.update(dt);
    render.draw(buildFrame());

    hudClock += dt;
    if (hudClock > 200) {
      hudClock = 0;
      if (dom.time) dom.time.textContent = UI.formatDuration(game.getState().elapsedMs);
      syncClock += 1;
      // 每 15 秒刷新一次「下次更新还有多久」
      if (syncClock >= 75) {
        syncClock = 0;
        renderSyncStatus();
      }
    }
  }

  function loop(ts) {
    root.requestAnimationFrame(loop);
    frame(ts);
  }

  /* ---------------- 选图 ---------------- */

  function refreshAssetViews() {
    UI.buildChain(dom.chain, assets);
    UI.updateChain(dom.chain, game.getState().maxTier, game.getState().tierCounts);
    renderBoardView();
    syncHud();
    if (picker && picker.isOpen()) picker.render();
  }

  /** 打开/关闭「选图小窗口」 */
  function openPicker(open) {
    if (!picker) return;
    var willOpen = open == null ? !picker.isOpen() : !!open;
    if (willOpen) picker.open();
    else picker.close();
  }

  /* ---------------- 事件绑定 ---------------- */

  function wire() {
    var canvas = dom.canvas;

    canvas.addEventListener('pointermove', function (e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      setAim(((e.clientX - rect.left) * BOARD.width) / rect.width);
    });

    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      if (rect.width) setAim(((e.clientX - rect.left) * BOARD.width) / rect.width);
      if (phase === 'playing') drop();
      else if (phase === 'over') startRound();
    });

    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    D.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        setAim(aimX - 16);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        setAim(aimX + 16);
        e.preventDefault();
      } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (phase === 'playing') drop();
        else if (phase === 'ready' || phase === 'over') startRound();
      } else if (e.key === 'p' || e.key === 'P') {
        if (phase === 'playing' || phase === 'paused') togglePause();
      } else if (e.key === 'r' || e.key === 'R') {
        startRound();
      } else if (e.key === 'Escape') {
        openPicker(false);
      }
    });

    if (dom.pause) dom.pause.addEventListener('click', function () { togglePause(); });
    if (dom.restart) dom.restart.addEventListener('click', function () { startRound(); });
    if (dom.sound) {
      dom.sound.addEventListener('click', function () {
        prefs.sound = !prefs.sound;
        saveJson(CFG.STORAGE_KEYS.prefs, prefs);
        sfx.unlock();
        syncHud();
        UI.toast(prefs.sound ? '音效已打开' : '音效已关闭');
      });
    }
    // 选图小窗口
    if (dom.pickerBtn) {
      dom.pickerBtn.addEventListener('click', function () {
        openPicker();
      });
    }

    if (dom.player) {
      dom.player.addEventListener('change', function () {
        prefs.player = playerName();
        saveJson(CFG.STORAGE_KEYS.prefs, prefs);
      });
    }
    if (dom.lbTabLive) dom.lbTabLive.addEventListener('click', function () { setBoardKind('live'); });
    if (dom.lbTabTop) dom.lbTabTop.addEventListener('click', function () { setBoardKind('top'); });
    if (dom.lbClear) {
      dom.lbClear.addEventListener('click', function () {
        if (isShared()) {
          UI.toast('全球榜是全世界玩家共用的一张榜，本机清不掉', 'bad');
          return;
        }
        if (root.confirm('清空本机保存的榜单成绩？')) {
          sync.clearCache();
          renderBoardView();
          UI.toast('本机榜单已清空');
        }
      });
    }
    if (dom.diffMinus) dom.diffMinus.addEventListener('click', function () { changeDifficulty(-1); });
    if (dom.diffPlus) dom.diffPlus.addEventListener('click', function () { changeDifficulty(1); });
    if (dom.lbRefresh) {
      dom.lbRefresh.addEventListener('click', function () {
        if (!isShared()) {
          UI.toast('当前是本机模式，没有需要同步的服务器');
          return;
        }
        UI.toast('正在同步榜单…');
        sync
          .flush()
          .then(function () {
            return sync.pull(true);
          })
          .then(function (res) {
            renderBoardView();
            UI.toast(res && res.ok ? '榜单已更新' : '暂时连不上，先显示本地缓存', res && res.ok ? 'ok' : 'bad');
          });
      });
    }

    root.addEventListener('resize', function () {
      setAim(aimX);
    });
  }

  /* ---------------- 启动 ---------------- */

  function cacheDom() {
    dom.canvas = UI.el('stage-canvas');
    dom.score = UI.el('hud-score');
    dom.delta = UI.el('hud-delta');
    dom.best = UI.el('hud-best');
    dom.merges = UI.el('hud-merges');
    dom.maxtier = UI.el('hud-maxtier');
    dom.time = UI.el('hud-time');
    dom.current = UI.el('hud-current');
    dom.next = UI.el('hud-next');
    dom.chain = UI.el('chain-list');
    dom.pause = UI.el('btn-pause');
    dom.restart = UI.el('btn-restart');
    dom.sound = UI.el('btn-sound');
    dom.pickerBtn = UI.el('btn-picker');
    dom.lbList = UI.el('lb-list');
    dom.lbClear = UI.el('lb-clear');
    dom.lbNote = UI.el('lb-note');
    dom.lbLive = UI.el('lb-live');
    dom.lbStatus = UI.el('lb-status');
    dom.lbRefresh = UI.el('lb-refresh');
    dom.lbTabLive = UI.el('lb-tab-live');
    dom.lbTabTop = UI.el('lb-tab-top');
    dom.player = UI.el('lb-player');
    dom.appVersion = UI.el('app-version');
    dom.storageWarning = UI.el('storage-warning');
    dom.diffLevel = UI.el('diff-level');
    dom.diffName = UI.el('diff-name');
    dom.diffBar = UI.el('diff-bar');
    dom.diffHint = UI.el('diff-hint');
    dom.diffMinus = UI.el('diff-minus');
    dom.diffPlus = UI.el('diff-plus');
    dom.combo = UI.el('hud-combo');
    dom.comboCount = UI.el('hud-combo-count');
    dom.comboMult = UI.el('hud-combo-mult');
    dom.comboBar = UI.el('hud-combo-bar');
  }

  function showReadyOverlay() {
    UI.showOverlay({
      title: '🍉 合成大西瓜',
      body:
        '<ul class="rules">' +
        '<li>前 5 级水果会从天上掉下来，<b>两颗相同的水果碰在一起</b>就会合成更大的水果。</li>' +
        '<li>得分按<b>合成出的水果大小</b>计算：草莓 +1、葡萄 +3、橘子 +6 …… 西瓜 +55。</li>' +
        '<li><b>连击加分</b>：1 秒内连续合成会累积连击，得分最高 ×' +
        CFG.RULES.combo.maxMultiplier +
        '，飘字和音效都会跟着变。</li>' +
        '<li>两颗西瓜相撞会双双消失，额外 +100 分。</li>' +
        '<li>水果堆过红色危险线并停下 <b>2 秒</b>，本局结束。左上角可以调 <b>1~10 级难度</b>（默认 Lv.' +
        CFG.DEFAULT_DIFFICULTY +
        '）。</li>' +
        '<li>成绩自动进 <b>全球排行榜</b>：实时榜是全世界最近 20 次提交（打开即最新），' +
        '总榜是历史前 100（每 ' +
        Math.round(CFG.BOARD_SYNC.refreshMs / 60000) +
        ' 分钟自动刷新）。' +
        (root.SUIKA_STANDALONE ? '' : '用「启动游戏.cmd」打开也一样是全球榜。') +
        '</li>' +
        '<li>水果图片来自内置图库：点右上角 <b>🖼 选图</b> 打开小窗口，从图库里挑 11 张放进水果位'
        + '（图片不用自己导入）。</li>' +
        '</ul>',
      actions: [{ label: '开始游戏', kind: 'primary', onClick: startRound }]
    });
  }

  function demoSeed() {
    // ?demo=1 ：自动开局并按剧本投一批水果，方便截图 / 检查画面
    // 演示模式用内存存储，不会污染你自己的存档
    startRound();
    var script = [
      [1, 120],
      [5, 300],
      [2, 150],
      [3, 260],
      [1, 205],
      [4, 175],
      [2, 345],
      [1, 240],
      [3, 115],
      [5, 385],
      [2, 300],
      [1, 215]
    ];
    script.forEach(function (item) {
      game.debugSpawn(item[0], item[1], BOARD.spawnY);
      for (var i = 0; i < 22; i++) game.step(BOARD.fixedStep);
    });
    for (var k = 0; k < 60; k++) game.step(BOARD.fixedStep);
    setComboHud(0, 1, 0);

    // 造几条示例成绩，方便看排行榜长什么样。
    // 演示模式默认走本机（provider='local'），不会把假成绩写进全世界共用的榜单。
    [
      ['小西瓜', 386, 9, 41, 6],
      ['阿瓜', 274, 8, 28, 5],
      ['吃瓜群众', 158, 7, 17, 4]
    ].forEach(function (row, i) {
      sync.submit({
        n: row[0],
        s: row[1],
        m: row[2],
        c: row[3],
        d: row[4],
        t: Date.now() - (i + 1) * 2400000
      });
    });
    renderBoardView();
    aimX = clampAim(BOARD.width / 2);
    syncHud();
  }

  function boot() {
    cacheDom();
    demoMode = /[?&]demo=1/.test(root.location.search);
    // ?shapes=1 ：把真实碰撞体（黄色圆组）画出来，用来验证「碰撞贴合玩偶轮廓」
    root.SUIKA_SHOW_SHAPES = /[?&]shapes=1/.test(root.location.search);
    if (!storage && dom.storageWarning) dom.storageWarning.hidden = false;
    // 演示模式一律用内存存储，不会动你自己的存档
    var store = demoMode ? null : storage;

    prefs = Object.assign({ sound: true, player: '玩家', difficulty: CFG.DEFAULT_DIFFICULTY }, loadJson(CFG.STORAGE_KEYS.prefs, {}));
    prefs.difficulty = CFG.clampDifficulty(prefs.difficulty);

    // ?demo=1&lib=demo ：还没有真图时，生成一个「多分组 + 不同尺寸」的占位图库，
    // 用来验证选图窗口（真图片内嵌进来之后就不需要它了）
    var baked = root.SUIKA_IMAGE_LIBRARY && root.SUIKA_IMAGE_LIBRARY.images && root.SUIKA_IMAGE_LIBRARY.images.length;
    var demoLib = demoMode && !baked && !/[?&]lib=none/.test(root.location.search);
    if (demoLib && root.SuikaPicker && root.SuikaPicker.buildDemoLibrary) {
      root.SuikaPicker.buildDemoLibrary();
    }

    assets = AS.create({ storage: store });
    game = EN.create({ difficulty: prefs.difficulty, shapeOf: function (tier) { return assets.shapeOf(tier); } });
    render = RD.create(dom.canvas, {});
    sfx = createSfx();
    /*
     * 榜单数据源：
     *   默认 = textdb（第三方免费 KV，全世界共用一张榜，静态页面就能用）
     *   ?board=textdb|rest|local 可以临时切换（调试 / 自建服务器）
     *   演示模式默认走本机 —— 别把演示的假成绩写进全世界共用的榜单里
     */
    var boardOverride = (/[?&]board=(textdb|rest|local)/.exec(root.location.search) || [])[1] || null;
    sync = SY.create({ storage: store, provider: boardOverride || (demoMode ? 'local' : null) });
    paintTabs();

    try {
      best = Number(storage && storage.getItem(CFG.STORAGE_KEYS.best)) || 0;
    } catch (e) {
      best = 0;
    }
    if (dom.player) dom.player.value = prefs.player || '玩家';

    game.on('merge', function (m) {
      var showTier = m.resultTier || m.fromTier;
      render.addMerge(m.x, m.y, showTier, m.gained, m.resultTier, m.combo);
      sfx.merge(showTier, m.combo);
      showDelta(m.gained, m.combo);
      setComboHud(m.combo, m.multiplier, 1);
      if (m.score > best) {
        best = m.score;
        if (!demoMode) {
          try {
            storage && storage.setItem(CFG.STORAGE_KEYS.best, String(best));
          } catch (e) {
            /* 忽略 */
          }
        }
      }
      syncHud();
    });

    game.on('combo-end', function () {
      setComboHud(0, 1, 0);
    });

    game.on('warn', function () {
      sfx.warn();
    });

    game.on('gameover', function (summary) {
      endRound(summary);
    });

    assets.onChange(refreshAssetViews);

    UI.buildChain(dom.chain, assets);
    UI.updateChain(dom.chain, 1, {});
    renderBoardView();
    if (dom.lbNote) {
      dom.lbNote.innerHTML =
        '榜单文档里只有<b>总榜 top</b> 和<b>实时榜 live</b> 两块，<b>没有个人排行表</b>这种东西 —— ' +
        '按你的要求，每局成绩只进榜，不给玩家攒个人历史。';
    }
    if (dom.appVersion) {
      dom.appVersion.textContent = 'v' + String(CFG.VERSION).split('-')[0] + (root.SUIKA_STANDALONE ? ' 单文件版' : ' 全球榜');
    }

    syncDiffUi();
    // 选图小窗口（图片全部来自内嵌图库，不做导入）
    picker = root.SuikaPicker.create({
      assets: assets,
      ui: UI,
      onChanged: function () {
        // 换图后：进化表色块、HUD 预览、画布上的水果都要跟着变
        refreshAssetViews();
      }
    });
    wire();
    showReadyOverlay();
    syncHud();
    render.draw(buildFrame());
    root.requestAnimationFrame(loop);

    // 启动时先补传离线期间攒下的成绩，然后拉一次榜单；之后每 30 分钟自动同步一次
    if (isShared()) {
      sync
        .flush()
        .then(function () {
          return sync.pull(true);
        })
        .then(function () {
          renderBoardView();
        });
      sync.start();
    }
    sync.onChange(function () {
      // 上传成功/同步完成后，列表里的「待确认」要变成正式名次，所以整块重绘
      renderBoardView();
    });

    /*
     * 演示模式（自检 / 截图用）。
     * 注意：玩偶图是**异步加载**的，如果直接同步跑帧，跑的都是「图还没到」的 emoji 兜底画面。
     * 所以这里等 preloadAll 完成后才开始铺场景 + 跑帧（预加载的 img 已挂进 DOM 池子，
     * 页面 load 事件会等它们，截图就不会拍到半成品）。
     */
    function runDemo() {
      // ?demo=1&diff=8 ：演示用，直接把难度设成第 8 级（走的是和界面按钮同一条路径）
      var dm = /[?&]diff=(\d+)/.exec(root.location.search);
      if (dm) {
        prefs.difficulty = CFG.clampDifficulty(dm[1]);
        game.setDifficulty(prefs.difficulty);
        syncDiffUi();
      }
      // ?demo=1&panel=1 ：演示用，直接打开选图窗口
      if (/[?&]panel=1/.test(root.location.search)) {
        openPicker(true);
        // ?demo=1&panel=1&close=1 ：再试一次关闭 → 没选满就会弹出提醒（自检/截图用）
        if (/[?&]close=1/.test(root.location.search)) openPicker(false);
      }
      refreshAssetViews();
      demoSeed();
      // ?demo=1&over=1 ：直接演示「本局结束 → 提交上榜」的流程
      if (/[?&]over=1/.test(root.location.search)) game.endGame('danger-line');
      // ?demo=1&pump=120 ：同步跑 120 帧（≈2 秒），把 HUD/计时/同步倒计时这些
      // 「要跑一会儿才会执行到」的代码路径提前跑到 —— 自检和截图都用它，
      // 否则报错会发生在截图之后，看不到。
      // ?demo=1&squash=0.28 ：把所有水果置成「正在被压」的状态并重绘一帧，
      // 用来给截图/自检看挤压形变（真实游戏里这是撞出来的，不是摆出来的）
      var sm = /[?&]squash=([\d.]+)/.exec(root.location.search);
      if (sm) {
        var kk = Math.min(CFG.RULES.jelly.squashMax, parseFloat(sm[1]) || 0.25);
        game.fruits().forEach(function (f, i) {
          f.suikaSq = kk;
          f.suikaSqA = i % 2 === 0 ? 0 : Math.PI / 2;
        });
        render.draw(buildFrame());
      }
      var pm = /[?&]pump=(\d+)/.exec(root.location.search);
      if (pm) {
        var n = Math.min(900, Math.max(1, parseInt(pm[1], 10) || 120));
        var t0 = root.performance && root.performance.now ? root.performance.now() : Date.now();
        for (var fi = 0; fi < n; fi++) frame(t0 + fi * 16.7);
      }
    }

    if (demoMode) {
      if (assets && assets.preloadAll) assets.preloadAll().then(runDemo, runDemo);
      else runDemo();
    }
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
