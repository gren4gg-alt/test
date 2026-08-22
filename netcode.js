/* ==========================================================================
   netcode.js — lightweight host-authoritative networking
   --------------------------------------------------------------------------
   Depends on: engine.js (window.Engine), input.js (window.InputManager),
               level.js  (window.Level),   peerjs (CDN)

   DESIGN GOAL: smooth on a phone, including phone-hosting-phone.
   Correctness is traded away wherever it buys smoothness, because a few px
   of position error is invisible and a dropped frame is not.

   WHAT CHANGED FROM THE ROLLBACK VERSION, AND WHY
     The old design had clients re-simulate the entire world to correct
     mispredictions. That meant BOTH ends ran full physics — the host for
     everyone, and every client again during rollback. Two phones in a room
     paid that twice, which is exactly why mobile-to-mobile was the worst
     case while desktop-to-desktop hid it in spare CPU.

     Now only the host simulates the world. A client simulates exactly ONE
     dynamic body: its own player. Everything else — boxes, platforms, other
     players — is positioned by interpolating between snapshots, which is
     arithmetic, not physics. No rollback, no replay, no prediction history,
     no determinism requirement between peers.

   WHAT THAT COSTS
     A client's own player can drift from the host's view (it predicts
     against interpolated, slightly-stale surroundings). We don't re-simulate
     to fix it; we ease it toward authority a fraction each snapshot. Drift
     is small and self-correcting, and easing is invisible where a rollback
     pop is not.

   RESPONSIVENESS
     Your own player still responds instantly — it is simulated locally the
     moment you press a key. Only other players and objects lag by the
     interpolation delay, which is the standard trade and is not something a
     player can perceive on someone else's character.

   HOST LIFECYCLE
     The host IS the server. When it leaves, the session is over: it sends an
     explicit farewell, and clients also treat a snapshot silence longer than
     HOST_TIMEOUT_MS as the session ending. No host migration.
   ========================================================================== */
(function () {
"use strict";

const { World, Player, Box, MovingPlatform } = window.Engine;

/* ===========================================================================
   CONFIG
   =========================================================================== */
const CFG = {
  SIM_HZ:           60,     // up from 45 — you confirmed no lag, so spend the headroom on precision
  SNAPSHOT_HZ:      60,     // stays pinned to SIM_HZ

  MAX_PLAYERS:      8,

  MAX_CATCHUP_MS:   200,
  MAX_STEPS_FRAME:  4,

  INTERP_DELAY_MIN: 34,     // ~2 snapshot intervals at 60Hz (was 44 at 45Hz)
  INTERP_DELAY_MAX: 200,    // slightly tighter ceiling now the floor is lower
  INTERP_DELAY_START: 45,
  JITTER_EWMA:      0.12,
  JITTER_MARGIN:    3.0,
  SNAP_BUFFER:      28,     // a bit more headroom since snapshots arrive more often

  TELEPORT_DIST:    140,

  HOST_TIMEOUT_MS:  2500,
  INPUT_KEEPALIVE_MS: 80,   // was 100 — matches the faster tick, held-key latency shaves a touch

  MAX_MSG_BYTES:    2048,
  MAX_MSG_PER_SEC:  110,    // was 90 — 60Hz keepalive traffic needs a bit more headroom
};
const SIM_DT  = 1 / CFG.SIM_HZ;
const SIM_MS  = 1000 / CFG.SIM_HZ;
// SNAPSHOT_HZ is pinned to SIM_HZ (see CFG comment) — the host broadcasts
// once per step, so there is no separate snapshot interval to track.

const PALETTE = ['#4bd07a','#e06c75','#61afef','#e5c07b','#c678dd','#56b6c2','#d19a66','#f28fd0'];

/* ===========================================================================
   INPUT — input.js emits {left,right,jump,action} -> 4 bits.
   Anything outside those bits is dropped by the validator, so a client
   cannot smuggle extra fields into the host's simulation.
   =========================================================================== */
const BTN = { LEFT: 1, RIGHT: 2, JUMP: 4, ACTION: 8 };
const INPUT_MASK = 15;

function stateToMask(s) {
  return (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.jump ? 4 : 0) | (s.action ? 8 : 0);
}
const _scratch = { left: false, right: false, jump: false, action: false };
function maskToState(m) {
  _scratch.left = !!(m & 1); _scratch.right = !!(m & 2);
  _scratch.jump = !!(m & 4); _scratch.action = !!(m & 8);
  return _scratch;
}

/* ===========================================================================
   WIRE FORMAT
   ---------------------------------------------------------------------------
   Flat int arrays, fixed-point. Static geometry is never sent — both sides
   build it from level.js, and it never moves.

     players:   [slot, x*8, y*8, facing, flags] ...
     boxes:     [x*8, y*8, flags] ...        (index order == netId order)
     platforms: [x*8, y*8] ...               (index order == netId order)

   1/8 px is far below anything visible and keeps the ints small. Clients no
   longer re-simulate from these numbers, so quantization can't accumulate —
   it's display data, not simulation input.
   =========================================================================== */
const P_FLAG = { GROUNDED: 1, CARRYING: 2 };
const B_FLAG = { CARRIED: 1 };
const Q = 8;

const Codec = {
  encode(nw, tick) {
    const p = [], b = [], m = [];
    for (const [slot, e] of nw.players) {
      p.push(slot, Math.round(e.x * Q), Math.round(e.y * Q), e.facing > 0 ? 1 : -1,
             (e.grounded ? P_FLAG.GROUNDED : 0) | (e.carrying ? P_FLAG.CARRYING : 0));
    }
    for (let i = 0; i < nw.boxes.length; i++) {
      const box = nw.boxes[i];
      b.push(Math.round(box.x * Q), Math.round(box.y * Q), box.carried ? B_FLAG.CARRIED : 0);
    }
    for (let i = 0; i < nw.platforms.length; i++) {
      const pl = nw.platforms[i];
      m.push(Math.round(pl.x * Q), Math.round(pl.y * Q));
    }
    return { t: tick, p, b, m };
  },

  /** Strict. Returns null on any malformation — never partial state. */
  decode(msg) {
    if (!msg || !Array.isArray(msg.p) || !Array.isArray(msg.b) || !Array.isArray(msg.m)) return null;
    if (msg.p.length % 5 || msg.b.length % 3 || msg.m.length % 2) return null;
    if (msg.p.length / 5 > CFG.MAX_PLAYERS) return null;

    const num = v => typeof v === 'number' && Number.isFinite(v);

    const players = [];
    for (let i = 0; i < msg.p.length; i += 5) {
      const slot = msg.p[i];
      if (!Number.isInteger(slot) || slot < 0 || slot >= CFG.MAX_PLAYERS) return null;
      for (let k = 1; k < 5; k++) if (!num(msg.p[i + k])) return null;
      players.push({
        slot, x: msg.p[i + 1] / Q, y: msg.p[i + 2] / Q,
        facing: msg.p[i + 3] >= 0 ? 1 : -1, flags: msg.p[i + 4] | 0,
      });
    }

    const boxes = [];
    for (let i = 0; i < msg.b.length; i += 3) {
      for (let k = 0; k < 3; k++) if (!num(msg.b[i + k])) return null;
      boxes.push({ x: msg.b[i] / Q, y: msg.b[i + 1] / Q, flags: msg.b[i + 2] | 0 });
    }

    const platforms = [];
    for (let i = 0; i < msg.m.length; i += 2) {
      for (let k = 0; k < 2; k++) if (!num(msg.m[i + k])) return null;
      platforms.push({ x: msg.m[i] / Q, y: msg.m[i + 1] / Q });
    }

    return { tick: msg.t, players, boxes, platforms };
  },
};

/* ===========================================================================
   VALIDATION — host trusts nothing off the wire
   =========================================================================== */
const Validate = {
  size(msg) {
    try { return JSON.stringify(msg).length <= CFG.MAX_MSG_BYTES; }
    catch { return false; }
  },
  input(msg) {
    if (!msg || msg.type !== 'i') return null;
    const s = msg.s, m = msg.m;
    if (!Number.isInteger(s) || s < 0 || s > 2 ** 31) return null;
    if (!Number.isInteger(m) || m < 0 || m > INPUT_MASK) return null;
    return { seq: s, mask: m };            // extra fields discarded
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
   WORLD BUILD — shared by host and client
   Both build the same level; only the host ever steps the full thing.
   =========================================================================== */
function buildWorld() {
  const nw = {
    world: new World(),
    players: new Map(),
    boxes: [],
    platforms: [],
  };
  window.Level.build(nw.world, nw);
  return nw;
}

function makePlayer(nw, slot) {
  if (nw.players.has(slot)) return nw.players.get(slot);
  const sp = window.Level.spawnPoint(slot);
  const p = new Player(sp.x, sp.y);
  p.color = PALETTE[slot % PALETTE.length];
  p._slot = slot;
  p._mask = 0;
  nw.world.add(p);
  nw.players.set(slot, p);
  return p;
}

function dropPlayer(nw, slot) {
  const p = nw.players.get(slot);
  if (!p) return;
  if (p.carrying) { p.carrying.carried = false; p.carrying.carriedBy = null; p.carrying = null; }
  nw.world.remove(p);
  nw.players.delete(slot);
}

/* ===========================================================================
   SMOOTH RENDER SAMPLING (host side)
   ---------------------------------------------------------------------------
   The sim runs in fixed 22ms chunks; the display refreshes on its own
   schedule. Drawing raw physics positions makes a 120Hz screen show some
   states twice and a 45fps screen skip others — visible stutter even with a
   perfect connection. So we keep the previous and current sim state and let
   the renderer blend between them.
   =========================================================================== */
/* ===========================================================================
   JITTER TRACKER
   ---------------------------------------------------------------------------
   A fixed interpolation delay is a guess about network conditions that
   quickly stops matching reality — too short and the client keeps running
   out of buffered snapshots (visible as micro-freezes while it holds the
   last position), too long and every remote entity lags more than the
   connection actually requires.

   This tracks the mean and variability of the gap between arriving
   snapshots using exponential moving averages (cheap, O(1) per sample, no
   history array to scan), and derives a delay that sits comfortably above
   what jitter is actually being observed. It only ever grows or shrinks
   gradually, so the render timeline never jumps.
   =========================================================================== */
class JitterTracker {
  constructor() {
    this.meanGap = 1000 / CFG.SNAPSHOT_HZ;
    this.meanDev = 0;                 // mean absolute deviation from meanGap
    this.delay = CFG.INTERP_DELAY_START;
    this._lastAt = 0;
  }

  sample(recvAt) {
    if (this._lastAt) {
      const gap = recvAt - this._lastAt;
      const a = CFG.JITTER_EWMA;
      this.meanGap += (gap - this.meanGap) * a;
      this.meanDev += (Math.abs(gap - this.meanGap) - this.meanDev) * a;
      const target = this.meanGap * 2 + this.meanDev * CFG.JITTER_MARGIN;
      const clamped = Math.max(CFG.INTERP_DELAY_MIN, Math.min(CFG.INTERP_DELAY_MAX, target));
      // Ease toward the new target rather than jumping — a sudden delay
      // change is itself a visible hitch, which defeats the point.
      this.delay += (clamped - this.delay) * 0.15;
    }
    this._lastAt = recvAt;
  }
}

class Tween {
  constructor() { this.prev = new Map(); this.curr = new Map(); this._out = []; }
  before(world) {
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      let p = this.prev.get(e); if (!p) { p = { x: 0, y: 0 }; this.prev.set(e, p); }
      const c = this.curr.get(e);
      p.x = c ? c.x : e.x; p.y = c ? c.y : e.y;
    }
  }
  after(world) {
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      let c = this.curr.get(e); if (!c) { c = { x: 0, y: 0 }; this.curr.set(e, c); }
      c.x = e.x; c.y = e.y;
    }
  }
  forget(e) { this.prev.delete(e); this.curr.delete(e); }
  sample(world, alpha) {
    const out = this._out; out.length = 0;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const ents = world.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const p = this.prev.get(e), c = this.curr.get(e);
      out.push(p && c
        ? { entity: e, x: p.x + (c.x - p.x) * a, y: p.y + (c.y - p.y) * a }
        : { entity: e, x: e.x, y: e.y });
    }
    return out;
  }
}

/* ===========================================================================
   HOST
   =========================================================================== */
const Host = {
  nw: null, tw: null, peers: new Map(), slots: new Map(), used: new Set(),
  tick: 0, acc: 0, snapAcc: 0, last: 0, mySlot: -1, selfId: null, alive: true,
  started: false,
  stats: { steps: 0, simMs: 0 },

  /**
   * Open the room for connections while the host is still on the lobby
   * screen. Players can join and get a slot, but nothing simulates or
   * broadcasts yet — that only begins once the host presses Start (see
   * start() below). This is what makes "host presses Start" the actual
   * gate on entering the room, not just a UI delay.
   */
  prepare(peer, onStatus) {
    this.nw = buildWorld();
    this.tw = new Tween();
    this.onStatus = onStatus || function () {};
    this.selfId = peer.id;
    this.alive = true;
    this.started = false;
    this.mySlot = this.claim(peer.id);
    makePlayer(this.nw, this.mySlot);
    this.peers.set(peer.id, { conn: null, mask: 0, lastSeq: 0, allow: () => true });
    this.tw.before(this.nw.world); this.tw.after(this.nw.world);
    peer.on('connection', c => this.onConn(c));

    this._bye = () => this.shutdown();
    window.addEventListener('pagehide', this._bye);
    window.addEventListener('beforeunload', this._bye);
  },

  /** Begin simulating and broadcasting. Only called once, on Start. */
  start(peer, input, onStatus, onEnd) {
    this.input = input;
    if (onStatus) this.onStatus = onStatus;
    this.onEnd = onEnd || function () {};
    this.started = true;
    this.last = performance.now();
    // Anyone who connected during the lobby wait gets their welcome now.
    for (const [peerId, p] of this.peers) {
      if (p.conn && p.conn.open) {
        const slot = this.slots.get(peerId);
        try { p.conn.send({ type: 'welcome', slot, simHz: CFG.SIM_HZ }); } catch {}
      }
    }
    this.report();
  },

  claim(id) {
    for (let s = 0; s < CFG.MAX_PLAYERS; s++) {
      if (!this.used.has(s)) { this.used.add(s); this.slots.set(id, s); return s; }
    }
    return -1;
  },

  onConn(conn) {
    if (!this.alive || this.peers.size >= CFG.MAX_PLAYERS) {
      conn.on('open', () => { try { conn.send({ type: 'full' }); } catch {} conn.close(); });
      return;
    }
    conn.on('open', () => {
      if (this.peers.has(conn.peer)) { conn.close(); return; }
      const slot = this.claim(conn.peer);
      if (slot < 0) { conn.close(); return; }
      makePlayer(this.nw, slot);
      this.peers.set(conn.peer, {
        conn, mask: 0, lastSeq: 0, allow: rateLimiter(CFG.MAX_MSG_PER_SEC),
      });
      // Reserve their slot and let them know they're queued, but withhold
      // 'welcome' until the host actually presses Start — that message is
      // what lets a client enter the room, so gating it here is the real
      // enforcement point, not just a UI-level delay.
      if (this.started) {
        try { conn.send({ type: 'welcome', slot, simHz: CFG.SIM_HZ }); } catch {}
      } else {
        try { conn.send({ type: 'queued' }); } catch {}
      }
      this.report();
    });
    conn.on('data', msg => this.onData(conn, msg));
    conn.on('close', () => this.drop(conn.peer));
    conn.on('error', () => this.drop(conn.peer));
  },

  onData(conn, msg) {
    const p = this.peers.get(conn.peer);
    if (!p) return;
    if (!p.allow()) return;                  // flood
    if (!Validate.size(msg)) return;         // oversized
    const inp = Validate.input(msg);
    if (!inp) return;                        // malformed
    if (inp.seq <= p.lastSeq) return;        // stale / replayed / out of order
    p.lastSeq = inp.seq;
    p.mask = inp.mask;                       // latest input wins; no queue
  },

  drop(peerId) {
    const slot = this.slots.get(peerId);
    if (slot !== undefined) {
      const e = this.nw.players.get(slot);
      if (e) this.tw.forget(e);
      dropPlayer(this.nw, slot);
      this.used.delete(slot);
      this.slots.delete(peerId);
    }
    this.peers.delete(peerId);
    this.report();
  },

  report() {
    const n = Math.max(0, this.peers.size - 1);
    this.onStatus(this.started
      ? `Hosting — ${n} player(s) in game.`
      : `Room open — ${n} player(s) waiting. Press Start when ready.`);
  },

  /** End the session for everyone. */
  shutdown() {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.peers.values()) {
      if (p.conn && p.conn.open) { try { p.conn.send({ type: 'bye' }); } catch {} }
    }
    window.removeEventListener('pagehide', this._bye);
    window.removeEventListener('beforeunload', this._bye);
    this.onEnd('You ended the session.');
  },

  step() {
    for (const [peerId, p] of this.peers) {
      const slot = this.slots.get(peerId);
      if (slot === undefined) continue;
      const e = this.nw.players.get(slot);
      if (e) e._mask = (peerId === this.selfId) ? stateToMask(this.input.getState()) : p.mask;
    }
    for (const e of this.nw.players.values()) {
      const st = maskToState(e._mask);
      e.handleInput(st, SIM_DT);
      this.nw.world.updateCarrying(e, st);
    }
    this.nw.world.step(SIM_DT);
    this.tick++;
  },

  broadcast() {
    const s = Codec.encode(this.nw, this.tick);
    for (const p of this.peers.values()) {
      if (!p.conn || !p.conn.open) continue;
      try { p.conn.send({ type: 's', t: s.t, p: s.p, b: s.b, m: s.m }); } catch {}
    }
  },

  update(now) {
    if (!this.alive || !this.started) return;
    let d = now - this.last; this.last = now;
    if (d > CFG.MAX_CATCHUP_MS) d = CFG.MAX_CATCHUP_MS;
    this.acc += d;

    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= SIM_MS && steps < CFG.MAX_STEPS_FRAME) {
      this.tw.before(this.nw.world);
      this.step();
      this.tw.after(this.nw.world);
      this.acc -= SIM_MS; steps++;
      // SNAPSHOT_HZ == SIM_HZ: every tick the host computes goes straight
      // out. There's no separate broadcast accumulator to fall out of sync
      // with the sim one, and no reason to hold a tick back.
      this.broadcast();
    }
    // Can't keep up: shed the backlog instead of compounding debt.
    if (steps >= CFG.MAX_STEPS_FRAME) this.acc = 0;
    this.stats.steps = steps;
    this.stats.simMs = performance.now() - t0;
  },

  world() { return this.nw.world; },
  renderList() { return this.tw.sample(this.nw.world, this.acc / SIM_MS); },
};

/* ===========================================================================
   CLIENT
   ---------------------------------------------------------------------------
   No client-side simulation at all — not even of the local player. Every
   entity, including your own, is positioned purely by interpolating between
   two real snapshots from the host. There is no prediction, no rollback, no
   correction/easing, and nothing here needs to know how engine.js physics
   actually works.

   TRADE-OFF, STATED PLAINLY
   Your own input now has full round-trip latency before you see it move —
   press a key, it goes to the host, the host simulates it, a snapshot comes
   back, and only then does your square move. There is no local prediction
   masking that gap. What compensates is snapshot rate: the host broadcasts
   every tick it computes (SNAPSHOT_HZ == SIM_HZ, see CFG above), so the gap
   is one round trip, not one round trip plus a coarse update interval.

   WHY THIS IS SIMPLER, NOT JUST DIFFERENT
   No PredictionHistory, no mispredict-gate, no replay budget, no easing
   constants, no "what if the client's physics disagrees with the host's"
   category of bug at all, because the client no longer HAS physics. The
   only moving part left is picking two snapshots and lerping.
   =========================================================================== */
const Client = {
  nw: null, conn: null, mySlot: -1,
  buf: [], seq: 0, last: 0, alive: false,
  jitter: null, _lastTick: -1,
  _sentMask: -1, _sentAt: 0,
  _out: [],
  stats: { gap: 0, lastRecv: 0, snaps: 0, teleports: 0, outOfOrder: 0 },

  start(conn, input, onStatus, onEnd) {
    this.nw = buildWorld();
    this.conn = conn;
    this.input = input;
    this.onStatus = onStatus || function () {};
    this.onEnd = onEnd || function () {};
    this.buf = [];
    this.seq = 0;
    this._sentMask = -1; this._sentAt = 0;
    this.alive = true;
    this.last = performance.now();
    this.jitter = new JitterTracker();
    this._lastTick = -1;      // guards against an out-of-order (stale) snapshot

    // Nothing on the client simulates, so nothing needs to be dynamic —
    // every entity here is a positioned prop, not a physics body.
    for (const b of this.nw.boxes) { b.dynamic = false; b.pushable = false; }
  },

  onData(msg) {
    if (!msg || typeof msg !== 'object' || !this.alive) return;

    if (msg.type === 'full') { this.end('Room is full.'); return; }
    if (msg.type === 'bye')  { this.end('Host ended the session.'); return; }

    if (msg.type === 'welcome') {
      if (!Number.isInteger(msg.slot) || msg.slot < 0 || msg.slot >= CFG.MAX_PLAYERS) return;
      this.mySlot = msg.slot;
      makePlayer(this.nw, msg.slot).dynamic = false;
      return;
    }

    if (msg.type !== 's') return;
    const snap = Codec.decode(msg);
    if (!snap) return;

    // The connection is unreliable+unordered, so a delayed packet can
    // arrive after a newer one already has. Using it would rubber-band the
    // world backward for one frame, so anything at or behind the last
    // accepted tick is dropped — not buffered, not blended, just discarded.
    if (snap.tick <= this._lastTick) { this.stats.outOfOrder++; return; }
    this._lastTick = snap.tick;

    const now = performance.now();
    this.stats.gap = this.stats.lastRecv ? now - this.stats.lastRecv : 0;
    this.stats.lastRecv = now;
    this.stats.snaps++;
    this.jitter.sample(now);

    // Timeline uses LOCAL receive time — the two machines' clocks are not
    // synchronized and never will be.
    snap.recvAt = now;
    this.buf.push(snap);
    if (this.buf.length > CFG.SNAP_BUFFER) this.buf.shift();
  },

  end(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.onEnd(reason);
  },

  /** Find the two snapshots bracketing render time. */
  interpolate() {
    const buf = this.buf;
    if (!buf.length) return null;
    const at = performance.now() - this.jitter.delay;

    let older = buf[0], newer = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].recvAt <= at) { older = buf[i]; newer = buf[i + 1] || null; break; }
    }
    if (!newer && buf.length > 1 && older === buf[0]) newer = buf[1];

    const t = (newer && newer.recvAt > older.recvAt)
      ? Math.max(0, Math.min(1, (at - older.recvAt) / (newer.recvAt - older.recvAt)))
      : 0;                                  // hold; never extrapolate
    return { older, newer, t };
  },

  /**
   * Position every entity — including our own player — purely from the
   * bracketing snapshots. A per-pair distance check catches teleports
   * (respawn, level transition): interpolating across the whole level in
   * one frame would look like a slide, so a jump past TELEPORT_DIST snaps
   * straight to the newer value instead of blending toward it.
   */
  applyInterpolated(iv) {
    if (!iv) return;
    const { older, newer, t } = iv;
    const blend = (a, b) => {
      if (!newer) return a;
      if (Math.abs(b - a) > CFG.TELEPORT_DIST) { this.stats.teleports++; return b; }
      return a + (b - a) * t;
    };

    const seen = new Set();
    for (let i = 0; i < older.players.length; i++) {
      const a = older.players[i];
      seen.add(a.slot);
      let b = null;
      if (newer) for (const q of newer.players) if (q.slot === a.slot) { b = q; break; }
      const e = makePlayer(this.nw, a.slot);
      e.dynamic = false;
      e.x = b ? blend(a.x, b.x) : a.x;
      e.y = b ? blend(a.y, b.y) : a.y;
      e.facing = a.facing;
      e.grounded = !!(a.flags & P_FLAG.GROUNDED);
      e._carrying = !!(a.flags & P_FLAG.CARRYING);
    }
    for (const slot of Array.from(this.nw.players.keys())) {
      if (!seen.has(slot)) dropPlayer(this.nw, slot);
    }

    for (let i = 0; i < this.nw.boxes.length && i < older.boxes.length; i++) {
      const box = this.nw.boxes[i], a = older.boxes[i];
      const b = newer && newer.boxes[i];
      box.x = b ? blend(a.x, b.x) : a.x;
      box.y = b ? blend(a.y, b.y) : a.y;
      box.carried = !!(a.flags & B_FLAG.CARRIED);
    }

    for (let i = 0; i < this.nw.platforms.length && i < older.platforms.length; i++) {
      const pl = this.nw.platforms[i], a = older.platforms[i];
      const b = newer && newer.platforms[i];
      pl.x = b ? blend(a.x, b.x) : a.x;
      pl.y = b ? blend(a.y, b.y) : a.y;
    }
  },

  /** Send only on change, or as a keepalive. Cheap on a mobile radio. */
  send(mask, now) {
    if (mask === this._sentMask && now - this._sentAt < CFG.INPUT_KEEPALIVE_MS) return;
    if (!this.conn || !this.conn.open) return;
    this._sentMask = mask; this._sentAt = now;
    try { this.conn.send({ type: 'i', s: ++this.seq, m: mask }); } catch {}
  },

  update(now) {
    if (!this.alive) return;

    // Host gone quiet: end rather than leaving a frozen world on screen.
    if (this.stats.lastRecv && now - this.stats.lastRecv > CFG.HOST_TIMEOUT_MS) {
      this.end('Lost connection to host.');
      return;
    }

    this.applyInterpolated(this.interpolate());

    // Input is sampled every frame and sent independently of any sim
    // step, because there is no client-side sim step anymore — only the
    // host's tick rate matters for how fast an input takes effect.
    if (this.mySlot >= 0) this.send(stateToMask(this.input.getState()), now);

    this.last = now;
  },

  world() { return this.nw.world; },

  /** Draw list. Every entity is already at its interpolated position. */
  renderList() {
    const out = this._out; out.length = 0;
    const ents = this.nw.world.entities;
    for (let i = 0; i < ents.length; i++) out.push({ entity: ents[i], x: ents[i].x, y: ents[i].y });
    return out;
  },
};

window.Netcode = {
  CFG, BTN, INPUT_MASK, P_FLAG, B_FLAG,
  Codec, Validate, Host, Client, Tween, JitterTracker,
  buildWorld, makePlayer, dropPlayer, stateToMask, maskToState, PALETTE,
};

})();
