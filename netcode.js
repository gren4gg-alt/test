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
/*const CFG = {
  // 45Hz sim: a third less CPU than 60 for physics that is not twitch-precise.
  // Only the host uses this, so it can change without desyncing anyone.
  SIM_HZ:           45,
  SNAPSHOT_HZ:      22,     // every 2nd sim tick
  MAX_PLAYERS:      8,

  MAX_CATCHUP_MS:   200,    // clamp frame delta; no post-stall spiral
  MAX_STEPS_FRAME:  4,      // never let one frame run away

  // Interpolation: render remote things this far behind, so we always have
  // two real snapshots to blend and never have to guess forward.
  INTERP_DELAY_MS:  95,     // ~2 snapshot intervals
  SNAP_BUFFER:      16,

  // Local player correction (no rollback — just ease toward authority)
  PULL:             0.22,   // fraction of positional error corrected per snapshot
  PULL_VEL:         0.30,
  SNAP_DIST:        90,     // beyond this, hard snap (teleport/respawn)

  // Session
  HOST_TIMEOUT_MS:  2500,   // no snapshot this long => host is gone
  INPUT_KEEPALIVE_MS: 100,  // resend held input at least this often

  // Security
  MAX_MSG_BYTES:    2048,
  MAX_MSG_PER_SEC:  90,
};*/
const CFG = {
  // Physics
  SIM_HZ:           50,

  // Network
  SNAPSHOT_HZ:      25,

  // Remote-player interpolation
  INTERP_DELAY_MS:  70,
  SNAP_BUFFER:      8,

  // Local-player correction
  PULL:             0.15,
  PULL_VEL:         0.20,
  SNAP_DIST:        90,

  // Frame protection
  MAX_CATCHUP_MS:   150,
  MAX_STEPS_FRAME:  3,

  // Session
  HOST_TIMEOUT_MS:  2500,
  INPUT_KEEPALIVE_MS: 80,

  // Security
  MAX_MSG_BYTES:    2048,
  MAX_MSG_PER_SEC:  60,

  MAX_PLAYERS:      8,
};
const SIM_DT  = 1 / CFG.SIM_HZ;
const SIM_MS  = 1000 / CFG.SIM_HZ;
const SNAP_MS = 1000 / CFG.SNAPSHOT_HZ;

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
    }
    // Can't keep up: shed the backlog instead of compounding debt.
    if (steps >= CFG.MAX_STEPS_FRAME) this.acc = 0;
    this.stats.steps = steps;
    this.stats.simMs = performance.now() - t0;

    this.snapAcc += d;
    if (this.snapAcc >= SNAP_MS) { this.snapAcc %= SNAP_MS; this.broadcast(); }
  },

  world() { return this.nw.world; },
  renderList() { return this.tw.sample(this.nw.world, this.acc / SIM_MS); },
};

/* ===========================================================================
   CLIENT
   ---------------------------------------------------------------------------
   Simulates exactly one dynamic body: the local player. Everything else is
   positioned by interpolating snapshots, which costs a lerp per entity.
   =========================================================================== */
const Client = {
  nw: null, conn: null, mySlot: -1, me: null,
  buf: [], seq: 0, acc: 0, last: 0, alive: false,
  _sentMask: -1, _sentAt: 0,
  _out: [],
  stats: { gap: 0, lastRecv: 0, simMs: 0, corrections: 0, snaps: 0 },

  start(conn, input, onStatus, onEnd) {
    this.nw = buildWorld();
    this.conn = conn;
    this.input = input;
    this.onStatus = onStatus || function () {};
    this.onEnd = onEnd || function () {};
    this.buf = [];
    this.alive = true;
    this.last = performance.now();

    // Only our own player is dynamic here. Boxes are placed from snapshots
    // instead of being simulated, so they still block and carry us correctly
    // without costing a physics body.
    for (const b of this.nw.boxes) { b.dynamic = false; b.pushable = false; }
  },

  onData(msg) {
    if (!msg || typeof msg !== 'object' || !this.alive) return;

    if (msg.type === 'full') { this.end('Room is full.'); return; }
    if (msg.type === 'bye')  { this.end('Host ended the session.'); return; }

    if (msg.type === 'welcome') {
      if (!Number.isInteger(msg.slot) || msg.slot < 0 || msg.slot >= CFG.MAX_PLAYERS) return;
      this.mySlot = msg.slot;
      this.me = makePlayer(this.nw, msg.slot);
      return;
    }

    if (msg.type !== 's') return;
    const snap = Codec.decode(msg);
    if (!snap) return;

    const now = performance.now();
    this.stats.gap = this.stats.lastRecv ? now - this.stats.lastRecv : 0;
    this.stats.lastRecv = now;
    this.stats.snaps++;

    // Timeline uses LOCAL receive time — the two machines' clocks are not
    // synchronized and never will be.
    snap.recvAt = now;
    this.buf.push(snap);
    if (this.buf.length > CFG.SNAP_BUFFER) this.buf.shift();

    this.correct(snap);
  },

  /**
   * Ease our locally-simulated player toward the host's view. No rollback:
   * we take a fraction of the error each snapshot, which converges quickly
   * and stays invisible, where a hard correction would pop. A large error
   * means something discrete happened (respawn, teleport) so we snap.
   */
  correct(snap) {
    if (!this.me || this.mySlot < 0) return;
    let auth = null;
    for (const p of snap.players) if (p.slot === this.mySlot) { auth = p; break; }
    if (!auth) return;

    const dx = auth.x - this.me.x, dy = auth.y - this.me.y;
    const dist = Math.hypot(dx, dy);
    if (dist > CFG.SNAP_DIST) {
      this.me.x = auth.x; this.me.y = auth.y;
      this.me.vx = 0; this.me.vy = 0;
      this.stats.corrections++;
      return;
    }
    this.me.x += dx * CFG.PULL;
    this.me.y += dy * CFG.PULL;
    // Authoritative grounded state matters: without it a client can think
    // it's airborne (and refuse to jump) while the host says it's standing.
    if (auth.flags & P_FLAG.GROUNDED) {
      this.me.grounded = true;
      if (this.me.vy > 0) this.me.vy *= (1 - CFG.PULL_VEL);
    }
  },

  end(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.onEnd(reason);
  },

  /** Find the two snapshots bracketing render time and blend them. */
  interpolate() {
    const buf = this.buf;
    if (!buf.length) return null;
    const at = performance.now() - CFG.INTERP_DELAY_MS;

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
   * Push interpolated positions into the local world so that (a) rendering
   * is smooth and (b) our own player collides against where things actually
   * are right now.
   */
  applyInterpolated(iv) {
    if (!iv) return;
    const { older, newer, t } = iv;
    const lerp = (a, b) => (newer ? a + (b - a) * t : a);

    // Remote players: solid, positioned, never simulated.
    const seen = new Set();
    for (let i = 0; i < older.players.length; i++) {
      const a = older.players[i];
      if (a.slot === this.mySlot) continue;
      seen.add(a.slot);
      let b = null;
      if (newer) for (const q of newer.players) if (q.slot === a.slot) { b = q; break; }
      const e = makePlayer(this.nw, a.slot);
      e.dynamic = false;
      e.x = b ? lerp(a.x, b.x) : a.x;
      e.y = b ? lerp(a.y, b.y) : a.y;
      e.facing = a.facing;
      e.grounded = !!(a.flags & P_FLAG.GROUNDED);
      e._carrying = !!(a.flags & P_FLAG.CARRYING);
    }
    for (const slot of Array.from(this.nw.players.keys())) {
      if (slot !== this.mySlot && !seen.has(slot)) dropPlayer(this.nw, slot);
    }

    for (let i = 0; i < this.nw.boxes.length && i < older.boxes.length; i++) {
      const box = this.nw.boxes[i], a = older.boxes[i];
      const b = newer && newer.boxes[i];
      box.x = b ? lerp(a.x, b.x) : a.x;
      box.y = b ? lerp(a.y, b.y) : a.y;
      box.carried = !!(a.flags & B_FLAG.CARRIED);
      // A carried box shouldn't block whoever's holding it; treating it as
      // non-solid while held is close enough and costs nothing.
      box.solid = !box.carried;
    }

    for (let i = 0; i < this.nw.platforms.length && i < older.platforms.length; i++) {
      const pl = this.nw.platforms[i], a = older.platforms[i];
      const b = newer && newer.platforms[i];
      const nx = b ? lerp(a.x, b.x) : a.x;
      const ny = b ? lerp(a.y, b.y) : a.y;
      // dx/dy let engine.js carry riders correctly this frame.
      pl.dx = nx - pl.x; pl.dy = ny - pl.y;
      pl.x = nx; pl.y = ny;
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

    let d = now - this.last; this.last = now;
    if (d > CFG.MAX_CATCHUP_MS) d = CFG.MAX_CATCHUP_MS;
    this.acc += d;

    // Position everything else from snapshots BEFORE stepping ourselves, so
    // we collide against current positions.
    this.applyInterpolated(this.interpolate());

    const t0 = performance.now();
    let steps = 0;
    while (this.acc >= SIM_MS && steps < CFG.MAX_STEPS_FRAME) {
      this.acc -= SIM_MS; steps++;
      if (!this.me) continue;
      const mask = stateToMask(this.input.getState());
      const st = maskToState(mask);
      this.me._mask = mask;
      this.me.handleInput(st, SIM_DT);
      // Only our own body is simulated. Everything else is already placed.
      this.nw.world.step(SIM_DT);
      this.send(mask, now);
    }
    if (steps >= CFG.MAX_STEPS_FRAME) this.acc = 0;
    this.stats.simMs = performance.now() - t0;
  },

  world() { return this.nw.world; },

  /**
   * Draw list. Everything is already at its interpolated position, and our
   * own player is at its locally-simulated position, so this is a plain
   * pass-through — no second layer of smoothing to fight the first.
   */
  renderList() {
    const out = this._out; out.length = 0;
    const ents = this.nw.world.entities;
    for (let i = 0; i < ents.length; i++) out.push({ entity: ents[i], x: ents[i].x, y: ents[i].y });
    return out;
  },
};

window.Netcode = {
  CFG, BTN, INPUT_MASK, P_FLAG, B_FLAG,
  Codec, Validate, Host, Client, Tween,
  buildWorld, makePlayer, dropPlayer, stateToMask, maskToState, PALETTE,
};

})();
