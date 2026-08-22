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

      while (step > 0) {
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
  }
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
  }

  /**
   * input: { left: bool, right: bool, jump: bool (held state) }
   * Sets this.vx / this.vy for the upcoming physics step. Actual movement
   * + collision happens later in World.step().
   */
  handleInput(input, dt) {
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
}

// ---------------------------------------------------------------------------
// Collision resolution helpers
// ---------------------------------------------------------------------------

// Everyone this entity should be blocked/pushed by (excludes itself,
// non-solid things like wind zones, and the box this entity is currently
// carrying — a held box moves *with* its holder, so treating it as an
// obstacle would wedge the holder against their own cargo).
function solidsFor(world, self) {
  return world.entities.filter(e => {
    if (e === self || !e.solid) return false;
    if (self.carrying === e) return false;   // don't collide with what I'm holding
    if (e.carriedBy === self) return false;  // same relationship, other direction
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

// Recursively gather everything currently resting (directly or via a chain
// of stacked boxes) on top of `base`, using groundEntity links computed at
// the END of the previous step. Used to carry riders when `base` moves.
function getAllRiders(world, base) {
  const direct = world.entities.filter(e => e.groundEntity === base);
  let all = direct.slice();
  for (const r of direct) all = all.concat(getAllRiders(world, r));
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
      if (!other.solid || other.oneWay || moveGroup.has(other)) continue;
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
function moveXWithCollision(world, entity, dx, depth = 0, exclude = null) {
  if (dx === 0) return;
  if (!exclude) exclude = new Set();
  exclude.add(entity);

  entity.x += dx;

  for (const other of solidsFor(world, entity)) {
    if (exclude.has(other)) continue; // never blocked by our own pusher/chain
    if (other.oneWay) continue; // one-way platforms never block horizontally
    if (!aabbOverlap(entity, other)) continue;

    if (other.pushable && depth < PHYSICS.PUSH_MAX_DEPTH) {
      const dir = Math.sign(dx); // pushing is inherently directional — dx sign is correct here
      const beforeX = other.x;
      moveXWithCollision(world, other, dx, depth + 1, exclude);
      const moved = other.x - beforeX;
      shiftRiders(world, other, moved, 0);
      // Clamp the pusher to sit flush against the box's new position,
      // in case the box got stopped early by something behind it.
      if (dir > 0) entity.x = Math.min(entity.x, other.x - entity.w);
      else entity.x = Math.max(entity.x, other.x + other.w);
      continue;
    }

    const overlapFromLeft = entity.right - other.x;   // penetration if resolved to entity's left
    const overlapFromRight = other.right - entity.x;  // penetration if resolved to entity's right

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
// World
// ---------------------------------------------------------------------------
class World {
  constructor() {
    this.entities = [];
    this.gravity = PHYSICS.GRAVITY;
  }

  add(entity) {
    entity.world = this;
    this.entities.push(entity);
    return entity;
  }

  remove(entity) {
    const i = this.entities.indexOf(entity);
    if (i !== -1) this.entities.splice(i, 1);
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
  step(dt) {
    // 0) Carried entities are inert (excluded from gravity/velocity via
    //    the `dynamics` filter below) and track their holder each frame.
    //    They keep full collision though, so the carry spot is validated
    //    against world geometry first: we take the best position that
    //    doesn't overlap anything solid, and if every candidate is
    //    obstructed we leave the box where it was rather than shoving it
    //    into a wall.
    for (const e of this.entities) {
      if (!e.carried || !e.carriedBy) continue;
      const h = e.carriedBy;
      for (const spot of carryPositions(h, e)) {
        if (carrySpotFree(this, e, h, spot.x, spot.y)) {
          e.x = spot.x;
          e.y = spot.y;
          break;
        }
      }
      e.vx = 0;
      e.vy = 0;
    }

    // 1) Kinematic platforms attempt to move along their path. If doing so
    //    would push a rider or an entity in its way into another solid
    //    with no room to go (a wall, a box, the level edge...), the
    //    platform halts for this frame instead of clipping through or
    //    crushing them. Its patrol state (segment/direction) is fully
    //    reverted too, not just its position — so it isn't left "ahead of
    //    itself" on the path once the way clears, it just tries the exact
    //    same move again next frame. Because the check is direction-aware
    //    and re-run fresh every frame, this resolves itself automatically
    //    the moment the obstruction clears, or the moment the platform's
    //    patrol reverses direction (pushing the other way is a different
    //    check, generally unobstructed since the obstruction is now
    //    behind it) — no special-case "unstick" logic needed.
    const platforms = this.entities.filter(e => e instanceof MovingPlatform);
    const committedMoves = [];

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

      committedMoves.push(candidates);
    }

    // 2) Commit carries/shoves for every platform that moved cleanly.
    //    Riders always move with the platform on both axes. Non-riders
    //    only get an explicit horizontal shove here (matching how they
    //    always have) — a vertical shove isn't needed: step 5 below
    //    already resolves a stationary entity correctly against a
    //    platform that just moved into it (least-penetration), so
    //    duplicating that here would be redundant.
    for (const candidates of committedMoves) {
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
    const dynamics = this.entities.filter(e => e.dynamic && !e.carried);
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

    // 4) Resolve horizontal motion (handles pushing boxes).
    for (const e of dynamics) {
      moveXWithCollision(this, e, e.vx * dt);
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
  Box,
  Player,
  aabbOverlap,
};

})();