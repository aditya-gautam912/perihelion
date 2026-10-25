'use strict';

/**
 * Perihelion - HTTP + WebSocket host.
 *
 * One process serves the static client and runs every room at a fixed 60 Hz.
 * Snapshots go out at 20 Hz; the client interpolates between them.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const G = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 3;          // 60 Hz sim -> 20 Hz wire
const EMPTY_ROOM_TTL = 90 * 1000;  // keep an abandoned private room around briefly
const RECONNECT_GRACE = Number(process.env.RECONNECT_GRACE_MS) || 20 * 1000;
const PUBLIC_ROOM = 'MAIN';
const metrics = { connections: 0, joins: 0, messages: 0 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------- rooms ----------

/** @type {Map<string, {room: any, sockets: Set<any>, lastActive: number}>} */
const rooms = new Map();

function getRoom(code, seed) {
  let entry = rooms.get(code);
  if (!entry) {
    entry = { room: G.createRoom(code, seed), sockets: new Set(), lastActive: Date.now() };
    rooms.set(code, entry);
    log(`room ${code} created`);
  }
  return entry;
}

function sanitizeCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return code.length >= 3 ? code : PUBLIC_ROOM;
}

function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}

// ---------- static files ----------

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const target = path.resolve(PUBLIC_DIR, `.${urlPath}`);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.url === '/metrics') {
    const body = [
      '# HELP perihelion_websocket_connections Active WebSocket connections',
      '# TYPE perihelion_websocket_connections gauge',
      `perihelion_websocket_connections ${wss.clients.size}`,
      '# HELP perihelion_joins_total Successful join messages',
      '# TYPE perihelion_joins_total counter',
      `perihelion_joins_total ${metrics.joins}`,
      '# HELP perihelion_messages_total WebSocket messages received',
      '# TYPE perihelion_messages_total counter',
      `perihelion_messages_total ${metrics.messages}`,
      '',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  serveStatic(req, res);
});

// ---------- websocket ----------

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });

wss.on('connection', (ws) => {
  metrics.connections += 1;
  ws.isAlive = true;
  ws.bucket = 90;          // messages allowed per second
  ws.bucketAt = Date.now();
  ws.entry = null;
  ws.player = null;
  ws.spectator = false;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    metrics.messages += 1;
    const now = Date.now();
    if (now - ws.bucketAt > 1000) {
      ws.bucketAt = now;
      ws.bucket = 90;
    }
    if (--ws.bucket < 0) return; // silently drop floods

    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'join': join(ws, msg); break;
      case 'input': {
        const p = ws.player;
        if (p) G.applyInput(p, msg.ax, msg.ay, msg.boost, msg.pulse);
        break;
      }
      case 'name': {
        const p = ws.player;
        if (p && typeof msg.name === 'string') {
          p.name = msg.name.trim().slice(0, 14) || p.name;
        }
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', ts: msg.ts });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    metrics.connections = Math.max(0, metrics.connections - 1);
    onClose(ws);
  });
  ws.on('error', () => {});
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function join(ws, msg) {
  if (ws.entry) return; // already seated

  const code = sanitizeCode(msg.room);
  metrics.joins += 1;
  const entry = getRoom(code);
  const room = entry.room;
  const token = typeof msg.token === 'string' ? msg.token.slice(0, 40) : null;
  const name = typeof msg.name === 'string' ? msg.name : '';

  // Rejoin with a matching token: recover the same seat, wins included.
  let player = token ? room.players.find((p) => p.token === token) : null;
  if (player) {
    player.connected = true;
    player.reconnectAt = null;
    player.bot = false;
  } else if (room.players.length < G.CFG.seats) {
    player = G.makePlayer(room, {
      name,
      bot: false,
      token: token || crypto.randomBytes(9).toString('base64url'),
    });
  }

  ws.entry = entry;
  ws.player = player;
  ws.spectator = !player;
  entry.sockets.add(ws);
  entry.lastActive = Date.now();

  G.reconcileBots(room);

  send(ws, {
    t: 'welcome',
    id: player ? player.id : null,
    token: player ? player.token : null,
    name: player ? player.name : 'SPECTATOR',
    room: code,
    spectator: !player,
    serverTime: Date.now(),
    cfg: { seats: G.CFG.seats },
  });
  send(ws, G.snapshot(room));
  log(`join ${code} ${player ? player.name : 'spectator'} (${room.players.length} seats)`);
}

function onClose(ws) {
  const entry = ws.entry;
  const player = ws.player;
  if (!entry) return;

  entry.sockets.delete(ws);
  entry.lastActive = Date.now();
  if (!player) return;

  player.connected = false;
  player.reconnectAt = Date.now() + RECONNECT_GRACE;
  log(`drop ${entry.room.code} ${player.name}`);

  // Release the seat if they never come back.
  setTimeout(() => {
    if (player.connected) return;
    const stillThere = entry.room.players.find((p) => p.id === player.id);
    if (!stillThere) return;
    G.removePlayer(entry.room, player.id);
    G.reconcileBots(entry.room);
    log(`seat released ${entry.room.code} ${player.name}`);
  }, RECONNECT_GRACE).unref();
}

// ---------- main loop ----------

let last = process.hrtime.bigint();
let acc = 0;
let wireTick = 0;

setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25; // tab was suspended / process stalled
  acc += dt;

  let steps = 0;
  while (acc >= TICK_MS / 1000 && steps < 5) {
    for (const entry of rooms.values()) {
      G.step(entry.room, TICK_MS / 1000);
    }
    acc -= TICK_MS / 1000;
    steps += 1;
  }

  wireTick += 1;
  if (wireTick % SNAPSHOT_EVERY !== 0) return;

  for (const [code, entry] of rooms) {
    if (!entry.sockets.size) {
      entry.room.events.length = 0; // nobody to show them to
      if (code !== PUBLIC_ROOM && Date.now() - entry.lastActive > EMPTY_ROOM_TTL) {
        rooms.delete(code);
        log(`room ${code} recycled`);
      }
      continue;
    }
    const payload = JSON.stringify(G.snapshot(entry.room));
    for (const ws of entry.sockets) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}, TICK_MS);

// Heartbeat so dead TCP connections do not hold seats forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  log(`Perihelion listening on http://localhost:${PORT}`);
});

function shutdown() {
  log('shutting down');
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
