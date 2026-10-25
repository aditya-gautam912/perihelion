'use strict';

/**
 * Perihelion - authoritative game simulation.
 *
 * One star, one gravity well, 2-6 ships, and a single flare in the ring.
 * Collect five flares to take the round. Being thrown into the star or past the
 * rim costs you 2.4 seconds, not the round - so the shoving stays reckless.
 *
 * Everything here is I/O-free and deterministic per room seed, which is what
 * test/sim.test.js exercises.
 */

const CFG = {
  arenaR: 560,        // past this radius you are lost to the void
  starR: 55,          // inside this radius you are consumed
  gravity: 9e6,       // G in px^3/s^2 (accel = G / r^2)
  gravityMax: 2000,
  thrust: 260,
  damping: 0.06,      // gentle drag so orbits decay
  maxSpeed: 300,
  hardMax: 480,       // impulses may overshoot briefly, never beyond this
  restitution: 0.9,
  boostImpulse: 170,
  boostCd: 3.0,
  pulseImpulse: 270,
  pulseRadius: 150,
  pulseCd: 0.8,
  shipR: 13,
  pickupR: 28,
  pickupEvery: 1.6,
  spawnR: 300,
  spawnGrace: 1.5,
  respawnDelay: 2.4,
  maxFlare: 2,
  scoreToWin: 4,
  roundMax: 70,
  winsToTake: 3,
  seats: 6,
  fillTo: 4,
  timers: { lobby: 4, roundEnd: 5, matchEnd: 10 },
};

const PALETTE = ['#57e6ff', '#ff6bd6', '#ffd166', '#7cff8a', '#b18cff', '#ff8f5e'];
const BOT_NAMES = ['VEGA', 'ORION', 'LYRA', 'CYGNUS', 'ATLAS', 'RHEA', 'JUNO', 'MIRA'];

const TAU = Math.PI * 2;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function len(x, y) { return Math.sqrt(x * x + y * y); }
function round1(v) { return Math.round(v * 10) / 10; }

/** Deterministic RNG so a room can be replayed from a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
function nextId() { return 'p' + (++idCounter).toString(36); }

// ---------- rooms ----------

function createRoom(code, seed) {
  return {
    code,
    seed: seed === undefined ? (Date.now() % 2147483647) : seed,
    rng: mulberry32(seed === undefined ? (Date.now() % 2147483647) : seed),
    players: [],
    pickups: [],
    events: [],
    tick: 0,
    round: 1,
    phase: 'lobby',
    tLeft: CFG.timers.lobby,
    starR: CFG.starR,
    pickupTimer: 0,
    lastWinner: null,
    createdAt: Date.now(),
  };
}

function freeColor(room) {
  const used = new Set(room.players.map((p) => p.color));
  for (const c of PALETTE) if (!used.has(c)) return c;
  return PALETTE[room.players.length % PALETTE.length];
}

/** Picks the spawn angle that is furthest from everyone already flying. */
function safeSpawnAngle(room) {
  let best = room.rng() * TAU;
  let bestScore = -1;
  for (let i = 0; i < 8; i++) {
    const a = room.rng() * TAU;
    const x = Math.cos(a) * CFG.spawnR;
    const y = Math.sin(a) * CFG.spawnR;
    let nearest = Infinity;
    for (const p of room.players) {
      if (!p.alive) continue;
      nearest = Math.min(nearest, len(p.x - x, p.y - y));
    }
    if (nearest > bestScore) { bestScore = nearest; best = a; }
  }
  return best;
}

function makePlayer(room, { name, bot = false, token = null, id = null }) {
  const p = {
    id: id || nextId(),
    token,
    name: (name || '').trim().slice(0, 14) || (bot ? BOT_NAMES[room.players.length % BOT_NAMES.length] : 'PILOT'),
    bot,
    connected: true,
    color: freeColor(room),
    x: 0, y: 0, vx: 0, vy: 0,
    angle: 0,
    input: { ax: 0, ay: 0, boost: false, pulse: false },
    boostCd: 0,
    pulseCd: 0,
    flare: 1,
    grace: CFG.spawnGrace,
    score: 0,
    wins: 0,
    alive: true,
    respawn: 0,
    elimReason: null,
    personality: 0.55 + (bot ? 0.45 : 0),
  };
  room.players.push(p);
  placeAtSpawn(room, p);
  return p;
}

function placeAtSpawn(room, p) {
  const a = safeSpawnAngle(room);
  const r = CFG.spawnR;
  p.x = Math.cos(a) * r;
  p.y = Math.sin(a) * r;
  const v = Math.sqrt(CFG.gravity / r) * 0.96; // start in a stable orbit
  p.vx = -Math.sin(a) * v;
  p.vy = Math.cos(a) * v;
  p.angle = a + Math.PI / 2;
  p.alive = true;
  p.respawn = 0;
  p.elimReason = null;
  p.grace = CFG.spawnGrace;
  p.flare = Math.max(1, p.flare);
  p.boostCd = 0;
  p.pulseCd = 0;
  p.input = { ax: 0, ay: 0, boost: false, pulse: false };
}

// ---------- lifecycle ----------

function startRound(room, { fresh = false } = {}) {
  if (fresh) room.round = 1;
  room.phase = 'live';
  room.tLeft = CFG.roundMax;
  room.starR = CFG.starR;
  room.pickups = [];
  room.events = [];
  room.pickupTimer = 0.6;
  room.lastWinner = null;

  for (const p of room.players) {
    p.score = 0;
    p.flare = 1;
    placeAtSpawn(room, p);
  }
  spawnPickup(room);
}

function endRound(room, winner, reason) {
  room.phase = 'roundEnd';
  room.tLeft = CFG.timers.roundEnd;
  room.lastWinner = winner ? { id: winner.id, name: winner.name, reason } : { id: null, name: null, reason };
  if (winner) winner.wins += 1;
  room.events.push({ k: 'round', winner: winner ? winner.id : null, reason });
}

function reconcileBots(room) {
  const humans = room.players.filter((p) => !p.bot).length;
  const target = Math.min(CFG.seats, Math.max(CFG.fillTo, humans));
  let bots = room.players.filter((p) => p.bot);

  while (room.players.length < target) {
    makePlayer(room, { bot: true });
    bots = room.players.filter((p) => p.bot);
  }
  // Humans take precedence: drop the least useful bot, dead ones first.
  while (room.players.length > target && bots.length) {
    const victim = bots.find((b) => !b.alive) || bots[bots.length - 1];
    removePlayer(room, victim.id);
    bots = room.players.filter((p) => p.bot);
  }
}

function removePlayer(room, id) {
  const i = room.players.findIndex((p) => p.id === id);
  if (i === -1) return null;
  const [p] = room.players.splice(i, 1);
  room.events.push({ k: 'leave', id: p.id });
  return p;
}

function spawnPickup(room) {
  const max = room.players.length >= 5 ? 2 : 1;
  if (room.pickups.length >= max) return;

  // In the last 15 seconds the star drags the flares deeper: risk/reward finale.
  const deep = room.tLeft < 15;
  const inner = deep ? 200 : 235;
  const outer = deep ? 330 : CFG.arenaR - 90;
  const a = room.rng() * TAU;
  const r = inner + room.rng() * (outer - inner);
  room.pickups.push({
    id: 'f' + Math.floor(room.rng() * 1e9).toString(36),
    x: Math.cos(a) * r,
    y: Math.sin(a) * r,
    born: room.tick,
    deep,
  });
}

function eliminate(room, p, reason) {
  if (!p.alive) return;
  p.alive = false;
  p.elimReason = reason;
  p.respawn = CFG.respawnDelay;
  p.vx *= 0.3;
  p.vy *= 0.3;
  room.events.push({ k: 'die', id: p.id, x: round1(p.x), y: round1(p.y), reason });
}

// ---------- simulation ----------

function applyInput(p, ax, ay, boost, pulse) {
  let x = Number(ax);
  let y = Number(ay);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  const m = len(x, y);
  if (m > 1) { x /= m; y /= m; }
  p.input = { ax: x, ay: y, boost: !!boost, pulse: !!pulse };
}

function pulse(room, p) {
  if (p.flare <= 0 || p.pulseCd > 0) return;
  p.flare -= 1;
  p.pulseCd = CFG.pulseCd;
  room.events.push({ k: 'pulse', id: p.id, x: round1(p.x), y: round1(p.y) });
  for (const o of room.players) {
    if (o === p || !o.alive || o.grace > 0) continue;
    const dx = o.x - p.x;
    const dy = o.y - p.y;
    const d = len(dx, dy) || 1;
    if (d > CFG.pulseRadius) continue;
    const falloff = 1 - d / CFG.pulseRadius;
    const imp = CFG.pulseImpulse * falloff * (0.6 + 0.4 * falloff);
    o.vx += (dx / d) * imp;
    o.vy += (dy / d) * imp;
    o.grace = Math.max(o.grace, 0.12);
  }
}

function stepPlayer(room, p, dt) {
  if (!p.alive) {
    p.respawn = Math.max(0, p.respawn - dt);
    if (p.respawn === 0 && room.phase === 'live') placeAtSpawn(room, p);
    return;
  }

  p.boostCd = Math.max(0, p.boostCd - dt);
  p.pulseCd = Math.max(0, p.pulseCd - dt);
  p.grace = Math.max(0, p.grace - dt);

  const inp = p.connected ? p.input : { ax: 0, ay: 0, boost: false, pulse: false };

  const r = len(p.x, p.y) || 1;
  const gAcc = Math.min(CFG.gravityMax, CFG.gravity / (r * r));
  let ax = (-p.x / r) * gAcc;
  let ay = (-p.y / r) * gAcc;

  ax += inp.ax * CFG.thrust;
  ay += inp.ay * CFG.thrust;

  if (inp.boost && p.boostCd <= 0) {
    const bm = len(inp.ax, inp.ay);
    const bx = bm > 0.15 ? inp.ax / bm : Math.cos(p.angle);
    const by = bm > 0.15 ? inp.ay / bm : Math.sin(p.angle);
    p.vx += bx * CFG.boostImpulse;
    p.vy += by * CFG.boostImpulse;
    p.boostCd = CFG.boostCd;
    room.events.push({ k: 'boost', id: p.id, x: round1(p.x), y: round1(p.y) });
  }
  if (inp.pulse) pulse(room, p);

  p.vx += ax * dt;
  p.vy += ay * dt;

  const damp = 1 - CFG.damping * dt;
  p.vx *= damp;
  p.vy *= damp;

  const sp = len(p.vx, p.vy);
  if (sp > CFG.maxSpeed) {
    p.vx = (p.vx / sp) * CFG.maxSpeed;
    p.vy = (p.vy / sp) * CFG.maxSpeed;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  if (sp > 25) p.angle = Math.atan2(p.vy, p.vx);

  const nr = len(p.x, p.y);
  if (nr < room.starR) eliminate(room, p, 'star');
  else if (nr > CFG.arenaR) eliminate(room, p, 'void');
}

function resolveCollisions(room) {
  const ps = room.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (!a.alive || a.grace > 0) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      if (!b.alive || b.grace > 0) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = len(dx, dy);
      const minD = CFG.shipR * 2;
      if (d >= minD) continue;
      if (d === 0) { dx = 1; dy = 0; d = 1; }
      const nx = dx / d;
      const ny = dy / d;

      const overlap = (minD - d) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;

      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const sep = rvx * nx + rvy * ny;
      if (sep > 0) continue;
      const jImp = (-(1 + CFG.restitution) * sep) / 2;
      a.vx -= nx * jImp; a.vy -= ny * jImp;
      b.vx += nx * jImp; b.vy += ny * jImp;

      if (Math.abs(sep) > 70) {
        room.events.push({ k: 'hit', x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2), s: Math.min(1, Math.abs(sep) / 260) });
      }
    }
  }
}

function collectPickups(room) {
  for (let i = room.pickups.length - 1; i >= 0; i--) {
    const f = room.pickups[i];
    for (const p of room.players) {
      if (!p.alive) continue;
      if (len(p.x - f.x, p.y - f.y) < CFG.pickupR + CFG.shipR) {
        p.flare = Math.min(CFG.maxFlare, p.flare + 1);
        p.score += 1;
        room.pickups.splice(i, 1);
        room.events.push({ k: 'pickup', id: p.id, x: round1(f.x), y: round1(f.y), sc: p.score });
        if (p.score >= CFG.scoreToWin) endRound(room, p, 'score');
        break;
      }
    }
  }
  if (room.phase !== 'live') return;
  room.pickupTimer -= 1 / 60;
  if (room.pickupTimer <= 0) {
    spawnPickup(room);
    room.pickupTimer = CFG.pickupEvery;
  }
}

function nearestAlive(room, p, filter) {
  let best = null;
  let bestD = Infinity;
  for (const o of room.players) {
    if (o === p || !o.alive) continue;
    if (filter && !filter(o)) continue;
    const d = len(o.x - p.x, o.y - p.y);
    if (d < bestD) { bestD = d; best = o; }
  }
  return { target: best, dist: bestD };
}

/**
 * Bots: fly to the flare, avoid the well and the rim, and shove whoever is
 * contesting it. Deliberately beatable - they commit to the inside line too
 * often.
 */
function botThink(room, p) {
  if (!p.alive) return;

  const r = len(p.x, p.y) || 1;
  const nx = p.x / r;
  const ny = p.y / r;
  const tx = -ny;
  const ty = nx;
  const vr = (p.x * p.vx + p.y * p.vy) / r; // radial velocity, + = outward
  const horizon = r + vr * 0.5;
  const star = room.starR;

  let dx = 0;
  let dy = 0;
  let boost = false;
  let fire = false;

  if (r < star + 190 || horizon < star + 150) {
    dx = nx + tx * 0.5;
    dy = ny + ty * 0.5;
    boost = r < star + 120 && p.boostCd <= 0;
  } else if (r > CFG.arenaR - 120 || horizon > CFG.arenaR - 40) {
    dx = -nx + tx * 0.15;
    dy = -ny + ty * 0.15;
    boost = p.boostCd <= 0 && vr > 70;
  } else {
    const flare = room.pickups[0] || null;
    const hunt = nearestAlive(room, p);
    let goal = flare;
    let chasingRival = false;

    // If a rival is breathing down our neck, deal with that first.
    if (hunt.target && hunt.dist < 120) { goal = hunt.target; chasingRival = true; }
    if (!goal) { goal = hunt.target; chasingRival = true; }

    if (goal) {
      const gx = goal.x - p.x;
      const gy = goal.y - p.y;
      const g = len(gx, gy) || 1;
      const lead = Math.min(0.5, g / 1200);
      const aimX = (gx + (goal.vx || 0) * lead * 30) / g;
      const aimY = (gy + (goal.vy || 0) * lead * 30) / g;

      // Steer by matching a desired velocity rather than pointing at the target:
      // this makes bots brake into the flare instead of slingshotting past it.
      const wantSpeed = chasingRival
        ? CFG.maxSpeed * 0.95
        : clamp(g / 1.15 + 45, 0, CFG.maxSpeed * 0.88);
      let sx = aimX * wantSpeed - p.vx;
      let sy = aimY * wantSpeed - p.vy;
      if (len(sx, sy) < 10) { sx = aimX; sy = aimY; }

      const m = len(sx, sy) || 1;
      const outComp = (sx * nx + sy * ny) / m;
      const greed = p.personality;
      boost = p.boostCd <= 0 && g > 200 && g < 420 && outComp < 0.3 && room.rng() < 0.05 * greed;

      if (p.flare > 0 && p.pulseCd <= 0) {
        const near = nearestAlive(room, p);
        if (near.target && near.dist < CFG.pulseRadius * 0.8) fire = true;
      }

      // A little orbital drift keeps them from flying dead-straight lines.
      dx = sx + tx * 18 * (1 - Math.min(1, g / 300));
      dy = sy + ty * 18 * (1 - Math.min(1, g / 300));
    } else {
      dx = tx * 0.9 - nx * 0.08;
      dy = ty * 0.9 - ny * 0.08;
    }
  }

  const noise = (room.rng() - 0.5) * 0.18;
  const ca = Math.cos(noise);
  const sa = Math.sin(noise);
  const rx = dx * ca - dy * sa;
  const ry = dx * sa + dy * ca;

  const m = len(rx, ry) || 1;
  p.input = { ax: rx / m, ay: ry / m, boost, pulse: fire };
}

function step(room, dt) {
  room.tick += 1;

  if (room.phase === 'lobby') {
    room.tLeft -= dt;
    if (room.tLeft <= 0) {
      reconcileBots(room);
      startRound(room);
    }
    return;
  }

  if (room.phase === 'live') {
    room.tLeft -= dt;
    for (const p of room.players) {
      if (p.bot) botThink(room, p);
    }
    for (const p of room.players) stepPlayer(room, p, dt);
    resolveCollisions(room);
    collectPickups(room);

    for (const p of room.players) {
      if (!p.alive) continue;
      const sp = len(p.vx, p.vy);
      if (sp > CFG.hardMax) {
        p.vx = (p.vx / sp) * CFG.hardMax;
        p.vy = (p.vy / sp) * CFG.hardMax;
      }
    }

    if (room.phase !== 'live') return;

    if (room.tLeft <= 0) {
      const ranked = room.players.filter((p) => p.alive).sort(
        (a, b) => b.score - a.score || len(a.x, a.y) - len(b.x, b.y)
      );
      // Ties break by depth in the well: the pilot living closest to the star.
      endRound(room, ranked[0] || null, 'time');
    }
    return;
  }

  if (room.phase === 'roundEnd') {
    room.tLeft -= dt;
    if (room.tLeft <= 0) {
      const champ = room.players.find((p) => p.wins >= CFG.winsToTake);
      if (champ) {
        room.phase = 'matchEnd';
        room.tLeft = CFG.timers.matchEnd;
        room.lastWinner = { id: champ.id, name: champ.name, reason: 'match' };
      } else {
        room.round += 1;
        startRound(room);
      }
    }
    return;
  }

  if (room.phase === 'matchEnd') {
    room.tLeft -= dt;
    if (room.tLeft <= 0) {
      for (const p of room.players) p.wins = 0;
      room.round = 1;
      startRound(room, { fresh: true });
    }
  }
}

// ---------- wire format ----------

function snapshot(room) {
  const players = room.players.map((p) => ({
    id: p.id,
    n: p.name,
    c: p.color,
    b: p.bot ? 1 : 0,
    on: p.connected ? 1 : 0,
    a: p.alive ? 1 : 0,
    x: round1(p.x),
    y: round1(p.y),
    vx: round1(p.vx),
    vy: round1(p.vy),
    an: Math.round(p.angle * 100) / 100,
    sc: p.score,
    w: p.wins,
    f: p.flare,
    rs: Math.round(p.respawn * 10) / 10,
    bc: Math.round(p.boostCd * 10) / 10,
    pc: Math.round(p.pulseCd * 10) / 10,
    g: p.grace > 0 ? 1 : 0,
    er: p.elimReason,
  }));

  return {
    t: 's',
    tick: room.tick,
    phase: room.phase,
    tLeft: Math.max(0, Math.round(room.tLeft * 10) / 10),
    round: room.round,
    winner: room.lastWinner,
    players,
    pickups: room.pickups.map((f) => ({ id: f.id, x: round1(f.x), y: round1(f.y), d: f.deep ? 1 : 0 })),
    events: room.events.splice(0, 24),
    cfg: {
      arenaR: CFG.arenaR,
      starR: round1(room.starR),
      shipR: CFG.shipR,
      pulseRadius: CFG.pulseRadius,
      spawnR: CFG.spawnR,
      target: CFG.scoreToWin,
    },
  };
}

module.exports = {
  CFG,
  PALETTE,
  createRoom,
  makePlayer,
  removePlayer,
  reconcileBots,
  startRound,
  applyInput,
  step,
  snapshot,
};
