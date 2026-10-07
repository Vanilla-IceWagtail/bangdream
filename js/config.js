/*!
 * 合成邦多利皇帝 · 基础配置
 * 纯数据 + 纯函数，不依赖 DOM，可以直接在 node 下 require 做逻辑测试。
 * 想改玩偶顺序 / 半径 / 分值 / 难度 / 物理手感，只改这一个文件就够了。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SuikaConfig = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '0.4.7';

  /* 画布与场地（逻辑像素，渲染时按 devicePixelRatio 放大） */
  var BOARD = {
    width: 480,
    height: 700,
    wall: 8, // 左右墙 / 地板的厚度
    spawnY: 72, // 待投放玩偶的中心高度
    dangerY: 145, // 危险线默认位置（随难度变化，见 DIFFICULTY）
    dropCooldownMs: 350, // 投放冷却默认值（随难度变化）
    fixedStep: 1000 / 60,
    stepsPerFrame: 5,
    aimPadding: 3
  };

  /* 物理参数：调手感主要动这里 */
  var PHYSICS = {
    gravity: 1,
    // 迭代次数越高，堆叠越不容易互相陷进去（实测 12 次时挤入墙里 <3px，8 次会有 10px）
    positionIterations: 12,
    velocityIterations: 12,
    /*
     * 关闭 Matter 的「沉睡」是必须的：玩偶在半空中互相卡住不动时会被判定为睡着，
     * 睡着之后引擎不再对它施加重力，它就会永远挂在那儿（娃娃卡在半空不掉就是这个原因）。
     */
    enableSleeping: false,
    fruit: {
      restitution: 0.42,
      // 摩擦调小：圆玩偶之间应该互相打滑滚开，而不是像粘在一起
      friction: 0.1,
      frictionStatic: 0.16,
      frictionAir: 0.004,
      density: 0.0012,
      slop: 0.02
    },
    wall: { friction: 0.3, restitution: 0.05 }
  };

  /*
   * 11 级玩偶（名字对应默认选中的角色）。
   * r     = 半径（像素，决定体积和外观大小）
   * score = 「合成出这一级」时获得的分数，越大的玩偶分数越高
   * 前 5 级会随机从天上掉下来，后面的只能靠合成得到。
   */
  var TIERS = [
    { tier: 1, key: 'cherry', name: '山吹沙绫', emoji: '🍒', r: 20, score: 0, color: '#e8483f', edge: '#9e1f18' },
    { tier: 2, key: 'strawberry', name: '上原绯玛', emoji: '🍓', r: 24, score: 1, color: '#f2536b', edge: '#ab2540' },
    { tier: 3, key: 'grape', name: '丸山彩', emoji: '🍇', r: 29, score: 3, color: '#8e5ad6', edge: '#52298f' },
    { tier: 4, key: 'orange', name: '今井莉莎', emoji: '🍊', r: 35, score: 6, color: '#f79331', edge: '#b25c0a' },
    { tier: 5, key: 'kiwi', name: '北泽育美', emoji: '🥝', r: 42, score: 10, color: '#8bbf3f', edge: '#547f19' },
    { tier: 6, key: 'tomato', name: '千早爱音', emoji: '🍅', r: 50, score: 15, color: '#e8402f', edge: '#9c1d12' },
    { tier: 7, key: 'peach', name: '三角初音', emoji: '🍑', r: 60, score: 21, color: '#f7a6a0', edge: '#c4635c' },
    { tier: 8, key: 'pineapple', name: '三角初音', emoji: '🍍', r: 72, score: 28, color: '#e8c53f', edge: '#9c7d0f' },
    { tier: 9, key: 'coconut', name: '仲町阿拉蕾', emoji: '🥥', r: 87, score: 36, color: '#c69a6d', edge: '#7d5528' },
    { tier: 10, key: 'melon', name: '若叶睦', emoji: '🍈', r: 104, score: 45, color: '#c9e07a', edge: '#839933' },
    { tier: 11, key: 'watermelon', name: '户山香澄', emoji: '🍉', r: 125, score: 55, color: '#3fae5a', edge: '#1c6f32' }
  ];

  /* 规则 */
  var RULES = {
    maxTier: TIERS.length,
    maxDropTier: 5, // 只有前 5 级会随机掉落
    watermelonBonus: 100, // 两只最大的玩偶（户山香澄）相撞：双双消失，额外加 100 分
    dangerGraceMs: 2000, // 越过危险线并静止多久判定结束
    dangerWarnMs: 800, // 超过这个时间开始闪红警告
    dangerSpeedLimit: 1.25, // 速度低于此值才算「停下」，避免把下落中的玩偶算成越线
    /*
     * 连击加分：两次合成间隔不超过 windowMs 就算连击。
     * 倍率 = 1 + (连击数-1) * step，最高 maxMultiplier；
     * 实际加成取「倍率加成」和「每连击 +1 分」里更大的那个（保证小玩偶连击也有收益）。
     */
    combo: { windowMs: 1000, step: 0.3, maxMultiplier: 2.5 },

    /*
     * 果冻手感（QQ 弹弹）。
     *
     * 参考了 BigNaiWa（yhsome.github.io/BigNaiWa）的做法 —— 它把"果冻感"拆成两层，
     * 两层互不干扰，所以既弹又稳：
     *   ① 回弹：由 restitution 决定；但**低于 bounceThreshold 的接触完全不给弹性**，
     *      这样堆叠静止时不会一直微弹（这是堆子"稳"的关键）。
     *   ② 挤压形变：纯渲染层。刚体形状全程不变，只在画的时候沿撞击法线压扁、垂直方向拉长，
     *      然后指数衰减。做成渲染层的好处是：物理绝不会被形变带得自激抖动。
     *
     * 单位说明：Matter.js 的速度是「像素/步」（60 步 = 1 秒），
     * BigNaiWa 用像素/秒，所以它的 1500 对应我们这里 1500/60 = 25；
     * 它的 55px/s 静止阈值对应 55/60 ≈ 0.92。
     */
    jelly: {
      restitution: 0.42, // 球球弹性（它 0.38、墙地 0.45，取中间值）
      bounceThreshold: 0.92, // 低于这个法向接近速度就不给弹性、也不算挤压
      squashMax: 0.3, // 最大压扁比例（法线方向缩到 70%）
      speedScale: 25, // k = 撞速 / speedScale，到这个速度就压满
      squashDecay: 9, // 每秒衰减系数，τ≈111ms
      stretch: 0.85, // 垂直方向的拉伸系数（拉伸略小于压缩）
      popScale: 0.28, // 合成瞬间"弹出来"的放大比例
      popMs: 220, // 弹出动画时长
      /*
       * 形变用**二阶弹簧-阻尼**（不是一条指数衰减）：
       *   sqV += (-springK * sq - springC * sqV) * dt
       *   sq  += sqV * dt
       * 这样压扁之后会弹过头（变成微微拉长）、再回摆，晃 1~2 下停住 —— 更像果冻。
       * springK=120 → ω≈11 rad/s（周期 ≈0.57s）；springC=11 → 阻尼比 ζ≈0.5（欠阻尼，过冲约 16%）。
       * 显式欧拉在 dt=1/60 下 ω·dt≈0.18，稳定。
       */
      springK: 120,
      springC: 11,
      stretchMax: 0.18 // 反向（拉长）时的上限，避免晃得太夸张
    }
  };

  /* 难度：1~10 级，默认第 5 级（比原来的 4 级难一档） */
  var DEFAULT_DIFFICULTY = 5;

  var DIFFICULTY = [
    { level: 1, name: '悠闲', dangerY: 116, dropCooldownMs: 460, spawnWeights: [46, 28, 16, 8, 2] },
    { level: 2, name: '轻松', dangerY: 124, dropCooldownMs: 440, spawnWeights: [42, 27, 17, 10, 4] },
    { level: 3, name: '常规', dangerY: 132, dropCooldownMs: 410, spawnWeights: [38, 27, 18, 12, 5] },
    { level: 4, name: '进阶', dangerY: 138, dropCooldownMs: 380, spawnWeights: [32, 26, 20, 14, 8] },
    { level: 5, name: '熟练', dangerY: 146, dropCooldownMs: 350, spawnWeights: [29, 25, 20, 16, 10] },
    { level: 6, name: '挑战', dangerY: 154, dropCooldownMs: 330, spawnWeights: [26, 24, 20, 18, 12] },
    { level: 7, name: '困难', dangerY: 162, dropCooldownMs: 310, spawnWeights: [23, 23, 20, 19, 15] },
    { level: 8, name: '硬核', dangerY: 170, dropCooldownMs: 292, spawnWeights: [20, 22, 20, 20, 18] },
    { level: 9, name: '大师', dangerY: 178, dropCooldownMs: 275, spawnWeights: [17, 21, 20, 21, 21] },
    { level: 10, name: '地狱', dangerY: 186, dropCooldownMs: 258, spawnWeights: [14, 20, 20, 22, 24] }
  ];

  /*
   * 全球排行榜（做法 C：没有自己的服务器，把整张榜单当成一个 JSON 文档
   * 存在第三方免费 KV 上，全世界玩家的浏览器读写同一份）。
   *
   * provider：
   *   'textdb' —— 默认。第三方免费 KV，免注册、CORS 全开，静态页面（含 GitHub Pages）直接可用。
   *               整份文档由客户端「读-合并-写-确认」维护，谁都能改（没有服务端校验）。
   *   'rest'   —— 换成自己那台 Node 服务器（server.cjs 的 /api/scores），有服务端去重与排序。
   *   'local'  —— 不联网，只在本机记成绩。
   * 也可以在网址后面加 ?board=textdb|rest|local 临时切换（调试用）。
   */
  var BOARD_SYNC = {
    provider: 'textdb',
    refreshMs: 30 * 60 * 1000, // 总榜自动刷新周期：30 分钟
    liveThrottleMs: 20000, // 实时榜最短重复拉取间隔：20 秒
    maxPending: 50, // 待上传队列上限
    pushTries: 3, // 提交重试次数
    textdb: {
      // 这就是「这张榜的地址」：换一个 key 就是另一张榜（也方便你自建私有榜）
      endpoint: 'https://textdb.dev/api/data/suika-daxigua-board-9c4f21e7',
      timeoutMs: 12000,
      maxChars: 60000 // 文档超过这个体积就先裁实时榜
    },
    rest: {
      path: '/api/scores', // 同源相对地址（启动游戏.cmd / 启动共享榜.cmd）
      endpoint: '', // 写绝对地址就强制用某个服务器
      timeoutMs: 8000
    }
  };

  var STORAGE_KEYS = {
    assets: 'suika.assets.v1',
    leaderboard: 'suika.leaderboard.v1',
    board: 'suika.board.v1',
    pending: 'suika.pending.v1',
    best: 'suika.best.v1',
    // 打到一半的局（手机切后台可能被系统丢掉页面，回来要能接着打）
    save: 'suika.save.v1',
    prefs: 'suika.prefs.v1'
  };

  /* ---------- 音频文件（可选：没有文件就全部走现场合成） ---------- */

  /*
   * 把音频按下面的名字丢进 assets/audio/ 就会被自动使用；缺文件不影响游戏
   * （js/audio.js 会退回 WebAudio 合成音）。命名与体积建议见 assets/audio/README.md。
   *
   * 格式：同一个名字出多份，按 formats 的顺序找第一个能用的（建议 opus + m4a + mp3）。
   * 音量/节流：volume 是 0~1；gapMs 是「同一个音最短间隔」（留空用全局默认 45ms）。
   */
  var AUDIO = {
    enabled: true,
    base: 'assets/audio/',
    formats: ['opus', 'm4a', 'mp3'], // 体积：opus 最小 → m4a 次之 → mp3 最大但最通用
    sounds: {
      /* 投放：可以多录几套随机播，避免听着重复 */
      drop: { files: ['drop-1', 'drop-2', 'drop-3'], volume: 0.5, gapMs: 60 },
      /* 合成：每级一个（merge-1 … merge-11）；没有的级别会退回合成音 */
      merge: { perTier: true, pattern: 'merge-{tier}', volume: 0.65, gapMs: 45 },
      /* 大玩偶合成额外的「哇」一下（可选，没有就不放） */
      mergeBig: { files: ['merge-big'], volume: 0.7, gapMs: 300 },
      /* 连击点缀：按连击数选，没有就退回合成音 */
      combo: { files: ['combo-2', 'combo-4', 'combo-6'], volume: 0.5, gapMs: 200 },
      /* 危险线报警 */
      warn: { files: ['ui-warn'], volume: 0.45, gapMs: 900 },
      /* 本局结束 */
      over: { files: ['ui-over'], volume: 0.6, gapMs: 500 },
      /* 按钮/选图等界面音（可选） */
      click: { files: ['ui-click'], volume: 0.35, gapMs: 60 }
    }
  };
  /* ---------- 音频节流（现场合成与文件音效共用） ---------- */

  /*
   * 为什么需要它：手机能同时混音的「声部」是有限的（实测体验上 8~16 个就比较稳，
   * iOS 上用 <audio> 元素老版本甚至只有 4~6 个）。合成连击、危险线报警、成堆掉落
   * 叠加起来很容易一瞬间触发十几个声音，结果就是爆音/掉音/卡顿。
   * 所以这里做一个纯函数限制器：并发上限 + 同一个音的最短间隔 + 全局最短间隔。
   */
  var AUDIO_LIMITS = {
    maxVoices: 8, // 同时最多 8 个声部
    minGapMs: 18, // 任意两个音之间至少隔 18ms（避免同帧叠一堆）
    sameGapMs: 45 // 同一个音（同一 tier 的合成音）至少隔 45ms
  };

  /**
   * 造一个限制器。传入 now（毫秒）由调用方决定，方便测试。
   *   allow(key, now) → 能不能放；能放就会占一个声部
   *   release(now)    → 声部播完释放（也可以不调用，靠 maxVoices 自然回收）
   */
  function createAudioLimiter(opts) {
    var o = Object.assign({}, AUDIO_LIMITS, opts || {});
    var voices = 0;
    var lastAny = -1e9;
    var lastSame = {};
    return {
      limits: o,
      allow: function (key, now) {
        var t = Number(now) || 0;
        if (voices >= o.maxVoices) return false;
        if (t - lastAny < o.minGapMs) return false;
        var k = String(key || '');
        if (t - (lastSame[k] == null ? -1e9 : lastSame[k]) < o.sameGapMs) return false;
        voices += 1;
        lastAny = t;
        lastSame[k] = t;
        return true;
      },
      release: function () {
        voices = Math.max(0, voices - 1);
      },
      voices: function () {
        return voices;
      },
      reset: function () {
        voices = 0;
        lastAny = -1e9;
        lastSame = {};
      }
    };
  }
  /* ---------- 纯函数工具 ---------- */

  function tierAt(index) {
    return TIERS[index] || null;
  }

  /** 1-based 取得玩偶定义 */
  function tierByNumber(n) {
    return TIERS[n - 1] || null;
  }

  function radiusOf(n) {
    var t = tierByNumber(n);
    return t ? t.r : 0;
  }

  /** 合成出第 n 级玩偶的基础得分；n = 0 表示两只最大玩偶相撞（双双消失） */
  function scoreOf(n) {
    if (n === 0) return RULES.watermelonBonus;
    var t = tierByNumber(n);
    return t ? t.score : 0;
  }

  function clampDifficulty(level) {
    var n = Math.round(Number(level));
    if (!isFinite(n)) return DEFAULT_DIFFICULTY;
    return Math.min(DIFFICULTY.length, Math.max(1, n));
  }

  function difficultyOf(level) {
    return DIFFICULTY[clampDifficulty(level) - 1];
  }

  /** 随机掉落的玩偶等级（在指定权重里抽，默认用默认难度的权重） */
  function pickSpawnTier(rand, weights) {
    var w = weights || difficultyOf(DEFAULT_DIFFICULTY).spawnWeights;
    var total = 0;
    var i;
    for (i = 0; i < w.length; i++) total += w[i];
    var r = (typeof rand === 'function' ? rand() : Math.random()) * total;
    var acc = 0;
    for (i = 0; i < w.length; i++) {
      acc += w[i];
      if (r < acc) return i + 1;
    }
    return 1;
  }

  /** 连击倍率 */
  function comboMultiplier(combo) {
    var c = Math.max(1, Math.floor(Number(combo) || 1));
    return Math.min(RULES.combo.maxMultiplier, 1 + (c - 1) * RULES.combo.step);
  }

  /** 连击加成后的实得分数 */
  function scoreWithCombo(baseScore, combo) {
    var base = Math.max(0, Math.round(Number(baseScore) || 0));
    var c = Math.max(1, Math.floor(Number(combo) || 1));
    if (c <= 1) return { base: base, multiplier: 1, bonus: 0, gained: base, combo: 1 };
    var m = comboMultiplier(c);
    var bonus = Math.max(c - 1, Math.round(base * (m - 1)));
    return { base: base, multiplier: m, bonus: bonus, gained: base + bonus, combo: c };
  }

  /** 每级玩偶的直径占场地宽度的比例，用来检查配置是否塞得下 */
  function widthRatio(n) {
    return (radiusOf(n) * 2) / (BOARD.width - BOARD.wall * 2);
  }

  function formatScore(n) {
    var v = Math.max(0, Math.floor(Number(n) || 0));
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 建议的文件名，例如 01-cherry.png（内嵌图库时按这个给图片起名最省事） */
  function suggestFileName(t) {
    return (t.tier < 10 ? '0' + t.tier : '' + t.tier) + '-' + t.key + '.png';
  }

  return {
    VERSION: VERSION,
    BOARD: BOARD,
    PHYSICS: PHYSICS,
    TIERS: TIERS,
    RULES: RULES,
    AUDIO: AUDIO,
    AUDIO_LIMITS: AUDIO_LIMITS,
    createAudioLimiter: createAudioLimiter,
    DIFFICULTY: DIFFICULTY,
    DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY,
    BOARD_SYNC: BOARD_SYNC,
    STORAGE_KEYS: STORAGE_KEYS,
    tierAt: tierAt,
    tierByNumber: tierByNumber,
    radiusOf: radiusOf,
    scoreOf: scoreOf,
    clampDifficulty: clampDifficulty,
    difficultyOf: difficultyOf,
    pickSpawnTier: pickSpawnTier,
    comboMultiplier: comboMultiplier,
    scoreWithCombo: scoreWithCombo,
    widthRatio: widthRatio,
    formatScore: formatScore,
    suggestFileName: suggestFileName
  };
});
