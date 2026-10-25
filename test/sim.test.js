'use strict';

/**
 * Perihelion smoke tests.
 *
 *  1. headless simulation: 4 bots, many rounds, no NaNs, rounds actually resolve
 *  2. live server: join, bot backfill, input, seat limit, reconnect, static files
 *
 * Run with: npm test
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const G = require('../server/game');

const results = [];
function ok(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, name, err.message]);
  }
}

async function okA(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (err) {
    results.push([false, name, err.message]);
  }
}

async function waitFor(fn, ms = 4000, every = 25) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  return fn();
}

// ---------- 1. simulation ----------

function simulate(seed, seconds) {
  const room = G.createRoom('TEST', seed);
  for (let i = 0; i < 4; i++) G.makePlayer(room, { bot: true });

  const dt = 1 / 60;
  const stats = { nan: false, deaths: 0, rounds: 0, matches: 0, phases: new Set(), firstDeathAt: null, pickups: 0, maxSpeedSeen: 0, outOfBounds: 0, durations: [] };
  let prevPhase = room.phase;
  let liveStart = 0;

  for (let i = 0; i < seconds * 60; i++) {
    G.step(room, dt);
    const snap = G.snapshot(room);
    stats.phases.add(snap.phase);
    for (const e of snap.events) {
      if (e.k === 'die') {
        stats.deaths += 1;
        if (stats.firstDeathAt === null) stats.firstDeathAt = i / 60;
      }
      if (e.k === 'pickup') stats.pickups += 1;
    }
    for (const p of room.players) {
      if (![p.x, p.y, p.vx, p.vy, p.angle].every(Number.isFinite)) stats.nan = true;
      const r = Math.hypot(p.x, p.y);
      if (p.alive && (r > G.CFG.arenaR + 1 || r < G.CFG.starR - 1)) stats.outOfBounds += 1;
      stats.maxSpeedSeen = Math.max(stats.maxSpeedSeen, Math.hypot(p.vx, p.vy));
    }
    if (prevPhase !== room.phase) {
      if (room.phase === 'live') { stats.rounds += 1; liveStart = i / 60; }
      else if (prevPhase === 'live') stats.durations.push(i / 60 - liveStart);
      if (room.phase === 'matchEnd') stats.matches += 1;
      prevPhase = room.phase;
    }
  }
  stats.avgRound = stats.durations.length ? stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length : 0;
  stats.finalPlayers = room.players.length;
  stats.tick = room.tick;
  return stats;
}

console.log('\nPerihelion test run\n-------------------');

const simA = simulate(1234, 420);
ok('sim: no NaN positions', () => assert.strictEqual(simA.nan, false));
ok('sim: ships stay in bounds while alive', () => assert.strictEqual(simA.outOfBounds, 0, `${simA.outOfBounds} frames out of bounds`));
ok('sim: eliminations happen', () => assert.ok(simA.deaths > 3, `only ${simA.deaths} deaths`));
ok('sim: matches complete', () => assert.ok(simA.matches >= 1, 'no match ever reached matchEnd'));
ok('sim: rounds restart', () => assert.ok(simA.rounds > 6, `only ${simA.rounds} rounds`));
ok('sim: speed stays under the hard cap', () => assert.ok(simA.maxSpeedSeen <= G.CFG.hardMax + 1, `speed ${simA.maxSpeedSeen}`));
ok('sim: flares get collected', () => assert.ok(simA.pickups > 20, `only ${simA.pickups} flares`));
ok('sim: nobody dies in the opening seconds', () => assert.ok(simA.firstDeathAt === null || simA.firstDeathAt > 2, `first death at ${simA.firstDeathAt}s`));

// Match quality: a round should not be a one-second bloodbath or an endless stalemate.
const simB = simulate(99, 300);
ok('sim: rounds have a playable length', () => {
  assert.ok(simB.durations.length >= 2, `only ${simB.durations.length} completed rounds`);
  assert.ok(simB.avgRound > 4, `average round ${simB.avgRound.toFixed(1)}s`);
  assert.ok(simB.avgRound < 100, `average round ${simB.avgRound.toFixed(1)}s`);
});

// ---------- 2. live server ----------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Client {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.welcome = null;
    this.snap = null;
    this.msgCount = 0;
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      this.msgCount += 1;
      if (msg.t === 'welcome') this.welcome = msg;
      if (msg.t === 's') this.snap = msg;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  async join(room, name, token) {
    await this.opened;
    this.send({ t: 'join', room, name, token });
    await waitFor(() => this.welcome, 3000);
    return this.welcome;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  const PORT = 4319;
  const serverPath = path.join(__dirname, '..', 'server', 'index.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitFor(() => serverLog.includes('listening'), 6000);
    assert.ok(serverLog.includes('listening'), 'server did not start');

    // Static client is served.
    await okA('http: index served', async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      const html = await res.text();
      assert.strictEqual(res.status, 200);
      assert.ok(html.toLowerCase().includes('perihelion'));
    });
    await okA('http: health endpoint', async () => {
      const h = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      assert.strictEqual(h.status, 200);
    });
    await okA('http: metrics endpoint', async () => {
      const m = await fetch(`http://127.0.0.1:${PORT}/metrics`);
      const body = await m.text();
      assert.strictEqual(m.status, 200);
      assert.match(body, /perihelion_websocket_connections \d+/);
      assert.match(body, /perihelion_joins_total \d+/);
    });
    await okA('http: HEAD serves headers without a body', async () => {
      const h = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'HEAD' });
      assert.strictEqual(h.status, 200);
      assert.strictEqual(await h.text(), '');
      assert.ok(Number(h.headers.get('content-length')) > 0);
    });
    await okA('http: missing file is 404', async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/nope.js`);
      assert.strictEqual(r.status, 404);
    });
    await okA('http: traversal is forbidden', async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/../package.json`);
      assert.ok([403, 404].includes(r.status));
    });

    const a = new Client(PORT);
    const wa = await a.join('TST1', 'ALPHA');
    ok('join: gets an id and token', () => {
      assert.ok(wa.id && wa.id.startsWith('p'));
      assert.ok(wa.token && wa.token.length > 6);
      assert.strictEqual(wa.room, 'TST1');
      assert.strictEqual(wa.spectator, false);
    });

    await waitFor(() => a.snap, 2000);
    ok('room: bots backfill empty seats', () => {
      assert.ok(a.snap.players.length >= 4, `only ${a.snap.players.length} seats`);
      assert.ok(a.snap.players.filter((p) => p.b).length >= 3);
    });

    ok('room: snapshots never leak tokens', () => {
      const s = JSON.stringify(a.snap);
      assert.ok(!s.includes('token'));
      assert.ok(!s.includes(wa.token));
    });

    const startX = a.snap.players.find((p) => p.id === wa.id).x;
    a.send({ t: 'input', ax: 1, ay: 0, boost: true, pulse: false });
    await sleep(700);
    ok('input: thrust moves the ship', () => {
      const me = a.snap.players.find((p) => p.id === wa.id);
      assert.ok(Math.abs(me.x - startX) > 1 || Math.abs(me.vx) > 1, 'ship did not move');
    });

    const b = new Client(PORT);
    const wb = await b.join('TST1', 'BRAVO');
    await sleep(250);
    ok('room: human replaces a bot instead of overflowing', () => {
      const humans = a.snap.players.filter((p) => !p.b);
      assert.strictEqual(humans.length, 2, `${humans.length} humans`);
      assert.ok(a.snap.players.length >= 4);
    });

    ok('room: second player is visible to the first', () => {
      assert.ok(a.snap.players.some((p) => p.id === wb.id));
    });

    // Abrupt drop keeps the seat for the grace window, then releases it.
    b.close();
    await sleep(300);
    ok('disconnect: seat is held for reconnect', () => {
      const p = a.snap.players.find((x) => x.id === wb.id);
      assert.ok(p, 'player vanished immediately');
    });

    const b2 = new Client(PORT);
    const wb2 = await b2.join('TST1', 'BRAVO', wb.token);
    await sleep(300);
    ok('reconnect: same seat and token', () => {
      assert.strictEqual(wb2.id, wb.id);
      assert.ok(b2.snap.players.some((p) => p.id === wb.id && p.on === 1));
    });

    // Fill the room; the next human should become a spectator rather than break.
    const extra = [];
    for (let i = 0; i < 6; i++) {
      const c = new Client(PORT);
      await c.join('TST2', `FILL${i}`);
      extra.push(c);
    }
    const overflow = new Client(PORT);
    const wo = await overflow.join('TST2', 'EXTRA');
    ok('room: seventh player becomes a spectator', () => {
      assert.strictEqual(wo.spectator, true);
      assert.strictEqual(wo.id, null);
    });

    // Flood protection must not take the server down.
    for (let i = 0; i < 300; i++) a.send({ t: 'input', ax: 1, ay: 1, boost: false, pulse: false });
    await sleep(400);
    ok('server: survives an input flood', () => {
      assert.ok(a.ws.readyState === 1);
      assert.ok(a.msgCount > 5);
    });

    // Grace expiry should free the seat and bring a bot back.
    const c = new Client(PORT);
    const wc = await c.join('TST3', 'CHARLIE');
    await waitFor(() => c.snap, 2000);
    const seatCount = c.snap.players.length;
    c.close();
    await sleep(1600);
    const d = new Client(PORT);
    await d.join('TST3', 'DELTA');
    await sleep(300);
    ok('disconnect: expired seat is re-filled', () => {
      assert.ok(d.snap.players.length >= Math.min(4, seatCount));
    });

    for (const cl of [a, b2, overflow, d, ...extra]) cl.close();
  } catch (err) {
    results.push([false, 'integration harness', err.message]);
  } finally {
    child.kill();
  }

  console.log('');
  let failed = 0;
  for (const [pass, name, msg] of results) {
    if (pass) {
      console.log(`  PASS  ${name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${name}${msg ? ' — ' + msg : ''}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  console.log('sim stats:', JSON.stringify({ deaths: simA.deaths, rounds: simA.rounds, matches: simA.matches, pickups: simA.pickups, avgSpeedMax: Math.round(simA.maxSpeedSeen) }));
  process.exit(failed ? 1 : 0);
})();
