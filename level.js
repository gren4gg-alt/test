/* ==========================================================================
   level.js — placeholder test level
   --------------------------------------------------------------------------
   This is the seam where the real level module from the level-design chat
   plugs in. It only has to satisfy two things:

     1. build(world, netWorld) constructs entities in a FIXED, deterministic
        order, pushing boxes into netWorld.boxes and moving platforms into
        netWorld.platforms in that same order. Those array indices become
        network ids, so host and client agree on which box is which without
        ever sending an id table. Randomised or conditional construction
        order will silently desync everything.

     2. spawnPoint(slot) is a pure function of slot.

   Nothing else in the level is replicated — static geometry never moves, so
   it costs zero bandwidth. Only boxes and platforms are synced.
   ========================================================================== */
(function () {
"use strict";

const { StaticBody, OneWayPlatform, MovingPlatform, Box, WindZone } = window.Engine;

const W = 960, H = 540;

window.Level = {
  WIDTH: W,
  HEIGHT: H,

  spawnPoint(slot) {
    return { x: 90 + (slot % 6) * 46, y: 300 - Math.floor(slot / 6) * 60 };
  },

  build(world, nw) {
    // --- static geometry (never replicated) ---
    world.add(new StaticBody(0, H - 40, W, 40));          // floor
    world.add(new StaticBody(0, 0, 20, H));               // left wall
    world.add(new StaticBody(W - 20, 0, 20, H));          // right wall
    world.add(new StaticBody(300, H - 150, 120, 20));     // ledge
    world.add(new StaticBody(640, H - 240, 140, 20));     // high ledge

    world.add(new OneWayPlatform(180, H - 230, 120, 12));
    world.add(new OneWayPlatform(460, H - 330, 120, 12));

    // --- wind zone (non-solid trigger, not replicated: it never moves) ---
    world.add(new WindZone(800, H - 200, 120, 160, -260, 0, 420));

    // --- moving platforms (replicated: position + patrol state) ---
    // Order here defines netId 1, 2, ...
    nw.platforms.push(world.add(new MovingPlatform(
      420, H - 120, 110, 18,
      [{ x: 420, y: H - 120 }, { x: 420, y: H - 300 }], 70, 'pingpong'
    )));
    nw.platforms.push(world.add(new MovingPlatform(
      120, H - 420, 100, 16,
      [{ x: 120, y: H - 420 }, { x: 520, y: H - 420 }], 90, 'pingpong', true
    )));

    // --- boxes (replicated: position, velocity, carry state) ---
    // Order here defines netId 1, 2, ...
    nw.boxes.push(world.add(new Box(340, H - 190, 34, 34)));
    nw.boxes.push(world.add(new Box(700, H - 280, 34, 34)));
    nw.boxes.push(world.add(new Box(560, H - 80,  34, 34)));
    nw.boxes.push(world.add(new Box(600, H - 80,  34, 34)));
  },
};

})();
