/*!
 * 合成邦多利皇帝 · Canvas 渲染
 * 只负责画：场地、危险线、玩偶（贴图或默认 emoji 外观）、粒子与飘分特效。
 */
(function (root) {
  'use strict';

  var CFG = root.SuikaConfig;
  var TAU = Math.PI * 2;

  function hexToRgb(hex) {
    var h = String(hex || '#888').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function lighten(hex, amount) {
    var c = hexToRgb(hex);
    var a = amount == null ? 0.45 : amount;
    return 'rgb(' + Math.round(c.r + (255 - c.r) * a) + ',' + Math.round(c.g + (255 - c.g) * a) + ',' + Math.round(c.b + (255 - c.b) * a) + ')';
  }

  function roundRectPath(ctx, x, y, w, h, radii) {
    var r = radii || [0, 0, 0, 0];
    var tl = r[0] || 0;
    var tr = r[1] || 0;
    var br = r[2] || 0;
    var bl = r[3] || 0;
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  var EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","EmojiOne Color",sans-serif';
  var UI_FONT = '"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif';

  function create(canvas, opts) {
    opts = opts || {};
    var BOARD = CFG.BOARD;
    var W = BOARD.width;
    var H = BOARD.height;
    var WT = BOARD.wall;
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(root.devicePixelRatio || 1, 2.5);

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var effects = [];
    var shake = 0;
    var flash = 0;
    var time = 0;

    function addMerge(x, y, tier, gained, resultTier, combo) {
      var def = CFG.tierByNumber(tier);
      var r = def ? def.r : 30;
      var c = Math.max(1, Math.floor(Number(combo) || 1));
      effects.push({ kind: 'ring', x: x, y: y, r: r, age: 0, dur: 380, combo: c });
      var pieces = Math.min(22, 5 + Math.round(r / 10) + (c - 1) * 2);
      for (var i = 0; i < pieces; i++) {
        var a = (TAU * i) / pieces + Math.random() * 0.5;
        var sp = (0.6 + Math.random() * 1.4) * (1 + (c - 1) * 0.12);
        effects.push({
          kind: 'bit',
          x: x,
          y: y,
          vx: Math.cos(a) * sp * (1 + r / 60),
          vy: Math.sin(a) * sp * (1 + r / 60) - 0.4,
          r: 1.5 + Math.random() * (r / 22),
          color: def ? def.color : '#f0a',
          age: 0,
          dur: 520 + Math.random() * 220
        });
      }
      if (gained > 0) {
        effects.push({
          kind: 'text',
          x: x,
          y: y,
          text: '+' + gained,
          age: 0,
          dur: 900,
          big: gained >= 21 || c >= 3,
          color: resultTier ? '#fff' : '#ffe08a'
        });
      }
      if (c >= 2) {
        // 连击提示：金黄色的「连击 ×N」，让连击有明确的正反馈
        effects.push({
          kind: 'text',
          x: x,
          y: y + (def ? def.r * 0.75 : 24),
          text: '连击 ×' + c,
          age: 0,
          dur: 1000,
          big: c >= 3,
          color: c >= 4 ? '#ffd166' : '#ffe9a8'
        });
      }
      var shakeAmount = Math.min(9, r / 22 + (c - 1) * 0.8);
      shake = Math.max(shake, shakeAmount);
    }

    function addDrop(x, tier) {
      var def = CFG.tierByNumber(tier);
      effects.push({ kind: 'ring', x: x, y: BOARD.spawnY, r: def ? def.r * 0.9 : 20, age: 0, dur: 240, soft: true });
    }

    function addBurst(x, y, color) {
      for (var i = 0; i < 26; i++) {
        var a = (TAU * i) / 26;
        var sp = 1.2 + Math.random() * 2.6;
        effects.push({
          kind: 'bit',
          x: x,
          y: y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 0.8,
          r: 2 + Math.random() * 4,
          color: color || '#ff5d5d',
          age: 0,
          dur: 700 + Math.random() * 300
        });
      }
      flash = 1;
      shake = 10;
    }

    function update(dt) {
      time += dt;
      shake *= Math.pow(0.9, dt / 16);
      if (shake < 0.05) shake = 0;
      flash *= Math.pow(0.88, dt / 16);
      if (flash < 0.01) flash = 0;
      for (var i = effects.length - 1; i >= 0; i--) {
        var e = effects[i];
        e.age += dt;
        if (e.kind === 'bit') {
          e.x += e.vx * (dt / 16);
          e.y += e.vy * (dt / 16);
          e.vy += 0.16 * (dt / 16);
          e.vx *= 0.99;
        }
        if (e.age >= e.dur) effects.splice(i, 1);
      }
    }

    /* ---------------- 绘制 ---------------- */

    function drawBoardBackground(dangerY) {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#fdf7ee');
      g.addColorStop(0.55, '#fbeedd');
      g.addColorStop(1, '#f6e2cb');
      ctx.fillStyle = g;
      roundRectPath(ctx, WT, WT, W - WT * 2, H - WT * 2, [0, 0, 22, 22]);
      ctx.fill();

      // 顶部淡淡的投放区
      var top = ctx.createLinearGradient(0, WT, 0, dangerY + 40);
      top.addColorStop(0, 'rgba(255,214,163,0.55)');
      top.addColorStop(1, 'rgba(255,214,163,0)');
      ctx.fillStyle = top;
      ctx.fillRect(WT, WT, W - WT * 2, Math.max(40, dangerY + 40 - WT));
    }

    function drawWalls() {
      var r = 26;
      roundRectPath(ctx, 0, 0, W, H, [0, 0, r, r]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(180,120,88,0.28)';
      ctx.stroke();

      // 墙壁/地板：跟着明亮主题走（原来是深灰蓝，和暖色棋盘不搭）
      ctx.fillStyle = '#f0d9c4';
      roundRectPath(ctx, 0, H - WT, W, WT, [0, 0, r, r]);
      ctx.fill();
      ctx.fillRect(0, 0, WT, H);
      ctx.fillRect(W - WT, 0, WT, H);

      // 一点点内阴影，让边框有厚度但不发黑
      var lg = ctx.createLinearGradient(0, 0, 0, H);
      lg.addColorStop(0, 'rgba(255,255,255,0.55)');
      lg.addColorStop(1, 'rgba(196,140,104,0.22)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, WT, H);
      ctx.fillRect(W - WT, 0, WT, H);
      ctx.fillRect(0, H - WT, W, WT);
    }

    function drawDangerLine(y, dangerRatio, warning) {
      ctx.save();
      var pulse = warning ? 0.45 + 0.55 * Math.abs(Math.sin(time / 160)) : 0.3;
      ctx.setLineDash([9, 8]);
      ctx.lineWidth = warning ? 2.4 : 1.6;
      ctx.strokeStyle = warning ? 'rgba(230,52,52,' + pulse.toFixed(3) + ')' : 'rgba(226,120,110,0.42)';
      ctx.beginPath();
      ctx.moveTo(WT + 2, y);
      ctx.lineTo(W - WT - 2, y);
      ctx.stroke();
      ctx.restore();

      if (warning) {
        var g = ctx.createLinearGradient(0, WT, 0, y);
        g.addColorStop(0, 'rgba(230,52,52,' + (0.05 + 0.16 * dangerRatio).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(230,52,52,0)');
        ctx.fillStyle = g;
        ctx.fillRect(WT, WT, W - WT * 2, y - WT);
      }
    }

    function drawFruitShape(def, r) {
      var g = ctx.createRadialGradient(-r * 0.32, -r * 0.38, r * 0.12, 0, 0, r * 1.06);
      g.addColorStop(0, lighten(def.color, 0.5));
      g.addColorStop(0.65, def.color);
      g.addColorStop(1, def.edge);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.055);
      ctx.strokeStyle = 'rgba(60,30,10,0.16)';
      ctx.stroke();

      ctx.font = Math.round(r * 1.15) + 'px ' + EMOJI_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.emoji, 0, r * 0.04);

      ctx.beginPath();
      ctx.ellipse(-r * 0.34, -r * 0.4, r * 0.26, r * 0.15, -0.62, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();
    }

    /** 轮廓圆的面积加权质心（和引擎里保持一致，用于「下一颗」预览） */
    function comOf(circles) {
      var sx = 0;
      var sy = 0;
      var sw = 0;
      for (var i = 0; i < circles.length; i++) {
        var c = circles[i];
        var a = c.r * c.r;
        sx += c.x * a;
        sy += c.y * a;
        sw += a;
      }
      if (!sw) return { x: 0, y: 0 };
      return { x: sx / sw, y: sy / sw };
    }

    function drawFruit(body, assets, nowMs) {
      var def = CFG.tierByNumber(body.suikaTier);
      if (!def) return;
      var r = body.circleRadius || def.r;
      var shape = body.suikaShape;
      var JELLY = (CFG.RULES && CFG.RULES.jelly) || {};
      // 合成瞬间「弹出来」：新玩偶出生后 popMs 内从 1+popScale 缩到 1
      var pop = 1;
      if (body.suikaBornMs != null && nowMs) {
        var age = nowMs - body.suikaBornMs;
        if (age >= 0 && age < (JELLY.popMs || 220)) {
          pop = 1 + (JELLY.popScale || 0.28) * (1 - age / (JELLY.popMs || 220));
        }
      }
      // 挤压形变（纯渲染层：世界轴先压扁再自转，物理形状完全不变）
      var sq = body.suikaSq || 0;
      var sqA = body.suikaSqA || 0;
      ctx.save();
      ctx.translate(body.position.x, body.position.y);
      if (Math.abs(sq) > 0.004) {
        ctx.rotate(sqA);
        ctx.scale(1 - sq, 1 + sq * (JELLY.stretch || 0.85));
        ctx.rotate(-sqA);
      }
      ctx.rotate(body.angle || 0);
      r = r * pop;

      if (shape) {
        /*
         * 玩偶：按整只的尺寸画（不再裁成圆形），并且跟着刚体一起转。
         * 刚体的 position 是质心，图片中心在 -com*D 处，所以要挪回去。
         */
        var D = r * 2;
        ctx.translate(-shape.com.x * D, -shape.com.y * D);
        var dimg = assets ? assets.imageOf(body.suikaTier) : null;
        // 脚下的小影子
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(0, D * 0.34, D * 0.33, D * 0.085, 0, 0, TAU);
        else ctx.arc(0, D * 0.34, D * 0.14, 0, TAU);
        ctx.fillStyle = 'rgba(70,40,20,0.13)';
        ctx.fill();
        if (dimg) {
          var diw = dimg.naturalWidth;
          var dih = dimg.naturalHeight;
          var dsc = D / Math.max(diw, dih);
          ctx.drawImage(dimg, (-diw * dsc) / 2, (-dih * dsc) / 2, diw * dsc, dih * dsc);
        } else {
          drawFruitShape(def, r);
        }
        // ?shapes=1 ：把真实碰撞体画出来（黄色圆组 = 物理引擎实际用的形状）
        if (root.SUIKA_SHOW_SHAPES) {
          for (var ci = 0; ci < shape.circles.length; ci++) {
            var cc = shape.circles[ci];
            ctx.beginPath();
            ctx.arc(cc.x * D, cc.y * D, cc.r * D, 0, TAU);
            ctx.fillStyle = 'rgba(255,170,40,0.20)';
            ctx.fill();
            ctx.lineWidth = Math.max(1, D * 0.006);
            ctx.strokeStyle = 'rgba(255,209,102,0.95)';
            ctx.stroke();
          }
        }
        ctx.restore();
        return;
      }

      // 影子
      ctx.beginPath();
      ctx.arc(0, 0, r + 1.5, 0, TAU);
      ctx.fillStyle = 'rgba(70,40,20,0.10)';
      ctx.fill();

      var img = assets ? assets.imageOf(body.suikaTier) : null;
      if (img) {
        var iw = img.naturalWidth;
        var ih = img.naturalHeight;
        var scale = Math.max((r * 2) / iw, (r * 2) / ih);
        var dw = iw * scale;
        var dh = ih * scale;
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.clip();
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(0, 0, r - 0.5, 0, TAU);
        ctx.lineWidth = Math.max(1, r * 0.04);
        ctx.strokeStyle = 'rgba(40,20,10,0.18)';
        ctx.stroke();
      } else {
        drawFruitShape(def, r);
      }
      ctx.restore();
    }

    function drawAim(aim, assets) {
      if (!aim || !aim.visible) return;
      var def = CFG.tierByNumber(aim.tier);
      if (!def) return;
      var x = aim.x;
      var y = BOARD.spawnY;
      var r = def.r;

      // 下落参考线
      ctx.save();
      ctx.setLineDash([5, 9]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(90,70,50,' + (aim.ready ? 0.26 : 0.12) + ')';
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.lineTo(x, H - WT - 4);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = aim.ready ? 1 : 0.32;
      var aimShape = assets && assets.shapeOf ? assets.shapeOf(aim.tier) : null;
      var fake = {
        position: { x: x, y: y },
        circleRadius: r,
        angle: 0,
        suikaTier: aim.tier,
        suikaShape: aimShape && aimShape.circles ? { circles: aimShape.circles, com: aimShape.com || null } : null
      };
      if (fake.suikaShape && !fake.suikaShape.com) fake.suikaShape.com = comOf(aimShape.circles);
      drawFruit(fake, assets);
      ctx.restore();

      if (!aim.ready && aim.progress != null) {
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, aim.progress));
        ctx.stroke();
        ctx.restore();
      }
    }

    function drawEffects() {
      for (var i = 0; i < effects.length; i++) {
        var e = effects[i];
        var t = e.age / e.dur;
        ctx.save();
        if (e.kind === 'ring') {
          var rr = e.r * (1 + t * (e.soft ? 0.5 : 1.1));
          ctx.globalAlpha = (1 - t) * (e.soft ? 0.35 : 0.7);
          ctx.lineWidth = Math.max(1.5, e.r * 0.12 * (1 - t));
          ctx.strokeStyle = e.soft ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.arc(e.x, e.y, rr, 0, TAU);
          ctx.stroke();
        } else if (e.kind === 'bit') {
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (1 - t * 0.5), 0, TAU);
          ctx.fill();
        } else if (e.kind === 'text') {
          var ease = 1 - Math.pow(1 - t, 3);
          var ty = e.y - 34 * ease;
          ctx.globalAlpha = t < 0.75 ? 1 : (1 - t) / 0.25;
          ctx.font = '700 ' + (e.big ? 26 : 21) + 'px ' + UI_FONT;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(40,30,20,0.55)';
          ctx.strokeText(e.text, e.x, ty);
          ctx.fillStyle = e.color;
          ctx.fillText(e.text, e.x, ty);
        }
        ctx.restore();
      }
    }

    /** frame: { fruits, aim, dangerRatio, warning, assets, paused } */
    function draw(frame) {
      frame = frame || {};
      var offset = shake > 0 ? { x: (Math.random() - 0.5) * shake, y: (Math.random() - 0.5) * shake } : null;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (offset) ctx.translate(offset.x, offset.y);

      var dangerY = frame.dangerY || BOARD.dangerY;
      drawBoardBackground(dangerY);
      drawDangerLine(dangerY, frame.dangerRatio || 0, !!frame.warning);

      ctx.save();
      roundRectPath(ctx, WT, WT, W - WT * 2, H - WT * 2, [0, 0, 22, 22]);
      ctx.clip();
      var list = frame.fruits || [];
      for (var i = 0; i < list.length; i++) drawFruit(list[i], frame.assets, frame.elapsedMs || 0);
      drawAim(frame.aim, frame.assets);
      drawEffects();
      ctx.restore();

      drawWalls();

      if (flash > 0.01) {
        ctx.fillStyle = 'rgba(230,60,60,' + (flash * 0.32).toFixed(3) + ')';
        roundRectPath(ctx, 0, 0, W, H, [0, 0, 26, 26]);
        ctx.fill();
      }
      if (frame.paused) {
        ctx.fillStyle = 'rgba(18,24,36,0.45)';
        roundRectPath(ctx, 0, 0, W, H, [0, 0, 26, 26]);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 30px ' + UI_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('已暂停', W / 2, H / 2);
      }
    }

    return {
      draw: draw,
      update: update,
      addMerge: addMerge,
      addDrop: addDrop,
      addBurst: addBurst,
      clearEffects: function () {
        effects = [];
        shake = 0;
        flash = 0;
      },
      ctx: ctx,
      dpr: dpr
    };
  }

  root.SuikaRender = { create: create, lighten: lighten };
})(typeof globalThis !== 'undefined' ? globalThis : this);
