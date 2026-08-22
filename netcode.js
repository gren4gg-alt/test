/* ==========================================================================
   netcode.js — host-authoritative networking for the co-op platformer
   --------------------------------------------------------------------------
   Depends on: engine.js (window.Engine), input.js (window.InputManager),
               level.js  (window.Level),   peerjs (CDN)

   MODEL
     - One peer is HOST: runs the full authoritative World.step() every
       fixed tick and broadcasts world state at SNAPSHOT_HZ.
     - CLIENTS send only a 4-bit input mask. They never send positions.
     - CLIENTS run the SAME World locally, predicted forward. When a
       snapshot arrives they roll the whole world back to it and re-simulate
       the ticks the host hasn't acked yet.

   WHY FULL-WORLD ROLLBACK (and not "predict only my own player")
     In the toy version each square was independent, so a client could
     predict its own entity and interpolate everyone else. That breaks the
     moment players share physics: you push boxes other players are
     standing on, you ride platforms, you throw boxes at each other. Your
     own predicted position depends on where the boxes are, which depends
     on what other players did. So the client re-simulates the entire
     World, and the host replicates every player's input mask in the
     snapshot so clients have something real to replay remote players with
     (rather than guessing). This is the standard approach — the same one
     Unity's netcode calls "input replication" for predicted ghosts.

   DETERMINISM CONTRACT (what engine.js must keep honouring)
     - World.step(dt) is a pure function of world state + inputs.
     - No Math.random(), no Date.now(), no frame-rate dependence.
     - Entity iteration order is insertion order, identical on both sides,
       which is why level.js must build the world in a fixed order.
     Break any of these and prediction will fight the host forever.
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
  MAX_PENDING:       240,     // ~4s of unacked input retained for replay
  MAX_ROLLBACK:      30,      // hard cap on replay steps per snapshot (CPU guard)
  MAX_CATCHUP_MS:    250,     // clamp on frame delta, prevents death spiral
  SMOOTH:            0.30,    // visual error decay per frame after a correction
  SNAP_DIST:         96,      // divergence above this snaps instead of smoothing
  // --- security ---
  MAX_MSG_BYTES:     4096,
  MAX_MSG_PER_SEC:   180,     // ~3x the expected 60Hz input rate
  MAX_QUEUED_INPUTS: 12,
};
const SIM_DT  = 1 / CFG.SIM_HZ;
const SIM_MS  = 1000 / CFG.SIM_HZ;
const SNAP_MS = 1000 / CFG.SNAPSHOT_HZ;

const PALETTE = ['#4bd07a','#e06c75','#61afef','#e5c07b','#c678dd','#56b6c2','#d19a66','#f28fd0'];

/* ===========================================================================
   INPUT ENCODING
   ---------------------------------------------------------------------------
   input.js emits {left,right,jump,action}. On the wire that's 4 bits.
   Anything outside those 4 bits is discarded by the validator, so a client
   cannot smuggle extra fields into the host's simulation.
   =========================================================================== */
const BTN = { LEFT: 1, RIGHT: 2, JUMP: 4, ACTION: 8 };
const INPUT_MASK = BTN.LEFT | BTN.RIGHT | BTN.JUMP | BTN.ACTION;   // 15

function stateToMask(s) {
  return (s.left ? BTN.LEFT : 0) | (s.right ? BTN.RIGHT : 0) |
         (s.jump ? BTN.JUMP : 0) | (s.action ? BTN.ACTION : 0);
}
// Reused object — this runs 60x/sec per player during replay, no allocation.
const _inputScratch = { left: false, right: false, jump: false, action: false };
function maskToState(m) {
  _inputScratch.left   = !!(m & BTN.LEFT);
  _inputScratch.right  = !!(m & BTN.RIGHT);
  _inputScratch.jump   = !!(m & BTN.JUMP);
  _inputScratch.action = !!(m & BTN.ACTION);
  return _inputScratch;
}

/* ===========================================================================
   REPLICATION SCHEMA
   ---------------------------------------------------------------------------
   Per entity TYPE, not just per player — boxes and platforms are synced too.
   Each field is [name, scale]: the value is sent as Math.round(v * scale),
   so we get fixed-point ints on the wire instead of full float JSON.

   Scale choice matters for prediction, not just bandwidth: quantization is
   a divergence source, because the client replays from the rounded value
   while the host continues from the exact one. Positions at 1/16px and
   velocities at 1/8 px/s are far below the visible-error threshold, and any
   residual drift is corrected on the next snapshot anyway.

   HIDDEN STATE IS REPLICATED TOO. Coyote timer, jump buffer, and the
   previous-frame jump/action held flags are not cosmetic — they're inputs
   to the next step. Omit them and a replayed jump lands one tick off from
   the host's, which is exactly the kind of desync that looks like "jump
   sometimes doesn't work".
   =========================================================================== */
const P_FLAG = { GROUNDED: 1, JUMP_HELD: 2, ACTION_HELD: 4 };
const B_FLAG = { GROUNDED: 1, CARRIED: 2 };

const SCHEMA = {
  // slot is the key; inputMask is the replicated input used for replay.
  player: [
    ['x', 16], ['y', 16], ['vx', 8], ['vy', 8],
    ['facing', 1],
    ['_coyoteTimer', 1000], ['_jumpBufferTimer', 1000],
    ['_flags', 1],        // P_FLAG bits
    ['_carryNet', 1],     // netId of held box, 0 = none
    ['_inputMask', 1],    // replicated input (see file header)
  ],
  box: [
    ['x', 16], ['y', 16], ['vx', 8], ['vy', 8],
    ['_flags', 1],        // B_FLAG bits
    ['_carrierSlot', 1],  // slot of holder + 1, 0 = none
  ],
  platform: [
    ['x', 16], ['y', 16],
    ['_segIndex', 1], ['_dir', 1],
  ],
};

// Timers count up forever once consumed; cap them so the encoded int stays
// small. Both thresholds are ~0.1s so anything past a second is equivalent.
const TIMER_CAP = 9.999;

/* ===========================================================================
   NET WORLD — wraps engine.js World with the bookkeeping the net layer needs
   =========================================================================== */
class NetWorld {
  constructor() {
    this.world = new World();
    this.players = new Map();    // slot -> Player
    this.boxes = [];             // netId order, fixed by level
    this.platforms = [];         // netId order, fixed by level
    window.Level.build(this.world, this);   // deterministic construction
    // netIds are assigned by build order, so host and client agree without
    // ever sending an id mapping over the wire.
    this.boxes.forEach((b, i) => { b._netId = i + 1; });
    this.platforms.forEach((p, i) => { p._netId = i + 1; });
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
    // Drop whatever they were holding, or the box is orphaned mid-air.
    if (p.carrying) {
      p.carrying.carried = false;
      p.carrying.carriedBy = null;
      p.carrying = null;
    }
    this.world.remove(p);
    this.players.delete(slot);
  }

  boxByNet(netId) { return netId > 0 ? this.boxes[netId - 1] || null : null; }

  /**
   * One fixed step for the whole world.
   * Order matters and mirrors engine.js's documented contract:
   *   handleInput  -> sets vx / jump velocity for this frame
   *   updateCarrying -> a throw reads the player's CURRENT vx, so it must
   *                     run after handleInput for a running throw to inherit
   *                     running speed (engine.js documents the arc as
   *                     matching the player's own jump, scaled by vx)
   *   world.step   -> gravity, platforms, collision
   */
  step(dt) {
    for (const p of this.players.values()) {
      const state = maskToState(p._inputMask);
      p.handleInput(state, dt);
      this.world.updateCarrying(p, state);
    }
    this.world.step(dt);
  }

  setInputs(masksBySlot) {
    for (const [slot, mask] of masksBySlot) {
      const p = this.players.get(slot);
      if (p) p._inputMask = mask;
    }
  }
}

/* ===========================================================================
   CODEC — schema-driven, so adding a field is a one-line change
   =========================================================================== */
const Codec = {
  _packPlayer(p) {
    p._flags = (p.grounded ? P_FLAG.GROUNDED : 0) |
               (p._wasJumpHeld ? P_FLAG.JUMP_HELD : 0) |
               (p._wasActionHeld ? P_FLAG.ACTION_HELD : 0);
    p._carryNet = p.carrying ? p.carrying._netId : 0;
    p._coyoteTimer = Math.min(p._coyoteTimer, TIMER_CAP);
    p._jumpBufferTimer = Math.min(p._jumpBufferTimer, TIMER_CAP);
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
      for (const [f, s] of SCHEMA.player) p.push(Math.round(ent[f] * s));
    }
    for (const box of nw.boxes) {
      this._packBox(box);
      b.push(box._netId);
      for (const [f, s] of SCHEMA.box) b.push(Math.round(box[f] * s));
    }
    for (const plat of nw.platforms) {
      m.push(plat._netId);
      for (const [f, s] of SCHEMA.platform) m.push(Math.round(plat[f] * s));
    }
    return { t: tick, p, b, m };
  },

  /** Strict decode. Returns null on ANY malformation — never partial state. */
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

  /** Overwrite a NetWorld with decoded authoritative state. */
  apply(nw, snap) {
    // Players: add/remove so the local roster matches the host's exactly.
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
      p.carrying = null;   // relinked below, once boxes are positioned
    }
    for (const slot of Array.from(nw.players.keys())) {
      if (!seen.has(slot)) nw.removePlayer(slot);
    }

    // Boxes.
    for (const rec of snap.boxes) {
      const box = nw.boxByNet(rec.id);
      if (!box) continue;                        // unknown netId: ignore, don't throw
      box.x = rec.x; box.y = rec.y; box.vx = rec.vx; box.vy = rec.vy;
      const fl = rec._flags | 0;
      box.grounded = !!(fl & B_FLAG.GROUNDED);
      box.carried  = !!(fl & B_FLAG.CARRIED);
      const holder = rec._carrierSlot > 0 ? nw.players.get(rec._carrierSlot - 1) : null;
      box.carriedBy = box.carried ? (holder || null) : null;
      if (box.carriedBy) box.carriedBy.carrying = box;
      if (!box.carried) { box.carried = false; box.carriedBy = null; }
    }

    // Platforms — position AND patrol state. Sending position alone would
    // let a client's platform drift onto the wrong path segment and then
    // reverse at the wrong moment.
    for (const rec of snap.platforms) {
      const plat = nw.platforms[rec.id - 1];
      if (!plat) continue;
      plat.x = rec.x; plat.y = rec.y;
      plat._segIndex = rec._segIndex | 0;
      plat._dir = rec._dir >= 0 ? 1 : -1;
    }

    // groundEntity links aren't replicated (they're object references, and
    // they're recomputed from scratch by moveYWithCollision on the very
    // next step). Clear them so a stale link can't carry a rider wrongly
    // for one frame after a correction.
    for (const e of nw.world.entities) e.groundEntity = null;
  },
};

/* ===========================================================================
   VALIDATION — the host trusts nothing off the wire
   =========================================================================== */
const Validate = {
  size(msg) {
    try { return JSON.stringify(msg).length <= CFG.MAX_MSG_BYTES; }
    catch { return false; }                       // circular/unserializable
  },
  input(msg) {
    if (!msg || msg.type !== 'i') return null;
    const { s, m } = msg;
    if (!Number.isInteger(s) || s < 0 || s > 2 ** 31) return null;
    if (!Number.isInteger(m) || m < 0 || m > INPUT_MASK) return null;
    return { seq: s, mask: m };                   // unknown bits dropped
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
   VISUAL SMOOTHING
   ---------------------------------------------------------------------------
   After a rollback the world can shift by a few px. Rendering that raw
   makes everything twitch. We remember each entity's pre-correction render
   position as an offset and decay it toward zero, so corrections are eased
   out over a few frames instead of snapping. Large corrections (teleports,
   respawns) snap deliberately — sliding across the level looks worse.
   =========================================================================== */
const Smoothing = {
  capture(nw, into) {
    into.clear();
    for (const e of nw.world.entities) into.set(e, { x: e.x, y: e.y });
  },
  diff(nw, before, offsets) {
    for (const e of nw.world.entities) {
      const b = before.get(e);
      if (!b) continue;
      const dx = b.x - e.x, dy = b.y - e.y;
      if (Math.hypot(dx, dy) > CFG.SNAP_DIST) { offsets.delete(e); continue; }
      const cur = offsets.get(e) || { x: 0, y: 0 };
      cur.x += dx; cur.y += dy;
      offsets.set(e, cur);
    }
  },
  decay(offsets) {
    for (const [e, o] of offsets) {
      o.x *= (1 - CFG.SMOOTH); o.y *= (1 - CFG.SMOOTH);
      if (Math.abs(o.x) < 0.05 && Math.abs(o.y) < 0.05) offsets.delete(e);
    }
  },
};

/* ===========================================================================
   HOST
   =========================================================================== */
const Host = {
  nw: null, peers: new Map(), slots: new Map(), usedSlots: new Set(),
  tick: 0, acc: 0, snapAcc: 0, lastTime: 0, mySlot: -1,
  offsets: new Map(),

  start(peer, input, onStatus) {
    this.nw = new NetWorld();
    this.input = input;
    this.onStatus = onStatus;

    this.selfId = peer.id;
    this.mySlot = this.claimSlot(peer.id);
    this.nw.addPlayer(this.mySlot);
    this.peers.set(peer.id, this.selfRecord());

    peer.on('connection', c => this.onConnection(c));
    this.lastTime = performance.now();
  },

  selfRecord() {
    return { conn: null, queue: [], lastMask: 0, lastSeq: 0, ackSeq: 0, allow: () => true };
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
      if (this.peers.has(conn.peer)) { conn.close(); return; }   // duplicate
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
    p.lastSeq = inp.seq;
    p.queue.push(inp);
    if (p.queue.length > CFG.MAX_QUEUED_INPUTS) {
      p.queue.splice(0, p.queue.length - CFG.MAX_QUEUED_INPUTS);
    }
  },

  drop(peerId) {
    const slot = this.slots.get(peerId);
    if (slot !== undefined) {
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
    const masks = new Map();
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
    this.nw.step(SIM_DT);
    this.tick++;
  },

  broadcast() {
    const snap = Codec.encode(this.nw, this.tick);
    for (const p of this.peers.values()) {
      if (!p.conn || !p.conn.open) continue;
      try { p.conn.send({ type: 's', t: snap.t, p: snap.p, b: snap.b, m: snap.m, a: p.ackSeq | 0 }); }
      catch {}
    }
  },

  update(now) {
    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > CFG.MAX_CATCHUP_MS) delta = CFG.MAX_CATCHUP_MS;
    this.acc += delta;
    while (this.acc >= SIM_MS) { this.step(); this.acc -= SIM_MS; }
    this.snapAcc += delta;
    if (this.snapAcc >= SNAP_MS) { this.snapAcc %= SNAP_MS; this.broadcast(); }
  },

  world() { return this.nw.world; },
  renderOffsets() { return this.offsets; },       // always empty on host
};

/* ===========================================================================
   CLIENT
   =========================================================================== */
const Client = {
  nw: null, conn: null, mySlot: -1,
  pending: [], seq: 0, acc: 0, lastTime: 0,
  offsets: new Map(), _before: new Map(),
  stats: { gap: 0, lastRecv: 0, replays: 0, rollbacks: 0 },

  start(conn, input, onStatus) {
    this.nw = new NetWorld();
    this.conn = conn;
    this.input = input;
    this.onStatus = onStatus;
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

    this.rollback(snap, msg.a);
  },

  /**
   * Roll the whole world back to the host's authoritative state, then
   * re-simulate every tick the host hasn't acknowledged yet.
   *
   * Remote players are replayed with their last replicated input mask
   * (which the snapshot carries). That's an assumption — they might have
   * changed input since — but it's a far better one than freezing them,
   * and it's corrected on the next snapshot regardless.
   */
  rollback(snap, ackSeq) {
    Smoothing.capture(this.nw, this._before);

    Codec.apply(this.nw, snap);

    if (Number.isInteger(ackSeq)) {
      let i = 0;
      while (i < this.pending.length && this.pending[i].seq <= ackSeq) i++;
      if (i) this.pending.splice(0, i);
    }

    // CPU guard: if we've fallen catastrophically behind (tab was
    // backgrounded, host stalled), don't try to replay hundreds of ticks —
    // drop the backlog and accept a visible correction instead of freezing
    // the browser.
    if (this.pending.length > CFG.MAX_ROLLBACK) {
      this.pending.splice(0, this.pending.length - CFG.MAX_ROLLBACK);
    }

    const masks = new Map();
    for (const p of this.pending) {
      masks.clear();
      for (const [slot, ent] of this.nw.players) {
        masks.set(slot, slot === this.mySlot ? p.mask : ent._inputMask);
      }
      this.nw.setInputs(masks);
      this.nw.step(SIM_DT);
    }

    this.stats.replays = this.pending.length;
    this.stats.rollbacks++;
    Smoothing.diff(this.nw, this._before, this.offsets);
  },

  update(now) {
    let delta = now - this.lastTime;
    this.lastTime = now;
    if (delta > CFG.MAX_CATCHUP_MS) delta = CFG.MAX_CATCHUP_MS;
    this.acc += delta;

    while (this.acc >= SIM_MS) {
      this.acc -= SIM_MS;
      if (this.mySlot < 0 || !this.conn || !this.conn.open) continue;

      const mask = stateToMask(this.input.getState());
      const seq = ++this.seq;

      // Predict locally: our own input now, everyone else's last known.
      const masks = new Map();
      for (const [slot, ent] of this.nw.players) {
        masks.set(slot, slot === this.mySlot ? mask : ent._inputMask);
      }
      this.nw.setInputs(masks);
      this.nw.step(SIM_DT);

      this.pending.push({ seq, mask });
      if (this.pending.length > CFG.MAX_PENDING) this.pending.shift();

      try { this.conn.send({ type: 'i', s: seq, m: mask }); } catch {}
    }

    Smoothing.decay(this.offsets);
  },

  world() { return this.nw.world; },
  renderOffsets() { return this.offsets; },
};

/* ===========================================================================
   PUBLIC API
   =========================================================================== */
window.Netcode = {
  CFG, BTN, INPUT_MASK, SCHEMA, Codec, Validate, NetWorld, Host, Client,
  stateToMask, maskToState, PALETTE,
};

})();
