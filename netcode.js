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

const { World, Player, Box, MovingPlatform, PressurePlate } = window.Engine;

/* ===========================================================================
   CONFIG
   =========================================================================== */
const CFG = {
  // 75Hz sim. Only the host uses this, so it can change without desyncing
  // anyone — clients never simulate, only interpolate what the host sends.
  SIM_HZ:           75,
  // Broadcast every tick the host computes. With no client-side prediction,
  // snapshot rate is the only lever left for responsiveness, so there is no
  // reason to send less often than the host has new state — SNAPSHOT_HZ
  // is pinned to SIM_HZ below rather than given its own number.
  SNAPSHOT_HZ:      75,
  MAX_PLAYERS:      8,

  MAX_CATCHUP_MS:   200,    // clamp frame delta; no post-stall spiral
  MAX_STEPS_FRAME:  7,      // was 6 at 60Hz — a 200ms stall now needs more
                             // 75Hz steps to catch up than it did at 60Hz

  // Interpolation delay is ADAPTIVE (see JitterTracker below) rather than a
  // fixed number. These are the floor and ceiling it's allowed to settle
  // between. The floor follows Source engine's default (cl_interp_ratio=2):
  // always keep ~2 snapshots buffered — (1000/75)*2 ≈ 27ms.
  INTERP_DELAY_MIN: 27,
  INTERP_DELAY_MAX: 200,
  INTERP_DELAY_START: 33,   // initial guess before we've measured anything
  JITTER_EWMA:      0.12,   // how fast the estimate reacts to new gaps
  JITTER_MARGIN:    3.0,    // delay = 2 snapshot intervals + MARGIN * jitter
  SNAP_BUFFER:      32,     // headroom for the larger end of the adaptive range

  // If two consecutive snapshots for the same entity differ by more than
  // this, treat it as a teleport/respawn rather than a slide: jump straight
  // to the newer position instead of interpolating across the whole level.
  TELEPORT_DIST:    140,

  // engine.js deliberately does NOT auto-reset on death — it raises
  // world.pendingReset and leaves *when* to actually call resetLevel() as
  // policy, explicitly netcode's call (see its own OWNERSHIP comment on
  // World.resetLevel). This is that policy: long enough for character.js's
  // death pose/animation to actually be seen before the room snaps back,
  // short enough that failing doesn't feel like it drags.
  RESET_DELAY_MS:   1200,

  // Lobby: self-healing resend interval for the pre-game lobby snapshot
  // (player list, progress, selection). See Host.prepare/broadcastLobby.
  LOBBY_HEARTBEAT_MS: 600,

  // Ultimate backstop: HOST_TIMEOUT_MS only starts counting once the FIRST
  // snapshot has arrived (see update() below). If nothing ever arrives at
  // all — a fundamentally broken data channel, not just one lost packet —
  // that check never fires, since its trigger condition itself never
  // becomes true. This timeout is independent of that one and covers exactly
  // that case: total silence from the moment the connection opened.
  HANDSHAKE_TIMEOUT_MS: 8000,   // comfortably past RETRY_MAX * RETRY_MS (2.4s)

  // Session
  HOST_TIMEOUT_MS:  2500,     // no snapshot this long => host is gone
  INPUT_KEEPALIVE_MS: 65,     // was 80 at 60Hz — matches the faster tick

  // Security
  MAX_MSG_BYTES:    2048,
  MAX_MSG_PER_SEC:  140,      // was 110 at 60Hz — 75Hz keepalive traffic needs headroom
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
   ENTITY TYPE REGISTRY
   ---------------------------------------------------------------------------
   Previously the codec hardcoded one array per entity type (p/b/m/pl) with
   type-specific pack/unpack logic in encode/decode/apply. That meant every
   new entity type — or even a new level-specific config of an existing one
   — required touching this file. This registry is the fix: each type
   registers itself once, and encode/decode/apply loop over the registry
   generically. Adding a type from here on is ONE entry, zero codec changes.

   This leans on something engine.js already provides for every synced
   class: getSyncState()/applySyncState(). The codec never needs to know a
   single field name — it just carries whatever that pair produces, validated
   generically (see isSafeSyncState) rather than field-by-field. The
   trade-off, stated plainly: Player.getSyncState() includes a few fields
   (coyote timer, jump-buffer timer, held-key latches) that exist for a
   rollback/prediction client we don't have — we removed client-side
   simulation entirely. Sending them is a few extra bytes per player,
   capped at MAX_PLAYERS; genuinely negligible, and the alternative (netcode
   curating which fields it wants per type) is exactly the coupling this
   registry exists to remove.

   EXTRAFIELDS — the escape hatch for the above. A few fields matter on
   the wire but have no business in engine.js's getSyncState(): a
   dynamic entity's w/h/color/kind, which the client cannot know because
   (unlike a static entity) it never constructs one itself and so never
   sees the constructor args. Listing them in a type's `extraFields`
   makes encode() append them to that type's payload. Keep the list to
   values that are genuinely constant per entity — they're re-sent every
   snapshot, which is what makes them self-healing against a dropped
   packet and against a client that joined late, but also means a field
   that changes per tick belongs in getSyncState() proper, not here.

   LIFECYCLE — the one thing that legitimately differs per type:
     'static'  — built once at level-load, count fixed for the level's
                 lifetime (box, platform, plate, trigger, spawner). Key is
                 the entity's own `.id`. Both host and client build the
                 SAME entities in the SAME deterministic order via
                 window.Level.build() — see buildWorld() — and that
                 construction always completes before the first Player is
                 ever created (the first point host/client id sequences can
                 diverge), so a static entity's `.id` is guaranteed
                 identical on both sides. The client looks it up once via
                 nw._staticById rather than searching every snapshot.
     'dynamic' — created/destroyed at runtime (player, projectile). Needs
                 an explicit per-snapshot presence set so the client knows
                 when to remove one, same "seen this tick or forget it"
                 pattern players already used before this generalized.
                 Player keys by `_slot` (host-assigned at connect, already
                 the established concept everywhere else in this file — no
                 reason to switch it to raw `.id`). Everything else dynamic
                 defaults to `.id`, which for a runtime-spawned entity like
                 a projectile is simply whatever the host's engine assigned
                 it; the client never constructs one independently (it
                 never runs the spawner logic that creates them), so
                 nothing needs to match — it's an opaque tracking key,
                 materialized via `makeLocal` purely from wire data.
   =========================================================================== */
const TYPE_REGISTRY = [
  { type: 'player',   lifecycle: 'dynamic', key: e => e._slot, source: nw => nw.players.values(), blendFields: ['x', 'y'] },
  { type: 'box',      lifecycle: 'static',  arrayKey: 'boxes', blendFields: ['x', 'y'] },
  { type: 'platform', lifecycle: 'static',  arrayKey: 'platforms', blendFields: ['x', 'y'] },
  { type: 'plate',    lifecycle: 'static',  arrayKey: 'plates' },
  { type: 'trigger',  lifecycle: 'static',  arrayKey: 'triggers' },
  { type: 'spawner',  lifecycle: 'static',  arrayKey: 'spawners' },
  {
    type: 'projectile', lifecycle: 'dynamic',
    source: nw => nw.world.entities.filter(e => e.isProjectile),
    blendFields: ['x', 'y'],
    extraFields: ['w', 'h', 'color', 'kind'],
    // Client-side materialization: NOT a real engine.js Projectile — the
    // client never simulates, so there's nothing to construct FROM. Just
    // enough of a plain object for the renderer to draw, filled in by
    // applySyncState-equivalent field assignment as snapshots arrive.
    // These values are now only a FALLBACK for the frame between an
    // entity first appearing and its state being assigned — the real
    // size/colour/kind arrive over the wire via extraFields above.
    makeLocal: id => ({ id, w: 8, h: 20, color: '#d8d8e0', kind: 'arrow' }),
  },
  {
    type: 'ball', lifecycle: 'dynamic',
    source: nw => nw.world.entities.filter(e => e.isBouncingBall),
    blendFields: ['x', 'y'],
    extraFields: ['w', 'h', 'color', 'kind'],
    // Same client-materialization reasoning as 'projectile' above.
    // w/h/color are never read by PHYSICS, but they are not therefore
    // cosmetic: a colour-matched level (level 5) makes a hazard kill or
    // defuse based on whether its colour matches the player's, so a
    // client rendering the host's ball in the wrong colour shows a
    // player a lethal hazard as a safe one. They're synced via
    // extraFields above; the literals below are only the fallback for
    // the frame between first appearance and first state assignment.
    makeLocal: id => ({ id, w: 20, h: 20, color: '#e0c845', kind: 'ball' }),
  },
  {
    // Singleton — always exactly one, never added/removed, so it's
    // wired as a one-element 'static' array (arrayKey: 'cameras') rather
    // than adding a third lifecycle just for this. Camera.id is fixed
    // to 0 by engine.js (not the auto-incrementing entity counter),
    // deterministically identical on host and client since both call
    // World.enableCamera() from this same shared buildWorld() — see
    // Camera's class doc comment in engine.js for the full design
    // (why walls instead of a bespoke clamp, why the recompute/
    // positionWalls ordering is what keeps it jitter-free). The host
    // computes x/y every tick; a client only ever renders whatever rect
    // arrives — it never runs enableCamera()'s recompute logic itself
    // (nothing calls world.step() client-side to begin with).
    type: 'camera', lifecycle: 'static', arrayKey: 'cameras', blendFields: ['x', 'y'],
  },
];

function regSource(reg, nw) { return reg.source ? reg.source(nw) : nw[reg.arrayKey]; }
function regKey(reg, e) { return reg.key ? reg.key(e) : e.id; }

/* ===========================================================================
   GENERIC WIRE-VALUE VALIDATION
   ---------------------------------------------------------------------------
   Since the codec no longer knows field names per type, "never trust the
   wire" has to work generically too: every value inside a decoded
   getSyncState() payload is checked against a small, fixed set of safe
   shapes (finite number, boolean, null, short string, or a shallow array
   of the same) — nested objects, functions, NaN/Infinity, oversized
   strings/arrays are all rejected. This is strictly stronger than the old
   per-field checks in one sense (nothing can ever be missed because a new
   type forgot to add a check) and about the security posture this project
   has held throughout: reject wholesale on any malformation, never apply
   partial state.
   =========================================================================== */
function isSafePrimitive(v) {
  if (v === null) return true;
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 64;
  return false;
}
function isSafeSyncState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  for (const k in s) {
    if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
    const v = s[k];
    if (Array.isArray(v)) {
      if (v.length > 64) return false;
      for (const item of v) if (!isSafePrimitive(item)) return false;
    } else if (!isSafePrimitive(v)) {
      return false;
    }
  }
  return true;
}

/* ===========================================================================
   LEVEL MESSAGE PAYLOAD VALIDATION
   ---------------------------------------------------------------------------
   The level channel (see Host.broadcastLevelMsg / Client.sendLevelMsg) is
   deliberately schemaless — netcode has no idea what a level wants to say,
   and adding one is supposed to require zero changes here. But schemaless
   is not the same as unchecked: this is the one path where wire data is
   handed to level code, which will not be written defensively, so it gets
   bounded before it's passed on.

   isSafeSyncState is too strict to reuse (it rejects nesting outright,
   which would make "arbitrary payload" a lie). So this is the same
   primitive whitelist, extended to allow nested objects and arrays down
   to a fixed depth with a fixed total node budget. What it still rejects:
   functions, NaN/Infinity, long strings, cycles (via the depth cap), and
   anything large enough to be a memory-pressure attempt. MAX_MSG_BYTES
   already caps the raw wire size before this ever runs; this stops a
   small-but-pathological payload (deeply nested, or thousands of tiny
   keys) from becoming the level's problem.
   =========================================================================== */
const LVL_MAX_DEPTH = 6, LVL_MAX_NODES = 256, LVL_MAX_KEYS = 64;
function isSafeLevelPayload(v, depth, budget) {
  depth = depth || 0;
  budget = budget || { n: 0 };
  if (++budget.n > LVL_MAX_NODES) return false;
  if (isSafePrimitive(v)) return true;
  if (depth >= LVL_MAX_DEPTH) return false;
  if (Array.isArray(v)) {
    if (v.length > LVL_MAX_KEYS) return false;
    for (const item of v) if (!isSafeLevelPayload(item, depth + 1, budget)) return false;
    return true;
  }
  if (v && typeof v === 'object') {
    let keys = 0;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (++keys > LVL_MAX_KEYS) return false;
      if (k.length > 64) return false;
      if (!isSafeLevelPayload(v[k], depth + 1, budget)) return false;
    }
    return true;
  }
  return false;   // function, symbol, undefined
}

const Codec = {
  encode(nw, tick) {
    const types = {};
    for (const reg of TYPE_REGISTRY) {
      const arr = [];
      for (const e of regSource(reg, nw)) {
        const state = e.getSyncState();
        // Registry-declared cosmetic fields (see `extraFields` in
        // TYPE_REGISTRY). Appended here rather than added to engine.js's
        // getSyncState() so this stays a netcode concern — nothing else
        // in the project pays for a field only the wire needs.
        // `undefined` is skipped: it isn't a safe wire value (see
        // isSafePrimitive) and an entity that doesn't define the field
        // should simply fall back to makeLocal's default.
        if (reg.extraFields) {
          for (const f of reg.extraFields) {
            if (e[f] !== undefined) state[f] = e[f];
          }
        }
        arr.push([regKey(reg, e), state]);
      }
      types[reg.type] = arr;
    }
    return { t: tick, g: nw.world.resetGeneration, types };
  },

  /** Strict. Returns null on any malformation — never partial state. */
  decode(msg) {
    if (!msg || !msg.types || typeof msg.types !== 'object' || Array.isArray(msg.types)) return null;
    if (!Number.isInteger(msg.t) || msg.t < 0) return null;
    if (!Number.isInteger(msg.g) || msg.g < 0) return null;

    const types = {};
    for (const reg of TYPE_REGISTRY) {
      const raw = msg.types[reg.type];
      if (!Array.isArray(raw)) return null;       // every registered type present, even if empty
      if (reg.type === 'player' && raw.length > CFG.MAX_PLAYERS) return null;
      const list = [];
      for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [key, state] = entry;
        if (!Number.isInteger(key) || key < 0) return null;
        if (reg.type === 'player' && key >= CFG.MAX_PLAYERS) return null;
        if (!isSafeSyncState(state)) return null;
        list.push({ key, state });
      }
      types[reg.type] = list;
    }
    return { tick: msg.t, gen: msg.g, types };
  },

  /**
   * Overwrite authoritative state generically, driven entirely by the
   * registry — no per-type branches beyond the two LIFECYCLE shapes.
   * `renderState` is optional (host doesn't interpolate its own state).
   */
  apply(nw, snap, renderState) {
    for (const reg of TYPE_REGISTRY) {
      const list = snap.types[reg.type];

      if (reg.lifecycle === 'static') {
        for (const { key, state } of list) {
          const e = nw._staticById.get(key);
          if (!e) continue;              // unknown id: ignore, never throw
          e.applySyncState(state);
        }
        continue;
      }

      if (reg.type === 'player') {
        const seen = new Set();
        for (const { key: slot, state } of list) {
          seen.add(slot);
          const e = makePlayer(nw, slot);
          e.applySyncState(state);
        }
        for (const slot of Array.from(nw.players.keys())) {
          if (!seen.has(slot)) {
            const gone = nw.players.get(slot);
            if (renderState && gone) renderState.forget(gone);
            dropPlayer(nw, slot);
          }
        }
        continue;
      }

      // Generic dynamic type (currently just projectile): find-or-create
      // a lightweight local tracking object per key, drop whatever key
      // stopped appearing this snapshot — same presence-diff pattern as
      // players, just against a plain Map instead of nw.players.
      let bucket = nw.dynamics.get(reg.type);
      if (!bucket) { bucket = new Map(); nw.dynamics.set(reg.type, bucket); }
      const seen = new Set();
      for (const { key, state } of list) {
        seen.add(key);
        let obj = bucket.get(key);
        if (!obj) { obj = reg.makeLocal(key); bucket.set(key, obj); }
        Object.assign(obj, state);
      }
      for (const key of Array.from(bucket.keys())) if (!seen.has(key)) bucket.delete(key);
    }
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
  /**
   * A client's self-reported "levels completed" count. This is trust-but-
   * clamp, not verification — there is no server, so a client that wants to
   * lie about its own localStorage progress technically can. What this DOES
   * guarantee: the value the host uses is always a well-formed, in-range
   * integer (never NaN/negative/absurd), and the host's own min()-across-
   * players computation (see Host.recomputeLobby) means one lying client can
   * at most raise the unlock level to the true minimum of everyone ELSE in
   * the room — it can never unlock content beyond what the most conservative
   * honest player has actually earned, unless that liar is the only player.
   */
  progress(msg, totalLevels) {
    if (!msg || !Number.isInteger(msg.v) || msg.v < 0) return null;
    return Math.min(msg.v, totalLevels);
  },
  /** returns: a valid level index, `null` for "deselect", or `undefined` for reject-as-malformed. */
  select(msg, unlockedCount) {
    if (!msg || !('level' in msg)) return undefined;
    if (msg.level === null) return null;
    if (!Number.isInteger(msg.level) || msg.level < 0 || msg.level >= unlockedCount) return undefined;
    return msg.level;
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
   RELIABLE HANDSHAKE DELIVERY
   ---------------------------------------------------------------------------
   The data channel is deliberately unreliable+unordered for continuous game
   state — a dropped snapshot is meaningless, the next one supersedes it. A
   handful of one-shot control messages ('welcome' above all) are a different
   animal: 'welcome' is the ONLY thing that tells a client its slot and lets
   it enter the room. If that single packet is lost, nothing else ever
   corrects it — the client just sits waiting forever with no visible error.
   That's a real single point of failure, not a theoretical one.

   The fix is the standard one for a critical message on an unreliable
   transport: resend it periodically until the receiver confirms it arrived,
   capped so a genuinely dead connection doesn't retry forever.
   =========================================================================== */
const RETRY_MS = 400, RETRY_MAX = 6;   // ~2.4s of coverage, well under HOST_TIMEOUT_MS

/* ===========================================================================
   RECONNECT TOKENS
   ---------------------------------------------------------------------------
   A standalone-HTML-per-level architecture means "go to the next level" is a
   real page navigation, which destroys the WebRTC PeerConnection outright —
   there is no way to keep a data channel open across it (confirmed: this is
   a known PeerJS limitation, not something this file can work around). What
   CAN survive is identity: each player is issued a random opaque token once,
   at first join, and reconnects on every later page with that same token
   instead of a fresh anonymous claim(). The host maps token -> slot for the
   lifetime of the whole play session (not just one connection), so a client
   arriving on a new page with a brand-new PeerJS id still lands back in
   their old slot, color, and progress.
   Storage of the token itself (sessionStorage, per player's own tab) is
   deliberately NOT this file's job — see the handoff contract at the bottom
   of this file for what the page-level driver (lobby.js) is expected to do
   with it.
   =========================================================================== */
function genToken() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendReliable(conn, msg, key, pendingAcks) {
  if (!conn || !conn.open) return;
  let attempts = 0;
  const fire = () => {
    if (!conn.open || pendingAcks.get(key) !== timer) return;
    try { conn.send(msg); } catch {}
    attempts++;
    if (attempts >= RETRY_MAX) { pendingAcks.delete(key); return; }
  };
  const timer = setInterval(fire, RETRY_MS);
  pendingAcks.set(key, timer);
  fire();   // send immediately, don't wait for the first interval tick
}

function ackReliable(pendingAcks, key) {
  const timer = pendingAcks.get(key);
  if (timer) { clearInterval(timer); pendingAcks.delete(key); }
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
    // Every kinematic, path-following body lives here — MovingPlatform,
    // LinkedDoor, and each half of a Seesaw all share the exact same
    // contract from the client's point of view: a position that moves
    // over time, nothing else. A door's open/closed state and a seesaw's
    // tilt are BOTH already fully encoded in position — the client
    // already knows a door's closedPos/openPos and a plank's baseY from
    // building the same level.js, so there is no new wire field to add,
    // just more entities pushed into this same array.
    platforms: [],
    // Pressure plates are the one genuinely new thing a client can't
    // already infer: whether something is resting on a plate depends on
    // physics the client never runs, so `active` has to be told, not
    // derived. Everything else about a plate (position) never changes,
    // so it isn't synced at all.
    plates: [],
    // TriggerZone (goal/hazard regions) and ProjectileSpawner — both
    // static, both new. Position (and for triggers, config like `effect`)
    // never changes post-build, but plate-style derived state does
    // (touching/touchCount for triggers, timer/enabled for spawners),
    // so both are synced the same way plates are.
    triggers: [],
    spawners: [],
    // Bucket storage for dynamic non-player types (currently just
    // projectile) — Map<type, Map<key, localObject>>. Player uses
    // `nw.players` directly rather than living in here; it predates this
    // registry and is deeply embedded elsewhere (mySlot, rendering), so
    // there's no value in moving it just for uniformity.
    dynamics: new Map(),
  };
  window.Level.build(nw.world, nw);

  // Camera setup — fully level-customizable via nw.world.cameraOpts,
  // which Level.build() may set directly (exactly like it already sets
  // deathY/levelBounds) to anything World.enableCamera(viewW, viewH,
  // opts) accepts: { viewW, viewH, blockLeft, blockRight, blockTop,
  // blockBottom }. Different levels legitimately want different
  // viewports — a wide-open puzzle room vs. a tight vertical shaft — so
  // this file never hardcodes a size; it just supplies a fallback
  // (960x540, matching the single-screen convention used throughout
  // this project's own test harnesses, all edges blocking) for a level
  // that doesn't specify one. NOT wired into rendering yet — see the
  // note at this file's end; draw() in index.html currently shows the
  // WHOLE level letterboxed to fit the window and needs to change to
  // crop/zoom to nw.cameras[0] instead. That's a rendering change for
  // whichever chat owns index.html's draw loop, not something this file
  // does on its own.
  //
  // levelBounds: prefer whatever Level.build() already set (it owns
  // deathY, so it's the authoritative source for how far past the
  // visible height a level actually needs the camera to reach — see the
  // comment next to where level.js sets it). Only fall back to a raw
  // WIDTH/HEIGHT box here if a level doesn't set one itself.
  if (!nw.world.levelBounds) {
    nw.world.levelBounds = { minX: 0, minY: 0, maxX: window.Level.WIDTH, maxY: window.Level.HEIGHT };
  }
  const camOpts = nw.world.cameraOpts || {};
  nw.world.enableCamera(camOpts.viewW || 960, camOpts.viewH || 540, camOpts);
  nw.cameras = [nw.world.camera];

  // Static-type id -> entity index, built once. Every static entity's
  // .id is guaranteed identical between host and client: Level.build()
  // constructs them in the exact same deterministic order on both sides,
  // and always completes before the first Player is ever created — the
  // first point the two sides' id sequences could diverge (see
  // TYPE_REGISTRY's header comment for the full reasoning).
  nw._staticById = new Map();
  for (const reg of TYPE_REGISTRY) {
    if (reg.lifecycle !== 'static') continue;
    for (const e of nw[reg.arrayKey]) nw._staticById.set(e.id, e);
  }
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
   WIN CONDITIONS
   ---------------------------------------------------------------------------
   Generic, level-declared. Level.build(world, nw) may set `nw.winCondition`
   to something like:
     { type: 'reach-goal', mode: 'any' | 'all' | 'each', goals: [triggerZoneInstance, ...] }
   `goals` are TriggerZone instances with effect:'goal' — the SAME objects
   Level.build() already pushed into nw.triggers, referenced again here so
   the evaluator doesn't have to guess which triggers are exit-relevant out
   of however many a level places (some triggers are just hazards).

   Deliberately host-only, deliberately simple: TriggerZone already tracks
   who's touching it (recomputed fresh every step, never latching — same
   "no lingering state" contract as PressurePlate), so this function does
   no physics of its own. It just reads that and decides. A level with no
   winCondition set simply never completes — that's a level-design gap to
   fix in level content, not something this function needs an opinion on.

   Returns null (not complete) or a result describing what happened.
   'any' -> { mode:'any', ids } names just the completer(s) touching a goal
   this instant. 'all' -> { mode:'all', ids } names every connected player,
   once every single one is touching (possibly different) goals
   simultaneously. 'each' -> { mode:'each', slots } names the players
   touching a goal right now so the host can remove them individually;
   unlike the other two this is NOT a "level is over" signal by itself —
   see the mode's own comment in the function body.
   =========================================================================== */
function evaluateWinCondition(nw) {
  const wc = nw.winCondition;
  if (!wc || wc.type !== 'reach-goal' || !Array.isArray(wc.goals) || !wc.goals.length) return null;

  const touchingIds = new Set();
  for (const goal of wc.goals) for (const id of goal.touching) touchingIds.add(id);

  if (wc.mode === 'any') {
    return touchingIds.size > 0 ? { mode: 'any', ids: touchingIds } : null;
  }
  if (wc.mode === 'all') {
    if (nw.players.size === 0) return null;
    for (const p of nw.players.values()) if (!touchingIds.has(p.id)) return null;
    return { mode: 'all', ids: new Set(Array.from(nw.players.values(), p => p.id)) };
  }
  // 'each' — players exit the level individually rather than gathering at
  // the goal together. Touching it removes that player from the room (they
  // "went through the portal"); the level completes once everyone has.
  //
  // Like relay's evaluateTurnMode, this is pure state-reading: it reports
  // WHICH slots are touching the goal right now and nothing else. Removing
  // them and deciding when the room is finished is policy, so it lives in
  // the host loop — see the 'each' branch there.
  //
  // Returns slots (not ids) for the same reason evaluateTurnMode does: the
  // player entity is about to be removed, so a bare id would immediately
  // become an orphaned reference, whereas the slot stays meaningful.
  if (wc.mode === 'each') {
    const slots = [];
    for (const [slot, p] of nw.players) if (touchingIds.has(p.id)) slots.push(slot);
    return slots.length ? { mode: 'each', slots } : null;
  }
  return null;
}

/* ===========================================================================
   TURN MODE ("relay") — one player active at a time
   ---------------------------------------------------------------------------
   Generic, level-declared, same shape/ownership philosophy as winCondition
   above: Level.build(world, nw) may set `nw.turnMode` to
     { type: 'relay', goal: triggerZoneInstance, invulnDuration: 0.5 }
   `goal` is a TriggerZone (effect:'goal') — the same reference-not-guess
   pattern winCondition.goals uses. `invulnDuration` (seconds) is how long
   a freshly-spawned player is immune to contact kills; omit/0 for none.

   A level sets EITHER winCondition OR turnMode, not both — they're two
   different win mechanisms (simultaneous multi-player goal-touching vs.
   sequential individual clearing). Nothing enforces that exclusivity here;
   it's just what each function actually reads.

   This function is pure state-reading, exactly like evaluateWinCondition:
   it only reports whether the CURRENTLY ACTIVE turn's player is touching
   the goal this instant. It does not remove players, spawn the next one,
   or decide when the level is complete — that's queue/turn POLICY, and
   like resetLevel()'s timing (see its OWNERSHIP note in engine.js) and
   pendingReset, policy belongs to the host loop, not here. See Host's
   advanceTurn()/the turnMode branch in its tick loop for the actual
   transition (drop this player, spawn the next queued one with
   invulnerability, or — queue empty — call completeLevel()).

   Returns null (nothing to report this tick) or the clearing player's
   `slot` (not `id` — slot is what Host's bookkeeping and makePlayer/
   dropPlayer key on, and it stays valid after the player entity is
   removed, whereas a bare player.id would become an orphaned reference).
   =========================================================================== */
function evaluateTurnMode(nw) {
  const tm = nw.turnMode;
  if (!tm || tm.type !== 'relay' || !tm.goal) return null;
  if (nw.turnActiveSlot === undefined || nw.turnActiveSlot === null) return null;

  const p = nw.players.get(nw.turnActiveSlot);
  if (!p || p.dead) return null; // dead is handled by the normal reset path, not a "clear"
  return tm.goal.touching.has(p.id) ? nw.turnActiveSlot : null;
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
/* ===========================================================================
   TICK CLOCK
   ---------------------------------------------------------------------------
   The previous guard rejected ANY packet that arrived after a newer one
   already had — but "arrived out of order" and "arrived too late to be
   useful" are not the same thing. Since SNAPSHOT_HZ == SIM_HZ, every tick
   the host sends represents a fixed, known slice of game time (SIM_MS
   apart). That means a tick's number tells you exactly where it belongs on
   the timeline, independent of when it happened to arrive — so a slightly
   late, out-of-order packet can still be slotted into its correct place and
   used, rather than thrown away just because something newer beat it here.

   This reconstructs that timeline: given a tick number, it returns the
   local time that tick SHOULD occupy, based on an anchor point that's
   gently corrected over time (a small nudge per newest-seen tick, not a
   hard reset) so it doesn't drift as the session goes on but also can't be
   yanked around by a single jittery sample or a late packet.
   =========================================================================== */
class TickClock {
  constructor(tickMs) {
    this.tickMs = tickMs;
    this.anchorTick = -1;
    this.anchorAt = 0;
    this.maxTick = -1;
  }

  /** The local time this tick belongs at. null if nothing's anchored yet. */
  virtualTime(tick) {
    if (this.anchorTick < 0) return null;
    return this.anchorAt + (tick - this.anchorTick) * this.tickMs;
  }

  /**
   * Feed the clock a newly-received tick. Only ticks that are the newest
   * seen so far are allowed to correct the anchor — a reordered late packet
   * describes the past and must not be allowed to yank the clock around.
   */
  observe(tick, recvAt) {
    if (this.anchorTick < 0) {
      this.anchorTick = tick; this.anchorAt = recvAt; this.maxTick = tick;
      return recvAt;
    }
    if (tick > this.maxTick) {
      const predicted = this.virtualTime(tick);
      // Nudge, don't snap: recvAt is a single noisy sample of network delay,
      // so only a small fraction of the error is corrected per observation.
      this.anchorAt += (recvAt - predicted) * 0.04;
      this.maxTick = tick;
    }
    return this.virtualTime(tick);
  }
}

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
  resetPendingSince: 0,   // 0 = no reset in progress; set once world.pendingReset first goes true
  levelComplete: false,   // latches once the win condition fires, so it can't re-trigger every tick
  // --- lobby state (see LOBBY PROTOCOL section below for the full flow) ---
  locked: false, totalLevels: 1, unlockedCount: 1, lobbyReady: false,
  chosenLevel: null, _lobbyVersion: 0, _lobbyHeartbeat: null,
  pendingAcks: new Map(),   // peerId -> Map(msgKey -> intervalTimer)
  stats: { steps: 0, simMs: 0 },
  // --- cross-page identity (see RECONNECT TOKENS above and the HANDOFF
  // CONTRACT at the end of this file) --- keyed by slot, NOT by peerId,
  // because peerId is only stable for the lifetime of one page's
  // PeerConnection; slot is stable for the whole play session.
  tokenBySlot: new Map(),   // slot -> token
  tokens: new Map(),        // token -> slot  (reverse index, rebuilt from tokenBySlot on restore)
  slotMeta: new Map(),      // slot -> { progress }  (survives a peer entry being torn down/recreated)
  resuming: false,          // true when this Host was built via restore(), not prepare()

  /**
   * Open the room for connections while the host is still on the lobby
   * screen. Players can join and get a slot, but nothing simulates or
   * broadcasts yet — that only begins once the host presses Start (see
   * start() below). This is what makes "host presses Start" the actual
   * gate on entering the room, not just a UI delay.
   *
   * opts.totalLevels: size of the level list, used to clamp reported
   *   progress and bound level selections. opts.onLobby: called with a
   *   lobby snapshot (see lobbySnapshot()) any time it changes — this is
   *   how the host's OWN UI gets player-list/progress/selection updates,
   *   the same shape a client gets over the wire.
   */
  prepare(peer, onStatus, opts) {
    opts = opts || {};
    // NOTE: no buildWorld()/makePlayer() here. Those need window.Level,
    // which isn't loaded yet at this point in the lobby flow (that only
    // happens once a level is chosen and locked in — see start() below,
    // which is the earliest point the world is safe to build).
    this.nw = null;
    this.tw = null;
    this.onStatus = onStatus || function () {};
    this.onEnd = function () {};   // safe default; start() overrides with the real callback
    this.onLobby = opts.onLobby || function () {};
    this.onRoster = opts.onRoster || function () {};
    this.onComplete = opts.onComplete || function () {};
    this.selfId = peer.id;
    this.alive = true;
    this.started = false;
    this.resetPendingSince = 0;
    this.locked = false;
    this.totalLevels = Math.max(1, opts.totalLevels | 0 || 1);
    this.unlockedCount = 1;
    this.lobbyReady = false;
    this.chosenLevel = null;
    this._lobbyVersion = 0;
    this.tokenBySlot = new Map();
    this.tokens = new Map();
    this.slotMeta = new Map();
    this.resuming = false;
    this.mySlot = this.claim(peer.id);
    this.selfToken = this.issueToken(this.mySlot);
    this.peers.set(peer.id, {
      conn: null, mask: 0, lastSeq: 0, allow: () => true, progress: 0, selection: null,
    });
    peer.on('connection', c => this.onConn(c));

    // Self-healing resend of lobby state (see CFG.LOBBY_HEARTBEAT_MS).
    clearInterval(this._lobbyHeartbeat);
    this._lobbyHeartbeat = setInterval(() => {
      if (this.alive && !this.started) this.broadcastLobby();
    }, CFG.LOBBY_HEARTBEAT_MS);
    this.recomputeLobby();

    this._bye = () => this.shutdown();
    window.addEventListener('pagehide', this._bye);
    window.addEventListener('beforeunload', this._bye);
  },

  /**
   * Close the room to new joins. This is the actual protocol-level gate
   * the spec asks for: called the instant the host presses Start, BEFORE
   * the chosen level is loaded or start() is called. From this point any
   * new connection attempt is rejected with a clear reason (see onConn)
   * instead of being silently queued or welcomed in.
   *
   * `level` is the agreed level index (see recomputeLobby/lobbyReady) —
   * stored so sendWelcome can tell every client which level to load.
   */
  lock(level) {
    if (this.locked) return;
    this.locked = true;
    this.chosenLevel = level;
    clearInterval(this._lobbyHeartbeat);
    for (const [peerId, p] of this.peers) {
      if (p.conn && p.conn.open) {
        if (!this.pendingAcks.has(peerId)) this.pendingAcks.set(peerId, new Map());
        sendReliable(p.conn, { type: 'starting', level }, 'starting', this.pendingAcks.get(peerId));
      }
    }
  },

  /**
   * Begin simulating and broadcasting. Only called once, after lock() and
   * after the host has finished loading `chosenLevel`'s level.js locally
   * (window.Level must already be the right level by the time this runs,
   * since buildWorld() reads it — see buildWorld()).
   */
  start(peer, input, onStatus, onEnd) {
    // World is built HERE, not in prepare() — this is the first point in
    // the lobby flow guaranteed to run after window.Level has been loaded
    // for the chosen level (lobby.js awaits Levels.load() before calling
    // this). A player entity is created for every slot claimed during the
    // lobby wait, including ones that connected before this moment —
    // UNLESS the level uses turnMode:{type:'relay'} (see evaluateTurnMode
    // in the WIN CONDITIONS section), in which case only the first
    // queued player spawns; the rest wait their turn via advanceTurn().
    this.nw = buildWorld();
    this.tw = new Tween();

    if (this.nw.turnMode && this.nw.turnMode.type === 'relay') {
      this.nw.turnQueue = Array.from(this.used);
      this.nw.turnClearedSlots = new Set();
      this.nw.turnActiveSlot = null;
      this.advanceTurn();
    } else {
      // Iterates this.used (every slot the room ever had), not
      // this.slots.values() (only currently-connected peerIds) — on a
      // resumed/auto-advanced page, clients rejoin asynchronously as their
      // own navigation completes, and each one should find their player
      // already in the world rather than the world waiting for all of
      // them (see restore() below).
      for (const slot of this.used) makePlayer(this.nw, slot);
    }

    this.tw.before(this.nw.world); this.tw.after(this.nw.world);

    this.input = input;
    if (onStatus) this.onStatus = onStatus;
    this.onEnd = onEnd || function () {};
    this.started = true;
    this.levelComplete = false;
    this.last = performance.now();
    // Anyone who connected during the lobby wait gets their welcome now.
    for (const [peerId, p] of this.peers) {
      if (p.conn && p.conn.open) {
        this.sendWelcome(peerId, this.slots.get(peerId));
      }
    }
    this.report();
  },

  /**
   * Relay-mode turn advancement (only meaningful when
   * nw.turnMode.type === 'relay' — see evaluateTurnMode's doc comment
   * for the full design). Pops the next queued slot and spawns it,
   * granting nw.turnMode.invulnDuration seconds of contact-kill immunity
   * if set (covers both the very first spawn and every subsequent one —
   * a fresh player facing a room full of already-moving balls needs the
   * same grace period regardless of turn number). Returns false with
   * nw.turnActiveSlot left null if the queue is empty — the caller (the
   * tick loop's turnMode branch below) treats that as "everyone has had
   * a turn" and completes the level.
   */
  advanceTurn() {
    this.nw.turnActiveSlot = null;
    if (!this.nw.turnQueue.length) return false;
    const slot = this.nw.turnQueue.shift();
    const p = makePlayer(this.nw, slot);
    if (this.nw.turnMode.invulnDuration) p.grantInvulnerability(this.nw.turnMode.invulnDuration);
    this.nw.turnActiveSlot = slot;
    return true;
  },

  sendWelcome(peerId, slot) {
    const p = this.peers.get(peerId);
    if (!p || !p.conn) return;
    if (!this.pendingAcks.has(peerId)) this.pendingAcks.set(peerId, new Map());
    sendReliable(p.conn, {
      type: 'welcome', slot, simHz: CFG.SIM_HZ, level: this.chosenLevel,
      token: this.tokenBySlot.get(slot) || null,   // client persists this — see HANDOFF CONTRACT
      peers: this.rosterIds(),                     // see VOICE ROSTER below
    }, 'welcome', this.pendingAcks.get(peerId));
  },

  /* =========================================================================
     VOICE ROSTER
     -------------------------------------------------------------------------
     The game transport is a star: every client holds exactly one
     DataConnection, to the host. That's deliberate and stays that way —
     snapshots are host-authoritative, so there is nothing for clients to
     say to each other about game state.

     Voice is the exception. voicechat.js is a full mesh (each participant
     calls every other directly), which means every client needs to know
     every OTHER client's PeerJS id — something the star topology never
     otherwise reveals to them. lobbySnapshot() can't carry it: it's
     lobby-phase only (the heartbeat stops at lock()) and intentionally
     exposes slot/color/progress rather than transport identifiers.

     So: one small message, {type:'roster', peers:[peerId, ...]}, sent to
     every connected client whenever room membership changes, and also
     folded into 'welcome' so a joining or rejoining client has the list
     the moment it's admitted rather than waiting for the next change.
     The list includes the host's own id and every bound client's id;
     consumers filter out their own (VoiceUI.sync(roster, selfId) already
     does exactly that).

     Ids are only ever ADDED here, never used for game traffic — a client
     receiving this still talks solely to the host. Membership changes are
     rare, so this is sent unreliably-but-idempotently: the full list is
     re-sent every time, so a dropped packet self-corrects on the next
     change, and the level page's own periodic VoiceUI.sync() call means
     a stale list costs a few seconds of missing voice, never a desync.
     ========================================================================= */

  /** Every peer id currently in the room, host included. Only peers with
   *  a bound slot are listed — a connection still waiting to present its
   *  rejoin token (slot === -1) isn't a room member yet. */
  rosterIds() {
    const ids = [this.selfId];
    for (const [peerId, p] of this.peers) {
      if (peerId === this.selfId) continue;
      if (p.slot === -1) continue;          // unbound rejoin socket, not a member yet
      if (!this.slots.has(peerId)) continue;
      ids.push(peerId);
    }
    return ids;
  },

  broadcastRoster() {
    const peers = this.rosterIds();
    for (const [peerId, p] of this.peers) {
      if (peerId === this.selfId) continue;
      if (p.conn && p.conn.open) {
        try { p.conn.send({ type: 'roster', peers }); } catch {}
      }
    }
    this.onRoster(peers);
  },

  /* =========================================================================
     LOBBY PROTOCOL (host side)
     -------------------------------------------------------------------------
     Runs entirely over the same `conn` objects the game later reuses —
     onConn() below wires ONE 'data' listener per peer for the whole
     connection lifetime, lobby messages and game input alike, so there is
     no separate lobby transport to keep in sync with the game one.

     Client -> host:  {type:'progress', v}        self-reported levels-done
                       {type:'select',  level}     pending level pick (or null)
                       {type:'rejoin',  token}     cross-page reconnect (see RECONNECT TOKENS)
     Host -> client:   {type:'lobby', ...snapshot} full state, on change + heartbeat
                       {type:'starting', level}    reliable, sent by lock()
                       {type:'queued', token}      first-join ack, carries the reconnect token
                       {type:'welcome', ..., token} slot assignment; token repeated for safety
                       {type:'complete', ..., next, done}  reliable; see LEVEL COMPLETION below
                       {type:'roster', peers}      voice-mesh peer ids; see VOICE ROSTER below
                       {type:'rejected', reason}   sent + conn closed (locked room / bad token)
     ========================================================================= */

  /** Host-authoritative unlock + readiness computation. Never trusts a
   *  client's own idea of what's unlocked — only the raw per-player
   *  progress integer crosses the wire; this function alone decides what
   *  that means for the room. See Validate.progress for the trust model. */
  recomputeLobby() {
    let minProgress = this.totalLevels;
    for (const p of this.peers.values()) {
      minProgress = Math.min(minProgress, Number.isInteger(p.progress) ? p.progress : 0);
    }
    this.unlockedCount = Math.max(1, Math.min(this.totalLevels, minProgress + 1));

    // A selection that's no longer in range (someone's progress just
    // lowered the group unlock) is cleared rather than silently kept.
    for (const p of this.peers.values()) {
      if (p.selection !== null && p.selection >= this.unlockedCount) p.selection = null;
    }

    const sels = Array.from(this.peers.values()).map(p => p.selection);
    const allSelected = sels.length > 0 && sels.every(s => s !== null);
    this.lobbyReady = allSelected && sels.every(s => s === sels[0]);
    this.chosenLevel = this.lobbyReady ? sels[0] : null;

    this.broadcastLobby();
  },

  lobbySnapshot() {
    const players = [];
    for (const [peerId, p] of this.peers) {
      const slot = this.slots.get(peerId);
      players.push({
        slot, color: PALETTE[slot % PALETTE.length],
        progress: p.progress | 0, selection: p.selection,
        isHost: peerId === this.selfId,
      });
    }
    players.sort((a, b) => a.slot - b.slot);
    return {
      v: this._lobbyVersion, players,
      unlocked: this.unlockedCount, totalLevels: this.totalLevels,
      ready: this.lobbyReady,
    };
  },

  broadcastLobby() {
    this._lobbyVersion++;
    const snap = this.lobbySnapshot();
    for (const [peerId, p] of this.peers) {
      if (p.conn && p.conn.open) {
        // `you` is the ONLY per-recipient field in an otherwise identical
        // broadcast: a client has no way to pick itself out of the player
        // list during the lobby phase, because slot assignment normally
        // rides on 'welcome' and that isn't sent until the game actually
        // starts. Without this a client can't highlight its own row or
        // show which level IT picked. Sent as the slot number rather than
        // the peer id, matching what every other message uses.
        const you = this.slots.has(peerId) ? this.slots.get(peerId) : null;
        try { p.conn.send({ type: 'lobby', ...snap, you }); } catch {}
      }
    }
    this.onLobby(snap);
  },

  /** Host's own lobby-screen UI calls these directly (no network hop for
   *  its own player, same pattern as `mySlot` handling elsewhere). */
  reportProgress(v) {
    const p = this.peers.get(this.selfId);
    if (!p || !Number.isInteger(v) || v < 0) return;
    p.progress = Math.min(v, this.totalLevels);
    const meta = this.slotMeta.get(this.mySlot);
    if (meta) meta.progress = p.progress;
    this.recomputeLobby();
  },
  selectLevel(level) {
    const p = this.peers.get(this.selfId);
    if (!p) return;
    if (level !== null && (!Number.isInteger(level) || level < 0 || level >= this.unlockedCount)) return;
    p.selection = level;
    this.recomputeLobby();
  },

  /* =========================================================================
     LEVEL COMPLETION — auto-advance
     -------------------------------------------------------------------------
     The whole room advances together: completion computes next = chosenLevel
     + 1 and puts it straight into the broadcast 'complete' message. This is
     a deliberate change from the old same-page-swap design (which routed
     everyone back through the lobby's select/consensus screen between every
     level) — with each level now a real page, "go to the next one" is the
     expected default, and the lobby's unlock/select UI still exists for
     picking a level explicitly (replay, jumping back in later, etc.), it's
     just no longer mandatory between every pair of levels.
     `next`/`done` describe what the room does after this message, but this
     file does NOT navigate anywhere itself — see the HANDOFF CONTRACT at
     the end of this file for what the page-level driver (lobby.js) does
     with them (write Host.snapshot() to storage, then `location.href` to
     the next level's page, or back to the shared lobby page when `done`).
     ========================================================================= */

  /** Called once by step() when evaluateWinCondition() first returns non-null. */
  completeLevel(result) {
    this.levelComplete = true;
    for (const [peerId, slot] of this.slots) {
      // mode:'all' is a blanket grant to everyone in the room. It
      // deliberately does NOT require nw.players.get(slot) to still
      // exist: relay-mode turn completion (see evaluateTurnMode) fires
      // this with mode:'all' after players have already been removed
      // one by one as they individually cleared the room, so by the
      // time the LAST one finishes, most slots have no live player
      // entity left at all. A normal simultaneous-goal 'all' win
      // condition still has every player alive when this fires, so this
      // is a strict generalization — no behavior change for that case.
      if (result.mode !== 'all') {
        const p = this.nw.players.get(slot);
        if (!p || !result.ids.has(p.id)) continue;   // 'any': only the actual completer(s)
      }
      const peer = this.peers.get(peerId);
      const newProgress = Math.max((peer && peer.progress) || 0, this.chosenLevel + 1);
      if (peer) peer.progress = newProgress;
      const meta = this.slotMeta.get(slot);
      if (meta) meta.progress = Math.max(meta.progress, newProgress);
    }

    const next = this.chosenLevel + 1;
    const done = next >= this.totalLevels;   // no next level: hand back to the shared lobby
    this.unlockedCount = Math.max(this.unlockedCount, done ? this.totalLevels : next + 1);

    const msg = { type: 'complete', level: this.chosenLevel, mode: result.mode, next: done ? null : next, done };
    for (const [peerId, p] of this.peers) {
      if (p.conn && p.conn.open) {
        if (!this.pendingAcks.has(peerId)) this.pendingAcks.set(peerId, new Map());
        sendReliable(p.conn, msg, 'complete', this.pendingAcks.get(peerId));
      }
    }
    this.onComplete(msg);
  },

  /**
   * Return to the lobby (all levels finished, or the group abandons/replays
   * on the SAME page). Not used for the level-to-level auto-advance case —
   * that's a page navigation handled entirely by the HANDOFF CONTRACT, not
   * an in-memory state reset. Kept for a lobby page that stays open across
   * multiple play sessions without navigating away.
   */
  returnToLobby() {
    this.started = false;
    this.locked = false;
    this.levelComplete = false;
    this.chosenLevel = null;
    for (const p of this.peers.values()) p.selection = null;
    this.nw = null;
    this.tw = null;
    clearInterval(this._lobbyHeartbeat);
    this._lobbyHeartbeat = setInterval(() => {
      if (this.alive && !this.started) this.broadcastLobby();
    }, CFG.LOBBY_HEARTBEAT_MS);
    this.recomputeLobby();
  },

  /* =========================================================================
     LEVEL MESSAGE CHANNEL
     -------------------------------------------------------------------------
     An escape hatch for level pages that need to say something to each
     other that the snapshot protocol doesn't cover — a puzzle's bespoke
     state, a cosmetic cue, a level-specific vote. netcode neither reads
     nor understands the payload; it validates its SHAPE (see
     isSafeLevelPayload) and hands it on.

     WHAT THIS IS NOT: a way around host authority. The host still owns the
     simulation, and a client message arriving here is a REQUEST, not a
     fact — it carries the sender's slot precisely so the host's level code
     can decide whether that player was entitled to say it. Anything that
     moves an entity or decides a win still has to go through the world the
     host simulates, or clients will disagree with each other.

     Delivery is unreliable and unordered, like everything else on this
     channel except the acked handshake messages. A level that needs a
     message to definitely arrive must make it idempotent and repeat it
     (the roster broadcast above is the pattern to copy), because a single
     dropped 'lvl' is never retried and nothing will tell you it vanished.
     ========================================================================= */

  /** Overridden by the level page. (slot, payload) — slot is the sender. */
  onLevelMsg: function () {},

  /** Fire-and-forget to every connected client. Not sent to the host's own
   *  level code: a host talking to itself should just call its own
   *  function directly, the same way reportProgress/selectLevel skip the
   *  network hop for the host's own player. */
  broadcastLevelMsg(payload) {
    const msg = { type: 'lvl', payload };
    if (!Validate.size(msg)) return false;
    for (const [peerId, p] of this.peers) {
      if (peerId === this.selfId) continue;
      if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch {} }
    }
    return true;
  },

  claim(id) {
    for (let s = 0; s < CFG.MAX_PLAYERS; s++) {
      if (!this.used.has(s)) { this.used.add(s); this.slots.set(id, s); return s; }
    }
    return -1;
  },

  /** Mint (or return the existing) reconnect token for a slot. Called once
   *  per slot, the first time that slot is ever claimed — NOT re-issued on
   *  every page/level, so a player's token (and thus their identity across
   *  the whole session) stays constant from first join to final level. */
  issueToken(slot) {
    if (slot < 0) return null;
    let tok = this.tokenBySlot.get(slot);
    if (!tok) {
      tok = genToken();
      this.tokenBySlot.set(slot, tok);
      this.tokens.set(tok, slot);
    }
    if (!this.slotMeta.has(slot)) this.slotMeta.set(slot, { progress: 0 });
    return tok;
  },

  /** Look up a rejoin token. Returns the slot, or -1 if unknown/expired. */
  slotForToken(token) {
    if (typeof token !== 'string' || token.length > 64) return -1;
    const s = this.tokens.get(token);
    return s === undefined ? -1 : s;
  },

  onConn(conn) {
    if (!this.alive || this.peers.size >= CFG.MAX_PLAYERS) {
      conn.on('open', () => { try { conn.send({ type: 'full' }); } catch {} conn.close(); });
      return;
    }
    // Protocol-level host gate: once lock() has run (host pressed Start) —
    // OR this Host was reconstituted via restore() for a level page, which
    // starts pre-locked — a brand-new anonymous join is refused. A REJOIN
    // (an already-known token, arriving on a fresh PeerConnection because
    // the player's browser just navigated to this page) is still welcome:
    // the socket is accepted and held open, but no slot/color/progress is
    // granted until onData sees a valid {type:'rejoin', token} for it. See
    // the RECONNECT TOKENS section above and the HANDOFF CONTRACT at the
    // end of this file.
    if (this.locked) {
      conn.on('open', () => {
        if (this.peers.has(conn.peer)) { conn.close(); return; }
        this.peers.set(conn.peer, {
          conn, mask: 0, lastSeq: 0, allow: rateLimiter(CFG.MAX_MSG_PER_SEC),
          progress: 0, selection: null, slot: -1,
        });
        if (!this._rejoinTimers) this._rejoinTimers = new Map();
        const t = setTimeout(() => {
          const pp = this.peers.get(conn.peer);
          if (pp && pp.slot < 0) { try { conn.close(); } catch {} this.peers.delete(conn.peer); }
        }, CFG.HANDSHAKE_TIMEOUT_MS);
        this._rejoinTimers.set(conn.peer, t);
      });
      conn.on('data', msg => this.onData(conn, msg));
      conn.on('close', () => this.drop(conn.peer));
      conn.on('error', () => this.drop(conn.peer));
      return;
    }
    conn.on('open', () => {
      if (this.peers.has(conn.peer)) { conn.close(); return; }
      const slot = this.claim(conn.peer);
      if (slot < 0) { conn.close(); return; }
      const token = this.issueToken(slot);
      // No makePlayer() here — the world doesn't exist yet during the
      // lobby phase (see prepare()/start()). Player entities for every
      // claimed slot are created together in start(), once a level has
      // actually been loaded.
      this.peers.set(conn.peer, {
        conn, mask: 0, lastSeq: 0, allow: rateLimiter(CFG.MAX_MSG_PER_SEC),
        progress: 0, selection: null,
      });
      // Reserve their slot and let them know they're queued, but withhold
      // 'welcome' until the host actually presses Start — that message is
      // what lets a client enter the room, so gating it here is the real
      // enforcement point, not just a UI-level delay.
      if (this.started) {
        this.sendWelcome(conn.peer, slot);
      } else {
        try { conn.send({ type: 'queued', token }) } catch {}
        this.recomputeLobby();
      }
      this.broadcastRoster();   // new member — everyone re-meshes voice
      this.report();
    });
    conn.on('data', msg => this.onData(conn, msg));
    conn.on('close', () => this.drop(conn.peer));
    conn.on('error', () => this.drop(conn.peer));
  },

  onData(conn, msg) {
    const p = this.peers.get(conn.peer);
    if (!p) return;
    if (!p.allow()) return;                  // flood — applies to every message type
    if (!Validate.size(msg)) return;         // oversized — applies to every message type

    // Ack for a reliably-retried handshake message — cancel the resend loop.
    if (msg && msg.type === 'ack' && typeof msg.for === 'string' && msg.for.length <= 32) {
      const acks = this.pendingAcks.get(conn.peer);
      if (acks) ackReliable(acks, msg.for);
      return;
    }

    // Cross-page rejoin: a socket held open by onConn's locked-branch,
    // waiting for the token that tells us which returning slot this is.
    if (p.slot === -1) {
      if (!msg || msg.type !== 'rejoin') return;   // ignore anything else until bound
      const slot = this.slotForToken(msg.token);
      if (slot < 0 || this.slots.has(conn.peer)) {
        try { conn.send({ type: 'rejected', reason: 'bad-token' }); } catch {}
        try { conn.close(); } catch {}
        this.peers.delete(conn.peer);
        return;
      }
      const t = this._rejoinTimers && this._rejoinTimers.get(conn.peer);
      if (t) { clearTimeout(t); this._rejoinTimers.delete(conn.peer); }
      this.used.add(slot);
      this.slots.set(conn.peer, slot);
      p.slot = slot;
      p.progress = (this.slotMeta.get(slot) || { progress: 0 }).progress;
      this.sendWelcome(conn.peer, slot);
      this.broadcastRoster();   // returning member's NEW peer id — re-mesh
      this.report();
      return;
    }

    // Lobby-phase messages. Only meaningful (and only accepted) before the
    // level has started — once started, these fall through to input.
    if (!this.started) {
      if (msg && msg.type === 'progress') {
        const v = Validate.progress(msg, this.totalLevels);
        if (v === null) return;
        p.progress = v;
        const slot = this.slots.get(conn.peer);
        const meta = slot !== undefined && this.slotMeta.get(slot);
        if (meta) meta.progress = v;
        this.recomputeLobby();
        return;
      }
      if (msg && msg.type === 'select') {
        const v = Validate.select(msg, this.unlockedCount);
        if (v === undefined) return;
        p.selection = v;
        this.recomputeLobby();
        return;
      }
    }

    // Level channel — schemaless pass-through to level code (see
    // broadcastLevelMsg below and the LEVEL MESSAGE section). Placed
    // AFTER the p.slot === -1 rejoin gate above deliberately: an
    // unbound socket that hasn't proven its token yet is not a room
    // member and must not be able to reach level logic. Placed BEFORE
    // the input fall-through so a 'lvl' message is never mistaken for
    // malformed input. Allowed during the lobby phase as well as in
    // game — a level page is not the only thing that might want it.
    if (msg && msg.type === 'lvl') {
      if (!isSafeLevelPayload(msg.payload)) return;
      const slot = this.slots.get(conn.peer);
      if (slot === undefined) return;
      try { this.onLevelMsg(slot, msg.payload); }
      catch (e) { console.error('[netcode] onLevelMsg threw:', e); }
      return;
    }

    const inp = Validate.input(msg);
    if (!inp) return;                        // malformed
    if (inp.seq <= p.lastSeq) return;        // stale / replayed / out of order
    p.lastSeq = inp.seq;
    p.mask = inp.mask;                       // latest input wins; no queue
  },

  drop(peerId) {
    const acks = this.pendingAcks.get(peerId);
    if (acks) { for (const t of acks.values()) clearInterval(t); this.pendingAcks.delete(peerId); }
    const slot = this.slots.get(peerId);
    if (slot !== undefined) {
      // this.nw is null during the lobby phase (world not built yet — see
      // prepare()/start()); only touch it if a world actually exists.
      if (this.nw) {
        const e = this.nw.players.get(slot);
        if (e) this.tw.forget(e);
        dropPlayer(this.nw, slot);

        // Relay mode: a disconnect must never stall the queue —
        // waiting forever on a slot that's never taking its turn would
        // softlock the room for everyone still connected. Two cases:
        // still queued (just remove them, not credited as "cleared" —
        // they never reached the goal), or currently the active turn
        // (advance immediately, same as if they'd been dropped for any
        // other reason; not counted as cleared either).
        if (this.nw.turnMode && this.nw.turnMode.type === 'relay' && !this.levelComplete) {
          const qi = this.nw.turnQueue.indexOf(slot);
          if (qi !== -1) this.nw.turnQueue.splice(qi, 1);
          if (this.nw.turnActiveSlot === slot) {
            if (!this.advanceTurn()) this.completeLevel({ mode: 'all', ids: new Set() });
          }
        }
      }
      this.used.delete(slot);
      this.slots.delete(peerId);

      // 'each' mode: a disconnect must not hand the room a win nobody
      // earned. Players are removed from `used` when they drop, so if the
      // ONLY player still needing to reach the exit leaves, the tick loop's
      // "has everyone been through?" check would otherwise see nothing
      // outstanding and complete the level for the people already parked
      // past the portal. Restart the attempt instead: everyone who'd
      // already exited comes back and runs it again.
      //
      // Deliberately only when the leaver hadn't exited yet — someone who
      // already finished and then closed their tab shouldn't punish the
      // players still going.
      if (this.nw && this.started && !this.levelComplete &&
          this.nw.winCondition && this.nw.winCondition.mode === 'each') {
        const exited = this.nw.exitedSlots || (this.nw.exitedSlots = new Set());
        const leaverHadExited = exited.has(slot);
        exited.delete(slot);

        if (!leaverHadExited && this.used.size > 0) {
          let stillPlaying = false;
          for (const s of this.used) if (!exited.has(s)) { stillPlaying = true; break; }
          if (!stillPlaying) {
            this.nw.world.resetLevel();
            // resetLevel restores state but never recreates entities
            // removed after build (see its doc comment), so exited
            // players need respawning explicitly.
            for (const s of this.used) {
              if (!this.nw.players.has(s)) makePlayer(this.nw, s);
            }
            exited.clear();
            this.resetPendingSince = 0;
            this.onStatus('A player left — restarting the level.');
          }
        }
      }
    }
    this.peers.delete(peerId);
    this.broadcastRoster();   // member gone — everyone tears that call down
    if (!this.started) this.recomputeLobby();
    this.report();
  },

  report() {
    const n = Math.max(0, this.peers.size - 1);
    this.onStatus(this.started
      ? `Hosting — ${n} player(s) in game.`
      : `Room open — ${n} player(s) waiting. Press Start when ready.`);
  },

  /**
   * Call this right before the host itself navigates away as part of a
   * deliberate handoff (level complete -> next level, or -> lobby). Without
   * this, the pagehide/beforeunload listener registered in prepare() would
   * fire shutdown() — broadcasting 'bye' and telling every client the
   * session is over — a split second before they were going to navigate
   * to the same next page anyway. Detaching the listener first means the
   * page can simply die (as any navigation does) without announcing a
   * false end-of-session. Does NOT close the current peer/connections
   * itself — the browser's own navigation does that.
   */
  prepareHandoff() {
    window.removeEventListener('pagehide', this._bye);
    window.removeEventListener('beforeunload', this._bye);
  },

  /**
   * Serialize exactly enough state to rebuild this room's roster (NOT its
   * live world/physics — the destination page rebuilds that itself from
   * window.Level) on the next page. Call right after completeLevel()'s
   * onComplete fires (or after lock() for the very first hand-off out of
   * the lobby). Pure data in, pure data out — where this gets stored
   * (sessionStorage, one per player's own tab) and how the navigation
   * actually happens is the page-level driver's job; see the HANDOFF
   * CONTRACT at the end of this file.
   */
  snapshot(nextLevel) {
    return {
      roomCode: this.selfId,           // fixed host Peer ID == room code
      totalLevels: this.totalLevels,
      chosenLevel: nextLevel,          // the level the NEXT page should load/start
      tokenBySlot: Array.from(this.tokenBySlot.entries()),
      slotMeta: Array.from(this.slotMeta.entries()),
      usedSlots: Array.from(this.used),
      selfSlot: this.mySlot,
      selfToken: this.selfToken,
    };
  },

  /**
   * Rebuild a Host on a freshly-loaded level page from a snapshot(), then
   * immediately start play — no lobby screens, no waiting for every slot
   * to individually rejoin (see start()'s `this.used` iteration). `peer`
   * must already be constructed with the fixed room-code ID (this file
   * doesn't create Peer objects — see the HANDOFF CONTRACT).
   */
  restore(peer, snapshot, input, onStatus, onEnd, onComplete) {
    this.nw = null; this.tw = null;
    this.peers = new Map(); this.slots = new Map(); this.used = new Set(snapshot.usedSlots);
    this.pendingAcks = new Map();
    this._rejoinTimers = new Map();
    this.onStatus = onStatus || function () {};
    this.onComplete = onComplete || function () {};
    this.onLobby = function () {};
    // Deliberately NOT reset: the page-level driver sets this once (via
    // prepare's opts or by assigning Host.onRoster directly) and needs it
    // to survive a level hand-off — restore() rebuilds the room on a new
    // page, and voice has to re-mesh there just like it did in the lobby.
    this.onRoster = this.onRoster || function () {};
    this.selfId = peer.id;
    this.alive = true;
    this.resetPendingSince = 0;
    this.levelComplete = false;
    this.totalLevels = snapshot.totalLevels;
    this.chosenLevel = snapshot.chosenLevel;
    this.unlockedCount = Math.max(1, Math.min(this.totalLevels, this.chosenLevel + 1));
    this.locked = true;              // pre-locked: only known rejoin tokens are admitted, see onConn
    this.resuming = true;
    this.lobbyReady = false;
    this._lobbyVersion = 0;
    this.tokenBySlot = new Map(snapshot.tokenBySlot);
    this.tokens = new Map(snapshot.tokenBySlot.map(([slot, tok]) => [tok, slot]));
    this.slotMeta = new Map(snapshot.slotMeta);
    this.slots.set(peer.id, snapshot.selfSlot);
    this.mySlot = snapshot.selfSlot;
    this.selfToken = snapshot.selfToken;
    this.peers.set(peer.id, {
      conn: null, mask: 0, lastSeq: 0, allow: () => true,
      progress: (this.slotMeta.get(this.mySlot) || { progress: 0 }).progress, selection: null,
    });
    peer.on('connection', c => this.onConn(c));

    this._bye = () => this.shutdown();
    window.addEventListener('pagehide', this._bye);
    window.addEventListener('beforeunload', this._bye);

    this.start(peer, input, onStatus, onEnd);
  },

  /** End the session for everyone. */
  shutdown() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._lobbyHeartbeat);
    for (const p of this.peers.values()) {
      if (p.conn && p.conn.open) { try { p.conn.send({ type: 'bye' }); } catch {} }
    }
    for (const acks of this.pendingAcks.values()) {
      for (const t of acks.values()) clearInterval(t);
    }
    this.pendingAcks.clear();
    if (this._rejoinTimers) { for (const t of this._rejoinTimers.values()) clearTimeout(t); this._rejoinTimers.clear(); }
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

    if (!this.levelComplete && this.nw.winCondition) {
      const result = evaluateWinCondition(this.nw);
      if (result && result.mode === 'each') {
        // Each player exits individually. Remove them as they reach the
        // goal (same path as a disconnect — see dropPlayer), remembering
        // the slot so a player who has already left still counts as
        // cleared even though they no longer have a live entity.
        if (!this.nw.exitedSlots) this.nw.exitedSlots = new Set();
        for (const slot of result.slots) {
          this.nw.exitedSlots.add(slot);
          dropPlayer(this.nw, slot);
        }
        // Everyone the room ever had (this.used, not just the currently
        // connected set — same reasoning as start()'s spawn loop) has now
        // been through. Credited to everyone via completeLevel's mode:'all'
        // generalization, which explicitly tolerates missing entities.
        let allOut = this.used.size > 0;
        for (const slot of this.used) if (!this.nw.exitedSlots.has(slot)) { allOut = false; break; }
        if (allOut) this.completeLevel({ mode: 'all', ids: new Set() });
      } else if (result) {
        this.completeLevel(result);
      }
    }

    // Relay-mode turn advancement: the active player reaching the goal
    // clears them (removed from the room, exactly like a normal
    // disconnect — see dropPlayer) and the next queued player spawns
    // with their invulnerability grace period. An empty queue after
    // that means every connected player has individually cleared the
    // room — level complete, credited to everyone via the same
    // completeLevel() path a normal 'all' win condition uses (see its
    // mode:'all' generalization for why that's safe even though most
    // player entities are already gone by this point).
    if (!this.levelComplete && this.nw.turnMode && this.nw.turnMode.type === 'relay') {
      const clearedSlot = evaluateTurnMode(this.nw);
      if (clearedSlot !== null) {
        this.nw.turnClearedSlots.add(clearedSlot);
        dropPlayer(this.nw, clearedSlot);
        if (!this.advanceTurn()) this.completeLevel({ mode: 'all', ids: new Set() });
      }
    }

    // Reset timing policy (see CFG.RESET_DELAY_MS comment for why this
    // lives here and not in engine.js). Checked every tick rather than
    // once per rendered frame, since the accumulator below can run
    // several ticks in one frame — checking only once per frame would
    // let the delay run past its intended length whenever that happens.
    if (this.nw.world.pendingReset) {
      const now = performance.now();
      if (!this.resetPendingSince) this.resetPendingSince = now;
      if (now - this.resetPendingSince >= CFG.RESET_DELAY_MS) {
        this.nw.world.resetLevel();
        this.resetPendingSince = 0;
        // resetLevel() restores state but deliberately does NOT recreate
        // entities removed after build (see its doc comment). In 'each'
        // mode players are removed as they exit, so a death that resets
        // the room after some have already gone through would otherwise
        // leave those slots permanently empty — unwinnable. Re-spawn them
        // and clear the tally so the attempt genuinely starts over.
        if (this.nw.exitedSlots && this.nw.exitedSlots.size) {
          for (const slot of this.nw.exitedSlots) {
            if (!this.nw.players.has(slot)) makePlayer(this.nw, slot);
          }
          this.nw.exitedSlots.clear();
        }
      }
    }
  },

  broadcast() {
    const s = Codec.encode(this.nw, this.tick);
    for (const p of this.peers.values()) {
      if (!p.conn || !p.conn.open) continue;
      try { p.conn.send({ type: 's', t: s.t, g: s.g, types: s.types }); } catch {}
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
  jitter: null, clock: null, _floorTick: -1, resetGen: -1,
  _sentMask: -1, _sentAt: 0,
  _out: [],
  stats: { gap: 0, lastRecv: 0, snaps: 0, teleports: 0, reordered: 0, lateDropped: 0, instabilityEvents: 0 },

  /** Peer ids of everyone currently in the room, host included (see VOICE
   *  ROSTER on the host side). Used only to open voice calls — never for
   *  game traffic, which always goes through the host. Read this directly,
   *  or set Client.onRoster to be notified on change. */
  roster: [],
  onRoster: function () {},

  /** Overridden by the level page. (payload) — always from the host. */
  onLevelMsg: function () {},

  /** Send an arbitrary payload up to the host's onLevelMsg. Returns false
   *  if there's no open connection or the payload is too large to fit
   *  MAX_MSG_BYTES — worth checking, since the host silently drops
   *  anything oversized on arrival and a level would otherwise have no
   *  way to tell a rejected message from a dropped one. Counts against
   *  the same per-peer rate limit as input (MAX_MSG_PER_SEC), so this is
   *  for events, not a per-tick side channel. */
  sendLevelMsg(payload) {
    if (!this.alive || !this.conn || !this.conn.open) return false;
    const msg = { type: 'lvl', payload };
    if (!Validate.size(msg)) return false;
    try { this.conn.send(msg); return true; } catch { return false; }
  },

  setRoster(peers) {
    // Host-supplied, so it crosses the trust boundary like anything else
    // off the wire — bound the list and drop anything that isn't a
    // plausible PeerJS id before it reaches voicechat.js's addPeer().
    const clean = [];
    for (const id of peers) {
      if (typeof id !== 'string') continue;
      if (id.length === 0 || id.length > 64) continue;
      if (clean.indexOf(id) !== -1) continue;
      clean.push(id);
      if (clean.length >= CFG.MAX_PLAYERS) break;
    }
    this.roster = clean;
    try { this.onRoster(clean); } catch (e) { console.error('[netcode] onRoster threw:', e); }
  },

  start(conn, input, onStatus, onEnd, onComplete) {
    this.nw = buildWorld();
    this.conn = conn;
    this.input = input;
    this.onStatus = onStatus || function () {};
    this.onEnd = onEnd || function () {};
    this.onComplete = onComplete || function () {};
    this.buf = [];
    this.seq = 0;
    this._sentMask = -1; this._sentAt = 0;
    this.alive = true;
    this.last = performance.now();
    this.jitter = new JitterTracker();
    this.clock = new TickClock(SIM_MS);
    this._floorTick = -1;     // ticks at/below this are too late to matter
    this.resetGen = -1;       // sentinel: any real generation counts as "new"

    // Backstop against total silence — see CFG.HANDSHAKE_TIMEOUT_MS comment.
    clearTimeout(this._handshakeTimer);
    this._handshakeTimer = setTimeout(() => {
      if (this.alive && this.mySlot < 0) {
        this.end('No response from host — check the room code and try again.');
      }
    }, CFG.HANDSHAKE_TIMEOUT_MS);

    // Nothing on the client simulates, so nothing needs to be dynamic —
    // every entity here is a positioned prop, not a physics body.
    for (const b of this.nw.boxes) { b.dynamic = false; b.pushable = false; }
  },

  /**
   * Cross-page reconnect: same as start(), except the host is expecting a
   * {type:'rejoin', token} before it will bind this (brand-new) connection
   * to an existing slot — see Host.onData's `p.slot === -1` branch. `token`
   * is whatever this player was given in their first 'welcome' (see
   * onData below, which stores it as `this.myToken`) — the page-level
   * driver is responsible for persisting and re-supplying it; see the
   * HANDOFF CONTRACT at the end of this file.
   */
  rejoin(conn, token, input, onStatus, onEnd, onComplete) {
    this.start(conn, input, onStatus, onEnd, onComplete);
    const send = () => { try { conn.send({ type: 'rejoin', token }); } catch {} };
    if (conn.open) send(); else conn.on('open', send);
  },

  onData(msg) {
    if (!msg || typeof msg !== 'object' || !this.alive) return;

    if (msg.type === 'full') { this.end('Room is full.'); return; }
    if (msg.type === 'bye')  { this.end('Host ended the session.'); return; }

    if (msg.type === 'welcome') {
      if (!Number.isInteger(msg.slot) || msg.slot < 0 || msg.slot >= CFG.MAX_PLAYERS) return;
      clearTimeout(this._handshakeTimer);
      // Ack immediately so the host's resend loop stops. Safe to ack even
      // if this is a retry we've already seen — the host only cares that
      // ONE ack eventually lands, not which attempt it corresponds to.
      try { this.conn.send({ type: 'ack', for: 'welcome' }); } catch {}
      this.mySlot = msg.slot;
      if (msg.token) this.myToken = msg.token;   // see HANDOFF CONTRACT — driver persists this
      // Voice mesh peer list (see VOICE ROSTER on the host side). Folded
      // into 'welcome' so it arrives reliably on join/rejoin rather than
      // only on the next membership change.
      if (Array.isArray(msg.peers)) this.setRoster(msg.peers);
      makePlayer(this.nw, msg.slot).dynamic = false;
      return;
    }

    if (msg.type === 'roster') {
      if (Array.isArray(msg.peers)) this.setRoster(msg.peers);
      return;
    }

    if (msg.type === 'complete') {
      try { this.conn.send({ type: 'ack', for: 'complete' }); } catch {}
      // msg.{level,mode,next,done} — auto-advance: the driver reads next/
      // done to decide where to navigate. See the HANDOFF CONTRACT below.
      this.onComplete(msg);
      return;
    }

    if (msg.type === 'rejected') {
      this.end(msg.reason === 'bad-token'
        ? 'Could not rejoin the room — your session may have expired.'
        : 'Connection rejected by host.');
      return;
    }

    // Level channel — see the LEVEL MESSAGE CHANNEL section on the host
    // side. Validated even though it came from the host: the host is
    // more trusted than a peer, but it is still a remote machine, and
    // this payload goes straight to level code.
    if (msg.type === 'lvl') {
      if (!isSafeLevelPayload(msg.payload)) return;
      try { this.onLevelMsg(msg.payload); }
      catch (e) { console.error('[netcode] onLevelMsg threw:', e); }
      return;
    }

    if (msg.type !== 's') return;
    const snap = Codec.decode(msg);
    if (!snap) return;

    const now = performance.now();

    // A room reset (world.resetGeneration incrementing) teleports every
    // entity back to spawn in one tick. If even one old-generation
    // snapshot stayed in the buffer, interpolate() could bracket it
    // against a new-generation one and blend positions across the
    // discontinuity — everyone would appear to slide across the level
    // back to spawn instead of just being there. TELEPORT_DIST alone
    // can't be trusted to catch this: a death near spawn could produce a
    // displacement under that threshold and slip through as an ordinary
    // (wrong) blend. The generation counter is authoritative and cheap to
    // check, so it goes first — wipe the buffer clean the instant it
    // changes, before this snapshot (or anything already buffered) can
    // be paired against it.
    if (snap.gen !== this.resetGen) {
      this.buf.length = 0;
      this.resetGen = snap.gen;
    }

    // Too late to matter: the floor advances as old buffer entries get
    // trimmed (see trimBuffer below), meaning render time has already moved
    // past this tick. There is nowhere left to insert it — using it now
    // would mean rewinding what's already been shown. This is the only
    // case that's actually "packet lost" from the client's perspective.
    if (snap.tick <= this._floorTick) { this.stats.lateDropped++; return; }

    // Find where this tick belongs. The buffer is kept sorted by tick, not
    // by arrival order, so a packet that arrives late but still describes a
    // moment we haven't rendered past yet gets slotted into its correct
    // place instead of being thrown away just because something newer got
    // here first.
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1].tick > snap.tick) i--;
    if (i > 0 && this.buf[i - 1].tick === snap.tick) return;   // exact duplicate
    if (i < this.buf.length) this.stats.reordered++;            // arrived out of order, but used

    snap.recvAt = now;
    snap.vt = this.clock.observe(snap.tick, now);
    this.buf.splice(i, 0, snap);

    this.stats.gap = this.stats.lastRecv ? now - this.stats.lastRecv : 0;
    this.stats.lastRecv = now;
    this.stats.snaps++;
    this.jitter.sample(now);

    this.trimBuffer();
  },

  /**
   * Drop buffered entries that render time has fully passed, and raise the
   * floor to match. Kept separate from onData so both a normal push and a
   * reordered insert go through the same trim + floor-advance logic.
   */
  trimBuffer() {
    const at = performance.now() - this.jitter.delay;
    const buf = this.buf;
    // Keep at least one entry at/before render time (needed as "older") —
    // trim everything strictly before that one.
    let keepFrom = 0;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i + 1].vt <= at) keepFrom = i + 1; else break;
    }
    if (keepFrom > 0) {
      this._floorTick = Math.max(this._floorTick, buf[keepFrom - 1].tick);
      buf.splice(0, keepFrom);
    }
    // Hard cap regardless of render time, so a stalled render loop (tab
    // backgrounded, etc.) can't let the buffer grow without bound.
    if (buf.length > CFG.SNAP_BUFFER) {
      const overflow = buf.length - CFG.SNAP_BUFFER;
      this._floorTick = Math.max(this._floorTick, buf[overflow - 1].tick);
      buf.splice(0, overflow);
    }
  },

  end(reason) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this._handshakeTimer);
    this.onEnd(reason);
  },

  /**
   * Called when the underlying WebRTC connection reports instability
   * (ICE state moving away from 'connected' — a network path change, a
   * dropped STUN check, a wifi/cellular handoff). This is a LEADING
   * indicator: it fires the moment the transport notices trouble, before
   * that trouble has necessarily shown up as a missed or delayed
   * snapshot. The JitterTracker's EWMA would eventually widen the delay
   * on its own once packets actually start arriving late — but "eventually"
   * means after the stutter has already been visible. Reacting here closes
   * that gap: widen defensively now, and let the normal per-snapshot
   * easing (see JitterTracker.sample) settle it back down once conditions
   * are confirmed stable again, exactly as it would for any other jitter.
   */
  flagUnstable() {
    if (!this.jitter) return;
    const boosted = Math.min(CFG.INTERP_DELAY_MAX, this.jitter.delay * 1.6 + 40);
    this.jitter.delay = Math.max(this.jitter.delay, boosted);
    this.stats.instabilityEvents++;
  },

  /** Find the two snapshots bracketing render time, by their tick-derived
   *  virtual time — the buffer is sorted by tick, so this stays consistent
   *  even when a packet was reordered in after arriving late. */
  interpolate() {
    const buf = this.buf;
    if (!buf.length) return null;
    const at = performance.now() - this.jitter.delay;

    let older = buf[0], newer = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].vt <= at) { older = buf[i]; newer = buf[i + 1] || null; break; }
    }
    if (!newer && buf.length > 1 && older === buf[0]) newer = buf[1];

    const t = (newer && newer.vt > older.vt)
      ? Math.max(0, Math.min(1, (at - older.vt) / (newer.vt - older.vt)))
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
      if (b === undefined) return a;
      if (Math.abs(b - a) > CFG.TELEPORT_DIST) { this.stats.teleports++; return b; }
      return a + (b - a) * t;
    };

    for (const reg of TYPE_REGISTRY) {
      const olderList = older.types[reg.type];
      const newerMap = newer ? new Map(newer.types[reg.type].map(e => [e.key, e.state])) : null;

      if (reg.lifecycle === 'static') {
        for (const { key, state: a } of olderList) {
          const e = this.nw._staticById.get(key);
          if (!e) continue;                 // unknown id: ignore, never throw
          const b = newerMap && newerMap.get(key);
          this._applyBlended(e, reg, a, b, t, blend);
        }
        continue;
      }

      if (reg.type === 'player') {
        const seen = new Set();
        for (const { key: slot, state: a } of olderList) {
          seen.add(slot);
          const b = newerMap && newerMap.get(slot);
          const e = makePlayer(this.nw, slot);
          e.dynamic = false;
          this._applyBlended(e, reg, a, b, t, blend);
        }
        for (const slot of Array.from(this.nw.players.keys())) {
          if (!seen.has(slot)) dropPlayer(this.nw, slot);
        }
        continue;
      }

      // Generic dynamic non-player type (currently just projectile).
      let bucket = this.nw.dynamics.get(reg.type);
      if (!bucket) { bucket = new Map(); this.nw.dynamics.set(reg.type, bucket); }
      const seen = new Set();
      for (const { key, state: a } of olderList) {
        seen.add(key);
        const b = newerMap && newerMap.get(key);
        let obj = bucket.get(key);
        if (!obj) { obj = reg.makeLocal(key); bucket.set(key, obj); }
        this._applyBlended(obj, reg, a, b, t, blend);
      }
      for (const key of Array.from(bucket.keys())) if (!seen.has(key)) bucket.delete(key);
    }
  },

  /**
   * Apply one entity's older/newer state to a local object generically:
   * fields the type declared in `blendFields` (position-like — smoothed
   * with the teleport-distance safety check) get blended; every other
   * field (booleans, strings, discrete flags) is discrete by nature — a
   * lerp between "active" and "inactive" is meaningless — so it's just
   * taken from whichever snapshot is more current (newer if we have it,
   * else older), matching how plates already worked before this
   * generalized to every type.
   */
  _applyBlended(target, reg, a, b, t, blend) {
    const blendSet = reg.blendFields;
    for (const k in a) {
      if (blendSet && blendSet.includes(k)) {
        target[k] = b ? blend(a[k], b[k]) : a[k];
      } else {
        target[k] = b ? b[k] : a[k];
      }
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

  /** Draw list. Every entity is already at its interpolated position.
   *  Includes world.entities (every static/player type, all genuinely
   *  world.add()-ed) PLUS anything in nw.dynamics (currently projectiles)
   *  — those are plain objects materialized purely from snapshot data and
   *  never go through world.add() on the client, so they'd otherwise sync
   *  correctly but never actually render. */
  renderList() {
    const out = this._out; out.length = 0;
    const ents = this.nw.world.entities;
    for (let i = 0; i < ents.length; i++) out.push({ entity: ents[i], x: ents[i].x, y: ents[i].y });
    for (const bucket of this.nw.dynamics.values()) {
      for (const obj of bucket.values()) out.push({ entity: obj, x: obj.x, y: obj.y });
    }
    return out;
  },
};

/* ===========================================================================
   HANDOFF CONTRACT — what the page-level driver (lobby.js) is expected to do
   ---------------------------------------------------------------------------
   This file deliberately does not touch sessionStorage, the URL, or
   location.href — that's page/navigation policy, owned by lobby.js. This is
   the contract it needs to fulfill for the pieces above to work:

   1. HOST PEER ID IS THE ROOM CODE.
      `new Peer(roomCode, {...})` on every page the host is ever on for this
      room — lobby AND every level. This is what lets a client's
      `peer.connect(roomCode)` always reach the current host page, without
      needing to know the host's previous (now-dead) PeerJS id.

   2. STORAGE KEY, one per tab: sessionStorage['dt-session'] = JSON of:
        HOST:   { role:'host', roomCode, hostSnapshot }
                  where hostSnapshot = Host.snapshot(nextLevelIndex)
        CLIENT: { role:'client', roomCode, token, level }
                  where token = Client.myToken (captured from 'welcome'),
                  level = the index to load (from the 'complete'/'starting'
                  message that triggered this navigation).
      sessionStorage (not localStorage, not the URL) because it's
      per-tab, invisible, and dies with the tab — exactly the play
      session's natural lifetime.

   3. ON "START" FROM THE LOBBY (first hand-off, chosenLevel already agreed
      via the existing select/consensus flow):
        Host:   lock(level) -> write sessionStorage per (2) using
                snapshot(level) -> prepareHandoff() -> location.href to
                that level's page (from the level manifest — this file
                doesn't map index -> URL, lobby.js's own manifest does).
        Client: on receiving 'starting' -> write sessionStorage per (2),
                using Client.myToken -> location.href to the same page.

   4. ON LEVEL COMPLETE (auto-advance — see LEVEL COMPLETION):
        Host's onComplete(msg) fires with {level, mode, next, done}.
          - done:  write sessionStorage role:'host' with hostSnapshot
                    pointing back at the lobby (or just clear the session
                    key and go to the shared lobby page) -> prepareHandoff()
                    -> navigate to the lobby page.
          - !done: write sessionStorage using snapshot(msg.next) ->
                    prepareHandoff() -> navigate to LEVELS[msg.next].url.
        Client's onComplete(msg) fires with the same shape (see Client.onData)
          - mirrors the host's done/!done branching, using Client.myToken
            instead of a hostSnapshot, navigating to the same URL.

   5. ON PAGE LOAD, before showing any lobby UI: check sessionStorage['dt-session'].
        Present + role:'host' -> new Peer(roomCode) -> once open,
          Host.restore(peer, hostSnapshot, input, onStatus, onEnd, onComplete)
          -> game is already running, skip #screen-join/#screen-lobby entirely.
        Present + role:'client' -> new Peer() (id doesn't matter, it always
          connects out to roomCode) -> once open, peer.connect(roomCode) ->
          once THAT opens, Client.rejoin(conn, token, input, onStatus, onEnd,
          onComplete) -> skip straight to #screen-game.
        Absent -> today's flow: show #screen-join/#screen-lobby, Host.prepare()
          / Client.start() from a fresh room-code entry.

   6. LEVEL MANIFEST. Replaces Levels.order. Owned by lobby.js:
        LEVELS = [{ index, url, title }, ...]
      Level-select grid renders titles from this; hand-off navigation (3/4
      above) resolves an index to a URL from it. netcode.js only ever deals
      in indices (chosenLevel/next), never URLs.
   ========================================================================= */

window.Netcode = {
  CFG, BTN, INPUT_MASK,
  Codec, Validate, Host, Client, Tween, JitterTracker, TickClock,
  TYPE_REGISTRY, evaluateWinCondition, evaluateTurnMode, isSafeSyncState,
  isSafeLevelPayload,
  buildWorld, makePlayer, dropPlayer, stateToMask, maskToState, PALETTE,
};

})();
