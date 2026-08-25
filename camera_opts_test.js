global.window = {};
require('./engine.js');
require('./level.js');
require('./netcode.js');
const { buildWorld } = window.Netcode;
function check(n,c,i){ console.log((c?'OK  ':'FAIL'),n,c?'':('- '+i)); if(!c)process.exitCode=1; }

// ---- 1. Default (no cameraOpts set): sane fallback dimensions ----
{
  const nw = buildWorld();
  check('no cameraOpts -> falls back to 960x540', nw.world.camera.w===960 && nw.world.camera.h===540,
    'w='+nw.world.camera.w+' h='+nw.world.camera.h);
}

// ---- 2. A level CAN customize viewport size + which edges block ----
{
  // Simulate a different level by monkey-patching Level.build to set
  // cameraOpts before returning, without touching the real level.js —
  // this proves netcode.js reads whatever the level provides generically,
  // not a hardcoded value.
  const { World, StaticBody } = window.Engine;
  const origBuild = window.Level.build;
  window.Level.build = function(world, nw) {
    world.add(new StaticBody(0,900,2000,40));
    nw.world.cameraOpts = { viewW: 500, viewH: 800, blockBottom: false };
    nw.world.levelBounds = { minX:0, minY:0, maxX:2000, maxY:900 };
  };
  const nw = buildWorld();
  check('custom viewW honored', nw.world.camera.w===500, 'w='+nw.world.camera.w);
  check('custom viewH honored', nw.world.camera.h===800, 'h='+nw.world.camera.h);
  check('custom blockBottom:false honored', nw.world.camera.blockBottom===false, '');
  check('unspecified edges (left/right/top) still default to blocking',
    nw.world.camera.blockLeft===true && nw.world.camera.blockRight===true && nw.world.camera.blockTop===true, '');
  window.Level.build = origBuild;
}

// ---- 3. levelBounds prefers what Level.build() sets, falls back to WIDTH/HEIGHT ----
{
  const { StaticBody } = window.Engine;
  const origBuild = window.Level.build;
  window.Level.build = function(world, nw) {
    world.add(new StaticBody(0,900,2000,40));
    // deliberately does NOT set levelBounds or cameraOpts
  };
  const nw = buildWorld();
  check('no levelBounds set by level -> falls back to Level.WIDTH/HEIGHT',
    nw.world.levelBounds.maxX===window.Level.WIDTH && nw.world.levelBounds.maxY===window.Level.HEIGHT, '');
  window.Level.build = origBuild;
}

// ---- 4. Real level.js: camera only blocks players, boxes pass through ----
{
  const { makePlayer } = window.Netcode;
  const nw = buildWorld();
  check('real level.js camera blocks players by default (all edges)',
    nw.world.camera.blockLeft && nw.world.camera.blockRight &&
    nw.world.camera.blockTop && nw.world.camera.blockBottom, '');

  const p = makePlayer(nw, 0);
  const box = nw.boxes[0]; // zone 0's first box
  check('a box exists to test against', !!box, '');
  // Push the box far left past where the camera would clamp, confirm no
  // engine crash and the box is not artificially constrained.
  const startX = box.x;
  box.x -= 2000; // simulate having been pushed far off-screen
  for (let i=0;i<10;i++) nw.world.step(1/60);
  check('box positioned off-camera does not get snapped back or blocked', box.x < startX,
    'box.x='+box.x+' startX='+startX);
}

console.log('\\nDone.');
