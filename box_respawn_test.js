global.window = {};
require('./engine.js');
const { World, StaticBody, Box, Player, Hazard, TriggerZone } = window.Engine;
function check(n,c,i){ console.log((c?'OK  ':'FAIL'),n,c?'':('- '+i)); if(!c)process.exitCode=1; }

// ---- 1. Default policy is 'respawn' — box stays in the world ----
{
  const w = new World(); w.deathY = 700;
  w.add(new StaticBody(0,500,300,40)); // short ledge, box falls off the end
  const box = w.add(new Box(320,460,40,40)); // starts past the ledge, over open air
  const spawnX = box.x, spawnY = box.y;
  // Nothing is under the box at its spawn x, so once respawned it falls
  // straight back past deathY and respawns again — correct behavior for
  // this geometry, but means the FINAL frame can land mid-fall between
  // cycles. Track whether it was ever exactly back at spawn instead.
  let wasAtSpawn = false, everMissing = false, sawZeroVelocityAtSpawn = false;
  for (let i=0;i<120;i++){
    w.step(1/60);
    if (!w.entities.includes(box)) everMissing = true;
    if (box.x===spawnX && box.y===spawnY) {
      wasAtSpawn = true;
      if (box.vx===0 && box.vy===0) sawZeroVelocityAtSpawn = true;
    }
  }
  check('box past deathY: never despawned at any point', !everMissing, '');
  check('box was teleported back to its original spawn position at least once', wasAtSpawn, '');
  check('velocity was zero at the moment of respawn', sawZeroVelocityAtSpawn, '');
}

// ---- 2. Per-box deathPolicy overrides the world default ----
{
  const w = new World(); w.deathY = 700; // world default stays 'respawn'
  w.add(new StaticBody(0,500,300,40));
  const box = w.add(new Box(320,460,40,40));
  box.deathPolicy = 'reset'; // this one box should fail the room instead
  check('pendingReset starts false', w.pendingReset===false, '');
  for (let i=0;i<120;i++) w.step(1/60);
  check("box.deathPolicy='reset' overrides the world default -> pendingReset raised",
    w.pendingReset===true, '');
  check("'reset' policy freezes the box in place rather than teleporting it",
    box.vx===0 && box.vy===0 && box.y > 600, 'box.y='+box.y.toFixed(1));
  check('box was NOT removed from the world (resetLevel will restore it, not despawn/graveyard)',
    w.entities.includes(box), '');
}

// ---- 3. World.defaultBoxDeathPolicy changes the default for ALL boxes ----
{
  const w = new World(); w.deathY = 700;
  w.defaultBoxDeathPolicy = 'reset'; // level-wide: losing any box fails the room
  w.add(new StaticBody(0,500,300,40));
  const boxA = w.add(new Box(320,460,40,40));
  const boxB = w.add(new Box(320,300,40,40));
  for (let i=0;i<150;i++) w.step(1/60);
  check('world default reset policy applies to every box with no per-box override',
    w.pendingReset===true, '');
}

// ---- 4. 'ignore' policy preserves the original despawn+graveyard behavior ----
{
  const w = new World(); w.deathY = 700;
  w.add(new StaticBody(0,500,300,40));
  const box = w.add(new Box(320,460,40,40));
  box.deathPolicy = 'ignore';
  for (let i=0;i<120;i++) w.step(1/60);
  check("'ignore': box removed from the world", !w.entities.includes(box), '');
  check("'ignore': does NOT force a room reset on its own", w.pendingReset===false, '');
  w.resetLevel();
  check("'ignore': box IS recoverable via a full resetLevel() triggered by something else",
    w.entities.includes(box), '');
}

// ---- 5. Custom respawnPoint — level-specified location, not original spawn ----
{
  const w = new World(); w.deathY = 700;
  w.add(new StaticBody(0,500,300,40));
  w.add(new StaticBody(600,300,100,40)); // a "dispenser" ledge elsewhere
  const box = w.add(new Box(320,460,40,40));
  box.respawnPoint = { x: 620, y: 260 }; // custom respawn location, not its spawn
  for (let i=0;i<120;i++) w.step(1/60);
  check('box respawns at the CUSTOM respawnPoint, not its original spawn',
    box.x===620 && box.y===260, 'now=('+box.x+','+box.y+')');
}

// ---- 6. killsBoxes hazard also routes through the same policy system ----
{
  const w = new World(); w.deathY = null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,460,80,40,{killsBoxes:true}));
  const box = w.add(new Box(310,300,40,40));
  const spawnX = box.x, spawnY = box.y;
  let wasAtSpawn = false, everMissing = false;
  for (let i=0;i<90;i++){
    w.step(1/60);
    if (!w.entities.includes(box)) everMissing = true;
    if (box.x===spawnX && box.y===spawnY) wasAtSpawn = true;
  }
  check('killsBoxes hazard triggers respawn (default policy), not despawn', wasAtSpawn && !everMissing, '');
}

// ---- 7. A box that survives a normal (non-killsBoxes) hazard is unaffected ----
{
  const w = new World(); w.deathY = null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,460,80,40)); // killsBoxes defaults false
  const box = w.add(new Box(310,300,40,40));
  for (let i=0;i<90;i++) w.step(1/60);
  check('box survives a hazard that does not opt into killing boxes', w.entities.includes(box), '');
  check('box was never teleported (no death triggered at all)', box.x===310, 'box.x='+box.x);
}

// ---- 8. resetLevel() still correctly restores a box mid-respawn-cycle ----
{
  const w = new World(); w.deathY = 700;
  w.add(new StaticBody(0,500,300,40));
  const box = w.add(new Box(320,460,40,40));
  for (let i=0;i<120;i++) w.step(1/60); // respawn cycling
  w.resetLevel();
  check('resetLevel cleanly restores a box regardless of mid-cycle state',
    w.entities.includes(box) && box.x===320 && box.y===460, 'now=('+box.x+','+box.y+')');
}

// ---- 9. Determinism: box respawn timing is bit-identical across runs ----
{
  function run(){
    const w = new World(); w.deathY = 700;
    w.add(new StaticBody(0,500,300,40));
    const box = w.add(new Box(320,460,40,40));
    const out = [];
    for (let i=0;i<150;i++){ w.step(1/60); out.push(box.x.toFixed(3)+','+box.y.toFixed(3)); }
    return out.join('|');
  }
  const r1 = run(), r2 = run();
  check('box respawn cycling is bit-identical across identical runs', r1===r2, 'diverged');
}

// ---- 10. A carried box never triggers death checks (held boxes are excluded) ----
{
  // Isolate the death pass's own `!e.carried` guard directly. The
  // carry-SYNC step (step 0 of _stepOnce) only repositions a box when
  // BOTH `carried` and `carriedBy` are set — leaving carriedBy null
  // means the box's position is left alone while `carried` alone still
  // satisfies the death pass's skip condition, isolating that one guard
  // from the rest of the carry system's behavior (which is exercised
  // elsewhere, e.g. carry_collision_test.js).
  const w = new World(); w.deathY = 700;
  const box = w.add(new Box(320,900,40,40)); // already past deathY
  box.carried = true; // carriedBy deliberately left null
  for (let i=0;i<10;i++) w.step(1/60);
  check('a carried box past deathY is NOT killed/respawned — the death pass skips it entirely',
    w.entities.includes(box) && box.y===900 && !w.pendingReset,
    'in world='+w.entities.includes(box)+' y='+box.y+' pendingReset='+w.pendingReset);
}
console.log('\nDone.');
