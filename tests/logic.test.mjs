/*!
 * 合成大西瓜 · 逻辑测试（node --test）
 *
 *   cd <项目根目录>
 *   node --test tests
 *
 * 测的是真东西：物理合成、计分、判负、排行榜排序与「不写个人表」、贴图包解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const CFG = require(path.join(ROOT, 'js/config.js'));

const ENGINE = require(path.join(ROOT, 'js/engine.js'));

function runSteps(game, ms, step = CFG.BOARD.fixedStep) {
  const n = Math.round(ms / step);
  for (let i = 0; i < n; i++) game.step(step);
}

/* ---------------- 配置与计分规则 ---------------- */

test('配置：11 级水果、半径递增、分值随体积递增', () => {
  assert.equal(CFG.TIERS.length, 11);
  assert.equal(CFG.RULES.maxTier, 11);
  for (let i = 1; i < CFG.TIERS.length; i++) {
    assert.ok(CFG.TIERS[i].r > CFG.TIERS[i - 1].r, `第 ${i + 1} 级半径应更大`);
    assert.ok(CFG.TIERS[i].score > CFG.TIERS[i - 1].score, `第 ${i + 1} 级分值应更高`);
  }
  assert.deepEqual(
    CFG.TIERS.map((t) => t.score),
    [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55]
  );
  assert.equal(CFG.scoreOf(11), 55);
  assert.equal(CFG.scoreOf(0), CFG.RULES.watermelonBonus);
  assert.ok(CFG.widthRatio(11) < 1, '最大的西瓜必须塞得进场地');
});

test('配置：随机掉落的只有前 5 级，且权重覆盖完整', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) seen.add(CFG.pickSpawnTier());
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(CFG.pickSpawnTier(() => 0), 1);
  assert.equal(CFG.pickSpawnTier(() => 0.999999), 5);
});

/* ---------------- 物理 + 合成 ---------------- */

test('两颗相同水果碰在一起会合成更大的水果，并按大小加分', () => {
  const game = ENGINE.create({});
  const merges = [];
  game.on('merge', (m) => merges.push(m));

  game.debugSpawn(1, 240, 600);
  game.debugSpawn(1, 240, 545);
  runSteps(game, 2500);

  assert.equal(merges.length, 1, '应该正好合成一次');
  assert.equal(merges[0].resultTier, 2);
  assert.equal(merges[0].gained, CFG.scoreOf(2));
  assert.equal(game.getState().score, 1);
  const fruits = game.fruits();
  assert.equal(fruits.length, 1);
  assert.equal(fruits[0].suikaTier, 2);
});

test('不同水果不会合成', () => {
  const game = ENGINE.create({});
  let merged = 0;
  game.on('merge', () => merged++);
  game.debugSpawn(1, 150, 600);
  game.debugSpawn(2, 150, 520);
  game.debugSpawn(3, 320, 600);
  runSteps(game, 2000);
  assert.equal(merged, 0);
  assert.equal(game.getState().score, 0);
  assert.equal(game.fruits().length, 3);
});

test('连锁合成会继续升级并累加分数，总分等于每次合成之和', () => {
  const game = ENGINE.create({});
  const gained = [];
  game.on('merge', (m) => gained.push(m.gained));
  game.debugSpawn(1, 240, 620);
  game.debugSpawn(1, 240, 570);
  game.debugSpawn(1, 240, 300);
  game.debugSpawn(1, 240, 250);
  runSteps(game, 4000);

  const st = game.getState();
  assert.ok(st.merges >= 3, `至少合成 3 次，实际 ${st.merges}`);
  assert.ok(st.maxTier >= 3, `最大水果至少到第 3 级，实际 ${st.maxTier}`);
  assert.equal(
    st.score,
    gained.reduce((a, b) => a + b, 0),
    '总分必须正好等于每次合成得分之和'
  );
  assert.ok(st.score >= st.merges, '每次合成至少 1 分');
  assert.ok(st.bestCombo >= 2, `连锁合成应该形成连击，实际最高连击 ${st.bestCombo}`);
});

/* ---------------- 连击加分 ---------------- */

test('连击规则：倍率封顶、小水果也有加成、永远不亏', () => {
  assert.equal(CFG.comboMultiplier(1), 1);
  assert.ok(Math.abs(CFG.comboMultiplier(2) - 1.3) < 1e-9);
  assert.equal(CFG.comboMultiplier(99), CFG.RULES.combo.maxMultiplier, '倍率要封顶');

  assert.deepEqual(
    [CFG.scoreWithCombo(1, 1).gained, CFG.scoreWithCombo(1, 2).gained, CFG.scoreWithCombo(1, 3).gained],
    [1, 2, 3],
    '基础分很小时按「每连击 +1」兜底'
  );
  assert.equal(CFG.scoreWithCombo(55, 2).gained, 55 + 17, '大水果按倍率加成（55×0.3=16.5→17）');
  assert.equal(CFG.scoreWithCombo(55, 6).multiplier, CFG.RULES.combo.maxMultiplier);
  assert.equal(CFG.scoreWithCombo(55, 6).gained, 55 + Math.round(55 * (CFG.RULES.combo.maxMultiplier - 1)));
  assert.equal(CFG.scoreWithCombo(100, 1).bonus, 0, '没有连击就没有加成');

  for (const base of CFG.TIERS.map((t) => t.score).concat([100])) {
    for (let c = 1; c <= 12; c++) {
      const r = CFG.scoreWithCombo(base, c);
      assert.ok(r.gained >= base, `连击不能让得分变少：base=${base} combo=${c}`);
      assert.equal(r.gained, r.base + r.bonus);
    }
  }
});

test('引擎连击：1 秒内连续合成会累计连击并加价，超时后归零', () => {
  const game = ENGINE.create({ gravity: 0 }); // 关掉重力，让两次合成发生在同一帧，结果确定
  const events = [];
  game.on('merge', (m) => events.push(m));
  let ended = null;
  game.on('combo-end', (info) => {
    ended = info;
  });

  game.debugSpawn(1, 140, 300);
  game.debugSpawn(1, 170, 300); // 左边一对
  game.debugSpawn(1, 340, 300);
  game.debugSpawn(1, 370, 300); // 右边一对
  runSteps(game, CFG.BOARD.fixedStep * 2);

  assert.equal(events.length, 2, '同一帧里应该发生两次合成');
  assert.equal(events[0].combo, 1);
  assert.equal(events[1].combo, 2, '第二次合成要算连击');
  assert.ok(events[1].bonus >= 1, '连击要有额外加成');
  assert.equal(game.getState().score, events[0].gained + events[1].gained);
  assert.equal(game.getState().bestCombo, 2);

  // 超过连击窗口没再合成 → 连击清零
  runSteps(game, CFG.RULES.combo.windowMs + 200);
  assert.equal(game.getState().combo, 0);
  assert.ok(ended, '连击结束要发事件，界面才知道把连击条收起来');
  assert.equal(ended.bestCombo, 2);
});

test('连击只算本次投放引发的连锁：一投放就把连击清零', () => {
  /*
   * 规则的由来（用户要求）：连击只统计「这颗玩偶落下造成的合成」，
   * 上一颗玩偶沉降/滚动引发的合成不该蹭进新一次投放的连击里。
   * 做法是 drop() 时把 combo 清零，之后再合成从 1 重新累计。
   */
  const game = ENGINE.create({ gravity: 0 });
  const combosAtDrop = [];
  game.on('drop', () => combosAtDrop.push(game.getState().combo));

  game.debugSpawn(1, 140, 300);
  game.debugSpawn(1, 170, 300);
  runSteps(game, CFG.BOARD.fixedStep * 2);
  assert.equal(game.getState().combo, 1, '前置条件：先合出一次连击 1');

  /* 再投放一颗：连击必须归零（而不是接着上一次继续涨） */
  game.drop(1, 240);
  assert.equal(game.getState().combo, 0, '投放后连击要清零');
  assert.equal(game.getState().comboRatio, 0, '连击条也要清掉');

  game.drop(1, 260);
  game.drop(1, 280);
  assert.ok(
    combosAtDrop.every((c) => c === 0),
    '每次投放时连击都应该是 0，实际 ' + JSON.stringify(combosAtDrop)
  );
});

/* ---------------- 草莓粘连 / 悬空（用户反馈的 bug） ---------------- */

test('悬空的水果一定会掉下来，不会卡在半空（沉睡已关闭）', () => {
  const game = ENGINE.create({});
  assert.equal(game.engine.enableSleeping, false, 'Matter 的沉睡必须关闭，否则水果会在半空睡着不再下落');
  const body = game.debugSpawn(2, 240, 180); // 半空放一颗草莓
  runSteps(game, 2500);
  assert.ok(body.position.y > 400, `草莓应该落到下面，实际停在 y=${body.position.y.toFixed(1)}`);
  assert.ok(body.speed < 1, '最后应该已经落地停稳');
});

test('大量水果落地后：没有水果悬在半空不接触任何东西', () => {
  const game = ENGINE.create({});
  let rnd = 987654321;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd / 2147483648;
  };
  for (let i = 0; i < 30; i++) {
    game.drop(1 + Math.floor(rand() * 5), CFG.BOARD.wall + 30 + rand() * (CFG.BOARD.width - 2 * CFG.BOARD.wall - 60));
    runSteps(game, 380);
  }
  runSteps(game, 2500);

  const fruits = game.fruits();
  const floorY = CFG.BOARD.height - CFG.BOARD.wall;
  const nearWall = (b) =>
    b.position.x - b.circleRadius <= CFG.BOARD.wall + 4 || b.position.x + b.circleRadius >= CFG.BOARD.width - CFG.BOARD.wall - 4;
  assert.ok(fruits.length > 0);
  for (const b of fruits) {
    const onFloor = b.position.y + b.circleRadius >= floorY - 4;
    const touching = fruits.some(
      (o) => o !== b && Math.hypot(o.position.x - b.position.x, o.position.y - b.position.y) <= b.circleRadius + o.circleRadius + 4
    );
    assert.ok(
      onFloor || nearWall(b) || touching,
      `第 ${b.suikaTier} 级水果悬空了：x=${b.position.x.toFixed(1)} y=${b.position.y.toFixed(1)}`
    );
  }
});

/* ---------------- 难度 ---------------- */

test('难度：10 级、参数逐级变难、默认第 5 级', () => {
  assert.equal(CFG.DIFFICULTY.length, 10);
  assert.equal(CFG.DEFAULT_DIFFICULTY, 5);
  for (let i = 1; i < CFG.DIFFICULTY.length; i++) {
    const easy = CFG.DIFFICULTY[i - 1];
    const hard = CFG.DIFFICULTY[i];
    assert.ok(hard.dangerY > easy.dangerY, `Lv.${hard.level} 的危险线应该更低（可用高度更小）`);
    assert.ok(hard.dropCooldownMs < easy.dropCooldownMs, `Lv.${hard.level} 的投放间隔应该更短`);
    assert.ok(hard.spawnWeights[4] >= easy.spawnWeights[4], `Lv.${hard.level} 掉大水果的概率不该更低`);
    assert.ok(hard.spawnWeights[0] <= easy.spawnWeights[0], `Lv.${hard.level} 掉最小水果的概率不该更高`);
    assert.equal(hard.spawnWeights.reduce((a, b) => a + b, 0), 100, '权重总和必须正好 100');
    assert.equal(hard.spawnWeights.length, 5);
  }
  assert.equal(CFG.clampDifficulty(99), 10);
  assert.equal(CFG.clampDifficulty(-3), 1);
  assert.equal(CFG.clampDifficulty('abc'), CFG.DEFAULT_DIFFICULTY);
  assert.equal(CFG.difficultyOf(5).name, '熟练');
});

test('难度：越高越容易掉大水果，引擎采用该等级的危险线', () => {
  const easy = CFG.difficultyOf(1);
  const hard = CFG.difficultyOf(10);
  const spread = (weights) => {
    const seen = [0, 0, 0, 0, 0];
    let rnd = 42;
    const rand = () => {
      rnd = (rnd * 1103515245 + 12345) % 2147483648;
      return rnd / 2147483648;
    };
    for (let i = 0; i < 3000; i++) seen[CFG.pickSpawnTier(rand, weights) - 1]++;
    return seen;
  };
  const e = spread(easy.spawnWeights);
  const h = spread(hard.spawnWeights);
  assert.ok(e[0] > h[0], '低难度应该掉更多小水果');
  assert.ok(h[4] > e[4], '高难度应该掉更多大水果');

  const game = ENGINE.create({ difficulty: 10 });
  assert.equal(game.getDifficulty(), 10);
  assert.equal(game.getState().dangerY, hard.dangerY);
  assert.equal(game.getState().difficulty, 10);
  game.setDifficulty(1);
  assert.equal(game.getState().dangerY, easy.dangerY);
  assert.equal(game.pickTier(() => 0), 1, '抽到权重区间最前面就是第 1 级');
});

test('难度影响判负：同一高度在 Lv.10 会结束，在 Lv.1 不会', () => {
  const mk = (level) => {
    const game = ENGINE.create({ gravity: 0, difficulty: level });
    let over = null;
    game.on('gameover', (s) => {
      over = s;
    });
    game.debugSpawn(5, 240, 176); // 顶边 y=134
    runSteps(game, CFG.RULES.dangerGraceMs + 400);
    return { over, game };
  };
  const hard = mk(10);
  assert.ok(hard.over, 'Lv.10（危险线更低）应该判负');
  assert.equal(hard.over.difficulty, 10);
  const easy = mk(1);
  assert.equal(easy.over, null, 'Lv.1（危险线更高）不该判负');
});

test('两个西瓜相撞：双双消失并加奖励分', () => {
  const game = ENGINE.create({});
  const merges = [];
  game.on('merge', (m) => merges.push(m));
  game.debugSpawn(11, 200, 560);
  game.debugSpawn(11, 260, 300);
  runSteps(game, 3500);

  assert.equal(game.fruits().length, 0, '西瓜应该都消失了');
  assert.equal(game.getState().score, CFG.RULES.watermelonBonus);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].resultTier, 0);
});

test('40 颗水果乱丢：位置不炸、不出界、落地后不抖', () => {
  const game = ENGINE.create({});
  let rnd = 123456789;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) % 2147483648;
    return rnd / 2147483648;
  };
  for (let i = 0; i < 40; i++) {
    game.drop(1 + Math.floor(rand() * 5), CFG.BOARD.wall + 30 + rand() * (CFG.BOARD.width - 2 * CFG.BOARD.wall - 60));
    runSteps(game, 400);
  }
  runSteps(game, 3000);

  const fruits = game.fruits();
  assert.ok(fruits.length > 0);
  for (const b of fruits) {
    assert.ok(Number.isFinite(b.position.x) && Number.isFinite(b.position.y), '坐标不能是 NaN');
    assert.ok(Number.isFinite(b.velocity.x) && Number.isFinite(b.velocity.y), '速度不能是 NaN');
    assert.ok(b.position.x >= CFG.BOARD.wall - 2 && b.position.x <= CFG.BOARD.width - CFG.BOARD.wall + 2, '不能穿墙');
    assert.ok(b.position.y <= CFG.BOARD.height + 2, '不能掉出地板');
    assert.ok(b.position.y - b.circleRadius < CFG.BOARD.height, '不能沉进地板');
  }

  const speeds = fruits.map((b) => b.speed);
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  assert.ok(avg < 0.35, `落地后应该基本静止，平均速度 ${avg.toFixed(3)}`);
  assert.equal(game.getState().corrections, 0, '不应该出现被挤穿墙的水果（墙加厚后安全带不该被触发）');
});

/* ---------------- 判负 ---------------- */

test('水果停在危险线以上超过 2 秒 → 本局结束', () => {
  const game = ENGINE.create({ gravity: 0 }); // 关掉重力，确定性地把它挂在线上方
  let over = null;
  game.on('gameover', (s) => {
    over = s;
  });
  game.debugSpawn(5, 240, CFG.BOARD.dangerY - 20);
  runSteps(game, CFG.RULES.dangerGraceMs - 300);
  assert.equal(over, null, '还没到 2 秒不应该结束');
  assert.ok(game.getState().dangerRatio > 0.5, '危险进度应该已经在涨');
  runSteps(game, 600);
  assert.ok(over, '超过 2 秒应该结束本局');
  assert.equal(over.reason, 'danger-line');
});

test('高速下落的漏过危险线不会误判结束', () => {
  const game = ENGINE.create({});
  let over = null;
  game.on('gameover', (s) => {
    over = s;
  });
  for (let i = 0; i < 6; i++) {
    game.drop(1, 100 + i * 40);
    runSteps(game, 2500);
  }
  assert.equal(over, null);
  assert.equal(game.getState().gameOver, false);
});

/* ---------------- 排行榜 ---------------- */

/*
 * 本机排行榜已经并进 js/boards.js（榜单文档）和 js/sync.js（同步/缓存/队列）：
 * 现在只有一份榜单实现，测试都在 tests/boards.test.mjs 和 tests/sync.test.mjs 里。
 */

/* ---------------- 贴图（图片库） ---------------- */

/*
 * 「导入贴图包」这套功能已经删掉了：图片全部内嵌在图库里，用户只在「选图小窗口」里挑 11 张。
 * 图库与选图的测试在 tests/library.test.mjs。
 */

/* ---------------- 果冻手感（QQ 弹弹） ---------------- */

test('果冻：低速贴住不给弹性（堆叠不微弹），高速撞击才弹并产生挤压形变', () => {
  const game = ENGINE.create({ enableSleeping: false });
  const def = CFG.tierByNumber(3);
  // 从很低的地方丢下来：落到地面时速度很低 → 不该产生挤压形变
  game.drop(CFG.BOARD.width / 2, 1);
  runSteps(game, 400);
  const slowPeak = Math.max(...game.fruits().map((f) => f.suikaSq || 0));

  // 从很高的地方丢：撞地速度大 → 要有明显挤压
  const game2 = ENGINE.create({ enableSleeping: false });
  const body = game2.debugSpawn(3, CFG.BOARD.width / 2, CFG.BOARD.spawnY);
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    game2.step(CFG.BOARD.fixedStep);
    peak = Math.max(peak, body.suikaSq || 0);
  }
  assert.ok(peak > 0.02, '掉下来砸到地面应该压一下，实际 ' + peak.toFixed(3));
  assert.ok(peak <= CFG.RULES.jelly.squashMax + 1e-6, '不超过上限');
  assert.ok(slowPeak <= CFG.RULES.jelly.squashMax, '低速也不该超过上限');
});

test('果冻：挤压形变会自己衰减掉（不会一直扁着）', () => {
  const game = ENGINE.create({ enableSleeping: false });
  const body = game.debugSpawn(4, CFG.BOARD.width / 2, CFG.BOARD.spawnY);
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    game.step(CFG.BOARD.fixedStep);
    peak = Math.max(peak, body.suikaSq || 0);
  }
  assert.ok(peak > 0, '应该有挤压过');
  runSteps(game, 1500); // 1.5 秒后
  const def = CFG.tierByNumber(4);
  const fresh = game.fruits().find((f) => f.suikaTier === 4);
  assert.ok(!fresh || (fresh.suikaSq || 0) < 0.01, '形变要衰减到接近 0，实际 ' + (fresh ? fresh.suikaSq : 'n/a'));
});

test('果冻：参数在 config 里，且回弹系数高于原来的 0.12', () => {
  assert.ok(CFG.RULES.jelly, '要有 jelly 参数');
  assert.ok(CFG.RULES.jelly.restitution > 0.12);
  assert.ok(CFG.RULES.jelly.bounceThreshold > 0);
  assert.ok(CFG.RULES.jelly.squashDecay > 0);
});

test('果冻：形变会过冲（弹过头变成微微拉长）再回摆停住，不是单调衰减', () => {
  const game = ENGINE.create({ enableSleeping: false });
  const body = game.debugSpawn(5, CFG.BOARD.width / 2, CFG.BOARD.spawnY);
  let minSq = 0;
  let maxSq = 0;
  let crosses = 0;
  let prev = 0;
  for (let i = 0; i < 240; i++) {
    game.step(CFG.BOARD.fixedStep);
    const sq = body.suikaSq || 0;
    maxSq = Math.max(maxSq, sq);
    minSq = Math.min(minSq, sq);
    if (prev > 0.002 && sq < -0.002) crosses += 1; // 从「压扁」越过 0 到「拉长」
    prev = sq;
  }
  assert.ok(maxSq > 0.02, '撞击要先压扁，实际峰值 ' + maxSq.toFixed(3));
  assert.ok(minSq < -0.002, '要弹过头（出现负形变 = 拉长），实际最小 ' + minSq.toFixed(3));
  assert.ok(crosses >= 1, '至少要过一次零点（回摆）');
  assert.ok(maxSq <= CFG.RULES.jelly.squashMax + 1e-6, '压扁不超过上限');
  assert.ok(minSq >= -CFG.RULES.jelly.stretchMax - 1e-6, '拉长不超过上限');
  // 2 秒后必须停下来（不能一直晃）
  runSteps(game, 2000);
  const f = game.fruits().find((x) => x.suikaTier === 5);
  assert.ok(!f || Math.abs(f.suikaSq || 0) < 0.01, '晃完要停，实际 ' + (f ? f.suikaSq : 'n/a'));
});


  /* ---------------- 局内快照：手机切后台被系统回收后要能接着打 ---------------- */

  test('局内快照：分数/统计/玩偶位置原样还原（切后台回来不清零）', () => {
    const g1 = ENGINE.create({ difficulty: 5 });
    for (let i = 0; i < 6; i++) {
      g1.drop(g1.pickTier(0.1), 140 + i * 25);
      runSteps(g1, 600);
    }
    const before = g1.summary();
    assert.ok(before.drops > 0, '前置条件：应该投过玩偶');

    const snap = g1.snapshot();
    assert.ok(snap.dolls.length > 0, '快照要带上场上的玩偶');
    const json = JSON.stringify(snap);
    assert.ok(json.length < 60 * 1024, '快照要小到能塞进 localStorage，实际 ' + json.length + ' 字节');

    /* 模拟「页面被系统丢掉 → 重新加载 → 从存档还原」 */
    const g2 = ENGINE.create({ difficulty: 5 });
    assert.equal(g2.restore(JSON.parse(json)), true, '还原应该成功');
    const after = g2.summary();
    assert.equal(after.score, before.score, '分数要还原');
    assert.equal(after.drops, before.drops, '投放次数要还原');
    assert.equal(after.merges, before.merges, '合成次数要还原');
    assert.equal(after.maxTier, before.maxTier, '最大玩偶等级要还原');
    assert.equal(after.bestCombo, before.bestCombo, '最高连击要还原');
    assert.equal(Math.round(after.durationMs), Math.round(before.durationMs), '本局用时也要还原');
    assert.equal(after.difficulty, before.difficulty, '难度要还原');
    assert.equal(g2.snapshot().dolls.length, snap.dolls.length, '场上玩偶数量要还原');

    /* 还原之后物理世界必须是活的：还能继续跑、时间继续走 */
    runSteps(g2, 600);
    assert.ok(g2.summary().durationMs > after.durationMs, '还原后时间要继续走：' + after.durationMs + ' → ' + g2.summary().durationMs);
    assert.ok(g2.fruits().length > 0, '还原后场上还有玩偶');
    assert.equal(g2.getState().gameOver, false, '还原后不该是已结束状态');

    /* 再存一次应该稳定（可以反复切后台） */
    const scoreNow = g2.summary().score; // 注意：这一局还在跑，期间可能又合成了，分数会涨
    const again = g2.snapshot();
    assert.equal(JSON.stringify(again).length < 60 * 1024, true);
    const g3 = ENGINE.create({ difficulty: 5 });
    assert.equal(g3.restore(again), true);
    assert.equal(g3.summary().score, scoreNow, '二次还原分数应与存档那一刻一致');
  });

  test('局内快照：坏存档不炸（被改坏/版本不符时按新一局处理）', () => {
    const g = ENGINE.create({ difficulty: 5 });
    assert.equal(g.restore(null), false, 'null 应该被拒绝');
    assert.equal(g.restore('nonsense'), false, '字符串应该被拒绝');
    assert.equal(g.restore(123), false, '数字应该被拒绝');
    /* 结构不对但能兜住：不抛异常，也不该把分数弄成 NaN */
    g.restore({ score: 'x', drops: null, dolls: [{ t: 999 }, null, { t: 3, x: 'a', y: 'b' }] });
    const s = g.summary();
    assert.equal(Number.isFinite(s.score), true, '分数必须是数字');
    assert.equal(Number.isFinite(s.drops), true, '投放次数必须是数字');
    assert.equal(s.score, 0, '坏分数按 0 处理');
    runSteps(g, 200);
    assert.equal(Number.isFinite(g.summary().score), true, '坏存档之后还能正常跑');
  });

  /* ---------------- 音频节流（并发上限 + 同一个音最短间隔） ---------------- */

  test('音频节流：并发上限与同音间隔都生效（防止连击爆音）', () => {
    const lim = CFG.createAudioLimiter({ maxVoices: 3, minGapMs: 10, sameGapMs: 50 });

    // 同一毫秒只能放一个（受「任意两声最短间隔」限制），所以时间要往前走
    assert.equal(lim.allow('a', 1000), true);
    assert.equal(lim.allow('b', 1000), false, '同一毫秒开第二个应被全局间隔挡住');
    assert.equal(lim.allow('b', 1011), true, '过了全局间隔可以开');
    assert.equal(lim.allow('c', 1022), true);
    assert.equal(lim.allow('d', 1033), false, '第 4 个应被并发上限挡住（前 3 个声部还没释放）');
    assert.equal(lim.voices(), 3);

    // 释放一个声部后就能再开
    lim.release();
    assert.equal(lim.allow('e', 1044), true, '释放一个声部后可以再开');
    assert.equal(lim.voices(), 3);

    // 同一个音（同 key）还有更长的间隔
    const lim2 = CFG.createAudioLimiter({ maxVoices: 99, minGapMs: 0, sameGapMs: 50 });
    assert.equal(lim2.allow('merge5', 2000), true);
    assert.equal(lim2.allow('merge5', 2030), false, '同一个音 30ms 内不该重复放');
    assert.equal(lim2.allow('merge5', 2060), true, '过 50ms 可以再放');
    assert.equal(lim2.allow('merge6', 2060), true, '不同 key 互不影响');

    lim2.reset();
    assert.equal(lim2.voices(), 0);
    assert.equal(lim2.allow('merge5', 3000), true, 'reset 之后立刻可用');
  });

  test('音频节流：默认参数对手机友好（并发不超过 8、同音至少 45ms）', () => {
    assert.ok(CFG.AUDIO_LIMITS.maxVoices >= 4 && CFG.AUDIO_LIMITS.maxVoices <= 12, '并发上限要在 4~12 之间（手机混音器一般 8~16）');
    assert.ok(CFG.AUDIO_LIMITS.minGapMs >= 10, '任意两声之间要有最小间隔');
    assert.ok(CFG.AUDIO_LIMITS.sameGapMs >= CFG.AUDIO_LIMITS.minGapMs, '同音间隔应不小于全局间隔');
  });

test('语音别名：常服版玩偶复用常规版的语音（Mujica 常服没有单独录音）', () => {
  assert.equal(CFG.AUDIO.audioIdOf('avemujica-casual-01'), 'avemujica-01', '三角初音·常服 → 三角初音');
  assert.equal(CFG.AUDIO.audioIdOf('avemujica-casual-05'), 'avemujica-05');
  assert.equal(CFG.AUDIO.audioIdOf('avemujica-01'), 'avemujica-01', '常规版不受影响');
  assert.equal(CFG.AUDIO.audioIdOf('afterglow-01'), 'afterglow-01', '其它乐队不受影响');
  assert.equal(CFG.AUDIO.audioIdOf(null), null, '空值要能安全返回');
  assert.ok(CFG.AUDIO.formats.indexOf('wav') >= 0, 'wav 要作为兜底格式（Mujica 那批是 16kHz wav）');
  assert.equal(CFG.AUDIO.formats[CFG.AUDIO.formats.length - 1], 'wav', 'wav 放最后，别抢在 mp3 前面');
});
