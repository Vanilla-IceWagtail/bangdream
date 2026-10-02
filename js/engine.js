/*!
 * 合成邦多利皇帝 · 游戏核心（物理 + 合成 + 计分 + 判负）
 *
 * 这个文件完全不碰 DOM，只维护 Matter.js 世界和游戏状态，
 * 所以可以直接在 node 里跑模拟测试（见 tests/logic.test.mjs）。
 * 渲染、输入、界面都在 render.js / ui.js / game.js 里。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SuikaEngine = factory(root);
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

  var Matter = root.Matter || tryRequire('../vendor/matter.min.js');
  var CFG = root.SuikaConfig || tryRequire('./config.js');

  function create(options) {
    options = options || {};
    if (!Matter || !CFG) throw new Error('SuikaEngine: 缺少 Matter.js 或 config.js');

    var Engine = Matter.Engine;
    var Composite = Matter.Composite;
    var Bodies = Matter.Bodies;
    var Body = Matter.Body;
    var Events = Matter.Events;

    var BOARD = CFG.BOARD;
    var PH = CFG.PHYSICS;
    var RULES = CFG.RULES;
    var W = BOARD.width;
    var H = BOARD.height;
    var WT = BOARD.wall;
    var innerLeft = WT;
    var innerRight = W - WT;
    var floorY = H - WT;

    var difficulty = CFG.clampDifficulty(options.difficulty != null ? options.difficulty : CFG.DEFAULT_DIFFICULTY);
    // 玩偶轮廓：给定等级返回 { circles:[{x,y,r}] }（归一化），没有就返回 null → 退回圆形碰撞
    var shapeOf = typeof options.shapeOf === 'function' ? options.shapeOf : null;
    var engine = Engine.create({
      // 默认不开沉睡：见 config.js 里的说明（沉睡会让半空卡住的玩偶永远不掉）
      enableSleeping: options.enableSleeping != null ? options.enableSleeping : PH.enableSleeping
    });
    engine.gravity.y = options.gravity != null ? options.gravity : PH.gravity;
    engine.positionIterations = PH.positionIterations;
    engine.velocityIterations = PH.velocityIterations;
    var world = engine.world;

    var handlers = {};
    var pendingMerges = [];
    var accumulator = 0;

    var state = {
      score: 0,
      merges: 0,
      maxTier: 1,
      drops: 0,
      dangerMs: 0,
      dangerRatio: 0,
      warned: false,
      gameOver: false,
      overReason: null,
      elapsedMs: 0,
      corrections: 0,
      difficulty: difficulty,
      dangerY: CFG.difficultyOf(difficulty).dangerY,
      combo: 0,
      comboRatio: 0,
      bestCombo: 0,
      lastMergeMs: -1e9,
      tierCounts: {}
    };

    var staticOpts = {
      isStatic: true,
      friction: PH.wall.friction,
      restitution: PH.wall.restitution,
      label: 'wall'
    };
    // 墙做得比画面厚很多：Matter 没有连续碰撞检测，薄墙会被高速玩偶穿过去
    var BULK = 90;
    var walls = [
      Bodies.rectangle(W / 2, floorY + BULK / 2, W + BULK * 2, BULK, staticOpts),
      Bodies.rectangle(innerLeft - BULK / 2, H / 2, BULK, H + BULK * 2, staticOpts),
      Bodies.rectangle(innerRight + BULK / 2, H / 2, BULK, H + BULK * 2, staticOpts)
    ];
    Composite.add(world, walls);

    /* ---------------- 事件 ---------------- */

    function on(name, fn) {
      (handlers[name] || (handlers[name] = [])).push(fn);
      return function () {
        off(name, fn);
      };
    }

    function off(name, fn) {
      var list = handlers[name];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }

    function emit(name, payload) {
      var list = handlers[name];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (e) {
          // 事件处理函数里的异常不要静默吞掉：既打到 console，也交给页面上的错误横幅
          if (root.console && console.error) console.error('[suika] handler error', name, e);
          if (typeof root.SUIKA_ON_ERROR === 'function') {
            try {
              root.SUIKA_ON_ERROR(e, name);
            } catch (ignored) {
              /* noop */
            }
          }
        }
      }
    }

    /* ---------------- 玩偶 ---------------- */

    function spawnBody(tierNum, x, y) {
      var def = CFG.tierByNumber(tierNum);
      if (!def) return null;
      var r = def.r;
      var lo = innerLeft + r + 0.5;
      var hi = innerRight - r - 0.5;
      if (hi <= lo) x = W / 2;
      else x = Math.min(hi, Math.max(lo, x));

      var opts = {
        label: 'fruit',
        restitution: PH.fruit.restitution,
        friction: PH.fruit.friction,
        frictionStatic: PH.fruit.frictionStatic,
        frictionAir: PH.fruit.frictionAir,
        density: PH.fruit.density,
        slop: PH.fruit.slop,
        sleepThreshold: 60
      };

      /*
       * 有玩偶轮廓数据时，用「一组圆」拼出复合刚体（碰撞体积贴合玩偶），
       * 没有就退回原来的单个圆（emoji 外观 / 没选图时）。
       * 注意：复合刚体的 position 是**质心**，而图片是按几何中心画的，
       * 所以这里把零件按 (c - com) 摆放，让质心正好落在 (x, y)，
       * 渲染时再用 -com*D 把图片挪回去。
       */
      var shape = shapeOf ? shapeOf(tierNum) : null;
      var body;
      if (shape && shape.circles && shape.circles.length > 1) {
        var D = r * 2;
        var com = shapeCom(shape.circles);
        var parts = [];
        for (var i = 0; i < shape.circles.length; i++) {
          var c = shape.circles[i];
          parts.push(Bodies.circle(x + (c.x - com.x) * D, y + (c.y - com.y) * D, Math.max(1.2, c.r * D), opts));
        }
        body = Body.create(Object.assign({}, opts, { parts: parts }));
        body.suikaShape = { circles: shape.circles, com: com };
        body.circleRadius = r; // 其余逻辑（危险线、边界兜底、渲染尺寸）都还用这个半径
      } else {
        body = Bodies.circle(x, y, r, opts);
      }
      body.suikaTier = tierNum;
      body.suikaAboveMs = 0;
      body.suikaDead = false;
      body.suikaRemoved = false;
      body.suikaBornMs = state.elapsedMs;
      body.suikaSq = 0; // 挤压形变量（渲染用）
      body.suikaSqA = 0; // 挤压轴角度
      body.suikaSqV = 0; // 形变速度（弹簧-阻尼用）
      Composite.add(world, body);
      return body;
    }

    /** 轮廓圆的面积加权质心（= 这个复合刚体的质心） */
    function shapeCom(circles) {
      var sx = 0;
      var sy = 0;
      var sw = 0;
      for (var i = 0; i < circles.length; i++) {
        var c = circles[i];
        var area = c.r * c.r;
        sx += c.x * area;
        sy += c.y * area;
        sw += area;
      }
      if (!sw) return { x: 0, y: 0 };
      return { x: sx / sw, y: sy / sw };
    }

    /** 当前场上还活着的玩偶（排除正在合并中的两颗） */
    function fruits() {
      var all = Composite.allBodies(world);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var b = all[i];
        if (b.suikaTier == null || b.suikaRemoved) continue;
        out.push(b);
      }
      return out;
    }

    function aliveFruits() {
      var all = Composite.allBodies(world);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var b = all[i];
        if (b.suikaTier == null || b.suikaRemoved || b.suikaDead) continue;
        out.push(b);
      }
      return out;
    }

    function drop(tierNum, x) {
      if (state.gameOver) return null;
      var body = spawnBody(tierNum, x, BOARD.spawnY);
      if (body) {
        state.drops += 1;
        emit('drop', { tier: tierNum, x: body.position.x, score: state.score });
      }
      return body;
    }

    /* ---------------- 果冻手感（回弹阈值 + 挤压形变） ---------------- */
    var JELLY = (CFG.RULES && CFG.RULES.jelly) || {};

    /**
     * 处理一次接触对：
     *   · 法向接近速度低于阈值 → 把这一对的弹性清零（堆叠静止时不微弹）
     *   · 高于阈值 → 记下碰撞前速度，并给两颗玩偶注入挤压形变
     */
    function applyJelly(pair, a, b) {
      var col = pair.collision;
      if (!col || !col.normal) return;
      var nx = col.normal.x;
      var ny = col.normal.y;
      var vax = a.velocity ? a.velocity.x : 0;
      var vay = a.velocity ? a.velocity.y : 0;
      var vbx = b.velocity ? b.velocity.x : 0;
      var vby = b.velocity ? b.velocity.y : 0;
      var vn = Math.abs((vax - vbx) * nx + (vay - vby) * ny);
      if (vn < (JELLY.bounceThreshold || 0.92)) {
        pair.restitution = 0; // 慢速贴住 → 不弹（Matter 没有内置阈值，这里补上）
        return;
      }
      squash(a, nx, ny, vn);
      squash(b, -nx, -ny, vn);
    }

    /** 沿撞击法线压扁（渲染时施加），只接受更强的撞击，避免连续接触反复顶起 */
    function squash(body, nx, ny, vn) {
      if (body.suikaTier == null) return;
      var k = Math.min(JELLY.squashMax || 0.3, vn / (JELLY.speedScale || 25));
      if (k <= (body.suikaSq || 0)) return;
      body.suikaSq = k;
      body.suikaSqA = Math.atan2(ny, nx);
      body.suikaSqV = 0; // 新撞击：从"被压扁"这一刻重新开始回弹
    }

    /**
     * 形变的恢复：二阶弹簧-阻尼（会过冲 + 回摆），按固定步长积分，跟帧率无关。
     * 压扁 → 弹回 → 弹过头（微微拉长）→ 回摆 → 停住，晃 1~2 下，像果冻。
     */
    function decaySquash(dtMs) {
      var dt = dtMs / 1000;
      var k = JELLY.springK || 120;
      var c = JELLY.springC || 11;
      var maxSq = JELLY.squashMax || 0.3;
      var minSq = -(JELLY.stretchMax || 0.18);
      var all = Composite.allBodies(world);
      for (var i = 0; i < all.length; i++) {
        var b = all[i];
        var sq = b.suikaSq || 0;
        var v = b.suikaSqV || 0;
        if (sq === 0 && v === 0) continue;
        v += (-k * sq - c * v) * dt;
        sq += v * dt;
        if (sq > maxSq) {
          sq = maxSq;
          v = Math.min(v, 0);
        } else if (sq < minSq) {
          sq = minSq;
          v = Math.max(v, 0);
        }
        if (Math.abs(sq) < 0.0015 && Math.abs(v) < 0.02) {
          b.suikaSq = 0;
          b.suikaSqV = 0;
        } else {
          b.suikaSq = sq;
          b.suikaSqV = v;
        }
      }
    }

    /* ---------------- 合成 ---------------- */

    Events.on(engine, 'collisionStart', function (evt) {
      var pairs = evt.pairs;
      for (var i = 0; i < pairs.length; i++) {
        // 复合刚体（玩偶轮廓）碰撞时报的是「零件」，要取回父体
        var a = pairs[i].bodyA.parent || pairs[i].bodyA;
        var b = pairs[i].bodyB.parent || pairs[i].bodyB;
        applyJelly(pairs[i], a, b);
        if (a.suikaTier == null || b.suikaTier == null) continue;
        if (a.suikaDead || b.suikaDead || a.suikaRemoved || b.suikaRemoved) continue;
        if (a.suikaTier !== b.suikaTier) continue;
        // 先打标记，避免同一帧里被重复配对；真正的增删留到 update 结束后做
        a.suikaDead = true;
        b.suikaDead = true;
        pendingMerges.push({ a: a, b: b });
      }
    });

    // 持续接触也要处理：果堆被压时下面那几颗会跟着形变（慢速贴住时上面那条阈值会拦住，不会自激）
    Events.on(engine, 'collisionActive', function (evt) {
      var pairs = evt.pairs;
      for (var i = 0; i < pairs.length; i++) {
        var a = pairs[i].bodyA.parent || pairs[i].bodyA;
        var b = pairs[i].bodyB.parent || pairs[i].bodyB;
        applyJelly(pairs[i], a, b);
      }
    });
    function flushMerges() {
      if (!pendingMerges.length) return;
      var queue = pendingMerges;
      pendingMerges = [];
      for (var i = 0; i < queue.length; i++) {
        var a = queue[i].a;
        var b = queue[i].b;
        if (a.suikaRemoved || b.suikaRemoved) continue;
        var tier = a.suikaTier;
        var mx = (a.position.x + b.position.x) / 2;
        var my = (a.position.y + b.position.y) / 2;
        var vx = (a.velocity.x + b.velocity.x) * 0.5;
        var vy = (a.velocity.y + b.velocity.y) * 0.5;

        a.suikaRemoved = true;
        b.suikaRemoved = true;
        Composite.remove(world, a, true);
        Composite.remove(world, b, true);

        var base;
        var resultTier;
        var created = null;
        if (tier >= RULES.maxTier) {
          // 两个玩偶相撞：双双消失 + 奖励分
          resultTier = 0;
          base = CFG.scoreOf(0);
        } else {
          resultTier = tier + 1;
          created = spawnBody(resultTier, mx, my);
          if (created) Body.setVelocity(created, { x: vx * 0.6, y: vy * 0.6 - 0.4 });
          base = CFG.scoreOf(resultTier);
          state.tierCounts[resultTier] = (state.tierCounts[resultTier] || 0) + 1;
          if (resultTier > state.maxTier) state.maxTier = resultTier;
        }

        // 连击：距离上次合成不超过 combo.windowMs 就累计，否则从 1 重新开始
        var gap = state.elapsedMs - state.lastMergeMs;
        state.combo = gap <= RULES.combo.windowMs ? state.combo + 1 : 1;
        state.lastMergeMs = state.elapsedMs;
        state.comboRatio = 1;
        if (state.combo > state.bestCombo) state.bestCombo = state.combo;
        var comboScore = CFG.scoreWithCombo(base, state.combo);

        state.score += comboScore.gained;
        state.merges += 1;
        emit('merge', {
          fromTier: tier,
          resultTier: resultTier,
          baseGained: base,
          bonus: comboScore.bonus,
          multiplier: comboScore.multiplier,
          combo: state.combo,
          gained: comboScore.gained,
          x: mx,
          y: my,
          score: state.score,
          merges: state.merges,
          maxTier: state.maxTier,
          body: created
        });
      }
    }

    /* ---------------- 兜底：万一还是被挤穿 ---------------- */

    /**
     * 正常情况下不会触发（墙已经加厚），留着当安全带：
     * 只有玩偶整颗被挤出场地（或掉到地板下面很深）时才拉回来，
     * 阈值放得很宽 —— 堆叠时玩偶陷进墙里几像素是正常的，不能每帧去硬掰它。
     */
    function containFruits() {
      var list = fruits();
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var r = b.circleRadius;
        var x = b.position.x;
        var y = b.position.y;
        var nx = x;
        var ny = y;
        if (x + r < innerLeft) nx = innerLeft + r + 1;
        else if (x - r > innerRight) nx = innerRight - r - 1;
        if (y - r > floorY + 40) ny = floorY - r - 1;
        else if (y + r < -240) ny = r + 1;
        if (nx !== x || ny !== y) {
          Body.setPosition(b, { x: nx, y: ny });
          Body.setVelocity(b, { x: b.velocity.x * 0.3, y: Math.min(0, b.velocity.y) });
          state.corrections += 1;
        }
      }
    }

    /* ---------------- 连击计时 ---------------- */

    function updateCombo() {
      if (state.combo <= 0) {
        state.comboRatio = 0;
        return;
      }
      var left = RULES.combo.windowMs - (state.elapsedMs - state.lastMergeMs);
      if (left <= 0) {
        state.combo = 0;
        state.comboRatio = 0;
        emit('combo-end', { bestCombo: state.bestCombo });
      } else {
        state.comboRatio = left / RULES.combo.windowMs;
      }
    }

    /* ---------------- 判负 ---------------- */

    function updateDanger(dt) {
      var list = fruits();
      var worst = 0;
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var top = b.position.y - b.circleRadius;
        var slow = b.speed < RULES.dangerSpeedLimit;
        if (top < state.dangerY && slow && !b.suikaDead) {
          b.suikaAboveMs = (b.suikaAboveMs || 0) + dt;
        } else {
          b.suikaAboveMs = 0;
        }
        if (b.suikaAboveMs > worst) worst = b.suikaAboveMs;
      }
      state.dangerMs = worst;
      state.dangerRatio = Math.min(1, worst / RULES.dangerGraceMs);

      var warn = worst >= RULES.dangerWarnMs;
      if (warn !== state.warned) {
        state.warned = warn;
        emit(warn ? 'warn' : 'warn-clear', { dangerMs: worst, ratio: state.dangerRatio });
      }
      if (worst >= RULES.dangerGraceMs) endGame('danger-line');
    }

    function endGame(reason) {
      if (state.gameOver) return;
      state.gameOver = true;
      state.overReason = reason || 'danger-line';
      state.dangerMs = RULES.dangerGraceMs;
      state.dangerRatio = 1;
      emit('gameover', summary());
    }

    function summary() {
      return {
        score: state.score,
        merges: state.merges,
        maxTier: state.maxTier,
        drops: state.drops,
        durationMs: state.elapsedMs,
        reason: state.overReason,
        difficulty: state.difficulty,
        bestCombo: state.bestCombo,
        tierCounts: Object.assign({}, state.tierCounts)
      };
    }

    /* ---------------- 难度 ---------------- */

    function setDifficulty(level) {
      difficulty = CFG.clampDifficulty(level);
      var def = CFG.difficultyOf(difficulty);
      state.difficulty = difficulty;
      state.dangerY = def.dangerY;
      emit('difficulty', { level: difficulty, config: def });
      return difficulty;
    }

    /** 按当前难度抽一颗随机掉落的玩偶 */
    function pickTier(rand) {
      return CFG.pickSpawnTier(rand, CFG.difficultyOf(difficulty).spawnWeights);
    }

    /* ---------------- 主循环 ---------------- */

    function step(dtMs) {
      if (state.gameOver) return;
      var dt = Number(dtMs);
      if (!isFinite(dt) || dt <= 0) dt = BOARD.fixedStep;
      dt = Math.min(dt, 50);
      state.elapsedMs += dt;

      accumulator += dt;
      var steps = 0;
      while (accumulator >= BOARD.fixedStep && steps < BOARD.stepsPerFrame) {
        Engine.update(engine, BOARD.fixedStep);
        decaySquash(BOARD.fixedStep);
        flushMerges();
        accumulator -= BOARD.fixedStep;
        steps += 1;
      }
      if (steps >= BOARD.stepsPerFrame) accumulator = 0;
      containFruits();
      updateCombo();
      updateDanger(dt);
    }

    function reset() {
      for (var i = 0; i < walls.length; i++) Composite.remove(world, walls[i], true);
      Composite.clear(world, false, true);
      pendingMerges = [];
      accumulator = 0;
      for (var j = 0; j < walls.length; j++) Composite.add(world, walls[j]);
      state = {
        score: 0,
        merges: 0,
        maxTier: 1,
        drops: 0,
        dangerMs: 0,
        dangerRatio: 0,
        warned: false,
        gameOver: false,
        overReason: null,
        elapsedMs: 0,
        corrections: 0,
        // 难度是一局开始时定下的，重开一局不改变难度
        difficulty: difficulty,
        dangerY: CFG.difficultyOf(difficulty).dangerY,
        combo: 0,
        comboRatio: 0,
        bestCombo: 0,
        lastMergeMs: -1e9,
        tierCounts: {}
      };
      emit('reset', {});
    }

    return {
      Matter: Matter,
      world: world,
      engine: engine,
      board: BOARD,
      drop: drop,
      step: step,
      reset: reset,
      fruits: fruits,
      aliveFruits: aliveFruits,
      getState: function () {
        return Object.assign({}, state, { gameOver: state.gameOver });
      },
      summary: summary,
      endGame: endGame,
      pickTier: pickTier,
      setDifficulty: setDifficulty,
      getDifficulty: function () {
        return difficulty;
      },
      on: on,
      off: off,
      debugSpawn: function (tierNum, x, y) {
        return spawnBody(tierNum, x, y == null ? BOARD.spawnY : y);
      }
    };
  }

  return { create: create };
});
