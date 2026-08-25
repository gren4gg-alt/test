/* ==========================================================================
   engine.js — Pico-Park-style co-op platformer physics engine
   --------------------------------------------------------------------------
   Vanilla JS, no build step, no dependencies. Plain <script src="engine.js">
   (not an ES module) so it opens directly from disk with no local server.

   Everything is driven by World.step(dt) using a FIXED timestep (call it
   from an accumulator loop — see test.html). Keeping physics on a fixed
   step now means that later, when PeerJS multiplayer is added, host and
   peers can run the same deterministic step() and stay in sync (or at
   least reconcile predictably) instead of physics depending on frame rate.

   Entity types:
     StaticBody      – immovable solid (ground, walls)
     OneWayPlatform  – solid from above only; pass through from below/sides
     MovingPlatform  – kinematic, follows a path, carries riders
     Box             – dynamic, gravity + pushable, can be stood on/stacked
     Player          – dynamic, keyboard-driven (walk/jump), pushes boxes
     WindZone        – non-solid trigger volume that applies a force

   Coordinate system: x/y = top-left corner, +x right, +y down (canvas-y).
   ========================================================================== */

// Wrapped in an IIFE so none of the classes/consts below leak into the
// page's global lexical scope (a top-level `class World {}` in a classic
// script isn't a `window.World` property, but it IS a global `let`-style
// binding — which would collide with `const { World } = window.Engine`
// in test.html). Only the final `window.Engine` object is exposed.
(function () {

// ---------------------------------------------------------------------------
// Tunables — the "feel" of the game lives here. Adjust freely.
// ---------------------------------------------------------------------------
const PHYSICS = {
  GRAVITY:          1700,  // px/s^2
  MAX_FALL_SPEED:   1400,  // px/s, terminal velocity
  MOVE_SPEED:        260,  // px/s, player top walk speed
  GROUND_ACCEL:     2600,  // px/s^2, how fast player reaches MOVE_SPEED on ground
  AIR_ACCEL:        1400,  // px/s^2, slightly less control in the air
  GROUND_FRICTION:  2600,  // px/s^2 — currently unused by Player (stopping is instant, see handleInput); kept for tuning if you reintroduce coast
  AIR_FRICTION:      400,  // px/s^2 — currently unused by Player, same reason
  JUMP_VELOCITY:      560,  // px/s (upward, so applied as -JUMP_VELOCITY)
  JUMP_CUT_MULT:      0.5,  // vy multiplier applied if jump released early (short hop)
  COYOTE_TIME:        0.10, // s, grace period to still jump after walking off a ledge
  JUMP_BUFFER:        0.12, // s, grace period for a jump press just before landing
  BOX_FRICTION:      2200,  // px/s^2, grounded boxes losing any residual push/wind momentum (never applied mid-air — see World.step — so a thrown box's arc isn't distorted)
  PICKUP_RANGE:        16,  // px, how far in front of the player a box can be grabbed from
  PUSH_MAX_DEPTH:        8, // max chain length when pushing a line of boxes

  // --- FIX 5: Delta Accumulator Protection (engine-level guard) ---
  // A hard ceiling on the dt a single World.step() call will ever
  // integrate, regardless of what's passed in. This exists as a
  // defense-in-depth safeguard independent of any accumulator loop a
  // consumer writes: if a tab is backgrounded and comes back after
  // several seconds, or a caller calls step() directly with a large or
  // unvalidated dt, one huge step would otherwise apply that much
  // gravity/velocity in a single integration — enough to tunnel through
  // thin geometry, and enough to produce a genuine "spiral of death" if
  // a naive accumulator loop keeps re-feeding a growing backlog. Capping
  // it here means engine.js is safe even if a consumer's own game loop
  // forgets to clamp its frame delta (test.html/puzzle_test.html/netcode
  // already do this in their own accumulator loops — this is a second,
  // independent floor under all of them, not a replacement for it).
  MAX_STEP_DT:        0.25, // s — matches the clamp already used in every consumer's own loop

  // --- Camera-bound movement (screen-edge constraint) ---
  CAMERA_PAN_SPEED:    420, // px/s — how fast the camera rect itself can move. Faster
                             // than MOVE_SPEED (260) so a lone walking player doesn't
                             // outrun the frame; still eased, not instant, per the
                             // "pan smoothly" requirement.
  CAMERA_WALL_THICKNESS: 400, // px — depth of the invisible boundary walls. Just needs
                               // to exceed the largest possible single-substep travel
                               // distance (bounded by SUB_STEP=1/60 and MAX_FALL_SPEED,
                               // ~23px) so nothing can tunnel through in one tick; sized
                               // generously well beyond that with margin to spare.

  // --- BouncingBall defaults (both overridable per-ball via config) ---
  BALL_DEFAULT_FRICTION: 60,  // px/s^2 — speed decay rate. Tunable per-ball; see BouncingBall.
  BALL_MIN_SPEED:        80,  // px/s — friction floors speed here rather than at 0, so a
                               // ball never goes fully dead and stops being a threat. See
                               // the BouncingBall class doc for the reasoning.

  // --- Player invulnerability (grace period after spawn/respawn) ---
  DEFAULT_INVULN_DURATION: 0.5, // s — matches the turn-relay spec's spawn grace period;
                                 // used as grantInvulnerability()'s default when called
                                 // with no explicit duration.
};

const EPS = 0.02;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function approach(current, target, maxDelta) {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
}

// ---------------------------------------------------------------------------
// Entity base class
// ---------------------------------------------------------------------------
let _nextId = 1;

class Entity {
  constructor(x, y, w, h) {
    this.id = _nextId++;
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.vx = 0; this.vy = 0;

    this.solid = true;       // participates in collision at all
    this.dynamic = false;    // affected by gravity / moves under its own physics
    this.pushable = false;   // can be shoved sideways by a pusher
    this.oneWay = false;     // solid from top only (falling onto it)
    this.isWindZone = false; // non-solid force volume
    this.isHazard = false;   // non-solid volume that kills players on contact
    this.dead = false;       // set by World's death pass; see Hazard / World.deathY

    this.grounded = false;
    this.groundEntity = null; // what this entity is currently resting on (if any)
    this.world = null;

    this.color = '#888';
  }

  get top() { return this.y; }
  get bottom() { return this.y + this.h; }
  get left() { return this.x; }
  get right() { return this.x + this.w; }
  get centerX() { return this.x + this.w / 2; }
  get centerY() { return this.y + this.h / 2; }

  /**
   * Default sync contract: bare position, nothing else. Most entities
   * (MovingPlatform among them) need nothing more — a pure-interpolation
   * client never runs updatePath()/physics itself, so position alone
   * fully encodes what it needs to draw. Types with additional synced
   * state override this (see Box, which also needs `carried`; every
   * puzzle-mechanic class already defines its own for the same reason).
   */
  getSyncState() { return { x: this.x, y: this.y }; }
  applySyncState(s) { this.x = s.x; this.y = s.y; }
}

// ---------------------------------------------------------------------------
// StaticBody — ground, walls, ceilings. Never moves.
// ---------------------------------------------------------------------------
class StaticBody extends Entity {
  constructor(x, y, w, h) {
    super(x, y, w, h);
    this.color = '#4a4e5a';
  }
}

// ---------------------------------------------------------------------------
// OneWayPlatform — solid only when something lands on top of it moving down.
// Jumping up through it or walking through the side passes right through.
// ---------------------------------------------------------------------------
class OneWayPlatform extends Entity {
  constructor(x, y, w, h) {
    super(x, y, w, h);
    this.oneWay = true;
    this.color = '#c9a24b';
  }
}

// ---------------------------------------------------------------------------
// MovingPlatform — kinematic body that follows a looping path defined by
// waypoints. Carries any entity resting on top of it, and shoves entities
// it runs into from the side. Halts (without losing its patrol state) if
// moving would push a rider or an entity in its way into another solid
// with no room — see World.step.
//
// path: array of {x, y} waypoints (absolute coordinates of the platform's
//       top-left corner). speed: px/s travelled along the path. The
//       platform ping-pongs back and forth between waypoints by default
//       (loop='pingpong'), or wraps ('loop'). oneWay: pass true to make
//       this platform solid from the top only (jump up through it, land
//       on top) — e.g. an elevator you can also duck under — exactly
//       like a static OneWayPlatform, just kinematic.
// ---------------------------------------------------------------------------
class MovingPlatform extends Entity {
  constructor(x, y, w, h, path, speed = 80, loopMode = 'pingpong', oneWay = false) {
    super(x, y, w, h);
    this.path = path && path.length ? path : [{ x, y }];
    this.speed = speed;
    this.oneWay = oneWay;
    this.loopMode = loopMode;
    this._segIndex = 0;
    this._dir = 1;
    this.color = '#5f8ac9';
    // deltas applied this frame, read by World.step to carry riders
    this.dx = 0;
    this.dy = 0;
  }

  updatePath(dt) {
    const prevX = this.x, prevY = this.y;

    if (this.path.length > 1) {
      let target = this.path[this._segIndex];
      let dx = target.x - this.x;
      let dy = target.y - this.y;
      let dist = Math.hypot(dx, dy);
      let step = this.speed * dt;

      // Iteration cap as defense-in-depth. The `dist < EPS` break below
      // already catches the obvious degenerate cases (duplicate or
      // sub-EPS-apart waypoints — all verified non-hanging), but this
      // loop advances waypoints in an unbounded `while`, so a path shape
      // that consumes `step` too slowly to terminate would lock the
      // browser tab outright rather than just glitching. A hard cap
      // turns any such case into a harmless one-frame stall. 100 is far
      // above any legitimate path: it would take a platform crossing 100
      // waypoints in a single frame to reach it.
      let guard = 0;
      while (step > 0 && guard++ < 100) {
        if (dist <= step || dist < EPS) {
          this.x = target.x;
          this.y = target.y;
          step -= dist;
          // advance to next waypoint
          if (this.loopMode === 'pingpong') {
            if (this._segIndex + this._dir >= this.path.length || this._segIndex + this._dir < 0) {
              this._dir *= -1;
            }
            this._segIndex += this._dir;
          } else { // 'loop'
            this._segIndex = (this._segIndex + 1) % this.path.length;
          }
          target = this.path[this._segIndex];
          dx = target.x - this.x;
          dy = target.y - this.y;
          dist = Math.hypot(dx, dy);
          if (dist < EPS) break; // avoid infinite loop on degenerate path
        } else {
          const nx = dx / dist, ny = dy / dist;
          this.x += nx * step;
          this.y += ny * step;
          step = 0;
        }
      }
    }

    this.dx = this.x - prevX;
    this.dy = this.y - prevY;
  }
}

// ---------------------------------------------------------------------------
// WindZone — non-solid area that applies a constant force to any dynamic
// entity whose AABB overlaps it. Great for gusts you have to fight/ride.
// ---------------------------------------------------------------------------
class WindZone extends Entity {
  constructor(x, y, w, h, forceX = 0, forceY = 0, maxSpeed = 500) {
    super(x, y, w, h);
    this.solid = false;
    this.isWindZone = true;
    this.forceX = forceX;   // px/s^2
    this.forceY = forceY;   // px/s^2
    this.maxSpeed = maxSpeed; // clamp on the component(s) wind affects
    this.color = 'rgba(140, 210, 255, 0.18)';
  }
}

// ---------------------------------------------------------------------------
// TriggerZone — a generic, non-solid rectangle that reports overlap and
// applies a configurable `effect`. This is the primitive to reach for
// whenever a level needs "a region that does something when you're in
// it"; adding a new region behaviour should mean adding an `effect`
// string here, NOT a new entity class.
//
// effect:
//   'kill'  — kills any Player overlapping it (spikes, lava, crushers,
//             saw blades — all the same primitive, drawn differently).
//   'goal'  — inert: kills nothing, blocks nothing. It only tracks which
//             players are currently overlapping (`touching`, a Set of
//             entity ids, plus `touchCount`). Deliberately no win logic
//             here — "all players on the goal at once" vs "any player" vs
//             "hold for 2s" is a game-rules decision that belongs to the
//             level/netcode layer, which reads this state and decides.
//
// `kind` is cosmetic only and never read by physics — use it to pick a
// sprite/colour ('spikes', 'lava', 'exit', ...).
//
// killsBoxes (effect 'kill' only): off by default. Most puzzles want a
// box to survive lava so it can be used as a bridge/shield; set true for
// "destroy the crate" puzzles. Boxes are despawned rather than flagged
// dead (only Players carry a `dead` pose), and are restored on
// resetLevel() so a lost box can't leave the room unsolvable.
// ---------------------------------------------------------------------------
class TriggerZone extends Entity {
  constructor(x, y, w, h, { effect = 'kill', kind = null, killsBoxes = false } = {}) {
    super(x, y, w, h);
    this.solid = false;
    this.isTrigger = true;
    this.effect = effect;
    this.kind = kind || (effect === 'goal' ? 'exit' : 'spikes');
    this.killsBoxes = killsBoxes;

    // Only meaningful for effect 'goal'; recomputed every frame from
    // resolved positions, so it never latches (matches PressurePlate).
    this.touching = new Set();
    this.touchCount = 0;

    this.color = effect === 'goal'
      ? 'rgba(90, 210, 140, 0.45)'
      : 'rgba(220, 70, 70, 0.55)';
  }

  /** True while this zone kills players — kept as a helper so the death
   *  pass doesn't hardcode effect-string comparisons all over. */
  get isHazard() { return this.effect === 'kill'; }
  set isHazard(v) { /* legacy no-op: effect is the source of truth */ }

  getSyncState() {
    return {
      effect: this.effect,
      touching: Array.from(this.touching),
      touchCount: this.touchCount,
    };
  }

  applySyncState(s) {
    this.effect = s.effect;
    this.touching = new Set(s.touching || []);
    this.touchCount = s.touchCount || 0;
  }
}

// ---------------------------------------------------------------------------
// Hazard — thin back-compat wrapper over TriggerZone{effect:'kill'}.
// Kept so existing levels and the netcode entity table keep working;
// prefer TriggerZone directly in new level data.
// ---------------------------------------------------------------------------
class Hazard extends TriggerZone {
  constructor(x, y, w, h, { kind = 'spikes', killsBoxes = false } = {}) {
    super(x, y, w, h, { effect: 'kill', kind, killsBoxes });
  }
}

// ---------------------------------------------------------------------------
// Projectile — a single emitted body (arrow, rock, fireball). Not placed
// directly by level design; ProjectileSpawner creates these. Non-solid by
// design: an arrow in flight shouldn't be standable or pushable, and
// shouldn't perturb the main collision pass. Its motion and its overlap
// checks run in a dedicated pass in World.step so it stays fully
// self-contained and deterministic.
// ---------------------------------------------------------------------------
class Projectile extends Entity {
  constructor(x, y, w, h, cfg) {
    super(x, y, w, h);
    this.solid = false;
    this.dynamic = false;      // integrated by the projectile pass, not the dynamics pass
    this.isProjectile = true;
    this.gravity = cfg.gravity;
    this.killsPlayers = cfg.killsPlayers;
    this.collidesWithBoxes = cfg.collidesWithBoxes;
    this.despawn = cfg.despawn;
    this.spawnerId = cfg.spawnerId;
    this.kind = cfg.kind;
    this.color = cfg.color;
    this.landed = false;       // set when it hits geometry (despawn 'onLand' only)
  }

  getSyncState() {
    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy, landed: this.landed };
  }
  applySyncState(s) {
    this.x = s.x; this.y = s.y; this.vx = s.vx; this.vy = s.vy; this.landed = s.landed;
  }
}

// ---------------------------------------------------------------------------
// ProjectileSpawner — generic timed emitter. One class covers falling
// arrows, horizontal dart traps, lobbed fireballs, etc., purely through
// config; adding a projectile-style hazard should mean new config, NOT a
// new entity class.
//
// config:
//   vx, vy          launch velocity (px/s). Straight-down arrows: vx 0,
//                   vy positive. Side dart trap: vx negative, gravity 0.
//   gravity         px/s^2 applied to the projectile. Defaults to the
//                   world's gravity for a natural parabola; pass 0 for a
//                   dead-straight line (the "no-gravity variant").
//   interval        seconds between spawns.
//   phase           seconds of offset before the first spawn. Lets a row
//                   of spawners fire in a staggered wave from pure
//                   config, with no randomness — important, since
//                   randomness would break host/peer determinism.
//   killsPlayers    default true.
//   collidesWithBoxes  default false (per the arrow spec) — arrows pass
//                   through crates. Set true and a box will block/absorb
//                   the projectile, which is how you'd build "hide behind
//                   the crate" puzzles.
//   despawn         'bounds' (default) or 'onLand'.
//   w, h            projectile size. kind/color are cosmetic.
//
// DESPAWN RULE — reasoning: 'bounds' is the default because it's the
// simpler and safer of the two. It needs no landing detection at all
// (just "am I outside the level"), it reuses the same recoverable
// despawn path everything else uses, and it can never leave a projectile
// stuck mid-level in a weird state. 'onLand' is also supported because
// it's genuinely cheap here (the projectile pass already has to detect
// geometry contact to stop the arrow) and because for dense arrow traps
// it's the difference between arrows vanishing on impact vs. sitting in
// the floor until they exit the level. Neither is a physics correctness
// question, so both are exposed and levels can pick per-trap.
// ---------------------------------------------------------------------------
class ProjectileSpawner extends Entity {
  constructor(x, y, {
    vx = 0, vy = 200, gravity = null,
    interval = 2, phase = 0,
    killsPlayers = true, collidesWithBoxes = false,
    despawn = 'bounds',
    w = 8, h = 20,
    kind = 'arrow', color = '#d8d8e0',
    enabled = true,
  } = {}) {
    super(x, y, 0, 0);   // the spawner itself is a point; it has no body
    this.solid = false;
    this.isSpawner = true;

    this.launchVx = vx;
    this.launchVy = vy;
    this.projGravity = gravity;      // null => use world gravity
    this.interval = interval;
    this.phase = phase;
    this.killsPlayers = killsPlayers;
    this.collidesWithBoxes = collidesWithBoxes;
    this.despawnRule = despawn;
    this.projW = w;
    this.projH = h;
    this.kind = kind;
    this.projColor = color;
    this.enabled = enabled;

    // Counts UP; a projectile fires each time it crosses `interval`.
    // Starting at -phase delays the first shot by exactly `phase`
    // seconds. Pure accumulator, no randomness, so two peers stepping
    // the same ticks emit on identical frames.
    this._timer = -phase;
    this.color = '#7a7f95';
  }

  /** Called once per step by World.step; returns projectiles to add. */
  update(dt, world) {
    if (!this.enabled) return null;
    this._timer += dt;
    if (this._timer < this.interval) return null;

    // Subtract rather than zero, so a long dt (or an interval shorter
    // than the step) doesn't silently drop shots or drift the cadence.
    const out = [];
    let guard = 0;
    while (this._timer >= this.interval && guard++ < 16) {
      this._timer -= this.interval;
      out.push(this.emit(world));
    }
    return out;
  }

  emit(world) {
    const p = new Projectile(
      this.x - this.projW / 2,
      this.y - this.projH / 2,
      this.projW, this.projH,
      {
        gravity: this.projGravity === null ? world.gravity : this.projGravity,
        killsPlayers: this.killsPlayers,
        collidesWithBoxes: this.collidesWithBoxes,
        despawn: this.despawnRule,
        spawnerId: this.id,
        kind: this.kind,
        color: this.projColor,
      }
    );
    p.vx = this.launchVx;
    p.vy = this.launchVy;
    return p;
  }

  getSyncState() { return { timer: this._timer, enabled: this.enabled }; }
  applySyncState(s) { this._timer = s.timer; this.enabled = s.enabled; }
}

// ---------------------------------------------------------------------------
// BouncingBall — a persistent, never-despawning hazard that moves in an
// arbitrary 2D direction, reflects off its containment on every axis, and
// slowly decelerates. Deliberately NOT built on Projectile: a Projectile
// is a one-shot parabola (gravity pulls it down, it lands/despawns and is
// gone) — a BouncingBall has no gravity, keeps whatever direction it's
// given until a wall changes it, and is meant to be a permanent fixture
// of the room for as long as the level runs.
//
// CONTAINMENT — two supported modes, matching the two ways a level might
// want to define "the room":
//   bounds: {minX,minY,maxX,maxY} — reflect off this exact rect. Cheap
//     (no per-frame geometry lookup), fully deterministic, and the
//     natural fit for a sealed rectangular room (which is what prompted
//     this feature) — this is the PRIMARY, best-tested path.
//   bounds: null — fall back to reflecting off actual solid geometry
//     (like Projectile's own geometry-contact check), for a room that
//     isn't a plain rectangle. Uses minimum-penetration axis selection
//     (the same MTV approach moveXWithCollision/moveYWithCollision use)
//     to decide whether a given contact is a horizontal or vertical hit.
//
// FRICTION — decelerates SPEED (the vx/vy vector's magnitude) toward
// minSpeed while preserving direction, rather than damping vx and vy
// independently (which would warp the direction of travel over time,
// not just slow it down). Floored at minSpeed rather than 0 — asked and
// answered explicitly: a ball that could fully stop would eventually
// stop being a hazard at all, which contradicts "continuously bouncing
// ... indefinitely." Both friction and minSpeed are tunable per-ball.
//
// BALL-VS-BALL: balls do not collide with each other, only with the
// containment and with Players — same precedent as Projectiles from
// different spawners, which also don't interact with one another. Kept
// simple deliberately; genuinely easy to add later (pairwise elastic
// bounce) if a level needs it, but nothing currently asks for it.
//
// Non-solid (`solid = false`) and NOT routed through the main `dynamics`
// pass — same reasoning as Projectile: it shouldn't be standable,
// pushable, or able to shove a platform, and gravity should never touch
// it. Self-contained update() call, invoked from its own pass in
// World._stepOnce, same pattern as the projectile pass.
// ---------------------------------------------------------------------------
class BouncingBall extends Entity {
  constructor(x, y, w, h, config = {}) {
    super(x, y, w, h);
    this.solid = false;
    this.dynamic = false;
    this.isBouncingBall = true;

    this.vx = config.vx || 0;
    this.vy = config.vy || 0;
    this.friction = config.friction !== undefined ? config.friction : PHYSICS.BALL_DEFAULT_FRICTION;
    this.minSpeed = config.minSpeed !== undefined ? config.minSpeed : PHYSICS.BALL_MIN_SPEED;
    this.killsPlayers = config.killsPlayers !== false; // default true
    this.bounds = config.bounds || null; // {minX,minY,maxX,maxY} | null -> geometry fallback
    this.color = config.color || '#e0c845';
  }

  /** Called once per tick by World._stepOnce's bouncing-ball pass. */
  update(world, dt) {
    // Friction: decay the SPEED magnitude toward minSpeed, rescaling
    // vx/vy to match so direction is preserved exactly.
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > EPS) {
      const newSpeed = approach(speed, this.minSpeed, this.friction * dt);
      const scale = newSpeed / speed;
      this.vx *= scale;
      this.vy *= scale;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.bounds) this._reflectBounds(this.bounds);
    else this._reflectGeometry(world);

    if (!this.killsPlayers) return;
    for (const e of world.entities) {
      if (!(e instanceof Player) || e.dead || e.invulnerableTimer > 0) continue;
      if (aabbOverlap(this, e)) { world.killPlayer(e); break; }
    }
  }

  _reflectBounds(b) {
    if (this.x < b.minX) { this.x = b.minX; this.vx = Math.abs(this.vx); }
    else if (this.x + this.w > b.maxX) { this.x = b.maxX - this.w; this.vx = -Math.abs(this.vx); }
    if (this.y < b.minY) { this.y = b.minY; this.vy = Math.abs(this.vy); }
    else if (this.y + this.h > b.maxY) { this.y = b.maxY - this.h; this.vy = -Math.abs(this.vy); }
  }

  _reflectGeometry(world) {
    for (const other of world.entities) {
      if (!other.solid || other.oneWay || other.isCameraWall || other === this) continue;
      if (!aabbOverlap(this, other)) continue;

      // Minimum-penetration axis selection — same disambiguation
      // principle used throughout the engine's own solid collision
      // (see moveXWithCollision/moveYWithCollision): whichever side has
      // the shallower overlap is the side that was actually hit.
      const overlapLeft = this.x + this.w - other.x;
      const overlapRight = other.x + other.w - this.x;
      const overlapX = Math.min(overlapLeft, overlapRight);
      const overlapTop = this.y + this.h - other.y;
      const overlapBottom = other.y + other.h - this.y;
      const overlapY = Math.min(overlapTop, overlapBottom);

      if (overlapX < overlapY) {
        if (overlapLeft < overlapRight) { this.x = other.x - this.w; this.vx = -Math.abs(this.vx); }
        else { this.x = other.x + other.w; this.vx = Math.abs(this.vx); }
      } else {
        if (overlapTop < overlapBottom) { this.y = other.y - this.h; this.vy = -Math.abs(this.vy); }
        else { this.y = other.y + other.h; this.vy = Math.abs(this.vy); }
      }
    }
  }

  getSyncState() { return { x: this.x, y: this.y, vx: this.vx, vy: this.vy }; }
  applySyncState(s) { this.x = s.x; this.y = s.y; this.vx = s.vx; this.vy = s.vy; }
}

// ---------------------------------------------------------------------------
// Box — dynamic, falls under gravity, can be pushed horizontally by a
// Player (or by another pusher), can be stood/stacked on.
// ---------------------------------------------------------------------------
class Box extends Entity {
  constructor(x, y, w, h) {
    super(x, y, w, h);
    this.dynamic = true;
    this.pushable = true;
    this.color = '#b06b3a';
    this.carried = false;   // true while held by a player — excluded from gravity/collision (see World.step)
    this.carriedBy = null;

    // Per-box override of World.defaultBoxDeathPolicy — null means "use
    // the world default." Set directly from level code for a box that
    // needs different treatment than the rest (e.g. most boxes respawn
    // quietly, but a single key-carrying box failing the level if lost).
    // See World._killBox for what each value does.
    this.deathPolicy = null; // null | 'respawn' | 'reset' | 'ignore'

    // Where a 'respawn' brings this box back. null falls back to its
    // original spawn position (captured automatically by World.add).
    // Set directly from level code for a custom respawn location (e.g.
    // a dispenser location rather than wherever the box started).
    this.respawnPoint = null; // { x, y } | null
  }

  getSyncState() { return { x: this.x, y: this.y, carried: this.carried }; }
  applySyncState(s) { this.x = s.x; this.y = s.y; this.carried = s.carried; }
}

// ---------------------------------------------------------------------------
// Player — dynamic, keyboard-controlled. Call handleInput() once per fixed
// step BEFORE world.step(), so input-driven velocity is in place before
// gravity/collision run for the frame.
// ---------------------------------------------------------------------------
class Player extends Entity {
  constructor(x, y, w = 28, h = 40) {
    super(x, y, w, h);
    this.dynamic = true;
    this.pushable = false; // players aren't shoved around by boxes in v1
    this.color = '#4bd07a';

    this.facing = 1;
    this._coyoteTimer = 0;     // counts UP since last time grounded
    this._jumpBufferTimer = 999; // counts UP since jump was pressed
    this._wasJumpHeld = false; // previous frame's input.jump, for edge detection
    this.carrying = null;      // Box currently held, or null
    this._wasActionHeld = false; // previous frame's input.action, for edge detection

    // Seconds remaining of immunity to CONTACT kills (hazards,
    // projectiles, bouncing balls) — see World._stepOnce's decrement
    // pass and each kill site's guard. Deliberately does NOT protect
    // against falling past deathY: invulnerability means "can't be hit
    // by something," not "can't fail to keep standing." Zero = normal
    // (vulnerable).
    this.invulnerableTimer = 0;
  }

  /** Grant (or extend) contact-kill immunity. Uses Math.max so a second
   *  call while already invulnerable never SHORTENS an existing grant. */
  grantInvulnerability(seconds = PHYSICS.DEFAULT_INVULN_DURATION) {
    this.invulnerableTimer = Math.max(this.invulnerableTimer, seconds);
  }

  /**
   * input: { left: bool, right: bool, jump: bool (held state) }
   * Sets this.vx / this.vy for the upcoming physics step. Actual movement
   * + collision happens later in World.step().
   */
  handleInput(input, dt) {
    // A dead player accepts no input — without this, holding a movement
    // key keeps re-setting vx every frame even though the death pass
    // zeroed it and the corpse is excluded from movement, so the player
    // would report full walk speed while lying still. That phantom
    // velocity feeds character.js (walk-cycle squash) and any netcode
    // reading vx, exactly like the jammed-box-push case.
    if (this.dead) { this.vx = 0; this.vy = 0; return; }

    const targetVx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (targetVx !== 0) this.facing = targetVx;

    const accel = this.grounded ? PHYSICS.GROUND_ACCEL : PHYSICS.AIR_ACCEL;

    if (targetVx !== 0) {
      // Ramp up toward top speed on key-down (this is the only place
      // GROUND_ACCEL / AIR_ACCEL are used now).
      this.vx = approach(this.vx, targetVx * PHYSICS.MOVE_SPEED, accel * dt);
    } else {
      // Arcade-style instant stop on key-up — no coast/glide. If you want
      // deceleration back, swap this for
      // approach(this.vx, 0, (this.grounded ? PHYSICS.GROUND_FRICTION : PHYSICS.AIR_FRICTION) * dt)
      this.vx = 0;
    }

    // Coyote time bookkeeping (grounded reflects *previous* step's result).
    if (this.grounded) this._coyoteTimer = 0;
    else this._coyoteTimer += dt;

    // Jump buffering: remember a fresh press even if we're not grounded yet.
    const jumpPressed = input.jump && !this._wasJumpHeld;
    if (jumpPressed) this._jumpBufferTimer = 0;
    else this._jumpBufferTimer += dt;

    const canJump = this._coyoteTimer <= PHYSICS.COYOTE_TIME;
    const wantsJump = this._jumpBufferTimer <= PHYSICS.JUMP_BUFFER;

    // Short hop: cut the ascent exactly once, on the frame jump is
    // *released* (the held -> not-held edge) — not on every subsequent
    // frame jump happens to be up. Applying it continuously would also
    // fight any other source of upward velocity (wind zones, moving
    // platforms) any time the player isn't actively holding jump.
    const jumpReleased = this._wasJumpHeld && !input.jump;

    if (canJump && wantsJump) {
      this.vy = -PHYSICS.JUMP_VELOCITY;
      this.grounded = false;
      this.groundEntity = null;
      this._coyoteTimer = PHYSICS.COYOTE_TIME + 1; // consume
      this._jumpBufferTimer = PHYSICS.JUMP_BUFFER + 1; // consume
    } else if (jumpReleased && this.vy < 0) {
      this.vy *= PHYSICS.JUMP_CUT_MULT;
    }

    this._wasJumpHeld = input.jump;
  }

  /**
   * Snapshot contract for the networking layer. `dead` is the field
   * character.js reads to draw the death pose — it was previously
   * hardcoded false at the call site.
   *
   * The underscore-prefixed timers are included deliberately: they're
   * "private" to gameplay but are genuine simulation state, and the
   * rollback/prediction layer needs them to reproduce a tick exactly.
   * Renaming any of them is a cross-file breaking change.
   */
  getSyncState() {
    return {
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      facing: this.facing,
      grounded: this.grounded,
      dead: this.dead,
      carryingId: this.carrying ? this.carrying.id : null,
      _coyoteTimer: this._coyoteTimer,
      _jumpBufferTimer: this._jumpBufferTimer,
      _wasJumpHeld: this._wasJumpHeld,
      _wasActionHeld: this._wasActionHeld,
      invulnerableTimer: this.invulnerableTimer,
    };
  }

  applySyncState(s) {
    this.x = s.x; this.y = s.y; this.vx = s.vx; this.vy = s.vy;
    this.facing = s.facing;
    this.grounded = s.grounded;
    this.dead = s.dead;
    if (s.invulnerableTimer !== undefined) this.invulnerableTimer = s.invulnerableTimer;
    if (s._coyoteTimer !== undefined) {
      this._coyoteTimer = s._coyoteTimer;
      this._jumpBufferTimer = s._jumpBufferTimer;
      this._wasJumpHeld = s._wasJumpHeld;
      this._wasActionHeld = s._wasActionHeld;
    }
    // carryingId is resolved by the caller (it needs the entity table);
    // left out here so this method stays dependency-free.
  }
}

// ---------------------------------------------------------------------------
// Collision resolution helpers
// ---------------------------------------------------------------------------

// Everyone this entity should be blocked/pushed by (excludes itself,
// non-solid things like wind zones, and the box this entity is currently
// carrying — a held box moves *with* its holder, so treating it as an
// obstacle would wedge the holder against their own cargo).
// Everyone this entity should be blocked/pushed by (excludes itself,
// non-solid things like wind zones, the box this entity is currently
// carrying — a held box moves *with* its holder, so treating it as an
// obstacle would wedge the holder against their own cargo — and, for
// anything that isn't a Player, camera boundary walls).
//
// Camera walls only ever block Players: "the group can't leave the
// screen" is a constraint on the playable characters, not on props.
// Concretely this means a box CAN be pushed past the camera boundary —
// the player pushing it gets stopped at the wall (their own solidsFor
// still includes it), but the box itself doesn't see the wall as an
// obstacle, so it keeps going. A box that ends up off-screen this way
// just sits there until the camera happens to pan back over it, OR
// until it falls into an actual hazard/deathY zone, which is what
// World._killBox's respawn mechanic exists to recover from — see there
// for the (per-level-customizable) policy.
function solidsFor(world, self) {
  return world.entities.filter(e => {
    if (e === self || !e.solid) return false;
    if (e.isCameraWall && !(self instanceof Player)) return false;
    if (self.carrying === e) return false;
    if (e.carriedBy === self) return false;
    return true;
  });
}

/**
 * Where a held box should sit relative to its holder, in preference
 * order. A held box keeps full collision (it is NOT made non-solid), so
 * it can't be shoved through walls or other boxes just because someone
 * is carrying it. If the preferred spot is obstructed we try the
 * alternatives before falling back to the last position that fit.
 */
function carryPositions(holder, box) {
  const front = holder.facing > 0 ? holder.right + 2 : holder.left - box.w - 2;
  const back  = holder.facing > 0 ? holder.left - box.w - 2 : holder.right + 2;
  return [
    // Overhead is the primary spot: it keeps the box clear of walls the
    // holder is walking up against, which is the common case.
    { x: holder.centerX - box.w / 2, y: holder.y - box.h - 2 },
    { x: front, y: holder.y + (holder.h - box.h) / 2 },
    { x: back,  y: holder.y + (holder.h - box.h) / 2 },
  ];
}

/** Would `box` at (x,y) overlap anything solid other than its holder? */
function carrySpotFree(world, box, holder, x, y) {
  const probe = { x, y, w: box.w, h: box.h };
  for (const other of world.entities) {
    if (other === box || other === holder || !other.solid) continue;
    if (other.oneWay) continue; // transparent; never blocks a carried box
    if (aabbOverlap(probe, other)) return false;
  }
  return true;
}

/**
 * --- FIX 2: Box Pickup/Drop Clipping in Tight Spaces ---
 * Find where a carried box should sit this frame. Tries the three named
 * spots (overhead, front, back) first — cheap, and covers the vast
 * majority of cases. If a player turns around inside a tight corridor
 * with walls close on both sides and a low ceiling, all three can fail
 * simultaneously; previously that left the box frozen at its last valid
 * position forever, silently falling further behind the holder as they
 * kept moving.
 *
 * The fallback searches progressively wider rings of positions around
 * the holder — starting just outside the box's own footprint (the
 * tightest ring that could possibly fit it) and widening only if
 * nothing there works — and returns whichever free spot is closest to
 * the box's *current* position. That means the box always slides toward
 * the nearest actually-reachable spot next to the holder rather than
 * teleporting or freezing. Only if nothing is free at any radius tried
 * does it return null, and even then the caller leaves the box exactly
 * where it was rather than forcing it into a wall.
 */
function findCarrySpot(world, box, holder) {
  for (const spot of carryPositions(holder, box)) {
    if (carrySpotFree(world, box, holder, spot.x, spot.y)) return spot;
  }

  // Search progressively wider rings starting from very close to the
  // holder — small radius steps so a good nearby spot is never skipped
  // over on the way to checking farther ones (an earlier version of
  // this used a coarse "half box diagonal" starting radius as a
  // pre-filter meant to avoid overlapping the holder itself, but that
  // pushed the closest ring searched out to ~30px, silently skipping
  // past perfectly valid 6px-away spots — carrySpotFree already
  // excludes the holder from its own overlap check, so no such
  // pre-filter is needed; small radii are safe to try directly).
  const maxRadius = Math.max(holder.w, holder.h) * 3;
  const radiusSteps = 10;
  const stepsPerRing = 16;

  for (let r = 1; r <= radiusSteps; r++) {
    const radius = (maxRadius * r) / radiusSteps;
    let best = null, bestDist = Infinity;
    for (let i = 0; i < stepsPerRing; i++) {
      const angle = (i / stepsPerRing) * Math.PI * 2;
      const x = holder.centerX + Math.cos(angle) * radius - box.w / 2;
      const y = holder.centerY + Math.sin(angle) * radius - box.h / 2;
      // carrySpotFree deliberately excludes the holder from its overlap
      // check (so the named front/back/overhead spots, which sit right
      // up against the holder, aren't rejected) — but a small search
      // radius can otherwise land the box's center almost exactly on the
      // holder's own center, which carrySpotFree would then wrongly wave
      // through. Reject that explicitly here instead of picking an
      // arbitrary starting radius meant to dodge it.
      if (aabbOverlap({ x, y, w: box.w, h: box.h }, holder)) continue;
      if (!carrySpotFree(world, box, holder, x, y)) continue;
      const dist = Math.hypot(x - box.x, y - box.y);
      if (dist < bestDist) { bestDist = dist; best = { x, y }; }
    }
    if (best) return best; // stop widening as soon as the closest ring has ANY hit
  }
  return null; // truly nothing reachable near the holder at any radius tried
}

/**
 * Recursively gather everything currently resting (directly or via a chain
 * of stacked boxes) on top of `base`, using groundEntity links computed at
 * the END of the previous step. Used to carry riders when `base` moves.
 *
 * `seen` guards against cyclic groundEntity chains. In normal play the
 * links form a clean tree (you can't stand on something that's standing
 * on you), but a cycle is reachable through external mutation — a level
 * editor, a networking layer applying a malformed/out-of-order snapshot,
 * or any code setting groundEntity directly — and without a guard the
 * recursion blows the stack outright (verified: RangeError, not a
 * graceful degradation). Since this runs inside the physics step, that
 * crash would take down the whole simulation, so it's worth the cheap
 * Set even though the tree shape should hold on its own.
 */
function getAllRiders(world, base, seen = null) {
  if (!seen) seen = new Set();
  if (seen.has(base)) return [];
  seen.add(base);

  const direct = world.entities.filter(e => e.groundEntity === base && !seen.has(e));
  let all = direct.slice();
  for (const r of direct) all = all.concat(getAllRiders(world, r, seen));
  return all;
}

function shiftRiders(world, base, dx, dy) {
  if (dx === 0 && dy === 0) return;
  for (const rider of getAllRiders(world, base)) {
    rider.x += dx;
    rider.y += dy;
  }
}

/**
 * Find the nearest not-already-carried Box within reach of `player`, in
 * front of them (their facing direction), for pickup. Extends the reach
 * a little vertically too so a box that's slightly higher/lower (e.g.
 * resting on a low ledge) is still forgiving to grab.
 */
function findPickupTarget(world, player) {
  const reach = {
    x: player.facing > 0 ? player.x : player.x - PHYSICS.PICKUP_RANGE,
    y: player.y - 12,
    w: player.w + PHYSICS.PICKUP_RANGE,
    h: player.h + 24,
  };
  let best = null, bestDist = Infinity;
  for (const e of world.entities) {
    if (!(e instanceof Box) || e.carried) continue;
    if (!aabbOverlap(reach, e)) continue;
    const dist = Math.abs(e.centerX - player.centerX);
    if (dist < bestDist) { bestDist = dist; best = e; }
  }
  return best;
}

/**
 * Compute what a platform's tentative movement (platform.dx/dy — already
 * applied to platform.x/y by updatePath, not yet committed to anyone
 * else) would do to every entity in its way this frame: riders (carried
 * by the full delta) and non-riders it's pushing into from the side,
 * underneath, or above. Nothing is written to any entity yet — this is
 * purely for deciding whether the move is safe (see isPlatformMoveBlocked).
 */
function computePlatformMove(world, platform) {
  const riders = getAllRiders(world, platform);
  const moveGroup = new Set([platform, ...riders]);
  const candidates = riders.map((r) => ({
    entity: r, x: r.x + platform.dx, y: r.y + platform.dy, isRider: true, pushedX: false,
  }));

  // A one-way platform is transparent to everything except a rider
  // resting on its top — it never pushes anyone from the side or from
  // underneath (that's the same rule a static OneWayPlatform follows).
  // So there's nothing to shove, and nothing else to check for blockage.
  if (!platform.oneWay) {
    for (const e of world.entities) {
      if (!e.dynamic || e.carried || moveGroup.has(e)) continue;
      if (!aabbOverlap(e, platform)) continue;

      let nx = e.x, ny = e.y;
      if (platform.dx !== 0) nx = platform.dx > 0 ? platform.right : platform.left - e.w;
      if (platform.dy !== 0) ny = platform.dy > 0 ? platform.bottom : platform.top - e.h;

      candidates.push({ entity: e, x: nx, y: ny, isRider: false, pushedX: platform.dx !== 0 });
      moveGroup.add(e);
    }
  }

  return { moveGroup, candidates };
}

/**
 * Would any candidate's resulting position overlap a solid outside the
 * platform's own move group — i.e. is there nowhere for it to go? A
 * one-way platform never counts as a blocker here, matching how it's
 * transparent everywhere else in the engine.
 */
function isPlatformMoveBlocked(world, moveGroup, candidates) {
  for (const c of candidates) {
    const box = { x: c.x, y: c.y, w: c.entity.w, h: c.entity.h };
    for (const other of world.entities) {
      if (!other.solid || other.oneWay || other.isCameraWall || moveGroup.has(other)) continue;
      if (aabbOverlap(box, other)) return true;
    }
  }
  return false;
}

/**
 * Move `entity` horizontally by dx, resolving collisions. If it bumps into
 * a pushable Box, attempt to push the box (and anything riding the box)
 * along with it, chaining through multiple boxes if needed. If the chain
 * is blocked, the whole chain (and the pusher) stops at the obstruction.
 *
 * `exclude` carries the set of entities already part of this push chain
 * (the original mover plus every box pushed so far) through the recursion.
 * Without it, a pushed box's own collision check would see the player
 * standing right behind it — who is *always* overlapping it while pushing
 * — and mistake them for a wall, snapping the box back into the player.
 *
 * Plain (non-pushable) solids are resolved by minimum penetration — which
 * side (left/right) has the shallower overlap — rather than by the
 * mover's own dx sign. Sign alone isn't reliable: if a solid's position
 * changes on some OTHER axis this same frame (e.g. a platform descending
 * past a player who happens to be sitting well inside its horizontal
 * span, not just brushing one edge of it), a fresh, deep horizontal
 * overlap can appear that has nothing to do with which way the mover was
 * walking. Resolving by dx sign in that case snaps the mover across the
 * solid's entire width to its far edge — a large, jarring teleport —
 * instead of the small, sensible nudge minimum-penetration produces.
 */
/**
 * Move `entity` horizontally by dx, resolving collisions. If it bumps into
 * a pushable Box, attempt to push the box (and anything riding the box)
 * along with it, chaining through multiple boxes if needed. If the chain
 * is blocked, the whole chain (and the pusher) stops at the obstruction.
 *
 * IMPORTANT: this always resolves any existing horizontal overlap, even
 * when dx is 0 (the entity has no horizontal velocity of its own) —
 * PROVIDED horizontal is actually the more natural axis to resolve it on.
 * This is the standard fix for a classic AABB collision pitfall: an
 * entity's horizontal position can end up overlapping a solid through
 * means other than its own horizontal velocity — most commonly here,
 * being centered on top of a carrier (rider stacking) that's standing
 * flush against a wall, where the wider rider overhangs into the wall by
 * a few pixels. If horizontal resolution only ran while vx !== 0, that
 * overlap would sit there unresolved (since a resting rider's vx is 0),
 * and vertical resolution would later find the entity overlapping that
 * wall too and misread it as a landing/bonk surface instead of the
 * horizontal-only overlap it actually is — snapping the entity to some
 * unrelated vertical position.
 *
 * The "actually the more natural axis" qualifier matters: without it, an
 * entity still falling toward a platform it's about to land on would also
 * get caught here, mid-fall, well before vertical resolution gets a
 * chance to land it — because it necessarily overlaps that platform
 * horizontally the whole way down (that's what "landing on it" requires).
 * The standard disambiguation (Minimum Translation Vector: compare the
 * horizontal penetration against the vertical penetration for the same
 * pair, and only resolve on whichever is shallower) sorts this out
 * correctly without needing to special-case "is this a fall" at all: a
 * few pixels of wall overhang has far less horizontal penetration than
 * vertical (the wall usually spans much taller than the overlap), while
 * a player about to land has far less vertical penetration than
 * horizontal (a full jump/fall approach vs. barely grazing a landing).
 * The dx !== 0 (actual, intentional movement) path below is unaffected —
 * it already resolves left/right via its own within-axis minimum
 * penetration, which is a separate, previously-verified fix.
 *
 * `exclude` carries the set of entities already part of this push chain
 * (the original mover plus every box pushed so far) through the recursion.
 * Without it, a pushed box's own collision check would see the player
 * standing right behind it — who is *always* overlapping it while pushing
 * — and mistake them for a wall, snapping the box back into the player.
 *
 * Plain (non-pushable) solids — and pushable boxes when dx is 0, since
 * there's no push direction to act on — are resolved by minimum
 * penetration: whichever side (left/right) has the shallower overlap,
 * rather than by the mover's own dx sign. Sign alone isn't reliable: if a
 * solid's position changes on some OTHER axis this same frame (e.g. a
 * platform descending past a player who happens to be sitting well inside
 * its horizontal span, not just brushing one edge of it), a fresh, deep
 * horizontal overlap can appear that has nothing to do with which way the
 * mover was walking. Resolving by dx sign in that case snaps the mover
 * across the solid's entire width to its far edge — a large, jarring
 * teleport — instead of the small, sensible nudge minimum-penetration
 * produces.
 */
function moveXWithCollision(world, entity, dx, depth = 0, exclude = null) {
  if (!exclude) exclude = new Set();
  exclude.add(entity);

  entity.x += dx;
  const hasIntent = dx !== 0; // is this an actual push/move, or passive depenetration?

  for (const other of solidsFor(world, entity)) {
    if (exclude.has(other)) continue; // never blocked by our own pusher/chain
    if (other.oneWay) continue; // one-way platforms never block horizontally
    if (!aabbOverlap(entity, other)) continue;

    if (hasIntent && other.pushable && depth < PHYSICS.PUSH_MAX_DEPTH) {
      const dir = Math.sign(dx); // pushing is inherently directional — dx sign is correct here
      const beforeX = other.x;
      moveXWithCollision(world, other, dx, depth + 1, exclude);
      const moved = other.x - beforeX;
      shiftRiders(world, other, moved, 0);
      // Clamp the pusher to sit flush against the box's new position,
      // in case the box got stopped early by something behind it.
      if (dir > 0) entity.x = Math.min(entity.x, other.x - entity.w);
      else entity.x = Math.max(entity.x, other.x + other.w);

      // --- FIX 6: zero velocity when a push is genuinely blocked ---
      // The plain-solid branch below already sets vx = 0 on contact, but
      // this branch used to just `continue`, leaving the pusher reporting
      // full walk speed while completely stationary (e.g. shoving a box
      // that's jammed against a wall). Physics itself was fine — the
      // player didn't actually move — but that phantom velocity leaks
      // into anything downstream that reads vx as "am I moving": the
      // character renderer drives its walk-cycle squash/stretch from it,
      // so a motionless player visibly jiggled and their drawn edge
      // pulled away from the box they were pushing. Velocity should
      // describe what actually happened, not what was requested, so if
      // the chain couldn't move, report a stop.
      if (moved === 0) entity.vx = 0;
      continue;
    }

    const overlapFromLeft = entity.right - other.x;   // penetration if resolved to entity's left
    const overlapFromRight = other.right - entity.x;  // penetration if resolved to entity's right
    const overlapX = Math.min(overlapFromLeft, overlapFromRight);

    // --- FIX 1 (generalized): Wall-Snagging via Misclassified Axis ---
    // This pair might actually be a vertical-type overlap (e.g. an
    // in-flight landing, or a solid that just swept into this entity on
    // its OWN motion) rather than a genuine horizontal one. Compare
    // against the vertical penetration for the same pair (mirroring
    // moveYWithCollision's own overlap math) and only resolve here if
    // horizontal is truly the shallower, more natural correction —
    // otherwise leave it for Y-resolution to handle.
    //
    // This used to only run when the entity itself had no horizontal
    // intent (dx === 0) — the reasoning being "if I'm actively walking
    // into something, that's obviously a real horizontal collision, no
    // ambiguity." That reasoning has a gap: it only accounted for the
    // ENTITY being stationary while something else moved into it. It
    // missed the case where the ENTITY has genuine horizontal intent
    // (actively walking) AND the OTHER solid ALSO moves — on some OTHER
    // axis — this same frame, sweeping into a fresh, incidental overlap
    // that has nothing to do with which way the entity was walking.
    //
    // Concretely: a camera boundary wall panning downward to follow a
    // player who's already settled on the floor sweeps its own Y
    // position through where the (horizontally-walking) player already
    // is. The player has real dx, so the old hasIntent gate skipped the
    // MTV check entirely and resolved by X-sign — which, since the
    // wall is CAMERA_WALL_THICKNESS (400px) deep, snapped the player
    // clean through to the wall's FAR edge: a ~600px single-frame
    // teleport. Applying the same MTV comparison unconditionally (not
    // gated on the entity's own intent) fixes this the same way it
    // already fixed the passive case, and verified NOT to regress
    // ordinary walking-into-a-wall: a normal wall is tall relative to
    // the graze depth, so overlapY stays large and overlapX still wins
    // correctly (see the regression suite).
    //
    // The one place this deliberately does NOT apply is the push-chain
    // branch above (`hasIntent && other.pushable`) — pushing a box is
    // always and unambiguously a horizontal event; second-guessing it
    // against a vertical MTV comparison would be wrong, not safer.
    const overlapFromTop = entity.bottom - other.y;
    const overlapFromBottom = other.bottom - entity.y;
    const overlapY = Math.min(overlapFromTop, overlapFromBottom);
    if (overlapX < EPS) continue;
    if (overlapX >= overlapY) continue;

    if (overlapFromLeft <= overlapFromRight) {
      entity.x = other.x - entity.w;
    } else {
      entity.x = other.right;
    }
    entity.vx = 0;
  }
}

/**
 * Move `entity` vertically by dy, resolving collisions and updating
 * grounded / groundEntity.
 *
 * All currently-overlapping solids are considered together and only the
 * SINGLE least-penetration correction is applied — not one correction per
 * overlapping solid, sequentially. Applying corrections one after another
 * lets a later solid undo the one a previous solid just made (e.g. a
 * descending platform squeezing a player against the floor: resolving
 * against the floor first pins the player at floor level, but then
 * resolving against the platform second, using that just-corrected
 * position, immediately shoves them back down through the floor —
 * ping-ponging every frame). Picking one global least-penetration
 * correction avoids that.
 *
 * Regular (non-one-way) solids are resolved by minimum penetration (top
 * vs. bottom), not by the entity's own velocity sign — sign alone isn't
 * reliable: a platform descending onto a stationary standing player has
 * the player's own dy pointing "down" from gravity even though the
 * platform is arriving from above, which would otherwise snap the player
 * instantly onto the platform's top instead of correctly being pushed
 * down by its underside.
 */
function moveYWithCollision(world, entity, dy) {
  const prevBottom = entity.bottom;
  entity.y += dy;

  entity.grounded = false;
  entity.groundEntity = null;

  let bestPenetration = Infinity;
  let bestY = null;
  let bestIsLanding = false;
  let bestGroundEntity = null;

  for (const other of solidsFor(world, entity)) {
    if (!aabbOverlap(entity, other)) continue;

    if (other.oneWay) {
      // Only active if we were fully above it last frame and are moving
      // downward (or resting) onto it — otherwise it's transparent.
      if (!(dy >= 0 && prevBottom <= other.top + EPS)) continue;
      const penetration = entity.bottom - other.top;
      if (penetration < bestPenetration) {
        bestPenetration = penetration;
        bestY = other.top - entity.h;
        bestIsLanding = true;
        bestGroundEntity = other;
      }
      continue;
    }

    const overlapFromTop = entity.bottom - other.top;   // landing-on-top penetration
    const overlapFromBottom = other.bottom - entity.y;  // bonk-underneath penetration

    if (overlapFromTop <= overlapFromBottom) {
      if (overlapFromTop < bestPenetration) {
        bestPenetration = overlapFromTop;
        bestY = other.top - entity.h;
        bestIsLanding = true;
        bestGroundEntity = other;
      }
    } else {
      if (overlapFromBottom < bestPenetration) {
        bestPenetration = overlapFromBottom;
        bestY = other.bottom;
        bestIsLanding = false;
        bestGroundEntity = null;
      }
    }
  }

  if (bestY === null) return; // nothing overlapping, no correction needed

  entity.y = bestY;
  if (bestIsLanding) {
    entity.vy = 0;
    entity.grounded = true;
    entity.groundEntity = bestGroundEntity;
  } else if (entity.vy < 0) {
    entity.vy = 0; // only kill upward momentum (a head-bonk), not a fall
  }
}

// ---------------------------------------------------------------------------
// PressurePlate — a thin solid you can stand on that reports whether
// anything is currently resting on it, and drives one or more linked
// targets (doors, gates, platforms) by id.
//
// Activation is computed fresh from world state every single frame, with
// no timers, no latching and no decay — so it deactivates the instant the
// last thing steps off, matching the "stop instantly" feel used for
// player movement. That also makes it trivially deterministic: two peers
// running the same snapshot compute the same result, and the plate needs
// no historical state of its own to stay in sync.
//
// targets: array of entity ids (or a single id) this plate activates.
// acceptsBoxes: if false, only players count (some puzzles want a plate
//               a box can't cheat).
// ---------------------------------------------------------------------------
class PressurePlate extends Entity {
  constructor(x, y, w, h, targets = [], acceptsBoxes = true) {
    super(x, y, w, h);
    this.targets = Array.isArray(targets) ? targets.slice() : [targets];
    this.acceptsBoxes = acceptsBoxes;
    this.active = false;      // recomputed every frame in World.step
    this.occupants = 0;       // how many things are on it (handy for HUD/debug)
    this.color = '#8d5fc9';
    this.activeColor = '#c07fff';
  }

  /**
   * Anything whose groundEntity is this plate counts as standing on it.
   * groundEntity is already maintained by the normal landing resolution,
   * so this needs no extra collision work and automatically covers
   * players, boxes, and anything stacked directly on the plate.
   */
  recomputeActive(world) {
    let n = 0;
    for (const e of world.entities) {
      if (e.groundEntity !== this) continue;
      if (!this.acceptsBoxes && e instanceof Box) continue;
      n++;
    }
    this.occupants = n;
    this.active = n > 0;
    return this.active;
  }

  getSyncState() { return { active: this.active, occupants: this.occupants }; }
  applySyncState(s) { this.active = s.active; this.occupants = s.occupants; }
}

// ---------------------------------------------------------------------------
// LinkedDoor — a solid slab that slides between a closed and an open
// position depending on whether any plate linked to it is active. Give it
// a `linkId` and reference that from a PressurePlate's `targets`.
//
// It exposes updatePath(dt)/dx/dy exactly like MovingPlatform, so it runs
// through the same kinematic pipeline in World.step and inherits all of
// it: it carries riders, and it halts rather than crushing or clipping
// through anything with nowhere to go (a door closing on a player stops
// against them instead of squashing them).
// ---------------------------------------------------------------------------
class LinkedDoor extends Entity {
  constructor(linkId, x, y, w, h, openOffset = { x: 0, y: -100 }, speed = 160) {
    super(x, y, w, h);
    this.linkId = linkId;
    this.closedPos = { x, y };
    this.openPos = { x: x + (openOffset.x || 0), y: y + (openOffset.y || 0) };
    this.speed = speed;
    this.open = false; // driven by linked plates each frame
    this.color = '#b0563a';
    this.dx = 0;
    this.dy = 0;
  }

  updatePath(dt) {
    const prevX = this.x, prevY = this.y;
    const target = this.open ? this.openPos : this.closedPos;

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    const stepLen = this.speed * dt;

    if (dist <= stepLen || dist < EPS) {
      this.x = target.x;
      this.y = target.y;
    } else {
      this.x += (dx / dist) * stepLen;
      this.y += (dy / dist) * stepLen;
    }

    this.dx = this.x - prevX;
    this.dy = this.y - prevY;
  }

  getSyncState() { return { x: this.x, y: this.y, open: this.open }; }
  applySyncState(s) { this.x = s.x; this.y = s.y; this.open = s.open; }
}

// ---------------------------------------------------------------------------
// Seesaw — a weight-sensitive platform, built as two plank halves that
// move vertically in opposite directions. Two AABBs rather than one
// rotated body keeps it compatible with the axis-aligned collision the
// rest of the engine uses, while still reading visually as a tilt.
//
// Weight per side is the combined `weight` of everything resting on that
// side's plank (default 1 each; set entity.weight to tune). The tilt
// target is the normalized weight difference, and actual tilt eases
// toward it at a fixed rate — so a sudden weight change produces a smooth
// swing rather than a snap, which also means clients interpolating
// between snapshots never see it jump.
//
// Deterministic: tilt is a pure function of (previous tilt, current
// weights, dt), so host and peers replaying the same inputs agree.
// ---------------------------------------------------------------------------
class SeesawPlank extends Entity {
  constructor(seesaw, side, x, y, w, h) {
    super(x, y, w, h);
    this.seesaw = seesaw;
    this.side = side; // 'left' | 'right'
    this.baseY = y;
    this.color = '#3f9e7c';
    this.dx = 0;
    this.dy = 0;
  }

  updatePath(dt) {
    const prevX = this.x, prevY = this.y;
    // The controller advances once per frame, driven by whichever plank
    // the kinematic loop reaches first.
    this.seesaw.update(dt);
    const dir = this.side === 'left' ? 1 : -1;
    this.y = this.baseY + dir * this.seesaw.tilt * this.seesaw.maxRise;
    this.dx = this.x - prevX;
    this.dy = this.y - prevY;
  }

  getSyncState() { return { y: this.y }; }
  applySyncState(s) { this.y = s.y; }
}

class Seesaw {
  /**
   * x,y — top-left of the whole seesaw. `w` is split evenly into two
   * planks with `gap` px between them (the pivot).
   * maxRise — how far each end travels from level, in px.
   * tiltRate — how fast tilt eases toward target (units/sec); lower feels
   *            heavier and smoother.
   * balanceWeight — the weight difference that produces a full tilt.
   */
  constructor(x, y, w, h, {
    gap = 8, maxRise = 40, tiltRate = 2.2, balanceWeight = 1,
  } = {}) {
    const half = (w - gap) / 2;
    this.maxRise = maxRise;
    this.tiltRate = tiltRate;
    this.balanceWeight = balanceWeight;
    this.tilt = 0;          // -1 (right end down) .. +1 (left end down)
    this.leftWeight = 0;
    this.rightWeight = 0;
    this._steppedThisFrame = false;
    this.left = new SeesawPlank(this, 'left', x, y, half, h);
    this.right = new SeesawPlank(this, 'right', x + half + gap, y, half, h);
    this.planks = [this.left, this.right];
  }

  /** Add both planks to a world. */
  addTo(world) {
    world.add(this.left);
    world.add(this.right);
    return this;
  }

  /**
   * --- FIX 4 (companion): coordinated removal for a two-entity body ---
   * A Seesaw is two separate world entities under the hood. Calling
   * world.remove() on just one plank would leave the other half-orphaned
   * (still in the world, still driving a controller with a dead
   * reference to its removed sibling). Removing both together through
   * this method keeps that invariant from ever being violated.
   */
  removeFrom(world) {
    world.remove(this.left);
    world.remove(this.right);
  }

  static weightOf(e) {
    return typeof e.weight === 'number' ? e.weight : 1;
  }

  _sideWeight(plank) {
    const world = plank.world;
    if (!world) return 0;
    // getAllRiders already returns the ENTIRE flattened subtree resting on
    // `plank` — direct riders plus everything stacked on them, to any
    // depth — so one call is all that's needed. (The previous version
    // looped over direct riders and called getAllRiders on each; the
    // subtrees are disjoint so it summed correctly, but the intent was
    // easy to misread as double-counting and it did redundant work.)
    let total = 0;
    for (const r of getAllRiders(world, plank)) total += Seesaw.weightOf(r);
    return total;
  }

  update(dt) {
    // Guard so the controller only advances once per frame even though
    // both planks call into it.
    if (this._steppedThisFrame) return;
    this._steppedThisFrame = true;

    this.leftWeight = this._sideWeight(this.left);
    this.rightWeight = this._sideWeight(this.right);

    const diff = this.leftWeight - this.rightWeight;
    const target = clamp(diff / this.balanceWeight, -1, 1);
    this.tilt = approach(this.tilt, target, this.tiltRate * dt);
  }

  endFrame() { this._steppedThisFrame = false; }

  getSyncState() { return { tilt: this.tilt, leftWeight: this.leftWeight, rightWeight: this.rightWeight }; }
  applySyncState(s) { this.tilt = s.tilt; this.leftWeight = s.leftWeight; this.rightWeight = s.rightWeight; }
}

// ---------------------------------------------------------------------------
// Camera — fixed-size viewport centered on the average of all connected
// players, clamped to level bounds, and enforced as a HARD movement
// boundary via four invisible solid walls that track its edges every
// tick. This is the core double trouble  mechanic: the group is physically
// unable to separate past what's currently visible, not just visually
// framed to look that way.
//
// ARCHITECTURE — why walls, not a bespoke clamp:
//   The requirement is "hard stop, same as colliding with a solid wall,
//   no soft push, no partial penetration." Rather than writing a second,
//   parallel position-clamping code path, the four edges are ordinary
//   `solid` entities repositioned every tick. They flow through the
//   EXACT SAME moveXWithCollision/moveYWithCollision machinery every
//   other wall in the game already uses — the same MTV disambiguation,
//   the same push-chain handling, the same tested edge cases. A player
//   pushing a box against the boundary, a stack of players near the
//   edge, a box resting half-in/half-out — all "just work" via the
//   existing solid-collision path with zero new special-casing, because
//   as far as that code is concerned, a camera wall IS a wall.
//
//   Scope of what a camera wall blocks: ONLY Players (see solidsFor's
//   isCameraWall check) — boxes, platforms, projectiles all pass through
//   freely. "The group can't leave the screen" is a constraint on the
//   playable characters specifically, not on props; a box pushed past
//   the boundary just sits there until the camera pans back over it, or
//   until it falls into an actual hazard/deathY zone, which is what
//   World._killBox's (per-level-customizable) respawn policy exists to
//   recover from. isPlatformMoveBlocked and the projectile pass also
//   explicitly ignore camera walls (see their `isCameraWall` checks) for
//   the same reason — a moving platform's patrol or an arrow's flight is
//   level GEOMETRY, not group-cohesion pressure, and shouldn't be
//   disrupted by where the screen happens to be.
//
// ORDERING / STABILITY — avoiding the feedback loop:
//   The camera's target depends on player positions, and movement is
//   now constrained by the camera — so computing both from the SAME
//   tick's in-progress positions would create a same-tick feedback loop
//   (move, which shifts the average, which shifts the boundary, which
//   should have constrained the move that already happened...). The fix
//   is ordering: recompute() and positionWalls() both run at the very
//   TOP of World._stepOnce, BEFORE any movement resolves. At that point
//   "current state" is exactly what it was at the END of the previous
//   tick (nothing has moved yet this tick), so the boundary in effect
//   for tick N is always a pure function of tick N-1's fully-resolved
//   positions — never of anything still being computed. No jitter, no
//   oscillation, because there's no cycle: it's a strict one-tick delay,
//   not a same-tick loop.
//
// SMOOTHING vs. SNAPPING:
//   Panning eases toward the target center at CAMERA_PAN_SPEED (see
//   recompute) rather than snapping instantly — "pan smoothly" per the
//   requirement. The one exception is resetLevel(), which snaps the
//   camera immediately alongside every other entity's hard reset (see
//   World.resetLevel) — interpolating a smooth pan across a reset would
//   look like the camera sliding across the level for a moment, exactly
//   the artifact resetGeneration already exists to let clients avoid for
//   every other entity's position.
//
// SYNC: getSyncState()/applySyncState() follow the exact same contract
// as every other synced type. netcode.js's TYPE_REGISTRY treats it as a
// one-element 'static' array (see the wiring note where it's wired in) —
// the host computes it, clients only ever render whatever rect arrives,
// never their own.
// ---------------------------------------------------------------------------
class CameraBoundaryWall extends Entity {
  constructor() {
    super(0, 0, 1, 1);
    this.isCameraWall = true; // excluded from platform-blocking + projectile checks
  }
}

class Camera {
  constructor(viewW, viewH, opts = {}) {
    this.id = 0; // fixed, deterministic on both host and client — see World.enableCamera
    this.w = viewW;
    this.h = viewH;
    this.x = 0;
    this.y = 0;
    this._initialized = false;

    // Which edges actually block movement. Left/right are the core
    // mechanic and should stay on. Top/bottom default on too (a faithful
    // reading of "cannot move past the edge of the viewport" on every
    // side) — but see the flagged interaction with fall-death in the
    // accompanying notes: if a level relies on a player falling well
    // below the group's average to reach deathY, and the group doesn't
    // descend together, the bottom wall can catch the lone faller first.
    // Flip blockBottom false here (per level, at enableCamera() call
    // time) if that turns out to be the wrong call for a given level.
    this.blockLeft = opts.blockLeft !== false;
    this.blockRight = opts.blockRight !== false;
    this.blockTop = opts.blockTop !== false;
    this.blockBottom = opts.blockBottom !== false;

    // Created and added to the world by World.enableCamera(); referenced
    // here so positionWalls() can update them every tick.
    this.wallLeft = null;
    this.wallRight = null;
    this.wallTop = null;
    this.wallBottom = null;
  }

  _target(world) {
    const players = world.entities.filter(e => e instanceof Player && !e.dead);
    let cx, cy;
    if (players.length === 0) {
      // Nothing to follow — hold position rather than snapping to an
      // arbitrary default (avoids a visible jump right as the last
      // player disconnects, or before the first one has connected).
      cx = this.x + this.w / 2;
      cy = this.y + this.h / 2;
    } else {
      let sx = 0, sy = 0;
      for (const p of players) { sx += p.centerX; sy += p.centerY; }
      cx = sx / players.length;
      cy = sy / players.length;
    }

    let tx = cx - this.w / 2;
    let ty = cy - this.h / 2;

    const b = world.levelBounds;
    if (b) {
      // Math.max guards against an inverted range if the level is
      // narrower/shorter than the viewport itself — falls back to
      // anchoring on the level's own origin rather than producing a
      // negative-width clamp.
      const maxX = Math.max(b.minX, b.maxX - this.w);
      const maxY = Math.max(b.minY, b.maxY - this.h);
      tx = clamp(tx, b.minX, maxX);
      ty = clamp(ty, b.minY, maxY);
    }
    return { tx, ty };
  }

  /**
   * Move toward the target rect — eased at CAMERA_PAN_SPEED by default
   * ("pan smoothly"), or snapped instantly when `snap` is true (used by
   * World.resetLevel() and on the very first call, so the boundary
   * doesn't spend several ticks slowly panning in from (0,0) at level
   * start). Called at the top of every World._stepOnce — see the class
   * doc comment for why that ordering is what keeps this stable.
   */
  recompute(world, dt, snap = false) {
    const { tx, ty } = this._target(world);
    if (snap || !this._initialized) {
      this.x = tx;
      this.y = ty;
    } else {
      const maxDelta = PHYSICS.CAMERA_PAN_SPEED * dt;
      this.x = approach(this.x, tx, maxDelta);
      this.y = approach(this.y, ty, maxDelta);
    }
    this._initialized = true;
  }

  /**
   * Snap the four wall entities to the CURRENT rect. Each wall's outer
   * edge extends CAMERA_WALL_THICKNESS past the rect (so nothing can
   * ever end up behind it); its inner edge sits exactly on the camera
   * boundary — that inner edge is the actual collidable surface. A wall
   * for a disabled edge (blockTop: false, etc.) is pushed far off to the
   * side instead of removed, which is simpler and cheaper than adding
   * or removing world entities every tick.
   */
  positionWalls() {
    const T = PHYSICS.CAMERA_WALL_THICKNESS;
    const FAR = -1e6; // parks a disabled wall well outside any real level

    if (this.blockLeft) {
      this.wallLeft.x = this.x - T; this.wallLeft.y = this.y - T;
      this.wallLeft.w = T;          this.wallLeft.h = this.h + T * 2;
    } else {
      this.wallLeft.x = FAR; this.wallLeft.y = FAR; this.wallLeft.w = 1; this.wallLeft.h = 1;
    }

    if (this.blockRight) {
      this.wallRight.x = this.x + this.w; this.wallRight.y = this.y - T;
      this.wallRight.w = T;               this.wallRight.h = this.h + T * 2;
    } else {
      this.wallRight.x = FAR; this.wallRight.y = FAR; this.wallRight.w = 1; this.wallRight.h = 1;
    }

    if (this.blockTop) {
      this.wallTop.x = this.x - T; this.wallTop.y = this.y - T;
      this.wallTop.w = this.w + T * 2; this.wallTop.h = T;
    } else {
      this.wallTop.x = FAR; this.wallTop.y = FAR; this.wallTop.w = 1; this.wallTop.h = 1;
    }

    if (this.blockBottom) {
      this.wallBottom.x = this.x - T; this.wallBottom.y = this.y + this.h;
      this.wallBottom.w = this.w + T * 2; this.wallBottom.h = T;
    } else {
      this.wallBottom.x = FAR; this.wallBottom.y = FAR; this.wallBottom.w = 1; this.wallBottom.h = 1;
    }
  }

  getSyncState() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
  applySyncState(s) { this.x = s.x; this.y = s.y; this.w = s.w; this.h = s.h; }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
class World {
  constructor() {
    this.entities = [];
    this.gravity = PHYSICS.GRAVITY;

    // --- DEATH / RESET ---
    // Any player whose top falls past deathY dies (off-screen fall).
    // null disables the bounds check entirely. Set this from level setup
    // to a bit below the lowest floor.
    this.deathY = null;

    // Set true by the death pass on any frame a player newly died, and
    // stays true until resetLevel() (or the host) clears it. This is the
    // signal netcode.js polls to decide when to reset the room — see the
    // OWNERSHIP note on resetLevel() below.
    this.pendingReset = false;

    // Incremented every resetLevel(). Useful as a generation counter so
    // clients can tell "this snapshot is from a different life" and skip
    // interpolating across the discontinuity (a reset teleports
    // everything; interpolating through it would look like everyone
    // sliding across the level).
    this.resetGeneration = 0;

    // Scratch list for entities removed during the death pass, so the
    // pass never mutates `entities` while iterating it. Always add via
    // _despawn() — see that method for why.
    this._doomed = [];

    // Entities despawned BY THE SIMULATION (a box falling into a pit or
    // burning up in lava) are parked here rather than dropped, so
    // resetLevel() can put them back. Without this, a box lost to a pit
    // is gone permanently — and since any death resets the room anyway,
    // the very next attempt would start with a missing box and the
    // puzzle could be unsolvable. An explicit world.remove() call from
    // game code is still permanent; only simulation-driven despawns are
    // recoverable.
    this._graveyard = [];

    // --- CAMERA / LEVEL BOUNDS ---
    // Both null (disabled) until a level opts in — see enableCamera().
    // Existing worlds that never call it are completely unaffected: no
    // walls exist, _stepOnce's camera block is skipped entirely, zero
    // behavior change for anything that predates this feature.
    this.camera = null;

    // { minX, minY, maxX, maxY } or null (unbounded). Set this directly
    // (mirrors how level.js already sets world.deathY directly) before
    // calling enableCamera(), or pass explicit bounds to enableCamera()
    // itself — see that method.
    this.levelBounds = null;

    // Default policy applied when a box falls into a death zone (past
    // deathY, or a killsBoxes hazard) and doesn't specify its own
    // `deathPolicy` — see Box and _killBox. 'respawn' (the default)
    // teleports it back immediately, no room reset; a level can pick a
    // stricter default via nw.world.defaultBoxDeathPolicy = 'reset' if
    // losing ANY box there should fail the room instead.
    this.defaultBoxDeathPolicy = 'respawn'; // 'respawn' | 'reset' | 'ignore'
  }

  /**
   * Opt a level into camera-bound movement. Call once, after the level's
   * geometry is built (so levelBounds — if not passed explicitly — can
   * already be sourced from it) and before the first player is added
   * (so the very first tick already has walls in the right place; not
   * strictly required, since recompute() handles zero-players safely,
   * but avoids a one-tick window with no boundary at all).
   *
   * bounds, if provided, sets world.levelBounds as a convenience —
   * equivalent to setting it directly beforehand. Pass null / omit to
   * leave the camera unclamped against level edges (it'll still track
   * the player average and still block movement, just without ever
   * refusing to pan further in some direction).
   */
  enableCamera(viewW, viewH, opts = {}) {
    if (opts.bounds) this.levelBounds = opts.bounds;

    const cam = new Camera(viewW, viewH, opts);
    cam.wallLeft = this.add(new CameraBoundaryWall());
    cam.wallRight = this.add(new CameraBoundaryWall());
    cam.wallTop = this.add(new CameraBoundaryWall());
    cam.wallBottom = this.add(new CameraBoundaryWall());

    this.camera = cam;
    cam.recompute(this, 0, true); // snap to an initial rect immediately
    cam.positionWalls();
    return cam;
  }

  add(entity) {
    entity.world = this;
    // Capture spawn state on add so resetLevel() can restore it without
    // the caller having to rebuild the level or hand us a snapshot. Only
    // the fields a reset needs to restore are stored — geometry (w/h),
    // links and tuning are immutable or rederived.
    entity._spawn = {
      x: entity.x, y: entity.y,
      baseY: entity.baseY,          // SeesawPlank tilt origin
      segIndex: entity._segIndex,   // MovingPlatform patrol position
      dir: entity._dir,
    };
    this.entities.push(entity);
    return entity;
  }

  /**
   * --- FIX 4: Entity Destruction Cleanup ---
   * Removing an entity used to just splice it out of `entities`, leaving
   * anything that referenced it (a holder's `carrying`, a box's
   * `carriedBy`, anything resting on it via `groundEntity`) pointing at
   * an orphaned object forever. That's not just stale data — it actively
   * breaks behavior: a player whose held box was destroyed would still
   * read as "carrying something" and could never pick up a real box
   * again (updateCarrying branches on `player.carrying` being truthy),
   * and anything left with a dangling `groundEntity` would never
   * re-evaluate its footing.
   *
   * Sweeping every remaining entity on removal clears all three links.
   * Anything that loses its ground is set ungrounded (falls, as it
   * should — the thing it was standing on no longer exists) rather than
   * quietly floating in place.
   */
  remove(entity) {
    const i = this.entities.indexOf(entity);
    if (i === -1) return;
    this.entities.splice(i, 1);

    for (const e of this.entities) {
      if (e.groundEntity === entity) { e.groundEntity = null; e.grounded = false; }
      if (e.carrying === entity) e.carrying = null;
      if (e.carriedBy === entity) { e.carried = false; e.carriedBy = null; }
    }
    entity.world = null;
  }

  /**
   * Kill a player. Safe to call directly from game/level code for any
   * bespoke death condition the generic triggers don't cover (a boss
   * attack, a timer running out, a scripted cutscene) — the built-in
   * triggers below just call this.
   *
   * Idempotent: killing an already-dead player is a no-op and won't
   * re-raise pendingReset, so a player sitting in lava during the reset
   * delay doesn't spam the signal.
   */
  killPlayer(player) {
    if (!(player instanceof Player) || player.dead) return;
    player.dead = true;
    player.vx = 0;
    player.vy = 0;
    // Drop anything they were holding so the box doesn't ride a corpse.
    if (player.carrying) {
      player.carrying.carried = false;
      player.carrying.carriedBy = null;
      player.carrying = null;
    }
    this.pendingReset = true;
  }

  /**
   * Handle a box that fell into a death zone (past deathY, or a
   * killsBoxes hazard) — see the death pass at the bottom of _stepOnce,
   * which is the only caller. Policy is per-box first (box.deathPolicy),
   * falling back to world.defaultBoxDeathPolicy:
   *
   *   'respawn' (default) — teleport it back immediately, to
   *       box.respawnPoint if set, otherwise its original spawn
   *       position. The box never leaves the simulation (no despawn, no
   *       graveyard) — it's simply repositioned this same tick. No
   *       cross-network delay needed for this, unlike a player death:
   *       a box has no death pose to show, so there's nothing worth
   *       pausing for.
   *
   *   'reset' — treated as a room failure, same signal/ownership as a
   *       player death: raises pendingReset and leaves the TIMING to
   *       netcode.js (see resetLevel's OWNERSHIP note — engine.js
   *       still never decides when, only that). The box is frozen
   *       (zeroed velocity) wherever it died rather than removed —
   *       resetLevel() will restore it to spawn once the host actually
   *       calls it, same as everything else.
   *
   *   'ignore' — permanently removed via the normal despawn/graveyard
   *       path (recoverable only by a full resetLevel() triggered by
   *       something ELSE, e.g. a player dying elsewhere — losing this
   *       box on its own doesn't force anything).
   */
  _killBox(box) {
    const policy = box.deathPolicy || this.defaultBoxDeathPolicy;

    if (policy === 'reset') {
      box.vx = 0;
      box.vy = 0;
      this.pendingReset = true;
      return;
    }

    if (policy === 'ignore') {
      this._despawn(box);
      return;
    }

    // 'respawn' (default, and the fallback for any unrecognized value —
    // fails toward the least-surprising, least-destructive behavior).
    const target = box.respawnPoint || (box._spawn ? { x: box._spawn.x, y: box._spawn.y } : { x: box.x, y: box.y });
    box.x = target.x;
    box.y = target.y;
    box.vx = 0;
    box.vy = 0;
    box.grounded = false;
    box.groundEntity = null;
  }

  /**
   * Queue an entity for removal at the end of this step. ALWAYS use this
   * rather than pushing to `_doomed` directly.
   *
   * The `_pendingDespawn` flag makes it idempotent, which matters because
   * a single entity can genuinely satisfy several despawn conditions in
   * one frame — a projectile can hit geometry AND a player on the same
   * tick, and a box can be both out of bounds and inside a killsBoxes
   * hazard. Without the guard it lands in `_doomed` twice, `remove()`
   * runs on it twice, and it gets pushed into `_graveyard` twice — so
   * resetLevel() would resurrect two references to the same object and
   * push a duplicate into `entities`, corrupting the entity list for
   * every subsequent frame. (Verified: duplicate pushes do occur in
   * ordinary arrow-trap play, so this is a live bug, not a theoretical
   * one.)
   */
  _despawn(entity) {
    if (entity._pendingDespawn) return;
    entity._pendingDespawn = true;
    this._doomed.push(entity);
  }

  /**
   * ============================================================
   * OWNERSHIP: who resets the room?  (read this before wiring netcode)
   * ============================================================
   * Split, deliberately:
   *
   *   engine.js  owns DETECTION and MECHANICS.
   *              It decides *that* a player died (deterministically, on
   *              the host, from world state alone) and knows *how* to
   *              restore every entity to spawn. It raises
   *              `world.pendingReset` and exposes this method.
   *
   *   netcode.js owns POLICY and TIMING.
   *              It decides *when* to actually call resetLevel() — after
   *              a death animation delay, after all peers have
   *              acknowledged, immediately, never. The engine
   *              deliberately does NOT auto-reset, because the right
   *              delay is a game-feel//networking question (players
   *              should see the death pose that character.js draws
   *              before the room snaps back), and because a reset that
   *              fires mid-frame on the host without the clients
   *              expecting it is exactly the kind of unannounced
   *              discontinuity that makes interpolation glitch.
   *
   * So the host loop looks like:
   *     world.step(dt);
   *     if (world.pendingReset && myResetDelayElapsed) world.resetLevel();
   *
   * Clients never detect death or call this — they receive `dead` in the
   * player snapshot (character.js reads it) and `resetGeneration`, which
   * increments here so they can snap rather than interpolate across the
   * discontinuity.
   *
   * Restores positions, velocities, contact links, carry state, patrol
   * progress, seesaw tilt, plate/door state, and clears every `dead`
   * flag. Entities added or removed after level build are NOT recreated —
   * resetLevel restores state, it doesn't rebuild geometry. If a level
   * spawns/destroys entities at runtime, rebuild the world instead.
   */
  resetLevel() {
    // Bring back anything the simulation despawned (boxes lost to pits or
    // lava) BEFORE restoring state, so they get restored to spawn along
    // with everything else. Otherwise a lost box would stay lost across
    // resets and could leave the room unsolvable.
    //
    // Projectiles are the deliberate exception: they're transient, spawner-
    // created bodies with no meaningful "spawn state" to return to, so a
    // graveyard'd arrow is dropped rather than resurrected. In-flight ones
    // are cleared below for the same reason — a fresh attempt should start
    // with empty air, not last attempt's arrows frozen mid-descent.
    for (const e of this._graveyard) {
      if (e.isProjectile) continue;
      e.world = this;
      this.entities.push(e);
    }
    this._graveyard.length = 0;

    this.entities = this.entities.filter(e => !e.isProjectile);

    for (const e of this.entities) {
      const s = e._spawn;
      if (s) {
        e.x = s.x;
        e.y = s.y;
        if (s.baseY !== undefined) e.baseY = s.baseY;
        if (s.segIndex !== undefined) e._segIndex = s.segIndex;
        if (s.dir !== undefined) e._dir = s.dir;
      }
      e.vx = 0;
      e.vy = 0;
      e.dx = 0;
      e.dy = 0;
      e.dead = false;
      e.grounded = false;
      e.groundEntity = null;

      // carry links
      if (e.carrying) e.carrying = null;
      if (e.carried) { e.carried = false; e.carriedBy = null; }

      // per-type latched state
      if (e instanceof Player) {
        e._coyoteTimer = 0;
        e._jumpBufferTimer = 999;
        e._wasJumpHeld = false;
        e._wasActionHeld = false;
        e.facing = 1;
        e.invulnerableTimer = 0;
      }
      if (e instanceof PressurePlate) { e.active = false; e.occupants = 0; }
      if (e instanceof LinkedDoor) { e.open = false; }
      // Restart spawner cadence from its configured phase, so every
      // attempt at the room sees an identical firing pattern — otherwise
      // a retry would start mid-cycle and the same jump would sometimes
      // work and sometimes not.
      if (e.isSpawner) e._timer = -e.phase;
      if (e.isTrigger && e.effect === 'goal') { e.touching.clear(); e.touchCount = 0; }
    }

    // Seesaws live outside `entities` (only their planks are in it), so
    // reset each controller once via its planks.
    const seen = new Set();
    for (const e of this.entities) {
      if (e instanceof SeesawPlank && !seen.has(e.seesaw)) {
        seen.add(e.seesaw);
        e.seesaw.tilt = 0;
        e.seesaw.leftWeight = 0;
        e.seesaw.rightWeight = 0;
        e.seesaw._steppedThisFrame = false;
      }
    }

    // Snap the camera immediately to center on the just-reset player
    // spawns, rather than letting the normal eased pan slowly catch up
    // from wherever it was — every other entity's position is hard-reset
    // above, and resetGeneration exists precisely so clients don't
    // interpolate across this exact kind of discontinuity. Camera should
    // match: snap, not pan.
    if (this.camera) {
      this.camera.recompute(this, 0, true);
      this.camera.positionWalls();
    }

    this.pendingReset = false;
    this.resetGeneration++;
  }

  /**
   * Toggle pickup/throw for `player`, based on a rising edge of
   * input.action (call this once per fixed step, same as
   * player.handleInput — before world.step() so a throw's velocity is in
   * place before gravity/collision run this frame).
   *
   * Throwing launches the box with the exact same vertical speed as the
   * player's own jump (PHYSICS.JUMP_VELOCITY) and a horizontal speed
   * matching the player's CURRENT vx — same gravity constant, same
   * launch speed, so the box traces an arc identical in shape to the
   * player's own jump, scaled by how fast they were moving when they
   * threw it (standing still throws straight up with no horizontal
   * travel; running gives it the same reach a running jump would).
   */
  updateCarrying(player, input) {
    const pressed = !!input.action && !player._wasActionHeld;
    player._wasActionHeld = !!input.action;
    if (!pressed) return;

    if (player.carrying) {
      const box = player.carrying;
      box.carried = false;
      box.carriedBy = null;
      box.vx = player.vx;
      box.vy = -PHYSICS.JUMP_VELOCITY;
      // Release from wherever it's actually being held (it already has a
      // collision-valid position — see step 0 of step()), so a throw can
      // never inject it into a wall.
      box.grounded = false;
      box.groundEntity = null;
      player.carrying = null;
    } else {
      const box = findPickupTarget(this, player);
      if (!box) return;
      // Defensive: findPickupTarget already skips boxes with `carried`
      // set, so a box can't normally be taken out of someone's hands and
      // this branch shouldn't fire. It's kept because `carriedBy` is
      // reachable through other paths — netcode applying a snapshot,
      // level scripting, a future "steal the box" mechanic — and if a box
      // ever did change hands without clearing the old holder, that
      // holder would keep a stale `carrying` pointer: they'd compute
      // carry positions for a box they don't have, and their next action
      // press would "throw" a box already held by someone else.
      if (box.carriedBy && box.carriedBy !== player) box.carriedBy.carrying = null;
      // A held box stays solid — it keeps full collision so it can't be
      // walked through walls or other boxes. It's only excluded from its
      // own holder's collision (see solidsFor).
      box.carried = true;
      box.carriedBy = player;
      box.vx = 0;
      box.vy = 0;
      box.grounded = false;
      box.groundEntity = null;
      player.carrying = box;
    }
  }

  /** Advance the simulation by one fixed timestep (seconds). */
  /**
   * --- FIX 5: Delta Accumulator Protection (engine-level guard) ---
   * Public entry point. A bare dt clamp alone isn't enough to "gracefully"
   * handle a large delta (e.g. a backgrounded tab waking up after several
   * seconds) — it bounds the damage from NaN/Infinity, but a single big
   * step still travels proportionally far: even the requested 0.25s cap
   * integrates ~106px of fall in one step, more than any thin collider in
   * this engine (one-way platforms can be as thin as 12px), so a single
   * huge step can still tunnel straight through geometry that fixed 1/60
   * stepping never would.
   *
   * So this clamps the total dt to PHYSICS.MAX_STEP_DT (preventing
   * runaway/spiral-of-death), then internally subdivides that into fixed
   * SUB_STEP-sized physics ticks via _stepOnce — the same safe increment
   * every consumer's own accumulator loop already uses. For the normal
   * case this is a complete no-op: calling step(1/60), as every consumer
   * already does in its own fixed-timestep loop, still runs exactly one
   * _stepOnce call with an unchanged dt — behavior is byte-identical to
   * before this fix. Subdivision only ever kicks in for an unusually
   * large dt, which in practice means step() is being called directly
   * without a consumer's own accumulator loop in front of it.
   *
   * Note for anything that assumes "one step() call == one tick" for
   * bookkeeping (e.g. a networking layer's tick counter): that holds for
   * every normal fixed-timestep call. It's only a large, out-of-pattern
   * dt that can advance multiple internal ticks in one call — exactly
   * the case where a naive single-tick counter would already have been
   * wrong anyway.
   */
  step(dt) {
    if (dt <= 0) return;
    dt = Math.min(dt, PHYSICS.MAX_STEP_DT);

    const SUB_STEP = 1 / 60;
    while (dt > SUB_STEP) {
      this._stepOnce(SUB_STEP);
      dt -= SUB_STEP;
    }
    if (dt > 0) this._stepOnce(dt);
  }

  _stepOnce(dt) {
    // -1) Camera boundary. Recompute the rect from whatever's true right
    //    now — which, since nothing has moved yet this tick, is exactly
    //    the fully-resolved state from the END of the previous tick —
    //    then immediately reposition the four boundary walls to match.
    //    This ordering (compute from last tick, apply to this tick,
    //    every tick) is what keeps camera-follows-players and
    //    movement-bounded-by-camera from feeding back into each other —
    //    see the Camera class doc comment for the full reasoning. Must
    //    run before anything below moves anyone.
    if (this.camera) {
      this.camera.recompute(this, dt);
      this.camera.positionWalls();
    }

    // -0.5) Player invulnerability timers. Decremented early, before any
    //    contact-kill check runs later this same tick — so a timer that
    //    reaches exactly 0 this frame makes that player vulnerable
    //    starting THIS frame, not the next one, and every kill-check
    //    later in the pass sees a fully up-to-date value. This does NOT
    //    protect against deathY (see the field's doc comment on Player).
    for (const e of this.entities) {
      if (e instanceof Player && e.invulnerableTimer > 0) {
        e.invulnerableTimer = Math.max(0, e.invulnerableTimer - dt);
      }
    }

    // 0) Carried entities are inert (excluded from gravity/velocity via
    //    the `dynamics` filter below) and track their holder each frame.
    //    They keep full collision though, so the carry spot is validated
    //    against world geometry first — see findCarrySpot (FIX 2) for
    //    the tight-space fallback when the usual candidates all fail.
    for (const e of this.entities) {
      if (!e.carried || !e.carriedBy) continue;
      const spot = findCarrySpot(this, e, e.carriedBy);
      if (spot) { e.x = spot.x; e.y = spot.y; }
      e.vx = 0;
      e.vy = 0;
    }

    // 0.5) Linked doors read the plate state computed at the END of the
    //    previous step (see step 6), which reflects final resolved
    //    positions rather than stale mid-frame ones.
    const plates = this.entities.filter(e => e instanceof PressurePlate);
    if (plates.length) {
      for (const e of this.entities) {
        if (!(e instanceof LinkedDoor)) continue;
        e.open = plates.some(p => p.active && p.targets.includes(e.linkId));
      }
    }

    // 1) Kinematic bodies attempt to move along their path. Anything that
    //    exposes updatePath(dt) + dx/dy participates — MovingPlatform,
    //    LinkedDoor and SeesawPlank all do — so each inherits the carry
    //    and anti-crush behaviour below rather than reimplementing it.
    //    If moving would push a rider or an entity in its way into
    //    another solid with no room to go (a wall, a box, the level
    //    edge...), the body halts for this frame instead of clipping
    //    through or crushing them. Its patrol state (segment/direction)
    //    is fully reverted too, not just its position — so it isn't left
    //    "ahead of itself" on the path once the way clears, it just
    //    tries the exact same move again next frame. Because the check
    //    is direction-aware and re-run fresh every frame, this resolves
    //    itself the moment the obstruction clears, or the moment the
    //    patrol reverses direction — no special-case "unstick" logic.
    //
    //    --- FIX 3: Simultaneous Multi-Platform Kinematic Collisions ---
    //    Each platform's check AND commit now happen together, in the
    //    same iteration, before the next platform is even looked at.
    //    This used to be two separate passes — check every platform
    //    first, then commit every move afterward — which meant a second
    //    platform's blocking check ran against entity positions from
    //    BEFORE the first platform had shifted them: stale data. Two
    //    platforms converging on the same entity in one frame could each
    //    independently decide their own move was clear, using a snapshot
    //    that predates the other's shove. Committing immediately after
    //    each platform's own check means every subsequent platform in
    //    the list always sees the fully up-to-date, already-resolved
    //    positions of everything that moved before it this frame.
    const platforms = this.entities.filter(e => typeof e.updatePath === 'function');

    for (const p of platforms) {
      const prevX = p.x, prevY = p.y, prevSeg = p._segIndex, prevDir = p._dir;
      p.updatePath(dt);

      if (p.dx === 0 && p.dy === 0) continue;

      const { moveGroup, candidates } = computePlatformMove(this, p);

      if (isPlatformMoveBlocked(this, moveGroup, candidates)) {
        p.x = prevX; p.y = prevY; p._segIndex = prevSeg; p._dir = prevDir;
        p.dx = 0; p.dy = 0;
        continue;
      }

      // Commit immediately — riders always move with the platform on
      // both axes; non-riders only get an explicit horizontal shove
      // here (matching how they always have). A vertical shove isn't
      // needed: step 5 below already resolves a stationary entity
      // correctly against a platform that just moved into it
      // (least-penetration), so duplicating that here would be
      // redundant.
      for (const c of candidates) {
        if (c.isRider) {
          c.entity.x = c.x;
          c.entity.y = c.y;
        } else if (c.pushedX) {
          c.entity.x = c.x;
          c.entity.vx = 0;
        }
      }
    }

    // 3) Forces: gravity + wind, applied to every dynamic entity. Carried
    //    entities are excluded entirely — they're inert while held (see
    //    step 0 above), not falling or colliding.
    // Dead players are frozen: excluded from gravity, movement and
    // collision entirely, so a corpse doesn't keep falling forever
    // (potentially past deathY again) or get shoved around by platforms
    // while the reset delay plays out. character.js draws the death pose
    // in place.
    const dynamics = this.entities.filter(e => e.dynamic && !e.carried && !e.dead);
    const windZones = this.entities.filter(e => e.isWindZone);

    for (const e of dynamics) {
      e.vy = Math.min(e.vy + this.gravity * dt, PHYSICS.MAX_FALL_SPEED);

      for (const wz of windZones) {
        if (!aabbOverlap(e, wz)) continue;
        if (wz.forceX !== 0) {
          e.vx = clamp(e.vx + wz.forceX * dt, -wz.maxSpeed, wz.maxSpeed);
        }
        if (wz.forceY !== 0) {
          e.vy = clamp(e.vy + wz.forceY * dt, -wz.maxSpeed, wz.maxSpeed);
        }
      }

      // Bleed off a grounded box's residual horizontal velocity (e.g.
      // from wind) so it doesn't drift forever. Deliberately NOT applied
      // while airborne — an airborne box (thrown, or knocked off a ledge)
      // needs constant horizontal velocity to trace a clean parabola,
      // same as the player's own jump; damping it mid-air would warp
      // that arc into something else.
      if (e instanceof Box && e.grounded) {
        e.vx = approach(e.vx, 0, PHYSICS.BOX_FRICTION * dt);
      }
    }

    // 4) Resolve horizontal motion (handles pushing boxes). Anything
    //    riding an entity is carried along by that entity's actual
    //    resolved delta — this is what makes the co-op boost work: when
    //    the bottom player of a stack walks, whoever is standing on
    //    their head travels with them instead of being left behind.
    //    Riders are moved through moveXWithCollision (not teleported) so
    //    a carried rider still stops against walls properly, and the
    //    full recursive rider list is used so 3+ player towers carry all
    //    the way up.
    for (const e of dynamics) {
      const riders = getAllRiders(this, e);
      const beforeX = e.x;
      moveXWithCollision(this, e, e.vx * dt);
      const carried = e.x - beforeX;
      if (carried !== 0) {
        for (const r of riders) {
          if (r.carried) continue; // held boxes track their holder instead
          moveXWithCollision(this, r, carried);
        }
      }
    }

    // 5) Resolve vertical motion (handles landing, one-way platforms).
    //    A box that just landed (was airborne last frame, grounded now)
    //    stops dead instead of sliding out any remaining vx — no bounce,
    //    no coast, matching a thrown box coming to rest immediately.
    for (const e of dynamics) {
      const wasGrounded = e.grounded;
      moveYWithCollision(this, e, e.vy * dt);
      if (e instanceof Box && e.grounded && !wasGrounded) {
        e.vx = 0;
      }
    }

    // 6) Pressure plates are recomputed here, at the END of the step,
    //    from fully-resolved positions — groundEntity is only accurate
    //    after vertical resolution has run, so computing plates earlier
    //    would read last frame's stale contacts and leave a plate active
    //    for a frame after everything had already stepped off. Doing it
    //    here means plate state always matches what's actually on screen,
    //    with no latching, timers or decay: step off and it is false
    //    immediately. Linked doors pick this up at step 0.5 next frame.
    for (const plate of this.entities) {
      if (plate instanceof PressurePlate) plate.recomputeActive(this);
    }

    // 7) Release each seesaw's once-per-frame guard so both of its planks
    //    can drive the shared controller again next frame.
    const seen = new Set();
    for (const e of this.entities) {
      if (e instanceof SeesawPlank && !seen.has(e.seesaw)) {
        seen.add(e.seesaw);
        e.seesaw.endFrame();
      }
    }

    // 7.5) Projectiles + spawners. Runs on resolved positions, before
    //    the death pass, so a projectile that hits a player this frame
    //    kills them this frame rather than next.
    //
    //    Projectiles are integrated here rather than through the main
    //    `dynamics` pass on purpose: they're non-solid (an arrow in
    //    flight shouldn't be standable, pushable, or able to shove a
    //    platform), so routing them through the full collision resolver
    //    would be both wasteful and semantically wrong. This pass is
    //    self-contained: integrate, test geometry, test overlaps.
    //    Deterministic throughout — accumulator timers, no randomness.
    const spawners = this.entities.filter(e => e.isSpawner);
    for (const s of spawners) {
      const emitted = s.update(dt, this);
      if (emitted) for (const p of emitted) this.add(p);
    }

    const projectiles = this.entities.filter(e => e.isProjectile);
    if (projectiles.length) {
      for (const p of projectiles) {
        if (p.landed) continue;

        p.vy += p.gravity * dt;   // gravity 0 => dead-straight line
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // Geometry contact: stop or despawn. One-way platforms are
        // skipped so an arrow doesn't stick in mid-air on a platform
        // it should visually pass by.
        let hitGeometry = false;
        for (const other of this.entities) {
          if (other === p || !other.solid || other.oneWay || other.isCameraWall) continue;
          if (other instanceof Box && !p.collidesWithBoxes) continue;
          if (!aabbOverlap(p, other)) continue;
          hitGeometry = true;
          break;
        }

        if (hitGeometry) {
          if (p.despawn === 'onLand') { this._despawn(p); continue; }
          // 'bounds' rule: stick where it hit and wait to leave the
          // level (or be cleared by a reset).
          p.landed = true;
          p.vx = 0; p.vy = 0;
          continue;
        }

        if (this.deathY !== null && p.y > this.deathY) { this._despawn(p); continue; }
      }

      // Overlap effects, after integration so it tests final positions.
      for (const p of projectiles) {
        if (p.landed || !p.killsPlayers) continue;
        for (const e of this.entities) {
          if (!(e instanceof Player) || e.dead || e.invulnerableTimer > 0) continue;
          if (!aabbOverlap(p, e)) continue;
          this.killPlayer(e);
          if (p.despawn === 'onLand') this._despawn(p);
          break;
        }
      }
    }

    // 7.55) Bouncing balls — same self-contained-pass reasoning as
    //    Projectiles (non-solid, no gravity, shouldn't go through the
    //    main dynamics/collision resolver). Each ball is fully
    //    independent: integrate, decelerate, reflect, kill-check — see
    //    BouncingBall.update() for the actual logic. Runs after
    //    projectiles / before the death pass, same ordering reason: a
    //    ball that hits a player this tick kills them this tick.
    for (const e of this.entities) {
      if (e.isBouncingBall) e.update(this, dt);
    }

    // 7.6) Goal-zone occupancy — recomputed fresh every frame from
    //    resolved positions, same no-latching rule as PressurePlate.
    //    State only; deliberately no win logic (see TriggerZone docs).
    for (const z of this.entities) {
      if (!z.isTrigger || z.effect !== 'goal') continue;
      z.touching.clear();
      for (const e of this.entities) {
        if (!(e instanceof Player) || e.dead) continue;
        if (aabbOverlap(z, e)) z.touching.add(e.id);
      }
      z.touchCount = z.touching.size;
    }

    // 8) Death pass — runs LAST, on fully-resolved positions, for the
    //    same reason the plate pass does: a mid-step position can be
    //    momentarily inside geometry before resolution pushes it out,
    //    and killing on that would produce phantom deaths. Host-only and
    //    deterministic: derived purely from world state, no randomness,
    //    no input, no wall-clock — so a peer replaying the same tick
    //    reaches the same verdict.
    //
    //    Doesn't reset anything itself; it only raises `dead` +
    //    `pendingReset`. See resetLevel()'s OWNERSHIP note for why the
    //    engine deliberately leaves the *when* to netcode.js.
    const hazards = this.entities.filter(e => e.isHazard);
    for (const e of this.entities) {
      if (e instanceof Player) {
        if (e.dead) continue;
        if (this.deathY !== null && e.y > this.deathY) { this.killPlayer(e); continue; }
        if (e.invulnerableTimer > 0) continue; // immune to hazard contact, not to falling (handled above)
        for (const hz of hazards) {
          if (aabbOverlap(e, hz)) { this.killPlayer(e); break; }
        }
      } else if (e instanceof Box && !e.carried) {
        // Boxes only die to hazards that opt in. What happens next is
        // policy-driven (respawn in place / fail the room / vanish for
        // good) — see World._killBox for the full per-box/per-world
        // customization surface.
        if (this.deathY !== null && e.y > this.deathY) { this._killBox(e); continue; }
        for (const hz of hazards) {
          if (hz.killsBoxes && aabbOverlap(e, hz)) { this._killBox(e); break; }
        }
      }
    }
    if (this._doomed.length) {
      for (const e of this._doomed) {
        const spawn = e._spawn;      // preserve — remove() detaches the entity
        this.remove(e);
        e._spawn = spawn;
        e._pendingDespawn = false;   // clear the guard; it's off the list now
        this._graveyard.push(e);     // recoverable on resetLevel(); see _graveyard
      }
      this._doomed.length = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports (plain globals — no bundler in this project)
// ---------------------------------------------------------------------------
window.Engine = {
  PHYSICS,
  World,
  Entity,
  StaticBody,
  OneWayPlatform,
  MovingPlatform,
  WindZone,
  Hazard,
  TriggerZone,
  Projectile,
  ProjectileSpawner,
  BouncingBall,
  Box,
  Player,
  PressurePlate,
  LinkedDoor,
  Seesaw,
  SeesawPlank,
  Camera,
  CameraBoundaryWall,
  aabbOverlap,
};

})();
