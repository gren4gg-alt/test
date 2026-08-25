global.window = {};
require('./engine.js');
const { World, StaticBody, MovingPlatform, Box, Player, Hazard,
        PressurePlate, LinkedDoor, Seesaw } = window.Engine;
function check(n,c,i){ console.log((c?'OK  ':'FAIL'),n,c?'':('- '+i)); if(!c)process.exitCode=1; }
const NONE={left:false,right:false,jump:false,action:false};
const RIGHT={left:false,right:true,jump:false,action:false};
function step(w,ps,inp,n=1){ for(let i=0;i<n;i++){ ps.forEach((p,j)=>p.handleInput((inp&&inp[j])||NONE,1/60)); w.step(1/60);} }

// ---- 1. Off-screen fall ----
{
  const w=new World(); w.deathY=700;
  w.add(new StaticBody(0,500,200,40)); // short ledge; walk off the right edge
  const p=w.add(new Player(150,460));
  step(w,[p],null,30);
  check('alive while on the ledge', !p.dead, 'y='+p.y);
  check('no pendingReset yet', w.pendingReset===false, '');
  step(w,[p],[RIGHT],240); // walk off and fall
  check('dies after falling past deathY', p.dead===true, 'y='+p.y.toFixed(1)+' deathY='+w.deathY);
  check('pendingReset raised', w.pendingReset===true, '');
}

// ---- 2. deathY = null disables the bounds check ----
{
  const w=new World(); w.deathY=null;
  const p=w.add(new Player(100,0));
  step(w,[p],null,300);
  check('deathY=null never kills by falling', p.dead===false, 'y='+p.y.toFixed(0));
}

// ---- 3. Hazard contact ----
{
  const w=new World();
  w.add(new StaticBody(0,500,800,40));
  const hz=w.add(new Hazard(300,460,80,40,{kind:'lava'}));
  const p=w.add(new Player(100,460));
  step(w,[p],null,20);
  check('alive away from hazard', !p.dead, '');
  step(w,[p],[RIGHT],90); // walk into it
  check('dies on hazard contact', p.dead===true, 'p.x='+p.x.toFixed(1)+' hazard at '+hz.x);
  check('hazard is non-solid (overlapped it rather than being blocked short)',
    p.right>hz.x, 'p.right='+p.right.toFixed(1)+' hazard.x='+hz.x);
}

// ---- 4. Dead players freeze (no further simulation) ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  const hz=w.add(new Hazard(300,440,80,60));
  const p=w.add(new Player(310,400));
  step(w,[p],null,30);
  check('player died in hazard', p.dead, '');
  const fx=p.x, fy=p.y;
  step(w,[p],[RIGHT],120); // hold right; corpse must not move
  check('dead player does not move', p.x===fx&&p.y===fy, 'was('+fx.toFixed(1)+','+fy.toFixed(1)+') now('+p.x.toFixed(1)+','+p.y.toFixed(1)+')');
  check('dead player velocity zeroed', p.vx===0&&p.vy===0, 'vx='+p.vx+' vy='+p.vy);
}

// ---- 5. killPlayer is idempotent ----
{
  const w=new World();
  w.add(new StaticBody(0,500,800,40));
  const p=w.add(new Player(100,460));
  step(w,[p],null,10);
  w.killPlayer(p);
  check('killPlayer sets dead', p.dead===true, '');
  w.pendingReset=false;          // simulate netcode consuming the signal
  w.killPlayer(p);               // still standing in lava, say
  check('re-killing a dead player does not re-raise pendingReset', w.pendingReset===false, '');
}

// ---- 6. Death drops a carried box ----
{
  const w=new World();
  w.add(new StaticBody(0,500,800,40));
  const p=w.add(new Player(100,460));
  const box=w.add(new Box(130,460,40,40));
  step(w,[p],null,20);
  w.updateCarrying(p,{action:true});
  check('picked up the box', p.carrying===box, '');
  w.killPlayer(p);
  check('death releases the carried box', p.carrying===null&&box.carried===false&&box.carriedBy===null,
    'carrying='+p.carrying+' carried='+box.carried);
}

// ---- 7. Boxes: survive hazards by default, die when killsBoxes ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,460,80,40));               // killsBoxes defaults false
  const box=w.add(new Box(310,400,40,40));
  for(let i=0;i<60;i++) w.step(1/60);
  check('box survives a normal hazard (usable as a bridge)', w.entities.includes(box), '');

  const w2=new World(); w2.deathY=null;
  w2.add(new StaticBody(0,500,800,40));
  w2.add(new Hazard(300,460,80,40,{killsBoxes:true}));
  const box2=w2.add(new Box(310,400,40,40));
  for(let i=0;i<60;i++) w2.step(1/60);
  check('box destroyed by a killsBoxes hazard', !w2.entities.includes(box2), '');
}

// ---- 8. Removing a doomed box does not corrupt other entities ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,460,80,40,{killsBoxes:true}));
  const box=w.add(new Box(310,400,40,40));
  const p=w.add(new Player(100,460));
  for(let i=0;i<60;i++){ p.handleInput(NONE,1/60); w.step(1/60); }
  check('box gone, player unaffected and still simulating', !w.entities.includes(box)&&!p.dead&&p.grounded, '');
}

// ---- 9. resetLevel restores everything ----
{
  const w=new World(); w.deathY=700;
  w.add(new StaticBody(0,500,100,40)); w.add(new StaticBody(160,500,140,40)); // notch at 100..160
  const plat=w.add(new MovingPlatform(400,460,80,16,[{x:400,y:460},{x:600,y:460}],120));
  const plate=w.add(new PressurePlate(100,500,60,10,['d']));
  const door=w.add(new LinkedDoor('d',700,300,20,120,{x:0,y:-100},200));
  const ss=new Seesaw(150,300,200,16,{}).addTo(w);
  const box=w.add(new Box(220,300,40,40));
  const p=w.add(new Player(110,460));

  const spawn={px:p.x,py:p.y,platx:plat.x,boxx:box.x,boxy:box.y};
  step(w,[p],null,60);
  check('plate held by player at spawn', plate.active===true, '');
  step(w,[p],[RIGHT],240);   // wander off and fall to death
  check('player died', p.dead===true, 'y='+p.y.toFixed(0));
  const genBefore=w.resetGeneration;

  w.resetLevel();

  check('resetGeneration incremented', w.resetGeneration===genBefore+1, '');
  check('pendingReset cleared', w.pendingReset===false, '');
  check('player revived', p.dead===false, '');
  check('player back at spawn', p.x===spawn.px&&p.y===spawn.py, 'now('+p.x+','+p.y+') spawn('+spawn.px+','+spawn.py+')');
  check('player velocity cleared', p.vx===0&&p.vy===0, '');
  check('box back at spawn', box.x===spawn.boxx&&box.y===spawn.boxy, 'now('+box.x+','+box.y+')');
  check('moving platform back at spawn', plat.x===spawn.platx, 'now='+plat.x);
  check('door reset to closed', door.open===false, '');
  check('seesaw tilt reset', ss.tilt===0, 'tilt='+ss.tilt);
  check('contact links cleared', p.groundEntity===null&&p.grounded===false, '');
}

// ---- 10. World is fully playable again after reset ----
{
  const w=new World(); w.deathY=700;
  w.add(new StaticBody(0,500,800,40));
  const hz=w.add(new Hazard(300,460,80,40));
  const p=w.add(new Player(100,460));
  step(w,[p],[RIGHT],90);
  check('died on hazard', p.dead, '');
  w.resetLevel();
  step(w,[p],null,40);
  check('player settles normally after reset', p.grounded===true&&!p.dead, 'y='+p.y.toFixed(1)+' grounded='+p.grounded);
  const x0=p.x;
  step(w,[p],[RIGHT],30);
  check('player can move again after reset', p.x>x0, 'x0='+x0.toFixed(1)+' now='+p.x.toFixed(1));
  step(w,[p],[RIGHT],90);
  check('hazard still lethal after reset (not consumed)', p.dead===true, '');
}

// ---- 11. Determinism: identical runs -> identical death frame ----
{
  function run(){
    const w=new World(); w.deathY=700;
    w.add(new StaticBody(0,500,200,40));
    const p=w.add(new Player(150,460));
    for(let i=0;i<400;i++){ p.handleInput(RIGHT,1/60); w.step(1/60); if(p.dead) return i; }
    return -1;
  }
  const a=run(), b=run();
  check('death occurs on the exact same tick across identical runs', a===b&&a>0, 'a='+a+' b='+b);
}

// ---- 12. One death flags the room once, even with several players ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,440,80,60));
  const p1=w.add(new Player(310,400));   // will die
  const p2=w.add(new Player(100,460));   // safe
  step(w,[p1,p2],null,40);
  check('only the player touching the hazard dies', p1.dead===true&&p2.dead===false,
    'p1='+p1.dead+' p2='+p2.dead);
  check('room flagged for reset by that one death', w.pendingReset===true, '');
  check('survivor still simulates normally', p2.grounded===true, '');
}

// ---- 13. A box lost to a pit comes back on reset (level stays solvable) ----
{
  const w=new World(); w.deathY=700;
  w.add(new StaticBody(0,500,200,40));
  const box=w.add(new Box(150,460,40,40));
  const p=w.add(new Player(50,460));
  const spawnX=box.x, spawnY=box.y;
  step(w,[p],[RIGHT],400);   // shove the box off the ledge into the pit
  check('box fell out of the world and was despawned', !w.entities.includes(box), '');
  w.resetLevel();
  check('lost box is restored by resetLevel (room still solvable)', w.entities.includes(box), '');
  check('restored box is back at its spawn', box.x===spawnX&&box.y===spawnY,
    'now('+box.x+','+box.y+') spawn('+spawnX+','+spawnY+')');
  check('restored box simulates again', box.world===w, '');
}

// ---- 14. A box burned by a killsBoxes hazard also returns on reset ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,460,80,40,{killsBoxes:true}));
  const box=w.add(new Box(310,400,40,40));
  const sx=box.x, sy=box.y;
  for(let i=0;i<60;i++) w.step(1/60);
  check('box consumed by lava', !w.entities.includes(box), '');
  w.resetLevel();
  check('consumed box restored at spawn', w.entities.includes(box)&&box.x===sx&&box.y===sy,
    'now('+box.x+','+box.y+')');
}

// ---- 15. Explicit world.remove() stays permanent (not resurrected) ----
{
  const w=new World();
  w.add(new StaticBody(0,500,800,40));
  const box=w.add(new Box(200,460,40,40));
  w.remove(box);
  w.resetLevel();
  check('explicitly removed entity is NOT resurrected by reset', !w.entities.includes(box), '');
}

// ---- 16. Dead player ignores input (no phantom velocity) ----
{
  const w=new World(); w.deathY=null;
  w.add(new StaticBody(0,500,800,40));
  w.add(new Hazard(300,440,80,60));
  const p=w.add(new Player(310,400));
  step(w,[p],null,30);
  check('player dead', p.dead, '');
  step(w,[p],[RIGHT],60);  // hold right into the void
  check('dead player reports zero velocity despite held input', p.vx===0&&p.vy===0,
    'vx='+p.vx+' vy='+p.vy);
}

console.log('\nDone.');
