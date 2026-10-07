/*!
 * 合成邦多利皇帝 · 主流程
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
  var lastRec = null; // 本局成绩记录（等玩家确认名字后再提交）
  var lastSummary = null; // 本局小结（结算画面重绘用）
  var roundSubmitted = false; // 本局是否已经确认上榜
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

    /*
     * 所有发声都过这一道限制器（见 js/config.js 的 createAudioLimiter）：
     * 并发上限 + 同一个音最短间隔。连击、危险线报警、成堆掉落叠在一起时不会爆音。
     */
var limiter = CFG.createAudioLimiter();

    /*
     * 计数：合成音 / 文件音各"真的发出声"了几次。
     * 用来排查「一点声音都没有」到底是游戏没触发，还是浏览器/系统那边被静音了
     * （?audio=1 会把这两个数字显示出来）。
     */
    var synthCount = 0;
    var fileCount = 0;

    function tone(freq, dur, type, vol, delay, key, force) {
      /* force：自检音（ping）不受档位影响，用来判断浏览器能不能出声 */
      if (!force && !voiceOn()) return;
      var ac = ensure();
      if (!ac) return;
      /* 限流：并发上限 + 同一个音最短间隔 */
      if (!limiter.allow(key || 'f' + freq, ac.currentTime * 1000)) return;
      /* 0 延迟就贴在当前时刻（越靠近 currentTime 越不容易听出延迟） */
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
      synthCount += 1;
      /* 播完把声部还回去；老浏览器没有 onended 就用定时器兜底 */
      var done = function () {
        limiter.release();
      };
      if (osc.onended !== undefined) osc.onended = done;
      else root.setTimeout(done, (dur + 0.06 + (delay || 0)) * 1000);
    }

    /*
     * 文件音效（可选）。把音频按 js/config.js 的 AUDIO.sounds 命名丢进 assets/audio/
     * 就会被用上；没有文件、取不到（file://）、或浏览器不支持时 play() 返回 false，
     * 这里就退回下面的现场合成音 —— 所以「加不加音频文件」都不影响能玩。
     */
    var fileAudio =
      root.SuikaAudio && CFG.AUDIO && CFG.AUDIO.enabled
        ? root.SuikaAudio.create({ config: CFG })
        : null;

    /**
     * 先试文件音效；没有再退回合成音。
     *
     * 关键：只有当文件音效的音频上下文**真的在运行**时才算"播出去了"。
     * 否则（上下文还在 suspended，自动播放策略没放行）文件音只是"排队等唤醒"，
     * 一点声音都没有 —— 这时必须让调用方退回合成音，
     * 否则就是「整局全静音」（真踩过：文件音返回 true 把合成音挡住了）。
     */
    function playFile(key, o) {
      if (!fileAudio || !voiceOn()) return false;
      try {
        var ac = fileAudio.context ? fileAudio.context() : null;
        var running = !!ac && ac.state === 'running';
        var ok = fileAudio.play(key, o) === true;
        if (!ok) return false;
        if (!running) return false; // 播了也听不见，交给合成音
        fileCount += 1;
        return true;
      } catch (err) {
        return false;
      }
    }

    return {
      /** 音频上下文（切后台时要把挂起/恢复，省电又避免积压音效一起响） */
      context: function () {
        var ac = ensure();
        return ac || (fileAudio && fileAudio.context ? fileAudio.context() : null);
      },
      unlock: function () {
        var ac = ensure();
        /* 浏览器自动播放策略：上下文默认是 suspended，必须在用户手势里 resume */
        if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
        if (fileAudio && fileAudio.unlock) fileAudio.unlock();
        /* 有的浏览器第一次 resume 会被忽略，这里再补一次 */
        if (ac && ac.state === 'suspended' && ac.resume) {
          try {
            ac.resume();
          } catch (err) {
            /* 忽略 */
          }
        }
        /* 解锁之后：预热固定名字的音效 + 当前/下一只玩偶的语音池 */
        if (fileAudio && fileAudio.preload) {
          try {
            fileAudio.preload(['warn', 'over', 'click']);
            warmVoices();
          } catch (err) {
            /* 忽略 */
          }
        }
      },
      /** 文件音效实例（加载页要用它的 preloadMany / nameList） */
      file: function () {
        return fileAudio;
      },
      /** 文件音效的状态（自检/调试用：?audio=1 会打到控制台和页面上） */
      /** 音频上下文状态（排查「没声音」：suspended 就是没被唤醒） */
      contextState: function () {
        var ac = ensure();
        var fa = fileAudio && fileAudio.context ? fileAudio.context() : null;
        return { synth: ac ? ac.state : 'none', file: fa ? fa.state : 'none' };
      },
      /**
       * 自检音：不受档位影响，故意响一声。
       * 试听页会用它来判断「浏览器/系统这边到底能不能出声」。
       */
      ping: function () {
        tone(880, 0.18, 'sine', 0.14, 0, 'ping', true);
        tone(1320, 0.16, 'sine', 0.08, 0.13, 'ping2', true);
      },
      /** 排查「没声音」用：合成音/文件音真正发声的次数 */
      counts: function () {
        return { synth: synthCount, file: fileCount };
      },
      fileStats: function () {
        return fileAudio && fileAudio.stats ? fileAudio.stats() : null;
      },
      /**
       * 释放玩偶：
       *   全语音 → 放「当前要投的那只玩偶」的语音（在那个角色的池子里随机一条）
       *   名场面 → 平时安静，只有连击高光时才出声
       *   静音   → 什么都不放
       */
      drop: function (id, tier, combo) {
        if (!voiceOn()) return;
        if (voiceMode() === 'all' && playFile('drop', { id: id })) return;
        if (voiceMode() === 'scene' && !voiceAllowed(tier, combo)) return; // 名场面模式：平时安静
        tone(300, 0.08, 'triangle', 0.045, 0, 'drop');
      },
      /**
       * 合成玩偶：
       *   全语音 → 放「合成出来的那一只」的语音（那个角色的池子里随机一条）
       *   名场面 → 只有合成出大玩偶（tier ≥ 9）或连击 ≥3 时才出声
       *   静音   → 什么都不放
       */
      merge: function (tier, combo, id) {
        var c = Math.max(1, combo || 1);
        if (!voiceOn()) return;
        var highlight = voiceAllowed(tier, c);
        if ((voiceMode() === 'all' || highlight) && playFile('merge', { id: id })) return;
        if (voiceMode() === 'scene' && !highlight) return; // 名场面模式：非高光时刻保持安静
        // 连击越高音越亮，给连击一个听觉反馈
        var f = 260 * Math.pow(1.085, Math.max(0, tier)) * Math.pow(1.06, c - 1);
        // key 带上 tier：同一只玩偶连爆时节流，不同 tier 互不压制
        tone(f, 0.15, 'sine', 0.085, 0, 'merge' + tier);
        tone(f * 1.5, 0.11, 'sine', 0.035, 0.015, 'mergeH' + tier);
        if (c >= 3) tone(f * 2, 0.1, 'triangle', 0.03, 0.05, 'mergeC' + tier);
      },
      warn: function () {
        if (!voiceOn()) return;
        if (playFile('warn')) return;
        tone(180, 0.18, 'sawtooth', 0.035, 0, 'warn');
      },
      over: function () {
        if (!voiceOn()) return;
        /* 「名场面」那批音频还没导入，这里照常走结束音 */
        if (playFile('over')) return;
        tone(420, 0.22, 'sine', 0.07);
        tone(300, 0.26, 'sine', 0.07, 0.14);
        tone(190, 0.42, 'sine', 0.07, 0.28);
      },
      /** 界面音（按钮/选图，可选文件；没有文件就静音，不硬凑合成音） */
      click: function () {
        playFile('click');
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
      // 玩偶版显示角色名（不再显示玩偶名 / emoji）
      dom.maxtier.textContent = def ? assets.labelOf(st.maxTier) : '—';
    }
    UI.paintPreview(dom.current, currentTier, assets, 0.5);
    UI.paintPreview(dom.next, nextTier, assets, 0.5);
    UI.updateChain(dom.chain, st.maxTier, st.tierCounts);
    if (dom.pause) dom.pause.textContent = phase === 'paused' ? '▶ 继续' : '⏸ 暂停';
    if (dom.sound) {
      var m = voiceMode();
      dom.sound.textContent = CFG.VOICE_MODE_ICONS[m] + ' ' + CFG.VOICE_MODE_LABELS[m];
      dom.sound.setAttribute('aria-pressed', String(m !== 'mute'));
      dom.sound.title =
        m === 'all'
          ? '全语音：释放与合成都会念台词（点一下切到「名场面」）'
          : m === 'scene'
            ? '名场面：只在大玩偶 / 连击时出声（点一下切到「静音」）'
            : '静音：完全不发声（点一下切回「全语音」）';
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
    sfx.drop(voiceIdOf(currentTier), currentTier, game.getState().combo);
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

  /**
   * 预热「当前」和「下一只」这两只玩偶的语音池（各 10 条 ≈ 250KB）。
   * 目的是让第一次投放/合成就有语音，而不是先用合成音顶一下。
   * 玩家在选图窗口换了阵容，这里的 id 自然也跟着变。
   */
  var warmedIds = {};
  function warmVoices() {
    /* fileAudio 是 createSfx 内部的，这里通过 sfx.file() 拿（之前直接引用报过 ReferenceError） */
    var fa = sfx && sfx.file ? sfx.file() : null;
    if (!fa || !fa.preload) return;
    if (voiceMode() === 'mute') return;
    [currentTier, nextTier].forEach(function (tier) {
      var id = voiceIdOf(tier);
      if (!id || warmedIds[id]) return;
      warmedIds[id] = true;
      try {
        fa.preload(['drop', 'merge'], { id: id });
      } catch (err) {
        /* 忽略 */
      }
    });
  }
  /*
   * 加载页：把「当前阵容要用到的语音」先全部取下来并解码好，再放玩家进游戏。
   * 这样发声就不会慢半拍、也不会出现「第一次点没声音」。
   *
   * 说明（省得以后误解）：这能消掉**加载/解码**带来的延迟，
   * 但消不掉**音频硬件本身的输出延迟**（那是系统缓冲区，通常 10~40ms）。
   * 真实输出延迟可以从 sfx.fileStats().baseLatency / outputLatency 读出来。
   */
  function runLoadingScreen() {
    return new Promise(function (resolve) {
      var screen = document.getElementById('loading-screen');
      var bar = document.getElementById('loading-bar');
      var note = document.getElementById('loading-note');
      /* 演示模式 / 没有文件音效 / 明确跳过时直接过 */
      var fa = sfx && sfx.file ? sfx.file() : null;
      var skip =
        demoMode ||
        !fa ||
        !fa.preloadMany ||
        /[?&]noloading=1/.test(root.location.search);
      if (skip || !screen) {
        resolve();
        return;
      }
      /*
       * 预取分两段（这是「加载更快」的关键）：
       *
       *   第一段（挡在加载页后面，必须先下完）：
       *     界面音效 + 当前 11 个位子的**释放语音** drop-1..5，约 1.9MB。
       *     投放是开局立刻要用的声音，必须先到位。
       *
       *   第二段（后台继续，不挡玩家），顺序也讲究：
       *     ① 当前阵容的**合成语音**（开局一两秒内就用得到，排最前）
       *     ② 图库里其余角色的全部语音
       *     合计约 7.7MB，玩家忙着玩的时候下完；万一某条还没到，
       *     那一次会退回合成音（不会没声音），下好了自动换回原声。
       *
       * 为什么不再「全部下完才进游戏」：那是 9.6MB，手机上要等很久，
       * 而真正开局立刻用得到的只有当前阵容的释放音。
       */
      var priority = [];
      var lineupMerge = [];
      for (var tier = 1; tier <= CFG.RULES.maxTier; tier++) {
        var pid = voiceIdOf(tier);
        if (!pid) continue;
        priority = priority.concat(fa.nameList(['drop'], { id: pid }));
        lineupMerge = lineupMerge.concat(fa.nameList(['merge'], { id: pid }));
      }
      priority = priority.concat(fa.nameList(['warn', 'over', 'click']));

      var restNames = lineupMerge.slice();
      var allIds = assets.allIds ? assets.allIds() : [];
      for (var vi = 0; vi < allIds.length; vi++) {
        /* 常服版复用常规版的语音（CFG.AUDIO.audioIdOf），所以先映射再收集，避免重复下载 */
        var mapped = CFG.AUDIO && CFG.AUDIO.audioIdOf ? CFG.AUDIO.audioIdOf(allIds[vi]) : allIds[vi];
        restNames = restNames.concat(fa.nameList(['drop', 'merge'], { id: mapped }));
      }
      /* 去重（常服映射后会出现重复项），并把第一段已经覆盖的剔掉 */
      var seen = {};
      priority.forEach(function (n) {
        seen[n] = true;
      });
      restNames = restNames.filter(function (n) {
        if (seen[n]) return false;
        seen[n] = true;
        return true;
      });

      /* 暴露两段清单（自检/测试用）：核对「挡在加载页后面的到底有多少」 */
      root.SUIKA_PRELOAD = { priority: priority.slice(), rest: restNames.slice() };

      var names = priority;
      /* 兜底：万一当前阵容一个角色都取不到（图库为空等），就退回「全部」 */
      if (!names.length) names = restNames.slice();
      if (!names.length) {
        resolve();
        return;
      }
      screen.hidden = false;
      /*
       * 插图先用静态首帧（147KB，立刻可见），再在后台把 1.3MB 的动画换上去 ——
       * 别人不会盯着空白等图，动画也不占加载时间。
       */
      var art = screen.querySelector ? screen.querySelector('.loading-art') : null;
      if (art && art.getAttribute) {
        var gifSrc = art.getAttribute('data-gif');
        if (gifSrc && String(art.src).indexOf('loading.gif') < 0) {
          var artImg = new Image();
          artImg.onload = function () {
            art.src = gifSrc;
          };
          artImg.src = gifSrc;
        }
      }
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        screen.hidden = true;
        resolve();
      };
      /* ?loading=1 ：把加载页停住（自检/截图用），方便看插图和进度条长什么样 */
      if (/[?&]loading=1/.test(root.location.search)) {
        if (bar) bar.style.width = '62%';
        if (note) note.textContent = '正在加载游戏（自检：停在这一屏）';
        return;
      }
      /*
       * 超时兜底：给足时间（手机 4G 下 7MB 语音可能要一两分钟）。
       * 之前是 30 秒，手机上经常「没加载完就消失」，结果语音不全 —— 现在：
       *   · 超时放宽到 3 分钟；
       *   · 而且不再默默消失：超时后还在加载就继续等，并给一个「先进入游戏」的按钮，
       *     由玩家决定要不要跳过（不会出现「进度条自己没了」）。
       */
      var giveUpAfterMs = 180000;
      var offeredSkip = false;
      var skipBtn = document.getElementById('loading-skip');
      if (skipBtn && !skipBtn._wired) {
        skipBtn._wired = true;
        skipBtn.addEventListener('click', finish);
      }
      var offerSkip = function () {
        if (offeredSkip || finished) return;
        offeredSkip = true;
        if (skipBtn) skipBtn.hidden = false;
        if (note) note.textContent = '网络较慢，仍在继续加载语音…';
      };
      root.setTimeout(offerSkip, 15000);
      root.setTimeout(offerSkip, giveUpAfterMs);
      var prefetch = fa.prefetchMany || fa.preloadMany;
      prefetch
        .call(fa, names, function (done, total) {
          var pct = total ? Math.round((done / total) * 100) : 100;
          if (bar) bar.style.width = pct + '%';
          if (note) note.textContent = '正在加载游戏';
        })
        .then(function (res) {
          /*
           * 预取完再核对一次：万一还有没拿到的（断网/限速），补一轮，
           * 只有真的全部处理完才自动进游戏 —— 这样才不会「语音只加载了一半」。
           */
          var retry = fa.retryMissing ? fa.retryMissing(names) : null;
          var tail = retry && retry.then ? retry : Promise.resolve(null);
          return tail.then(function (again) {
            if (again && again.remaining && !offeredSkip) {
              if (note) note.textContent = '还有 ' + again.remaining + ' 条没拿到，继续重试…';
              offerSkip();
            }
            if (note) note.textContent = '准备完成，马上开始！';
            /* 预取完成后，把当前/下一只需要用到的先解码好，进游戏就是原声 */
            warmVoices();
            finish();
            /* 放人进游戏之后，剩下的语音在后台悄悄下完（不挡玩家） */
            prefetchRest(fa, restNames);
          });
        });
    });
  }

  /**
   * 后台把「其余角色」的语音下完。
   * 不显示进度、不阻塞，失败也无所谓（下次要用的那条会退回合成音）。
   */
  function prefetchRest(fa, list) {
    if (!fa || !fa.prefetchMany || !list || !list.length) return;
    try {
      fa.prefetchMany(list, null).then(function () {
        if (fa.retryMissing) fa.retryMissing(list);
      });
    } catch (err) {
      /* 后台任务失败不影响游戏 */
    }
  }

  /* ---------------- 背景音乐（选图后面那颗图标） ---------------- */

  /*
   * 一首完整的歌（朋友的酒 DJ 完整版，4.4MB），所以：
   *   · 用 <audio> 播放（流式，不占解码内存）而不是 WebAudio 解码整首
   *   · preload=none：不点就不下载
   *   · 循环播放，音量压低，别盖过玩偶语音
   */
  var BGM_SRC = 'assets/bgm/kkr-pengyou-de-jiu-dj.m4a';
  var bgmEl = null;
  var bgmPlaying = false;
  var bgmWanted = false; // 用户希望它响（切后台时用来恢复）

  function bgmElement() {
    if (bgmEl) return bgmEl;
    var el = null;
    if (D.createElement) {
      el = D.createElement('audio');
      if (el) {
        el.src = BGM_SRC;
        el.loop = true;
        el.volume = 0.32;
        el.preload = 'none';
      }
    }
    bgmEl = el;
    return el;
  }

  /**
   * 把「播放中」的外观画到按钮上。
   *
   * 为什么用内联样式而不是只靠 CSS 类：顶栏里 `.btn` / `.btn:hover` 的 background
   * 会把 `.btn-music.is-on` 那条规则盖掉（实测：类加上了、box-shadow 生效了，
   * 但底色和图标颜色没变）。内联样式优先级最高，最稳，也不再依赖外部样式表。
   */
  function applyBgmLook(on) {
    if (!dom.musicBtn) return;
    dom.musicBtn.classList.toggle('is-on', on);
    try {
      dom.musicBtn.style.background = on ? '#007aff' : '';
      dom.musicBtn.style.borderColor = on ? '#007aff' : '';
      var icon = dom.musicBtn.querySelector ? dom.musicBtn.querySelector('.btn-music-icon') : null;
      /* 图标本身是「透明底 + 黑图形」，播放时翻成白色 */
      if (icon) icon.style.filter = on ? 'brightness(0) invert(1)' : '';
    } catch (err) {
      /* 内联样式失败也不影响播放本身 */
    }
  }

  function syncBgmButton() {
    if (!dom.musicBtn) return;
    applyBgmLook(bgmPlaying);
    dom.musicBtn.setAttribute('aria-pressed', String(bgmPlaying));
    dom.musicBtn.title = bgmPlaying
      ? '停止背景音乐（朋友的酒 DJ 完整版）'
      : '播放背景音乐（朋友的酒 DJ 完整版）';
  }

  function bgmPlay() {
    var el = bgmElement();
    if (!el) return false;
    try {
      if (el.play) {
        var r = el.play();
        /* 浏览器返回 Promise：失败（比如自动播放策略）就当没播 */
        if (r && r.catch) {
          r.catch(function () {
            bgmPlaying = false;
            syncBgmButton();
          });
        }
      }
    } catch (err) {
      return false;
    }
    bgmPlaying = true;
    syncBgmButton();
    /*
     * 手机上播/停 <audio> 会把 WebAudio 上下文挤成 suspended，
     * 结果连玩偶语音一起哑掉（用户反馈：「关掉这个图标时也会关闭玩偶的语音」）。
     * 所以启停之后都要把语音用的上下文重新唤醒一次。
     */
    reviveVoices();
    return true;
  }

  function bgmStop() {
    if (bgmEl) {
      try {
        if (bgmEl.pause) bgmEl.pause();
      } catch (err) {
        /* 忽略 */
      }
    }
    bgmPlaying = false;
    syncBgmButton();
    reviveVoices();
  }

  /** 把语音用的音频上下文重新唤醒（手机上 <audio> 抢走音频会话后必须做这一步） */
  function reviveVoices() {
    try {
      if (!sfx || !sfx.context) return;
      var ac = sfx.context();
      if (ac && ac.state !== 'running' && sfx.unlock) sfx.unlock();
    } catch (err) {
      /* 唤醒失败也不影响游戏 */
    }
  }

  /** 点一下开始 / 再点一下停止 */
  function toggleBgm() {
    if (bgmPlaying) {
      bgmWanted = false;
      bgmStop();
      UI.toast('背景音乐已停止（玩偶语音照常）');
      return;
    }
    bgmWanted = true;
    sfx.unlock(); // 顺手把音效上下文也解锁一下
    if (bgmPlay()) {
      UI.toast('🎵 朋友的酒（DJ 完整版）开始播放');
    } else {
      UI.toast('这个浏览器不让播放音频');
    }
  }

  /* ---------------- 语音模式 ---------------- */

  /** 当前是哪一档：all（全语音）/ scene（名场面）/ mute（静音） */
  function voiceMode() {
    var m = prefs && prefs.voice;
    if (CFG.VOICE_MODES && CFG.VOICE_MODES.indexOf(m) >= 0) return m;
    /*
     * 没有 voice 字段时**一律按「全语音」**，不再从老版本的布尔 sound 推断。
     * 原因：老版本点过「音效」关掉的人，localStorage 里留着 sound:false，
     * 若据此推断成 mute，升级后就是「一点声音都没有」，很容易被当成 bug（真发生过）。
     * 静音现在必须在新按钮上明确选一次。
     */
    return 'all';
  }

  /**
   * 取「这一级该用哪个角色的语音」：先查图库 id，再应用常服别名（常服版复用常规版语音）。
   */
  function voiceIdOf(tier) {
    if (!assets || !assets.idOf) return null;
    var id = assets.idOf(tier);
    return CFG.AUDIO && CFG.AUDIO.audioIdOf ? CFG.AUDIO.audioIdOf(id) : id;
  }

  /** 切到「静音」档时顺手把背景音乐也停掉（用户点的是静音，期望整体安静） */
  function stopBgmIfMuted() {
    if (voiceMode() === 'mute' && bgmPlaying) bgmStop();
  }

  var voiceOn = function () {
    return voiceMode() !== 'mute';
  };
  /** 名场面模式只在「高光时刻」出声；全语音模式一律出声 */
  var voiceAllowed = function (tier, combo) {
    var m = voiceMode();
    if (m === 'mute') return false;
    if (m === 'all') return true;
    var h = CFG.VOICE_HIGHLIGHT || { tierFrom: 9, comboFrom: 3 };
    return (tier != null && tier >= h.tierFrom) || (combo != null && combo >= h.comboFrom);
  };
  /* ---------------- 局内存档（手机切后台不清零） ---------------- */

  /*
   * 手机上切到后台再回来「数据清零」，绝大多数不是我们的 bug，而是：
   * 系统为了省内存把页面直接丢掉，回来时浏览器**重新加载**了一次页面 ——
   * 内存里的这一局自然就没了（最高分/昵称这些进了 localStorage，所以还在）。
   *
   * 对策：把「打到一半的这一局」也存进 localStorage。
   *   · 什么时候存：切到后台、页面要卸载、暂停、以及玩的时候每 2 秒一次
   *   · 什么时候清：这一局结束（结算/重开）之后
   *   · 什么时候恢复：下次打开页面时，如果存档还新鲜（12 小时内）就直接接着打
   * 一个快照只有几 KB，写起来很便宜。
   */

  var SAVE_VERSION = 1;
  var SAVE_FRESH_MS = 12 * 60 * 60 * 1000;
  var saveClock = 0;

  function saveProgress(force) {
    /* 演示模式一律用内存存储，绝不碰你自己的存档 */
    if (demoMode || !storage) return false;
    if (phase !== 'playing' && phase !== 'paused') return false;
    if (!force && saveClock < 2000) return false;
    saveClock = 0;
    try {
      storage.setItem(
        CFG.STORAGE_KEYS.save,
        JSON.stringify({
          v: SAVE_VERSION,
          ts: Date.now(),
          currentTier: currentTier,
          nextTier: nextTier,
          aim: aimX,
          cooldown: cooldown,
          round: game.snapshot()
        })
      );
      return true;
    } catch (err) {
      /* 存不下就算了（比如隐私模式），不能因为存档把游戏搞崩 */
      return false;
    }
  }

  function clearProgress() {
    if (demoMode || !storage) return;
    try {
      storage.removeItem(CFG.STORAGE_KEYS.save);
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 读存档；过期/坏掉的返回 null（顺便把坏档删掉） */
  function loadProgress() {
    if (demoMode || !storage) return null;
    var raw = null;
    try {
      raw = storage.getItem(CFG.STORAGE_KEYS.save);
    } catch (err) {
      return null;
    }
    if (!raw) return null;
    var data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      clearProgress();
      return null;
    }
    var fresh = data && data.v === SAVE_VERSION && Date.now() - Number(data.ts) < SAVE_FRESH_MS;
    if (!fresh || !data.round || !Array.isArray(data.round.dolls) || !data.round.dolls.length) {
      clearProgress();
      return null;
    }
    return data;
  }

  /** 用存档接着打 */
  function resumeFromSave(data) {
    if (!data) return false;
    if (!game.restore(data.round)) return false;
    prefs.difficulty = CFG.clampDifficulty(data.round.difficulty != null ? data.round.difficulty : prefs.difficulty);
    diffPending = false;
    game.setDifficulty(prefs.difficulty);
    render.clearEffects();
    round = { id: 'r' + Date.now().toString(36), rank: 0 };
    currentTier = CFG.tierByNumber(data.currentTier) ? data.currentTier : game.pickTier();
    nextTier = CFG.tierByNumber(data.nextTier) ? data.nextTier : game.pickTier();
    cooldown = Math.max(0, Number(data.cooldown) || 0);
    aimX = clampAim(Number(data.aim) || BOARD.width / 2);
    phase = 'playing';
    if (dom.delta) dom.delta.textContent = '';
    setComboHud(0, 1, 0);
    UI.hideOverlay();
    syncDiffUi();
    renderBoardView();
    syncHud();
    UI.toast('已恢复上一局：' + game.getState().score + ' 分', 'ok');
    return true;
  }

  /* ---------------- 一局流程 ---------------- */

  function startRound() {
    UI.hideOverlay();
    sfx.unlock();
    clearProgress(); // 开新的一局，旧存档作废
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
    clearProgress(); // 这一局结束了：成绩已经进榜单/最高分，临时存档没用了
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
    lastRec = rec;
    lastSummary = summary;
    lastRecKey = rec.n + '|' + rec.t + '|' + rec.s;
    roundSubmitted = false;

    /*
     * 按需求：**先让玩家确认名字，再同步成绩**。
     * 所以这里不自动上传，只在结算画面里给一个「上榜名字」输入框
     * （默认取排行榜那边填的名字，兜底「玩家」），点「确认并上榜」才提交。
     */
    renderRoundResult(summary, {
      pending: true,
      rank: BOARDS.rankOf(rec, sync.view('top')),
      shared: isShared(),
      limit: BOARDS.TOP_MAX
    });
  }

  /** 结算画面里的「确认并上榜」：存名字 → 提交成绩 → 刷新名次 */
  function confirmAndSubmit() {
    if (roundSubmitted || !lastRec) return;
    var input = document.getElementById('result-player');
    var name = input && input.value ? String(input.value).trim().slice(0, 12) : '';
    if (!name) name = '玩家';
    if (dom.player) dom.player.value = name;
    prefs.player = name;
    saveJson(CFG.STORAGE_KEYS.prefs, prefs);

    lastRec.n = name;
    lastRecKey = name + '|' + lastRec.t + '|' + lastRec.s;
    roundSubmitted = true;

    if (!isShared()) {
      UI.toast('本机模式：成绩只记在这台电脑上', 'ok');
      renderBoardView(lastRecKey);
      renderRoundResult(lastSummary, {
        uploaded: false,
        rank: BOARDS.rankOf(lastRec, sync.view('top')),
        shared: false,
        limit: BOARDS.TOP_MAX
      });
      return;
    }

    renderRoundResult(lastSummary, {
      uploading: true,
      rank: BOARDS.rankOf(lastRec, sync.view('top')),
      shared: true,
      limit: BOARDS.TOP_MAX
    });
    sync.submit(lastRec).then(function (res) {
      if (!res.ok) UI.toast('没上传成功，已放进待上传队列，联网后自动重试', 'bad');
      else UI.toast('已上榜：' + name + ' · 第 ' + (res.rank || '-') + ' 名', 'ok');
      renderBoardView(lastRecKey);
      renderRoundResult(lastSummary, {
        uploaded: !!res.ok,
        rank: res.rank || 0,
        shared: true,
        limit: BOARDS.TOP_MAX
      });
    });
  }

  /** 「请作者吃小布丁」：弹出收款码 + 寄语 */
  function showDonate() {
    UI.showOverlay({
      title: '🍮 请作者吃小布丁',
      body:
        '<p class="donate-msg">本网站为爱发电，全程无广，感谢喜欢，作者会努力整活的！感谢喜欢邦多利！</p>' +
        '<div class="donate-qr-wrap">' +
        '<img class="donate-qr" src="assets/qr-donate.jpg" alt="请作者吃小布丁（收款码）" />' +
        '</div>' +
        '<p class="donate-tip">微信扫码 · 一块两块都是爱，全部用来买小布丁 🍮</p>',
      actions: [
        {
          label: '返回结算',
          kind: 'primary',
          onClick: function () {
            if (lastSummary) renderRoundResult(lastSummary, roundSubmitted ? { uploaded: true, rank: BOARDS.rankOf(lastRec, sync.view('top')), shared: isShared(), limit: BOARDS.TOP_MAX } : { pending: true, rank: BOARDS.rankOf(lastRec, sync.view('top')), shared: isShared(), limit: BOARDS.TOP_MAX });
            else UI.hideOverlay();
          }
        },
        { label: '再来一局', kind: 'ghost', onClick: startRound }
      ]
    });
  }

  /**
   * Q 裙交流：点顶栏那颗「💬 Q裙交流」弹出来。
   * 群号单独一行、可一键复制 —— 手机上手动选中一串数字很费劲。
   */
  var QQ_GROUP = '1107292028';

  function showQqGroup() {
    UI.showOverlay({
      title: '💬 Q裙交流',
      body:
        '<p class="qq-msg">欢迎一起来交流哦</p>' +
        '<div class="qq-num-wrap">' +
        '<span class="qq-num" id="qq-num">' +
        QQ_GROUP +
        '</span>' +
        '<button class="btn btn-primary qq-copy" id="qq-copy" type="button">复制群号</button>' +
        '</div>' +
        '<p class="qq-tip">群号：' + QQ_GROUP + '</p>',
      actions: [{ label: '关闭', kind: 'ghost', onClick: function () { UI.hideOverlay(); } }]
    });
    var copyBtn = document.getElementById('qq-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyText(QQ_GROUP, '群号已复制：' + QQ_GROUP);
      });
    }
  }

  /** 复制到剪贴板：优先 Clipboard API，失败就退回老办法（http 下没有 clipboard） */
  function copyText(text, okMsg) {
    var done = function () {
      UI.toast(okMsg);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (err) {
        UI.toast('复制失败，群号是 ' + text);
      }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
        return;
      }
    } catch (err) {
      /* 落到 fallback */
    }
    fallback();
  }

  function renderRoundResult(summary, submitted) {
    var def = CFG.tierByNumber(summary.maxTier) || CFG.tierByNumber(1);
    var diff = CFG.difficultyOf(summary.difficulty);
    var rankText;
    var statusText;
    var submitLabel = '确认并上榜';
    var submitDisabled = false;
    if (submitted.pending) {
      rankText = '还没上榜 —— 确认名字后马上同步（本地预览第 <b>' + (submitted.rank || '-') + '</b> 名）';
      statusText = '填好名字点右边按钮，就可以上榜了';
    } else if (submitted.uploading) {
      rankText = '正在同步到榜上…';
      statusText = '同步中…';
      submitLabel = '同步中…';
      submitDisabled = true;
    } else if (submitted.shared) {
      rankText = submitted.uploaded
        ? '已上榜（' + escapeHtml(lastRec ? lastRec.n : '') + '），暂列第 <b>' + (submitted.rank || '-') + '</b> 名'
        : '已存进待上传队列，联网后自动上榜';
      statusText = submitted.uploaded ? '已上榜 ✔' : '已排队，等联网';
      submitLabel = '已上榜 ✔';
      submitDisabled = true;
    } else {
      rankText = '本机榜暂列第 <b>' + (submitted.rank || '-') + '</b> 名（当前是本机模式）';
      statusText = '本机模式：只记在这台电脑上';
      submitLabel = '记到本机榜';
    }
    var rows =
      '<div class="result-score">' +
      CFG.formatScore(summary.score) +
      '<span>分</span></div>' +
      '<div class="result-grid">' +
      '<div><span class="k">最大</span><b>' +
      (def ? assets.labelOf(def.tier) : '—') +
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
      '<div><span class="k">投放次数</span><b>' +
      summary.drops +
      '</b></div>' +
      '</div>' +
      // 名字确认：自定义，或留空用默认「玩家」，确认后才同步成绩
      '<div class="result-name">' +
      '<label for="result-player">上榜名字</label>' +
      '<input id="result-player" type="text" maxlength="12" placeholder="玩家" value="' +
      escapeHtml(lastRec ? lastRec.n : '玩家') +
      '" />' +
      '<button class="btn btn-primary btn-mini" id="result-submit" type="button"' +
      (submitDisabled ? ' disabled' : '') +
      '>' +
      submitLabel +
      '</button>' +
      '<span class="result-name-status" id="result-name-status">' +
      statusText +
      '</span>' +
      '</div>' +
      '<p class="result-rank">' +
      rankText +
      '</p>' +
      '<p class="result-note">按当前需求，本局成绩<b>不写入个人排行表</b>；' +
      (submitted.shared || submitted.pending
        ? '实时榜打开即最新，总榜每 ' + Math.round(sync.refreshMs / 60000) + ' 分钟自动刷新。'
        : '当前是本机模式（看榜单右下角的说明可以切回全球榜）。') +
      '</p>';

    UI.showOverlay({
      title: '本局结束',
      body:
        rows +
        '<div class="credit-box" id="result-credit" hidden>' +
        '<b>音频来源</b><br />朋友的酒DJ版——活跃黑江乐' +
        '</div>',
      actions: [
        { label: '再来一局', kind: 'primary', onClick: startRound },
        {
          label: '留在榜上看看',
          kind: 'ghost',
          onClick: function () {
            UI.hideOverlay();
          }
        },
        {
          label: '🎵 音频来源',
          kind: 'ghost',
          onClick: function () {
            /* 就地展开，不关掉结算界面（关掉就看不到本局成绩了） */
            var box = document.getElementById('result-credit');
            if (!box) return;
            box.hidden = !box.hidden;
          }
        },
        { label: '🍮 请作者吃小布丁', kind: 'ghost', onClick: showDonate }
      ]
    });

    // showOverlay 用 innerHTML 重建，事件得在这之后再挂
    var input = document.getElementById('result-player');
    var btn = document.getElementById('result-submit');
    if (btn && !submitDisabled) btn.addEventListener('click', confirmAndSubmit);
    if (input && !submitDisabled) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') confirmAndSubmit();
      });
      try {
        input.focus();
        input.select();
      } catch (e) {
        /* 无头环境没有 focus 也没关系 */
      }
    }
  }

  /** 名字要拼进 innerHTML，做一下转义（玩家可以随便输） */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function togglePause(force) {
    if (phase === 'playing' || force === true) {
      phase = 'paused';
      saveProgress(true); // 暂停时顺手存一次
      syncHud();
      UI.showOverlay({
        title: '已暂停',
        body: '<p>棉花娃娃们先歇一会儿。</p>',
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

  /* ---------------- 手机端布局：得分搬到棋盘上方、即将投放浮到棋盘左上角 ---------------- */

  var mobileLayout = null; // null = 还没判断过

  /**
   * 手机端（≤880px）：
   *   · 「本局得分」整块搬到 .layout 之前 —— 顶栏按钮下方、棋盘正上方
   *   · 「即将投放」搬进 .board-wrap，做成棋盘左上角的小浮层
   * 桌面端恢复原位（记了原来的父节点与后继节点，搬回去是精确的）。
   * 为什么搬 DOM 而不是纯 CSS：这些面板嵌在 .col-left 里，外层网格排不到它们；
   * 而用 display:contents + 命名区域重排，在没有 grid-template-areas 时
   * （`grid-area: stage` 会退化成隐式命名线）反而会把单列布局搞成乱多列。
   */
  function applyMobileLayout() {
    // 环境不支持就跳过（很老的浏览器 / 精简的测试环境）
    if (typeof document.querySelector !== 'function') return;
    var narrow = root.matchMedia ? root.matchMedia('(max-width: 880px)').matches : (root.innerWidth || 9999) <= 880;
    if (mobileLayout === narrow) return;
    var score = document.querySelector('.score-panel');
    var next = document.querySelector('.next-panel');
    var wrap = document.querySelector('.board-wrap');
    var layout = document.querySelector('.layout');
    if (!score || !next || !wrap || !layout || !layout.parentNode) return;
    mobileLayout = narrow;
    if (narrow) {
      if (!score.__home) score.__home = { parent: score.parentNode, next: score.nextSibling };
      if (!next.__home) next.__home = { parent: next.parentNode, next: next.nextSibling };
      layout.parentNode.insertBefore(score, layout);
      wrap.appendChild(next);
      score.classList.add('is-topstrip');
      next.classList.add('is-floating');
    } else {
      if (score.__home) score.__home.parent.insertBefore(score, score.__home.next);
      if (next.__home) next.__home.parent.insertBefore(next, next.__home.next);
      score.__home = null;
      next.__home = null;
      score.classList.remove('is-topstrip');
      next.classList.remove('is-floating');
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

    /* 每 2 秒落一次盘：切后台时系统可能直接丢掉页面，不能只在切后台那一刻才存 */
    if (phase === 'playing') {
      saveClock += dt;
      saveProgress(false);
    }

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

    /*
     * 投放的手感（手机重点）：
     *   按下 → 只把瞄准线移过去，**不投放**；拖动 → 跟着手指移动；
     *   松手 → 才投放。
     * 这样手机上就能「按住在屏幕上左右找位置」，找好了再松手放，不会一点就掉。
     * 鼠标同理（点一下就是按下+松手，感觉不到差别）。
     * pointercancel（被系统手势打断）不投放，避免误放。
     */
    var dragging = false;
    var dragPointerId = null;

    function aimAt(e) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return false;
      setAim(((e.clientX - rect.left) * BOARD.width) / rect.width);
      return true;
    }

    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (phase === 'over') {
        startRound();
        return;
      }
      if (phase !== 'playing') return;
      if (dragging) return; // 多指同时按：只认第一根
      aimAt(e);
      dragging = true;
      dragPointerId = e.pointerId;
      /* 把后续事件绑到 canvas 上：手指划出棋盘也能继续瞄准、并在松手时收到 pointerup */
      if (e.pointerId != null && canvas.setPointerCapture) {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 老浏览器/测试桩没有真实指针，忽略 */
        }
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      /* 没按下时鼠标移动也实时瞄准（hover 跟手），手机上只有按住才会收到 move */
      if (dragging && dragPointerId != null && e.pointerId != null && e.pointerId !== dragPointerId) return;
      aimAt(e);
    });

    canvas.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      if (dragPointerId != null && e.pointerId != null && e.pointerId !== dragPointerId) return;
      dragging = false;
      dragPointerId = null;
      aimAt(e); // 用松手的位置作为最终落点
      if (phase === 'playing') drop();
    });

    canvas.addEventListener('pointercancel', function () {
      /* 被系统手势/来电打断：只清状态，不投放 */
      dragging = false;
      dragPointerId = null;
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
      /*
       * 点一下换一档，顺序固定：全语音 → 名场面 → 静音 → 全语音 …
       * 选择存在 prefs.voice 里，下次打开还是这一档。
       */
      dom.sound.addEventListener('click', function () {
        prefs.voice = CFG.nextVoiceMode(voiceMode());
        prefs.sound = prefs.voice !== 'mute'; // 兼容老字段
        saveJson(CFG.STORAGE_KEYS.prefs, prefs);
        sfx.unlock();
        stopBgmIfMuted(); // 切到静音档：背景音乐也停掉
        syncHud();
        var mode = voiceMode();
        UI.toast(
          mode === 'all'
            ? '全语音：释放与合成都会念台词'
            : mode === 'scene'
              ? '名场面：只在大玩偶 / 连击时出声'
              : '静音：不发声'
        );
      });
    }
    /*
     * 手机上音频上下文随时可能被系统或别的音频挤成 suspended（比如刚播完背景音乐），
     * 每次点屏幕都顺手检查一次并唤醒 —— 这样语音不会「莫名其妙就没了」。
     */
    D.addEventListener(
      'pointerdown',
      function () {
        reviveVoices();
      },
      true
    );

    /* Q 裙交流：组建乐队右边那颗 */
    if (dom.qqBtn) dom.qqBtn.addEventListener('click', showQqGroup);

    /* 背景音乐：选图后面那颗图标，点一下播放、再点一下停止 */
    if (dom.musicBtn) {
      dom.musicBtn.addEventListener('click', toggleBgm);
      syncBgmButton();
      /* ?bgm-ui=1 ：只把「播放中」的样子亮出来（自检/截图用，不真的播放） */
      if (/[?&]bgm-ui=1/.test(root.location.search)) applyBgmLook(true);
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
      applyMobileLayout(); // 横竖屏切换 / 改窗口大小时重排
    });

    /*
     * 切后台 / 切回来。
     * 手机切后台时浏览器可能把页面冻结、甚至直接丢掉（回来就是重新加载），
     * 所以这一刻必须把这一局存下来；回来时如果是我们自动暂停的，就自动继续。
     */
    var autoPaused = false;

    function isHidden() {
      return D.hidden === true || D.visibilityState === 'hidden' || D.webkitHidden === true;
    }

    function onVisibility() {
      /* 后台挂起音频上下文：省电，也避免切回来时积压的音效一起炸响 */
      var ac = sfx && sfx.context ? sfx.context() : null;
      if (ac) {
        try {
          if (isHidden() && ac.state === 'running' && ac.suspend) ac.suspend();
          else if (!isHidden() && ac.state === 'suspended' && ac.resume) ac.resume();
        } catch (err) {
          /* 音频挂起失败不影响游戏 */
        }
      }
      /* 背景音乐：切后台暂停，切回来若本来是「想响」的状态就继续 */
      if (isHidden()) {
        if (bgmPlaying && bgmEl && bgmEl.pause) {
          try {
            bgmEl.pause();
          } catch (err) {
            /* 忽略 */
          }
        }
      } else if (bgmWanted && !bgmPlaying) {
        bgmPlay();
      }
      if (isHidden()) {
        if (phase === 'playing') {
          autoPaused = true;
          togglePause(true); // 自动暂停：免得切后台期间被判定失败
        }
        saveProgress(true);
      } else if (autoPaused) {
        autoPaused = false;
        if (phase === 'paused') {
          phase = 'playing';
          UI.hideOverlay();
          syncHud();
        }
      }
    }

    /*
     * 试听页专属自检（正式页不开启）：
     * 第一次用户交互时响一声「叮」并报出音频上下文状态 ——
     *   听到「叮」= 浏览器/系统这边没问题，之后就该听得到语音；
     *   听不到    = 标签被静音 / 系统音量 / 输出设备的问题，不是游戏的问题。
     */
    var didSelftest = false;
    function audioSelftest() {
      if (didSelftest) return;
      didSelftest = true;
      sfx.unlock();
      var st = sfx.contextState ? sfx.contextState() : { synth: 'none', file: 'none' };
      sfx.ping();
      var c = sfx.counts ? sfx.counts() : { synth: 0, file: 0 };
      UI.toast(
        '自检：档位 ' +
          CFG.VOICE_MODE_LABELS[voiceMode()] +
          ' · 音频 ' +
          st.synth +
          ' · 发声 合成' +
          c.synth +
          '/' +
          c.file +
          (st && st.baseLatency != null ? ' · 延迟 ' + st.baseLatency + 'ms' : '') +
          '（听不到「叮」就是浏览器标签或系统音量的问题）'
      );
    }
    if (root.SUIKA_AUDIO_SELFTEST) {
      D.addEventListener('pointerdown', audioSelftest, true);
      D.addEventListener('keydown', audioSelftest, true);
    }
    D.addEventListener('visibilitychange', onVisibility);
    /* pagehide 比 beforeunload 更可靠（iOS/bfcache 场景），而且不影响前进后退缓存 */
    root.addEventListener('pagehide', function () {
      saveProgress(true);
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
    dom.qqBtn = UI.el('btn-qq');
    dom.musicBtn = UI.el('btn-music');
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
      title: '🎸 合成邦多利皇帝',
      body:
        '<ul class="rules">' +
        '<li>前 5 级棉花娃娃会从天上掉下来，<b>两只相同的棉花娃娃碰在一起</b>就会合成更大的棉花娃娃。</li>' +
        '<li>得分按<b>合成出的棉花娃娃大小</b>计算：越大越多分（每级分数见左栏进化表）。</li>' +
        '<li><b>连击加分</b>：只算<b>本次投放的玩偶引发的连锁</b> —— 投放一颗、连锁合成几次就是几连（换了下一颗就重新算），得分最高 ×' +
        CFG.RULES.combo.maxMultiplier +
        '，飘字和音效都会跟着变。</li>' +
        '<li>两只 <b>' + (CFG.tierByNumber(CFG.RULES.maxTier) ? CFG.tierByNumber(CFG.RULES.maxTier).name : '最大玩偶') + '</b> 相撞会双双消失，额外 +100 分。</li>' +
        '<li>棉花娃娃堆过红色危险线并停下 <b>2 秒</b>，本局结束。左上角可以调 <b>1~10 级难度</b>（默认 Lv.' +
        CFG.DEFAULT_DIFFICULTY +
        '）。</li>' +
        '<li>成绩自动进 <b>全球排行榜</b>：实时榜是全世界最近 20 次提交（打开即最新），' +
        '总榜是历史前 100（每 ' +
        Math.round(CFG.BOARD_SYNC.refreshMs / 60000) +
        ' 分钟自动刷新）。' +
        (root.SUIKA_STANDALONE ? '' : '用「启动游戏.cmd」打开也一样是全球榜。') +
        '</li>' +
        '<li>棉花娃娃图片来自内置图库：点右上角 <b>🎸 组建乐队</b> 打开小窗口，从图库里挑 11 位角色放进棉花娃娃位'
        + '（图片不用自己导入）。</li>' +
        '</ul>',
      actions: [{ label: '开始游戏', kind: 'primary', onClick: startRound }]
    });
  }

  function demoSeed() {
    // ?demo=1 ：自动开局并按剧本投一批玩偶，方便截图 / 检查画面
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
      ['沙绫', 386, 9, 41, 6],
      ['阿彩', 274, 8, 28, 5],
      ['路人', 158, 7, 17, 4]
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
      sfx.merge(showTier, m.combo, voiceIdOf(showTier));
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
    /*
     * 玩偶版：界面文案也跟着换 —— 不再出现「玩偶」字样（11 个位子按大小排序，
     * 名字用角色名），玩偶版（图库为空）保持原样。
     */
    if (assets.hasLibrary()) {
      var maxLabel = UI.el('hud-max-label');
      var chainTitle = UI.el('chain-title');
      var chainHint = UI.el('chain-hint');
      if (maxLabel) maxLabel.textContent = '最大棉花娃娃';
      if (chainTitle) chainTitle.textContent = '棉花娃娃进化表';
      if (chainHint) chainHint.textContent = '分数＝合成出该棉花娃娃的得分';
      if (dom.current && dom.current.parentNode) {
        var curLabel = dom.current.parentNode.querySelector('.preview-label');
        if (curLabel) curLabel.textContent = '当前';
      }
    }
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

    /*
     * 演示模式暴露一个只读句柄：页面测试要断言「按下不投放、松手才投放」，
     * 而投放次数只有引擎知道。只在 ?demo=1 下挂，正常玩不受影响。
     */
    /* 背景音乐状态（页面测试断言用） */
    root.SUIKA_BGM = {
      isOn: function () {
        return bgmPlaying;
      },
      el: function () {
        return bgmEl;
      }
    };

    if (demoMode) {
      root.SuikaDemo = {
        phase: function () {
          return phase;
        },
        stats: function () {
          return game.summary();
        },
        aim: function () {
          return aimX;
        },
        /* 排查「一点声音都没有」用：合成音 / 语音各真的发声了几次 */
        counts: function () {
          return sfx && sfx.counts ? sfx.counts() : null;
        }
      };
    }
    // 手机端：把得分搬到棋盘上方、即将投放浮到棋盘左上角（桌面端不动）
    applyMobileLayout();

    syncDiffUi();
    // 选图小窗口（图片全部来自内嵌图库，不做导入）
    picker = root.SuikaPicker.create({
      assets: assets,
      ui: UI,
      onChanged: function () {
        // 换图后：进化表色块、HUD 预览、画布上的玩偶都要跟着变
        refreshAssetViews();
      }
    });
    wire();

    /*
     * 启动时如果停在静音档，明确提示一下 ——
     * 「一点声音都没有」最常见的原因就是这个档位（点过按钮或老存档带来的），
     * 用户不会想到去看右上角那颗按钮。
     */
    if (voiceMode() === 'mute') {
      UI.toast('当前是「静音」档：点右上角 🎵 可以切回全语音');
    }

    /*
     * 上次打到一半的局（手机切后台被系统丢掉页面后，回来不能让成绩清零）：
     * 存档还新鲜就直接接着打，否则正常显示开始界面。
     */
    var saved = demoMode ? null : loadProgress();
    if (saved && resumeFromSave(saved)) {
      /* 恢复了上一局：同样先把语音解码好再继续 */
      runLoadingScreen();
    } else {
      /* 先过加载页（把语音解码好），再显示开始界面 —— 进游戏后发声就不会慢半拍 */
      runLoadingScreen().then(function () {
        showReadyOverlay();
      });
    }
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
      // ?demo=1&donate=1 ：直接打开「请作者吃小布丁」弹窗（截图/自检用）
      if (/[?&]donate=1/.test(root.location.search)) showDonate();
      // ?demo=1&qq=1 ：直接打开「Q裙交流」弹窗（截图/自检用）
      if (/[?&]qq=1/.test(root.location.search)) showQqGroup();

      // ?combo=6 ：把连击 HUD 摆成 6 连（走真实的 HUD 更新路径，用来验证手机端分数面板不会被撑高）
      var cm = /[?&]combo=(\d+)/.exec(root.location.search);
      if (cm) {
        var stacks = Math.min(20, Math.max(1, parseInt(cm[1], 10) || 2));
        setComboHud(stacks, Math.min(CFG.RULES.combo.maxMultiplier, 1 + (stacks - 1) * CFG.RULES.combo.step), 0.7);
      }

      // ?demo=1&squash=0.28 ：把所有玩偶置成「正在被压」的状态并重绘一帧，
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

      /*
       * ?audio=1 ：把当前语音档位和「加载了几条语音」显示出来（自检用）。
       * 语音是懒加载的，所以这里等一会儿再报，数字才是准的。
       */
      if (/[?&]audio=1/.test(root.location.search)) {
        var showAudioState = function () {
          var st = sfx.fileStats && sfx.fileStats();
          var c = sfx.counts ? sfx.counts() : { synth: 0, file: 0 };
          var txt =
            '语音档位 ' +
            CFG.VOICE_MODE_LABELS[voiceMode()] +
            ' · 发声 合成' +
            c.synth +
            ' / 语音' +
            c.file +
            (st ? ' · 已加载 ' + st.loaded + ' 条' : '') +
            (st && st.baseLatency != null
              ? ' · 延迟 ' + st.baseLatency + 'ms' + (st.outputLatency != null ? '（输出 ' + st.outputLatency + 'ms）' : '')
              : '');
          if (dom.appVersion) dom.appVersion.textContent = txt;
          UI.toast(txt);
        };
        root.setTimeout(showAudioState, 1500);
        root.setTimeout(showAudioState, 4000);
      }
    }

    /*
     * 演示模式（自检 / 截图用）在 preloadAll 之后才跑，也就是在 Promise 里执行 ——
     * 这里的异常原本会被静默吞掉（页面看着正常，其实演示脚本根本没跑）。
     * 包一层把错误接到页面错误横幅上，自检脚本 / 测试才看得见。
     */
    var runDemoSafe = function () {
      try {
        runDemo();
      } catch (e) {
        if (root.SUIKA_ON_ERROR) root.SUIKA_ON_ERROR(e, 'demo');
        else throw e;
      }
    };
    if (demoMode) {
      if (assets && assets.preloadAll) assets.preloadAll().then(runDemoSafe, runDemoSafe);
      else runDemoSafe();
    }
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
