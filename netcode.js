/* ==========================================================================
   netcode.js — host-authoritative networking for the co-op platformer
   --------------------------------------------------------------------------
   Depends on: engine.js (window.Engine), input.js (window.InputManager),
               level.js  (window.Level),   peerjs (CDN)

   ONE CODE PATH FOR DESKTOP AND MOBILE.
   There is deliberately no "mobile mode". Prediction only works if host and
   client compute bit-identical results from identical inputs, so the
   simulation must be the same everywhere — a phone and a laptop in the same
   room would desync instantly otherwise. What adapts to the device is how
   OFTEN we pay for work, never WHAT the work computes:

     - fixed 60Hz simulation, identical on every device
     - rendering interpolates between sim states, so 30 / 60 / 120Hz
       displays all look smooth without the sim changing at all
     - rollback runs only on an actual mispredict, under a time budget
     - input is coalesced, so a slow radio sends ~10 msg/s instead of 60

   WHY RENDER INTERPOLATION MATTERS MOST (this is the jitter fix)
     The sim advances in fixed 16.67ms chunks; the display refreshes on its
     own schedule. Drawing raw physics positions means a 120Hz screen shows
     some sim states twice and a 45fps screen skips others — visible stutter
     even on a perfect connection. So we keep the previous and current sim
     state and draw at prev + (curr - prev) * alpha, where alpha is how far
     through the current tick we are. Render rate is then fully decoupled
     from sim rate.

   MODEL
     - HOST runs the authoritative World.step() and broadcasts at SNAPSHOT_HZ.
     - CLIENTS send only a 4-bit input mask. They never send positions.
     - CLIENTS run the same World predicted forward, and roll the whole world
       back to the host's state when (and only when) they mispredicted.

   WHY FULL-WORLD ROLLBACK
     Players share physics: you push boxes others stand on, ride platforms,
     throw boxes. Your own position depends on what everyone else did, so a
     client cannot predict just itself. The host therefore replicates every
     player's input mask so clients replay remote players with real input
     rather than a guess. (Unity's netcode calls this input replication.)

   DETERMINISM CONTRACT (what engine.js must keep honouring)
     - World.step(dt) is a pure function of world state + inputs
     - no Math.random(), no Date.now(), no frame-rate dependence
     - entity iteration order is insertion order, identical on both sides
   ========================================================================== */
(function () {
"use strict";

const { World, Player, Box, MovingPlatform, PHYSICS } = window.Engine;

/* ===========================================================================
   CONFIG
   =========================================================================== */
const CFG = {
  SIM_HZ:            60,
  SNAPSHOT_HZ:       20,
  MAX_PLAYERS:       8,
  MAX_PENDING:       180,
  MAX_CATCHUP_MS:    250,   // clamp frame delta; prevents post-stall spiral
  MAX_STEPS_FRAME:   6,     // hard cap on sim steps in one frame (mobile guard)

  // --- rollback ---
  REPLAY_BUDGET_MS:  6,     // stop replaying past this; degrade accuracy,
                            // never framerate
  MAX_REPLAY_TICKS:  24,
  DESYNC_POS:        0.6,   // px   — below this we accept our prediction
  DESYNC_VEL:        6.0,   // px/s   and skip the rollback entirely

  // --- visual correction ---
  SMOOTH:            0.25,  // per-frame decay of correction offset
  SNAP_DIST:         110,   // beyond this, snap (teleport / respawn)

  // --- input coalescing ---
  INPUT_KEEPALIVE:   6,     // flush at least every N ticks even if unchanged
  MAX_RUN:           16,    // max ticks one coalesced message may represent

  // --- security ---
  MAX_MSG_BYTES:     4096,
  MAX_MSG_PER_SEC:   90,    // ample for coalesced input, far under 60/s raw
  MAX_QUEUED_INPUTS: 24,
};
const SIM_DT  = 1 / CFG.SIM_HZ;
const SIM_MS  = 1000 / CFG.SIM_HZ;
const SNAP_MS = 1000 / CFG.SNAPSHOT_HZ;

const PALETTE = ['#4bd07a','#e06c75','#61afef','#e5c07b','#c678dd','#56b6c2','#d19a66','#f28fd0'];

/* ===========================================================================
   INPUT ENCODING
   input.js emits {left,right,jump,action} -> 4 bits. Anything outside those
   bits is discarded by the validator, so a client cannot smuggle extra
   fields into the host's simulation.
   =========================================================================== */
const BTN = { LEFT: 1, RIGHT: 2, JUMP: 4, ACTION: 8 };
const INPUT_MASK = BTN.LEFT | BTN.RIGHT | BTN.JUMP | BTN.ACTION;   // 15

function stateToMask(s) {
  return (s.left ? BTN.LEFT : 0) | (s.right ? BTN.RIGHT : 0) |
         (s.jump ? BTN.JUMP : 0) | (s.action ? BTN.ACTION : 0);
}
// Reused object: this runs 60x/sec per player during replay. No allocation.
const _inputScratch = { left: false, right: false, jump: false, action: false };
function maskToState(m) {
  _inputScratch.left   = !!(m & BTN.LEFT);
  _inputScratch.right  = !!(m & BTN.RIGHT);
  _inputScratch.jump   = !!(m & BTN.JUMP);
  _inputScratch.action = !!(m & BTN.ACTION);
  return _inputScratch;
}

/* ===========================================================================
   REPLICATION SCHEMA — per entity TYPE, not just players
   ---------------------------------------------------------------------------
   Each field is [name, scale]; the value ships as Math.round(v * scale), so
   the wire carries fixed-point ints instead of float JSON.

   Scale is a correctness knob, not just bandwidth: the client replays from
   the rounded value while the host continues from the exact one, so
   quantization is a divergence source. 1/16px and 1/8 px/s sit well under
   the visible threshold, and residual drift is corrected next snapshot.

   HIDDEN STATE IS REPLICATED TOO. Coyote timer, jump buffer and the
   previous-frame held flags are inputs to the next step, not cosmetics.
   Omit them and a replayed jump lands a tick off from the host's — which
   players experience as "jump sometimes doesn't work".
   =========================================================================== */
const P_FLAG = { GROUNDED: 1, JUMP_HELD: 2, ACTION_HELD: 4 };
const B_FLAG = { GROUNDED: 1, CARRIED: 2 };

const SCHEMA = {
  player: [
    ['x', 16], ['y', 16], ['vx', 8], ['vy', 8],
    ['facing', 1],
    ['_coyoteTimer', 1000], ['_jumpBufferTimer', 1000],
    ['_flags', 1],        // P_FLAG bits
    ['_carryNet', 1],     // netId of held box, 0 = none
    ['_inputMask', 1],    // replicated input, for remote-player replay
  ],
  box: [
    ['x', 16], ['y', 16], ['vx', 8], ['vy', 8],
    ['_flags', 1],        // B_FLAG bits
    ['_carrierSlot', 1],  // holder slot + 1, 0 = none
  ],
  platform: [
    ['x', 16], ['y', 16],
    ['_segIndex', 1], ['_dir', 1],
  ],
};

// Timers count up forever once consumed; cap so the encoded int stays small.
// Both thresholds are ~0.1s, so anything past a second is equivalent.
const TIMER_CAP = 9.999;

/* ===========================================================================
   NET WORLD — engine.js World plus the bookkeeping the net layer needs
   =========================================================================== */
class NetWorld {
  constructor() {
    this.world = new World();
    this.players = new Map();    // slot -> Player
    this.boxes = [];             // index order == netId-1, fixed by level
    this.platforms = [];
    window.Level.build(this.world, this);
    this.boxes.forEach((b, i) => { b._netId = i + 1; });
    this.platforms.forEach((p, i) => { p._netId = i + 1; });
    this._maskScratch = new Map();
  }

  addPlayer(slot) {
    if (this.players.has(slot)) return this.players.get(slot);
    const spawn = window.Level.spawnPoint(slot);
    const p = new Player(spawn.x, spawn.y);
    p.color = PALETTE[slot % PALETTE.length];
    p._slot = slot;
    p._inputMask = 0;
    this.world.add(p);
    this.players.set(slot, p);
    return p;
  }

  removePlayer(slot) {
    const p = this.players.get(slot);
    if (!p) return;
    if (p.carrying) {              // else the box is orphaned mid-air
      p.carrying.carried = false;
      p.carrying.carriedBy = null;
      p.carrying = null;
    }
    this.world.remove(p);
    this.players.delete(slot);
  }

  boxByNet(id) { return id > 0 ? this.boxes[id - 1] || null : null; }

  /**
   * One fixed step. Order mirrors engine.js's documented contract:
   *   handleInput    -> sets vx / jump velocity for this frame
   *   updateCarrying -> a throw reads the player's CURRENT vx, so it must
   *                     run after handleInput for a running throw to inherit
   *                     running speed (engine.js documents the thrown arc as
   *                     matching the player's own jump, scaled by vx)
   *   world.step     -> gravity, platforms, collision
   */
  step(dt) {
    for (const p of this.players.values()) {
      const state = maskToState(p._inputMask);
      p.handleInput(state, dt);
      this.world.updateCarrying(p, state);
    }
    this.world.step(dt);
  }

  setInputs(masks) {
    for (const [slot, mask] of masks) {
      const p = this.players.get(slot);
      if (p) p._inputMask = mask;
    }
  }

  /** Set one player's mask; everyone else keeps their replicated mask. */
  setLocalInput(slot, mask) {
    const p = this.players.get(slot);
    if (p) p._inputMask = mask;
  }
}

/* ===========================================================================
   RENDER STATE — the jitter fix
   ---------------------------------------------------------------------------
   Snapshot every entity's position before and after each sim tick, then let
   the renderer sample anywhere between them. Cost is two number writes per
   entity per tick, which is nothing next to a physics step, and it decouples
   visual smoothness from both device refresh rate and simulation rate.

   A correction offset from rollback is layered on top and decayed, so a
   snap-to-authority eases out over a few frames instead of popping.
   =========================================================================== */
class RenderState {
  constructor() {
    this.prev = new Map();     // entity -> {x, y}
    this.curr = new Map();
    this.offset = new Map();   // entity -> {x, y} residual correction
    this._out = [];            // reused; no per-frame allocation
  }

  /** Call immediately BEFORE a sim step. */
  capturePrev(world) {
    const { prev, curr } = this;
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      let p = prev.get(e);
      if (!p) { p = { x: 0, y: 0 }; prev.set(e, p); }
      const c = curr.get(e);
      // Start from last tick's post-step position when we have one, so
      // prev/curr are always consecutive sim states.
      p.x = c ? c.x : e.x;
      p.y = c ? c.y : e.y;
    }
  }

  /** Call immediately AFTER a sim step. */
  captureCurr(world) {
    const { curr } = this;
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      let c = curr.get(e);
      if (!c) { c = { x: 0, y: 0 }; curr.set(e, c); }
      c.x = e.x; c.y = e.y;
    }
  }

  /** Record how far a rollback moved things, to ease the correction out. */
  applyCorrection(before) {
    for (const [e, b] of before) {
      const c = this.curr.get(e);
      if (!c) continue;
      const dx = b.x - c.x, dy = b.y - c.y;
      if (Math.hypot(dx, dy) > CFG.SNAP_DIST) { this.offset.delete(e); continue; }
      let o = this.offset.get(e);
      if (!o) { o = { x: 0, y: 0 }; this.offset.set(e, o); }
      o.x += dx; o.y += dy;
    }
  }

  decay() {
    for (const [e, o] of this.offset) {
      o.x *= (1 - CFG.SMOOTH); o.y *= (1 - CFG.SMOOTH);
      if (Math.abs(o.x) < 0.05 && Math.abs(o.y) < 0.05) this.offset.delete(e);
    }
  }

  forget(entity) {
    this.prev.delete(entity); this.curr.delete(entity); this.offset.delete(entity);
  }

  /**
   * Interpolated draw list. alpha is how far through the current tick we are
   * (0..1). Returns a REUSED array of {entity, x, y} — read it this frame,
   * don't retain it.
   */
  sample(world, alpha) {
    const out = this._out;
    out.length = 0;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const p = this.prev.get(e), c = this.curr.get(e);
      let x, y;
      if (p && c) { x = p.x + (c.x - p.x) * a; y = p.y + (c.y - p.y) * a; }
      else { x = e.x; y = e.y; }
      const o = this.offset.get(e);
      if (o) { x += o.x; y += o.y; }
      out.push({ entity: e, x, y });
    }
    return out;
  }
}

/* ===========================================================================
   PREDICTION HISTORY
   ---------------------------------------------------------------------------
   A ring of compact records of what we predicted at each tick, so that when
   a snapshot arrives describing tick N we can ask "was our prediction at
   tick N right?" rather than "does our present state equal the past?".

   Records are typed arrays drawn from a free pool, because this writes once
   per sim tick (60/sec) and allocating there would hand the GC a steady
   stream of garbage — which on a phone shows up as periodic frame hitches,
   exactly the symptom we're trying to remove.
   =========================================================================== */
class PredictionHistory {
  constructor(maxLen) {
    this.max = maxLen;
    this.records = [];       // oldest first
    this._pool = [];
  }

  _take(nP, nB, nM) {
    const r = this._pool.pop();
    if (r && r.players.length >= nP * 7 && r.boxes.length >= nB * 3 &&
        r.platforms.length >= nM * 3) {
      return r;
    }
    return {
      seq: 0, playerCount: 0,
      players:   new Float32Array(Math.max(nP, CFG.MAX_PLAYERS) * 7),
      boxes:     new Float32Array(nB * 3),
      platforms: new Float32Array(nM * 3),
    };
  }

  /** Record the world as it stands right now, tagged with this input seq. */
  record(nw, seq) {
    const nP = nw.players.size, nB = nw.boxes.length, nM = nw.platforms.length;
    const r = this._take(nP, nB, nM);
    r.seq = seq;
    r.playerCount = nP;

    let i = 0;
    const P = r.players;
    for (const [slot, p] of nw.players) {
      P[i]     = slot;
      P[i + 1] = p.x;  P[i + 2] = p.y;
      P[i + 3] = p.vx; P[i + 4] = p.vy;
      P[i + 5] = (p.grounded ? P_FLAG.GROUNDED : 0);
      P[i + 6] = p.carrying ? p.carrying._netId : 0;
      i += 7;
    }

    const B = r.boxes;
    for (let k = 0; k < nB; k++) {
      const b = nw.boxes[k];
      B[k * 3] = b.x; B[k * 3 + 1] = b.y; B[k * 3 + 2] = b.carried ? 1 : 0;
    }

    const M = r.platforms;
    for (let k = 0; k < nM; k++) {
      const m = nw.platforms[k];
      M[k * 3] = m.x; M[k * 3 + 1] = m.y; M[k * 3 + 2] = m._segIndex | 0;
    }

    this.records.push(r);
    while (this.records.length > this.max) this._pool.push(this.records.shift());
  }

  /** The record for this seq, or null if it has aged out. */
  find(seq) {
    const recs = this.records;
    for (let i = recs.length - 1; i >= 0; i--) {
      if (recs[i].seq === seq) return recs[i];
      if (recs[i].seq < seq) return null;      // ordered; no point continuing
    }
    return null;
  }

  /** Retire everything at or before seq — the host has confirmed past it. */
  dropThrough(seq) {
    const recs = this.records;
    let n = 0;
    while (n < recs.length && recs[n].seq <= seq) n++;
    for (let i = 0; i < n; i++) this._pool.push(recs[i]);
    if (n) recs.splice(0, n);
  }

  clear() {
    for (const r of this.records) this._pool.push(r);
    this.records.length = 0;
  }
}

/* ===========================================================================
   CODEC
   =========================================================================== */
const Codec = {
  _packPlayer(p) {
    p._flags = (p.grounded ? P_FLAG.GROUNDED : 0) |
               (p._wasJumpHeld ? P_FLAG.JUMP_HELD : 0) |
               (p._wasActionHeld ? P_FLAG.ACTION_HELD : 0);
    p._carryNet = p.carrying ? p.carrying._netId : 0;
    if (p._coyoteTimer > TIMER_CAP) p._coyoteTimer = TIMER_CAP;
    if (p._jumpBufferTimer > TIMER_CAP) p._jumpBufferTimer = TIMER_CAP;
  },
  _packBox(b) {
    b._flags = (b.grounded ? B_FLAG.GROUNDED : 0) | (b.carried ? B_FLAG.CARRIED : 0);
    b._carrierSlot = (b.carriedBy && b.carriedBy._slot !== undefined)
      ? b.carriedBy._slot + 1 : 0;
  },

  encode(nw, tick) {
    const p = [], b = [], m = [];
    for (const [slot, ent] of nw.players) {
      this._packPlayer(ent);
      p.push(slot);
      for (let i = 0; i < SCHEMA.player.length; i++) {
        const f = SCHEMA.player[i];
        p.push(Math.round(ent[f[0]] * f[1]));
      }
    }
    for (let j = 0; j < nw.boxes.length; j++) {
      const box = nw.boxes[j];
      this._packBox(box);
      b.push(box._netId);
      for (let i = 0; i < SCHEMA.box.length; i++) {
        const f = SCHEMA.box[i];
        b.push(Math.round(box[f[0]] * f[1]));
      }
    }
    for (let j = 0; j < nw.platforms.length; j++) {
      const plat = nw.platforms[j];
      m.push(plat._netId);
      for (let i = 0; i < SCHEMA.platform.length; i++) {
        const f = SCHEMA.platform[i];
        m.push(Math.round(plat[f[0]] * f[1]));
      }
    }
    return { t: tick, p, b, m };
  },

  /** Strict: returns null on ANY malformation. Never applies partial state. */
  decode(msg) {
    if (!msg || !Array.isArray(msg.p) || !Array.isArray(msg.b) || !Array.isArray(msg.m)) return null;

    const read = (flat, schema, idMax) => {
      const stride = schema.length + 1;
      if (flat.length % stride !== 0) return null;
      const out = [];
      for (let i = 0; i < flat.length; i += stride) {
        const id = flat[i];
        if (!Number.isInteger(id) || id < 0 || id > idMax) return null;
        const rec = { id };
        for (let f = 0; f < schema.length; f++) {
          const v = flat[i + 1 + f];
          if (typeof v !== 'number' || !Number.isFinite(v)) return null;
          rec[schema[f][0]] = v / schema[f][1];
        }
        out.push(rec);
      }
      return out;
    };

    const players   = read(msg.p, SCHEMA.player,   CFG.MAX_PLAYERS - 1);
    const boxes     = read(msg.b, SCHEMA.box,      4096);
    const platforms = read(msg.m, SCHEMA.platform, 4096);
    if (!players || !boxes || !platforms) return null;
    if (players.length > CFG.MAX_PLAYERS) return null;

    return { tick: msg.t, players, boxes, platforms };
  },

  /**
   * Compare an authoritative snapshot against a RECORDED PAST prediction.
   *
   * The comparison must be against what we predicted at the tick the host is
   * reporting, NOT against our current state. The client deliberately runs
   * ahead of the host by roughly the round-trip time, so its present state
   * never equals a snapshot describing the past — comparing those reports a
   * mispredict every single time and the rollback is never skipped.
   *
   * `rec` is a PredictionHistory record. Returns true if our past prediction
   * was right, meaning everything derived from it is right too and the
   * rollback can be skipped entirely.
   */
  matchesHistory(rec, snap) {
    if (!rec) return false;
    if (rec.playerCount !== snap.players.length) return false;

    const P = rec.players;              // [slot, x, y, vx, vy, flags, carryNet] * n
    for (let i = 0; i < snap.players.length; i++) {
      const s = snap.players[i];
      let base = -1;
      for (let k = 0; k < rec.playerCount; k++) {   // counts are tiny; linear is fine
        if (P[k * 7] === s.id) { base = k * 7; break; }
      }
      if (base < 0) return false;
      if (Math.abs(P[base + 1] - s.x)  > CFG.DESYNC_POS) return false;
      if (Math.abs(P[base + 2] - s.y)  > CFG.DESYNC_POS) return false;
      if (Math.abs(P[base + 3] - s.vx) > CFG.DESYNC_VEL) return false;
      if (Math.abs(P[base + 4] - s.vy) > CFG.DESYNC_VEL) return false;
      // Discrete state must match EXACTLY. A wrong grounded or carry flag
      // diverges immediately on the next step even when positions still look
      // close, so tolerating it would let real desync through.
      const sFl = s._flags | 0;
      if ((P[base + 5] & P_FLAG.GROUNDED) !== (sFl & P_FLAG.GROUNDED)) return false;
      if (P[base + 6] !== (s._carryNet | 0)) return false;
    }

    const B = rec.boxes;                // [x, y, carried] * nBoxes
    for (let i = 0; i < snap.boxes.length; i++) {
      const s = snap.boxes[i];
      const base = (s.id - 1) * 3;
      if (base < 0 || base + 2 >= B.length) continue;
      if (Math.abs(B[base] - s.x) > CFG.DESYNC_POS) return false;
      if (Math.abs(B[base + 1] - s.y) > CFG.DESYNC_POS) return false;
      if (B[base + 2] !== (((s._flags | 0) & B_FLAG.CARRIED) ? 1 : 0)) return false;
    }

    const M = rec.platforms;            // [x, y, segIndex] * nPlatforms
    for (let i = 0; i < snap.platforms.length; i++) {
      const s = snap.platforms[i];
      const base = (s.id - 1) * 3;
      if (base < 0 || base + 2 >= M.length) continue;
      if (Math.abs(M[base] - s.x) > CFG.DESYNC_POS) return false;
      if (Math.abs(M[base + 1] - s.y) > CFG.DESYNC_POS) return false;
      if (M[base + 2] !== (s._segIndex | 0)) return false;
    }
    return true;
  },

  /** Overwrite a NetWorld with authoritative state. */
  apply(nw, snap, renderState) {
    const seen = new Set();
    for (const rec of snap.players) {
      seen.add(rec.id);
      const p = nw.addPlayer(rec.id);
      p.x = rec.x; p.y = rec.y; p.vx = rec.vx; p.vy = rec.vy;
      p.facing = rec.facing;
      p._coyoteTimer = rec._coyoteTimer;
      p._jumpBufferTimer = rec._jumpBufferTimer;
      p._inputMask = rec._inputMask | 0;
      const fl = rec._flags | 0;
      p.grounded       = !!(fl & P_FLAG.GROUNDED);
      p._wasJumpHeld   = !!(fl & P_FLAG.JUMP_HELD);
      p._wasActionHeld = !!(fl & P_FLAG.ACTION_HELD);
      p.carrying = null;                 // relinked below
    }
    for (const slot of Array.from(nw.players.keys())) {
      if (!seen.has(slot)) {
        const gone = nw.players.get(slot);
        if (renderState && gone) renderState.forget(gone);
        nw.removePlayer(slot);
      }
    }

    for (const rec of snap.boxes) {
      const box = nw.boxByNet(rec.id);
      if (!box) continue;                // unknown netId: ignore, never throw
      box.x = rec.x; box.y = rec.y; box.vx = rec.vx; box.vy = rec.vy;
      const fl = rec._flags | 0;
      box.grounded = !!(fl & B_FLAG.GROUNDED);
      box.carried  = !!(fl & B_FLAG.CARRIED);
      const holder = rec._carrierSlot > 0 ? nw.players.get(rec._carrierSlot - 1) : null;
      box.carriedBy = box.carried ? (holder || null) : null;
      if (box.carriedBy) box.carriedBy.carrying = box;
      if (!box.carried) { box.carried = false; box.carriedBy = null; }
    }

    // Platforms: position AND patrol state. Position alone lets a client's
    // platform drift onto the wrong segment and reverse at the wrong moment.
    for (const rec of snap.platforms) {
      const plat = nw.platforms[rec.id - 1];
      if (!plat) continue;
      plat.x = rec.x; plat.y = rec.y;
      plat._segIndex = rec._segIndex | 0;
      plat._dir = rec._dir >= 0 ? 1 : -1;
    }

    // groundEntity holds object references, and moveYWithCollision recomputes
    // it from scratch next step. Clear it so a stale link can't carry a rider
    // wrongly for one frame after a correction.
    for (const e of nw.world.entities) e.groundEntity = null;
  },
};

/* ===========================================================================
   VALIDATION — the host trusts nothing off the wire
   =========================================================================== */
const Validate = {
  size(msg) {
    try { return JSON.stringify(msg).length <= CFG.MAX_MSG_BYTES; }
    catch { return false; }                      // circular / unserializable
  },
  /** Coalesced input: seq s, mask m, repeated n ticks. */
  input(msg) {
    if (!msg || msg.type !== 'i') return null;
    const s = msg.s, m = msg.m;
    const n = msg.n === undefined ? 1 : msg.n;
    if (!Number.isInteger(s) || s < 0 || s > 2 ** 31) return null;
    if (!Number.isInteger(m) || m < 0 || m > INPUT_MASK) return null;
    if (!Number.isInteger(n) || n < 1 || n > CFG.MAX_RUN) return null;
    return { seq: s, mask: m, count: n };        // unknown fields dropped
  },
  roomCode(str) {
    return typeof str === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(str.trim());
  },
};

function rateLimiter(perSec) {
  let tokens = perSec, last = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(perSec, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1; return true;
  };
}

/* ===========================================================================
   HOST
   =========================================================================== */
const Host = {
  nw: null, rs: null, peers: new Map(), slots: new Map(), usedSlots: new Set(),
  tick: 0, acc: 0, snapAcc: 0, lastTime: 0, mySlot: -1, selfId: null,
  stats: { stepsFrame: 0, simMs: 0 },

  start(peer, input, onStatus) {
    this.nw = new NetWorld();
    this.rs = new RenderState();
    this.input = input;
    this.onStatus = onStatus || function () {};
    this.selfId = peer.id;
    this.mySlot = this.claimSlot(peer.id);
    this.nw.addPlayer(this.mySlot);
    this.peers.set(peer.id, {
      conn: null, queue: [], lastMask: 0, lastSeq: 0, ackSeq: 0, allow: () => true,
    });
    this.rs.capturePrev(this.nw.world);
    this.rs.captureCurr(this.nw.world);
    peer.on('connection', c => this.onConnection(c));
    this.lastTime = performance.now();
  },

  claimSlot(id) {
    for (let s = 0; s < CFG.MAX_PLAYERS; s++) {
      if (!this.usedSlots.has(s)) { this.usedSlots.add(s); this.slots.set(id, s); return s; }
    }
    return -1;
  },

  onConnection(conn) {
    if (this.peers.size >= CFG.MAX_PLAYERS) {
      conn.on('open', () => { try { conn.send({ type: 'full' }); } catch {} conn.close(); });
      return;
    }
    conn.on('open', () => {
      if (this.peers.has(conn.peer)) { conn.close(); return; }      // duplicate
      const slot = this.claimSlot(conn.peer);
      if (slot < 0) { conn.close(); return; }
      this.nw.addPlayer(slot);
      this.peers.set(conn.peer, {
        conn, queue: [], lastMask: 0, lastSeq: 0, ackSeq: 0,
        allow: rateLimiter(CFG.MAX_MSG_PER_SEC),
      });
      try { conn.send({ type: 'welcome', slot, tick: this.tick }); } catch {}
      this.report();
    });
    conn.on('data', msg => this.onData(conn, msg));
    conn.on('close', () => this.drop(conn.peer));
    conn.on('error', () => this.drop(conn.peer));
  },

  onData(conn, msg) {
    const p = this.peers.get(conn.peer);
    if (!p) return;
    if (!p.allow()) return;                       // flood
    if (!Validate.size(msg)) return;              // oversized
    const inp = Validate.input(msg);
    if (!inp) return;                             // malformed / unknown type
    if (inp.seq <= p.lastSeq) return;             // stale or replayed

    // Expand the coalesced run back into individual ticks.
    for (let i = 0; i < inp.count; i++) {
      p.queue.push({ seq: inp.seq + i, mask: inp.mask });
    }
    p.lastSeq = inp.seq + inp.count - 1;
    if (p.queue.length > CFG.MAX_QUEUED_INPUTS) {
      p.queue.splice(0, p.queue.length - CFG.MAX_QUEUED_INPUTS);
    }
  },

  drop(peerId) {
    const slot = this.slots.get(peerId);
    if (slot !== undefined) {
      const ent = this.nw.players.get(slot);
      if (ent) this.rs.forget(ent);
      this.nw.removePlayer(slot);
      this.usedSlots.delete(slot);
      this.slots.delete(peerId);
    }
    this.peers.delete(peerId);
    this.report();
  },

  report() {
    this.onStatus(`Hosting — ${Math.max(0, this.peers.size - 1)} client(s) connected.`);
  },

  step() {
    const masks = this.nw._maskScratch;
    masks.clear();
    for (const [peerId, p] of this.peers) {
      const slot = this.slots.get(peerId);
      if (slot === undefined) continue;
      if (peerId === this.selfId) {
        masks.set(slot, stateToMask(this.input.getState()));
      } else if (p.queue.length) {
        const inp = p.queue.shift();
        p.lastMask = inp.mask; p.ackSeq = inp.seq;
        masks.set(slot, inp.mask);
      } else {
        masks.set(slot, p.lastMask);              // underrun: hold last input
      }
    }
    this.nw.setInputs(masks);
    this.rs.capturePrev(this.nw.world);
    this.nw.step(SIM_DT);
    this.rs.captureCurr(this.nw.world);
    this.tick++;
  },

  broadcast() {
    const snap = Codec.encode(this.nw, this.tick);
    for (const p of this.peers.values()) {
      if (!p.conn || !p.conn.open) continue;
      try {
        p.conn.send({ type: 's', t: snap.t, p: snap.p, b: snap.b, m: snap.m, a: p.ackSeq | 0 });
      } catch {}
    }
  },

  update(now) {
    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > CFG.MAX_CATCHUP_MS) delta = CFG.MAX_CATCHUP_MS;
    this.acc += delta;

    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= SIM_MS && steps < CFG.MAX_STEPS_FRAME) {
      this.step(); this.acc -= SIM_MS; steps++;
    }
    // Hitting the cap means the device can't keep up; shed the backlog
    // rather than accumulating debt that makes the next frame worse.
    if (steps >= CFG.MAX_STEPS_FRAME) this.acc = 0;
    this.stats.stepsFrame = steps;
    this.stats.simMs = performance.now() - t0;

    this.snapAcc += delta;
    if (this.snapAcc >= SNAP_MS) { this.snapAcc %= SNAP_MS; this.broadcast(); }
    this.rs.decay();
  },

  world() { return this.nw.world; },
  alpha() { return this.acc / SIM_MS; },
  renderList() { return this.rs.sample(this.nw.world, this.alpha()); },
};

/* ===========================================================================
   CLIENT
   =========================================================================== */
const Client = {
  nw: null, rs: null, history: null, conn: null, mySlot: -1,
  pending: [], seq: 0, acc: 0, lastTime: 0,
  _sendMask: -1, _sendStart: 0, _sendCount: 0,
  _before: new Map(),
  stats: { gap: 0, lastRecv: 0, replays: 0, rollbacks: 0, accepted: 0,
           simMs: 0, replayMs: 0, budgetHits: 0 },

  start(conn, input, onStatus) {
    this.nw = new NetWorld();
    this.rs = new RenderState();
    this.history = new PredictionHistory(CFG.MAX_PENDING);
    this.conn = conn;
    this.input = input;
    this.onStatus = onStatus || function () {};
    this.rs.capturePrev(this.nw.world);
    this.rs.captureCurr(this.nw.world);
    this.lastTime = performance.now();
  },

  onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'full') { this.onStatus('Room is full.'); return; }

    if (msg.type === 'welcome') {
      if (!Number.isInteger(msg.slot) || msg.slot < 0 || msg.slot >= CFG.MAX_PLAYERS) return;
      this.mySlot = msg.slot;
      this.nw.addPlayer(msg.slot);
      return;
    }

    if (msg.type !== 's') return;
    const snap = Codec.decode(msg);
    if (!snap) return;                            // malformed: ignore entirely

    const now = performance.now();
    this.stats.gap = this.stats.lastRecv ? now - this.stats.lastRecv : 0;
    this.stats.lastRecv = now;

    this.reconcile(snap, msg.a);
  },

  /**
   * Drop acked inputs, then roll back ONLY if we actually mispredicted.
   *
   * On a stable connection the prediction is usually right, and re-simulating
   * a world we already have is pure waste — the check costs a handful of
   * comparisons and skips ~100 World.step() calls per second when it passes.
   * That is the difference between comfortable and dropping frames on a phone.
   */
  reconcile(snap, ackSeq) {
    // Was the prediction we made at the tick the host is reporting correct?
    // Compare against the recorded past state, not our current state — we
    // run ahead of the host on purpose, so "current" never matches.
    const past = Number.isInteger(ackSeq) ? this.history.find(ackSeq) : null;
    const predictedWell = Codec.matchesHistory(past, snap);

    if (Number.isInteger(ackSeq)) {
      let i = 0;
      while (i < this.pending.length && this.pending[i].seq <= ackSeq) i++;
      if (i) this.pending.splice(0, i);
      this.history.dropThrough(ackSeq);
    }

    if (predictedWell) {
      // Prediction held. Adopt remote players' replicated input masks so the
      // next predicted tick uses fresh input, then skip the rollback — this
      // is where the CPU saving comes from.
      for (let i = 0; i < snap.players.length; i++) {
        const rec = snap.players[i];
        if (rec.id === this.mySlot) continue;
        const p = this.nw.players.get(rec.id);
        if (p) p._inputMask = rec._inputMask | 0;
      }
      this.stats.accepted++;
      this.stats.replays = this.pending.length;
      return;
    }

    const t0 = performance.now();

    this._before.clear();
    const ents = this.nw.world.entities;
    for (let i = 0; i < ents.length; i++) {
      this._before.set(ents[i], { x: ents[i].x, y: ents[i].y });
    }

    Codec.apply(this.nw, snap, this.rs);

    if (this.pending.length > CFG.MAX_REPLAY_TICKS) {
      this.pending.splice(0, this.pending.length - CFG.MAX_REPLAY_TICKS);
    }

    // Time-budgeted replay. If the device can't finish, stop early and accept
    // a slightly stale local state rather than blowing the frame — the next
    // snapshot corrects it anyway. Degrading accuracy beats degrading
    // framerate: a dropped frame is far more visible than a few px of
    // position error that then gets smoothed out.
    // History before this point is now wrong (it described the mispredicted
    // timeline), so it is rebuilt as we replay.
    this.history.clear();

    let replayed = 0;
    for (let i = 0; i < this.pending.length; i++) {
      this.nw.setLocalInput(this.mySlot, this.pending[i].mask);
      this.rs.capturePrev(this.nw.world);
      this.nw.step(SIM_DT);
      this.rs.captureCurr(this.nw.world);
      this.history.record(this.nw, this.pending[i].seq);
      replayed++;
      if (performance.now() - t0 > CFG.REPLAY_BUDGET_MS) {
        this.stats.budgetHits++;
        break;
      }
    }

    this.rs.applyCorrection(this._before);
    this.stats.replays = replayed;
    this.stats.rollbacks++;
    this.stats.replayMs = performance.now() - t0;
  },

  /**
   * Coalesced input send. The mask changes rarely (you hold right for
   * hundreds of ms), so instead of 60 messages/sec we send one when the mask
   * changes or every INPUT_KEEPALIVE ticks, carrying a repeat count. Roughly
   * 6x fewer radio wakeups on mobile with no loss of fidelity: the host
   * expands the run back into individual ticks.
   */
  _queueSend(mask, seq) {
    if (mask !== this._sendMask || this._sendCount >= CFG.MAX_RUN) {
      this._flushSend();
      this._sendMask = mask; this._sendStart = seq; this._sendCount = 1;
    } else {
      this._sendCount++;
    }
    if (this._sendCount >= CFG.INPUT_KEEPALIVE) this._flushSend();
  },

  _flushSend() {
    if (this._sendCount <= 0) { this._sendCount = 0; return; }
    if (this.conn && this.conn.open) {
      try {
        this.conn.send({ type: 'i', s: this._sendStart, m: this._sendMask, n: this._sendCount });
      } catch {}
    }
    this._sendMask = -1; this._sendCount = 0;
  },

  update(now) {
    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > CFG.MAX_CATCHUP_MS) delta = CFG.MAX_CATCHUP_MS;
    this.acc += delta;

    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= SIM_MS && steps < CFG.MAX_STEPS_FRAME) {
      this.acc -= SIM_MS; steps++;
      if (this.mySlot < 0 || !this.conn || !this.conn.open) continue;

      const mask = stateToMask(this.input.getState());
      const seq = ++this.seq;

      this.nw.setLocalInput(this.mySlot, mask);
      this.rs.capturePrev(this.nw.world);
      this.nw.step(SIM_DT);
      this.rs.captureCurr(this.nw.world);

      this.pending.push({ seq, mask });
      if (this.pending.length > CFG.MAX_PENDING) this.pending.shift();
      // Record what we just predicted, so a later snapshot can be judged
      // against it instead of against our (further-ahead) present state.
      this.history.record(this.nw, seq);

      this._queueSend(mask, seq);
    }
    if (steps >= CFG.MAX_STEPS_FRAME) this.acc = 0;
    this.stats.simMs = performance.now() - t0;

    // Never let input sit longer than a frame, even mid-run.
    if (this._sendCount > 0) this._flushSend();

    this.rs.decay();
  },

  world() { return this.nw.world; },
  alpha() { return this.acc / SIM_MS; },
  renderList() { return this.rs.sample(this.nw.world, this.alpha()); },
};

/* ===========================================================================
   PUBLIC API
   =========================================================================== */
window.Netcode = {
  CFG, BTN, INPUT_MASK, SCHEMA, P_FLAG, B_FLAG,
  Codec, Validate, NetWorld, RenderState, PredictionHistory, Host, Client,
  stateToMask, maskToState, PALETTE,
};

})();