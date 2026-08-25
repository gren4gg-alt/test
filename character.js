// character.js — procedural character rendering for Pico Park-style co-op game
// No external assets; everything drawn each frame via Canvas 2D.
// Pure rendering + LOCAL (client-side-only) animation state — never sent over
// the network, never touches physics. Safe to compute independently on host
// and every client since it's derived only from already-synced snapshot fields.
//
// USAGE (per player, once at spawn):
//   const anim = Character.createAnimState();
// USAGE (per player, every render frame):
//   Character.update(anim, dt, { x, y, vx, vy, facing, grounded, dead });
//   Character.draw(ctx, anim, { x, y, w, h, color });
//
// `vx`/`vy` are optional — if the sync payload doesn't carry velocity,
// update() derives it from position deltas automatically.

(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  function createAnimState() {
    return {
      speed: 0,
      facing: 1,
      wasGrounded: true,
      airTime: 0,

      scaleX: 1,
      scaleY: 1,

      breathPhase: Math.random() * TAU, // desync multiple players
      blinkTimer: 1 + Math.random() * 2,
      blinkPhase: 0,
      eyeLookX: 0,
      eyeLookTimer: 1 + Math.random() * 2,
      eyeLookTargetX: 0,

      walkPhase: 0,

      launchPop: 0,
      landPop: 0,

      deadSpin: 0,
      deadTime: 0,

      _lastX: undefined,
      _lastY: undefined,
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function decay(v, rate, dt) { return v * Math.exp(-rate * dt); }

  function update(anim, dt, state) {
    dt = clamp(dt, 0, 0.05); // guard against tab-switch / stall spikes

    if (anim._lastX === undefined) { anim._lastX = state.x; anim._lastY = state.y; }
    const dx = state.x - anim._lastX;
    const dy = state.y - anim._lastY;
    anim._lastX = state.x;
    anim._lastY = state.y;

    const instVx = (state.vx !== undefined) ? state.vx : (dt > 0 ? dx / dt : 0);
    const instVy = (state.vy !== undefined) ? state.vy : (dt > 0 ? dy / dt : 0);

    // ---- dead short-circuits everything else ----
    if (state.dead) {
      anim.deadTime += dt;
      anim.deadSpin += dt * 6;
      anim.scaleX = lerp(anim.scaleX, 0.6, 1 - Math.exp(-8 * dt));
      anim.scaleY = lerp(anim.scaleY, 0.5, 1 - Math.exp(-8 * dt));
      return;
    } else if (anim.deadTime > 0) {
      // room reset: snap back out of dead pose
      anim.deadTime = 0;
      anim.deadSpin = 0;
      anim.scaleX = 1;
      anim.scaleY = 1;
    }

    // ---- smoothed speed + facing ----
    const absSpeed = Math.abs(instVx);
    anim.speed = lerp(anim.speed, absSpeed, 1 - Math.exp(-12 * dt));
    if (absSpeed > 8) {
      anim.facing = instVx > 0 ? 1 : -1;
    } else if (state.facing !== undefined) {
      anim.facing = state.facing;
    }

    // ---- grounded transitions: launch / land pop ----
    const grounded = !!state.grounded;
    if (anim.wasGrounded && !grounded) anim.launchPop = 1;
    if (!anim.wasGrounded && grounded) anim.landPop = clamp(anim.airTime * 2.5, 0.3, 1);
    anim.airTime = grounded ? 0 : anim.airTime + dt;
    anim.wasGrounded = grounded;

    anim.launchPop = decay(anim.launchPop, 10, dt);
    anim.landPop = decay(anim.landPop, 9, dt);

    // ---- squash & stretch composite ----
    let targetScaleX = 1, targetScaleY = 1;

    if (!grounded) {
      const vyStretch = clamp(instVy / 900, -0.18, 0.22);
      targetScaleY += vyStretch + anim.launchPop * 0.22;
      targetScaleX -= (vyStretch + anim.launchPop * 0.22) * 0.6;
    } else {
      targetScaleY -= anim.landPop * 0.3;
      targetScaleX += anim.landPop * 0.22;

      if (anim.speed > 12) {
        anim.walkPhase += dt * (6 + anim.speed * 0.02);
        const bounce = Math.sin(anim.walkPhase);
        targetScaleY += bounce * 0.05;
        targetScaleX -= bounce * 0.035;
      } else {
        anim.walkPhase = 0;
      }
    }

    anim.scaleX = lerp(anim.scaleX, targetScaleX, 1 - Math.exp(-16 * dt));
    anim.scaleY = lerp(anim.scaleY, targetScaleY, 1 - Math.exp(-16 * dt));

    // ---- idle breathing ----
    anim.breathPhase += dt * 1.6;

    // ---- blinking ----
    anim.blinkTimer -= dt;
    if (anim.blinkTimer <= 0 && anim.blinkPhase <= 0) {
      anim.blinkPhase = 1;
      anim.blinkTimer = 1.5 + Math.random() * 3;
    }
    if (anim.blinkPhase > 0) anim.blinkPhase = Math.max(0, anim.blinkPhase - dt * 9);

    // ---- idle eye drift (overridden by movement lead) ----
    anim.eyeLookTimer -= dt;
    if (anim.eyeLookTimer <= 0) {
      anim.eyeLookTargetX = (Math.random() * 2 - 1) * 0.6;
      anim.eyeLookTimer = 1 + Math.random() * 2;
    }
    const lookTarget = anim.speed > 12 ? anim.facing * 0.8 : anim.eyeLookTargetX;
    anim.eyeLookX = lerp(anim.eyeLookX, lookTarget, 1 - Math.exp(-6 * dt));
  }

  // box = { x, y, w, h, color } — x,y top-left, already camera-transformed
  function draw(ctx, anim, box) {
    const { x, y, w, h, color } = box;
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.save();
    ctx.translate(cx, cy);

    if (anim.deadTime > 0) ctx.rotate(anim.deadSpin);
    ctx.scale(anim.scaleX, anim.scaleY);

    const r = Math.min(w, h) * 0.28;
    const bob = (anim.speed < 12 && anim.airTime === 0 && anim.deadTime === 0)
      ? Math.sin(anim.breathPhase) * h * 0.02
      : 0;

    drawRoundedBox(ctx, -w / 2, -h / 2 + bob, w, h, r, color);
    drawFace(ctx, anim, w, h, bob);

    ctx.restore();
  }

  function drawRoundedBox(ctx, x, y, w, h, r, color) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = Math.max(1, w * 0.02);
    ctx.stroke();
  }

  function drawFace(ctx, anim, bw, bh, bob) {
    const faceY = -bh * 0.05 + bob;
    const eyeSpacing = bw * 0.22;
    const eyeY = faceY - bh * 0.02;
    const eyeR = bw * 0.09;
    const lookX = anim.eyeLookX * eyeR * 0.55;

    ctx.fillStyle = '#1a1a1a';

    if (anim.deadTime > 0) {
      drawXEyes(ctx, -eyeSpacing, eyeY, eyeR);
      drawXEyes(ctx, eyeSpacing, eyeY, eyeR);
      ctx.beginPath();
      ctx.moveTo(-bw * 0.12, faceY + bh * 0.18);
      ctx.lineTo(bw * 0.12, faceY + bh * 0.18);
      ctx.lineWidth = Math.max(1.5, bw * 0.035);
      ctx.strokeStyle = '#1a1a1a';
      ctx.stroke();
      return;
    }

    const openness = 1 - anim.blinkPhase;
    const launchWiden = anim.launchPop * 0.4;
    const landSquint = anim.landPop * 0.5;
    const eyeScaleY = clamp(openness + launchWiden - landSquint, 0.06, 1.35);

    [-1, 1].forEach(side => {
      const ex = side * eyeSpacing + lookX;
      ctx.save();
      ctx.translate(ex, eyeY);
      ctx.scale(1, eyeScaleY);
      ctx.beginPath();
      ctx.arc(0, 0, eyeR, 0, TAU);
      ctx.fill();
      ctx.restore();
    });

    const mouthOpen = clamp(0.15 + anim.speed * 0.004 + anim.launchPop * 0.3, 0.15, 0.7);
    const mw = bw * 0.16;
    ctx.beginPath();
    ctx.moveTo(-mw, faceY + bh * 0.16);
    ctx.quadraticCurveTo(0, faceY + bh * 0.16 + bh * 0.14 * mouthOpen, mw, faceY + bh * 0.16);
    ctx.lineWidth = Math.max(1.5, bw * 0.035);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawXEyes(ctx, ex, ey, r) {
    ctx.save();
    ctx.translate(ex, ey);
    ctx.lineWidth = Math.max(1.5, r * 0.4);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, -r * 0.7); ctx.lineTo(r * 0.7, r * 0.7);
    ctx.moveTo(-r * 0.7, r * 0.7); ctx.lineTo(r * 0.7, -r * 0.7);
    ctx.stroke();
    ctx.restore();
  }

  global.Character = { createAnimState, update, draw };
})(typeof window !== 'undefined' ? window : this);
