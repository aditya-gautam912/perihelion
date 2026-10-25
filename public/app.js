'use strict';

/**
 * Perihelion client.
 *
 * The server owns the truth. We buffer its 20 Hz snapshots and render ~110 ms in
 * the past, which is enough to hide jitter without any prediction/rollback code.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const menu = $('menu');
  const hud = $('hud');
  const board = $('board');
  const banner = $('banner');
  const note = $('note');
  const toastEl = $('toast');
  const reconnectEl = $('reconnect');
  const touchEl = $('touch');
  const stick = $('stick');
  const knob = $('knob');
  const nameInput = $('nameInput');
  const fineprint = $('fineprint');

  const params = new URLSearchParams(location.search);
  const INTERP = 110;          // ms of interpolation delay
  const SEND_EVERY = 40;       // ms between input packets (25 Hz)
  const MAX_BUF = 40;

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; }
    },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  const state = {
    ws: null,
    joined: false,
    connected: false,
    attempt: 0,
    myId: null,
    token: store.get('peri.token', '') || null,
    name: store.get('peri.name', ''),
    room: clean(params.get('room')) || 'MAIN',
    spectator: false,
    buf: [],
    latest: null,
    roster: new Map(),
    particles: [],
    waves: [],
    pending: [],
    trails: new Map(),
    shake: 0,
    sound: store.get('peri.sound', '1') === '1',
    started: false,
    lastPhase: null,
    lastRound: 0,
    lastTick: 0,
    phaseSaid: '',
    fpsHint: 0,
  };

  const W = () => window.innerWidth;
  const H = () => window.innerHeight;

  // ---------- audio ----------

  let audio = null;
  function audioCtx() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function tone(freq, dur, type, gain, slideTo, delay) {
    if (!state.sound) return;
    const ac = audioCtx();
    if (!ac) return;
    const t0 = ac.currentTime + (delay || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain == null ? 0.09 : gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, gain, cutoff) {
    if (!state.sound) return;
    const ac = audioCtx();
    if (!ac) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buffer = ac.createBuffer(1, n, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff || 900;
    const g = ac.createGain();
    g.gain.value = gain == null ? 0.12 : gain;
    src.connect(filter).connect(g).connect(ac.destination);
    src.start();
  }

  const sfx = {
    pickup: () => { tone(880, 0.09, 'sine', 0.07); tone(1320, 0.12, 'sine', 0.05, 1560, 0.05); },
    pulse: () => { tone(240, 0.38, 'triangle', 0.11, 55); noise(0.22, 0.09, 700); },
    die: () => { tone(180, 0.5, 'sawtooth', 0.08, 42); noise(0.35, 0.12, 420); },
    boost: () => { noise(0.16, 0.07, 1400); },
    hit: () => { tone(120, 0.12, 'square', 0.05, 70); },
    tick: () => { tone(520, 0.07, 'sine', 0.05); },
    start: () => { tone(660, 0.16, 'sine', 0.07); tone(990, 0.22, 'sine', 0.05, 990, 0.1); },
    win: () => { tone(523, 0.18, 'sine', 0.07); tone(784, 0.18, 'sine', 0.06, 784, 0.12); tone(1047, 0.4, 'sine', 0.06, 1047, 0.24); },
  };

  // ---------- geometry ----------

  const starField = [];
  (function seedStars() {
    let s = 1337;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 190; i++) {
      starField.push({
        x: (rnd() * 2 - 1) * 900,
        y: (rnd() * 2 - 1) * 900,
        r: 0.4 + rnd() * 1.5,
        p: rnd() * Math.PI * 2,
        a: 0.18 + rnd() * 0.55,
      });
    }
  })();

  const view = { scale: 1, cx: 0, cy: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W() * dpr);
    canvas.height = Math.round(H() * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = W() < 760 ? 26 : 70;
    view.scale = (Math.min(W(), H()) - pad * 2) / (2 * 660);
    view.cx = W() / 2;
    view.cy = H() / 2 + (W() < 760 ? -10 : 10);
  }
  window.addEventListener('resize', resize);
  resize();

  const sx = (x) => view.cx + x * view.scale;
  const sy = (y) => view.cy + y * view.scale;

  // ---------- networking ----------

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(`${proto}://${location.host}`); } catch { scheduleReconnect(); return; }
    state.ws = ws;

    ws.onopen = () => {
      state.attempt = 0;
      reconnectEl.hidden = true;
      send({ t: 'join', room: state.room, name: state.name, token: state.token });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || !msg.t) return;
      if (msg.t === 'welcome') onWelcome(msg);
      else if (msg.t === 's') onSnapshot(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      if (state.started) {
        reconnectEl.hidden = false;
        scheduleReconnect();
      }
    };

    ws.onerror = () => { /* onclose handles it */ };
  }

  function scheduleReconnect() {
    state.attempt += 1;
    if (state.attempt > 10) {
      reconnectEl.textContent = 'Could not reach the arena — reload to retry.';
      return;
    }
    setTimeout(() => {
      if (!state.started) return;
      connect();
    }, Math.min(4000, 400 * state.attempt));
  }

  function onWelcome(msg) {
    state.joined = true;
    state.connected = true;
    state.myId = msg.id;
    state.room = msg.room;
    state.spectator = !!msg.spectator;
    if (msg.token) { state.token = msg.token; store.set('peri.token', msg.token); }
    // A (re)join can jump the timeline: drop stale interpolation data.
    state.buf.length = 0;
    state.pending.length = 0;
    state.trails.clear();
    $('roomCode').textContent = state.room;
    updateFineprint();
    if (state.spectator) showToast('Arena full — you are spectating this round');
    else if (state.name) send({ t: 'name', name: state.name });
  }

  function onSnapshot(s) {
    const now = performance.now();
    state.buf.push({ at: now, s });
    if (state.buf.length > MAX_BUF) state.buf.shift();
    state.latest = s;

    for (const p of s.players) {
      if (!state.roster.has(p.id)) {
        state.roster.set(p.id, { color: p.c, name: p.n });
      }
    }
    for (const id of state.roster.keys()) {
      if (!s.players.some((p) => p.id === id)) state.roster.delete(id);
    }

    if (s.events && s.events.length) {
      for (const e of s.events) {
        state.pending.push({ due: now + INTERP, e });
      }
    }

    if (s.phase !== state.lastPhase) {
      onPhase(s.phase, s);
      state.lastPhase = s.phase;
    }
    state.lastRound = s.round;
  }

  // ---------- input ----------

  const keys = new Set();
  const stickVec = { x: 0, y: 0, active: false };
  const edge = { boost: false, pulse: false };
  let sendTimer = 0;

  function inputVector() {
    if (stickVec.active) return { x: stickVec.x, y: stickVec.y };
    let x = 0;
    let y = 0;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (keys.has('w') || keys.has('arrowup')) y -= 1;
    if (keys.has('s') || keys.has('arrowdown')) y += 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y };
  }

  function pumpInput() {
    if (!state.joined || !state.connected) return;
    const v = inputVector();
    send({ t: 'input', ax: v.x, ay: v.y, boost: edge.boost, pulse: edge.pulse });
    edge.boost = false;
    edge.pulse = false;
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k);
    if (k === 'shift') edge.boost = true;
    if (k === ' ') edge.pulse = true;
    if (k === 'm') toggleSound();
  });

  window.addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); });
  window.addEventListener('blur', () => keys.clear());

  // Touch stick.
  (function bindStick() {
    let id = null;
    const R = 46;

    const move = (ev) => {
      const t = [...ev.touches].find((x) => x.identifier === id) || ev.changedTouches[0];
      if (!t) return;
      const box = stick.getBoundingClientRect();
      let dx = t.clientX - (box.left + box.width / 2);
      let dy = t.clientY - (box.top + box.height / 2);
      const m = Math.hypot(dx, dy);
      if (m > R) { dx = (dx / m) * R; dy = (dy / m) * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = 0.16;
      const nx = dx / R;
      const ny = dy / R;
      const mag = Math.hypot(nx, ny);
      stickVec.active = mag > dead;
      if (stickVec.active) {
        const s = (mag - dead) / (1 - dead) / mag;
        stickVec.x = nx * s;
        stickVec.y = ny * s;
      }
    };

    const end = () => {
      id = null;
      stickVec.active = false;
      stickVec.x = 0;
      stickVec.y = 0;
      knob.style.transform = 'translate(0px, 0px)';
    };

    stick.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      id = ev.changedTouches[0].identifier;
      move(ev);
    }, { passive: false });
    stick.addEventListener('touchmove', (ev) => { ev.preventDefault(); move(ev); }, { passive: false });
    stick.addEventListener('touchend', (ev) => { ev.preventDefault(); end(); }, { passive: false });
    stick.addEventListener('touchcancel', end);
  })();

  for (const btn of document.querySelectorAll('.action')) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btn.dataset.act === 'boost') edge.boost = true;
      if (btn.dataset.act === 'pulse') edge.pulse = true;
    });
  }

  // ---------- menu ----------

  function updateFineprint() {
    if (state.room === 'MAIN') {
      fineprint.textContent = 'Joining the live public arena. Empty seats are held by bots — drop in any time.';
      $('playBtn').textContent = 'Enter the arena';
    } else {
      fineprint.textContent = `Private arena ${state.room}. Send the invite link to a friend — bots hold the rest.`;
      $('playBtn').textContent = `Join room ${state.room}`;
    }
  }

  function defaultName() {
    return 'PILOT-' + String(Math.floor(Math.random() * 90) + 10);
  }

  function begin() {
    state.name = (nameInput.value || '').trim().slice(0, 14) || defaultName();
    nameInput.value = state.name;
    store.set('peri.name', state.name);
    state.started = true;

    menu.classList.add('gone');
    setTimeout(() => { menu.hidden = true; }, 360);
    hud.hidden = false;
    if (matchMedia('(pointer: coarse)').matches) touchEl.hidden = false;

    const ac = audioCtx(); // user gesture: unlock audio
    if (ac && ac.state === 'suspended') ac.resume();

    updateFineprint();
    connect();
  }

  $('enterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    begin();
  });

  $('privateBtn').addEventListener('click', () => {
    const code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    state.room = code;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
    updateFineprint();
    begin();
  });

  function inviteUrl() {
    const url = new URL(location.href);
    url.search = '';
    if (state.room !== 'MAIN') url.searchParams.set('room', state.room);
    return url.toString();
  }

  $('copyLink').addEventListener('click', async () => {
    const link = inviteUrl();
    try {
      await navigator.clipboard.writeText(link);
      showToast('Invite link copied');
    } catch {
      showToast(link);
    }
  });

  let toastTimer = 0;
  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function toggleSound() {
    state.sound = !state.sound;
    store.set('peri.sound', state.sound ? '1' : '0');
    $('soundBtn').classList.toggle('off', !state.sound);
    if (state.sound) tone(660, 0.08, 'sine', 0.05);
  }

  $('soundBtn').addEventListener('click', toggleSound);
  $('soundBtn').classList.toggle('off', !state.sound);

  nameInput.value = state.name;
  updateFineprint();

  // ---------- snapshot interpolation ----------

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function blend(a, b, t) {
    if (!b) return a;
    const out = {
      phase: b.phase,
      tLeft: b.tLeft,
      round: b.round,
      winner: b.winner,
      cfg: b.cfg,
      events: b.events,
      pickups: t < 0.5 ? a.pickups : b.pickups,
      players: [],
    };
    for (const pb of b.players) {
      const pa = a.players.find((p) => p.id === pb.id);
      if (!pa) { out.players.push(pb); continue; }
      out.players.push({
        ...pb,
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t),
        vx: lerp(pa.vx, pb.vx, t),
        vy: lerp(pa.vy, pb.vy, t),
        an: lerpAngle(pa.an, pb.an, t),
      });
    }
    return out;
  }

  function sample(now) {
    const buf = state.buf;
    if (!buf.length) return null;
    const target = now - INTERP;
    if (target <= buf[0].at) return buf[0].s;
    let i = buf.length - 1;
    while (i > 0 && buf[i].at > target) i -= 1;
    const a = buf[i];
    const b = buf[i + 1];
    if (!b || b.at <= a.at) return a.s;
    const t = Math.max(0, Math.min(1, (target - a.at) / (b.at - a.at)));
    return blend(a.s, b.s, t);
  }

  // ---------- effects ----------

  function spawnBurst(x, y, color, n, speed) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const count = reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.25 + Math.random() * 0.9);
      state.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.8,
        max: 1,
        color,
        size: 1 + Math.random() * 2.4,
      });
    }
  }

  function ring(x, y, maxR, color, width) {
    state.waves.push({ x, y, r: 6, maxR, color, w: width || 3, life: 1 });
  }

  function processEvents() {
    const now = performance.now();
    const due = state.pending.filter((p) => p.due <= now);
    if (!due.length) return;
    state.pending = state.pending.filter((p) => p.due > now);

    for (const { e } of due) {
      if (e.k === 'pickup') {
        const who = state.roster.get(e.id);
        spawnBurst(e.x, e.y, who ? who.color : '#ffd166', 16, 150);
        ring(e.x, e.y, 46, who ? who.color : '#ffd166', 2);
        if (e.id === state.myId) sfx.pickup();
      } else if (e.k === 'pulse') {
        spawnBurst(e.x, e.y, '#ff9ae6', 22, 220);
        ring(e.x, e.y, 170, '#ff6bd6', 4);
        state.shake = Math.min(10, state.shake + 5);
        sfx.pulse();
      } else if (e.k === 'die') {
        const who = state.roster.get(e.id);
        const color = who ? who.color : '#ffffff';
        spawnBurst(e.x, e.y, color, 34, 300);
        ring(e.x, e.y, 110, color, 3);
        state.shake = Math.min(14, state.shake + 7);
        sfx.die();
      } else if (e.k === 'boost') {
        const who = state.roster.get(e.id);
        spawnBurst(e.x, e.y, who ? who.color : '#57e6ff', 8, 90);
        if (e.id === state.myId) sfx.boost();
      } else if (e.k === 'hit') {
        spawnBurst(e.x, e.y, '#ffffff', Math.round(6 + e.s * 10), 120 + e.s * 160);
        if (e.s > 0.45) sfx.hit();
      } else if (e.k === 'round') {
        if (e.winner === state.myId) sfx.win();
      }
    }
  }

  function onPhase(phase, s) {
    if (phase === 'live') {
      banner.classList.remove('show');
      sfx.start();
    } else if (phase === 'roundEnd') {
      sfx.tick();
    }
  }

  // ---------- HUD ----------

  let boardSig = '';
  function updateHud(s) {
    if (!s) return;
    const target = (s.cfg && s.cfg.target) || 4;
    const alive = s.players.filter((p) => p.a).length;
    const me = s.players.find((p) => p.id === state.myId);

    $('roundLabel').textContent = `Round ${s.round}`;
    $('aliveLabel').textContent = `${alive} racing`;
    $('myScore').textContent = me ? `${me.sc} / ${target}` : '—';

    const sig = s.players.map((p) => `${p.id}:${p.sc}:${p.w}:${p.a}:${p.n}`).join('|') + '#' + state.myId;
    if (sig !== boardSig) {
      boardSig = sig;
      const rows = [...s.players].sort((a, b) => b.sc - a.sc || b.w - a.w || a.n.localeCompare(b.n));
      board.innerHTML = rows.map((p) => `
        <div class="board-row ${p.id === state.myId ? 'me' : ''} ${p.a ? '' : 'out'}">
          <span class="swatch" style="background:${p.c};color:${p.c}"></span>
          <span class="board-name">${escapeHtml(p.n)}${p.b ? '<em>BOT</em>' : ''}</span>
          <span class="board-score">${p.sc}</span>
          <span class="pips">${[0, 1, 2].map((i) => `<span class="pip ${p.w > i ? 'on' : ''}"></span>`).join('')}</span>
        </div>`).join('');
    }

    // Banner + note are driven by round state.
    let html = '';
    let showBanner = false;
    let noteText = '';

    if (s.phase === 'lobby') {
      const n = Math.max(1, Math.ceil(s.tLeft));
      html = `<span class="count">${n}</span><small>Grab the first flare</small>`;
      showBanner = true;
    } else if (s.phase === 'roundEnd' && s.winner) {
      const w = s.winner;
      html = `${escapeHtml(w.name || 'Nobody')} takes the round<small>${reasonText(w.reason)} · next in ${Math.max(1, Math.ceil(s.tLeft))}</small>`;
      showBanner = true;
    } else if (s.phase === 'matchEnd' && s.winner) {
      html = `${escapeHtml(s.winner.name || 'Someone')} wins the match<small>First to three rounds · new match in ${Math.max(1, Math.ceil(s.tLeft))}</small>`;
      showBanner = true;
    }

    if (showBanner) {
      if (banner.innerHTML !== html) banner.innerHTML = html;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }

    if (state.spectator) {
      noteText = 'Arena full — spectating';
    } else if (me && !me.a) {
      const reason = me.er === 'star' ? 'consumed by the star' : 'lost to the void';
      noteText = `Respawning in ${Math.max(0, me.rs).toFixed(1)}s — ${reason}`;
    }

    if (noteText) {
      if (note.textContent !== noteText) note.textContent = noteText;
      note.classList.add('show');
    } else {
      note.classList.remove('show');
    }
  }

  function reasonText(reason) {
    if (reason === 'score') return 'Four flares banked';
    if (reason === 'time') return 'Most flares when the clock ran out';
    if (reason === 'star') return 'Pulled past the event horizon';
    if (reason === 'void') return 'Lost to the void';
    if (reason === 'match') return 'First to three rounds';
    return 'Winner';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- rendering ----------

  function drawBackground(t) {
    const g = ctx.createRadialGradient(view.cx, view.cy, 0, view.cx, view.cy, Math.max(W(), H()) * 0.9);
    g.addColorStop(0, '#0a1224');
    g.addColorStop(0.55, '#070b16');
    g.addColorStop(1, '#04060c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W(), H());

    ctx.save();
    for (const s of starField) {
      const x = sx(s.x);
      const y = sy(s.y);
      if (x < -20 || x > W() + 20 || y < -20 || y > H() + 20) continue;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.3 + s.p);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = '#cfe6ff';
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawArena(cfg, t) {
    const R = cfg.arenaR * view.scale;

    // Outer boundary: past this you are gone.
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 107, 214, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 9]);
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Safe-orbit guide.
    ctx.strokeStyle = 'rgba(87, 230, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, (cfg.spawnR || 300) * view.scale, 0, Math.PI * 2);
    ctx.stroke();

    // Tick marks around the arena.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const r1 = R;
      const r2 = R + (i % 3 === 0 ? 9 : 4);
      ctx.beginPath();
      ctx.moveTo(view.cx + Math.cos(a) * r1, view.cy + Math.sin(a) * r1);
      ctx.lineTo(view.cx + Math.cos(a) * r2, view.cy + Math.sin(a) * r2);
      ctx.stroke();
    }
    ctx.restore();

    // Danger halo near the star.
    const danger = ctx.createRadialGradient(view.cx, view.cy, cfg.starR * view.scale, view.cx, view.cy, 250 * view.scale);
    danger.addColorStop(0, 'rgba(255, 90, 60, 0.16)');
    danger.addColorStop(1, 'rgba(255, 90, 60, 0)');
    ctx.fillStyle = danger;
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, 250 * view.scale, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStar(cfg, t) {
    const r = cfg.starR * view.scale * (1 + Math.sin(t * 1.8) * 0.015);
    const cx = view.cx;
    const cy = view.cy;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const corona = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 4.6);
    corona.addColorStop(0, 'rgba(255, 170, 80, 0.5)');
    corona.addColorStop(0.32, 'rgba(255, 110, 40, 0.16)');
    corona.addColorStop(1, 'rgba(255, 60, 20, 0)');
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 4.6, 0, Math.PI * 2);
    ctx.fill();

    // Solar flares: a couple of slow arcs that read as "this thing is unstable".
    for (let i = 0; i < 5; i++) {
      const a = t * (0.18 + i * 0.07) + i * 2.1;
      const len = 0.7 + Math.sin(t * 0.9 + i) * 0.35;
      const flareColor = i % 2 === 0 ? `rgba(255, ${120 + i * 30}, 60, 0.25)` : `rgba(255, 200, 100, 0.15)`;
      ctx.strokeStyle = flareColor;
      ctx.lineWidth = 2 + Math.sin(t * 2) * 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.35 + i * 0.28), a, a + len);
      ctx.stroke();
    }

    const core = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r);
    core.addColorStop(0, '#fffdf5');
    core.addColorStop(0.35, '#ffe2a0');
    core.addColorStop(0.72, '#ff9a3c');
    core.addColorStop(1, '#c9330f');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawPickups(pickups, t) {
    for (const f of pickups) {
      const x = sx(f.x);
      const y = sy(f.y);
      const pulse = 0.85 + 0.15 * Math.sin(t * 4 + f.x);
      const r = 9 * pulse;
      const hot = f.d ? '#ff8a5c' : '#ffd166';
      const glowRGB = f.d ? '255, 120, 70' : '255, 209, 102';

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * 0.8);
      ctx.globalCompositeOperation = 'lighter';

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 34);
      glow.addColorStop(0, `rgba(${glowRGB}, 0.5)`);
      glow.addColorStop(1, `rgba(${glowRGB}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.72, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.72, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawTrail(id, color) {
    const trail = state.trails.get(id);
    if (!trail || trail.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < trail.length; i++) {
      const p0 = trail[i - 1];
      const p1 = trail[i];
      const a = (i / trail.length) * 0.45;
      ctx.strokeStyle = hexA(color, a);
      ctx.lineWidth = (i / trail.length) * 5 * view.scale * 2.4;
      ctx.beginPath();
      ctx.moveTo(sx(p0.x), sy(p0.y));
      ctx.lineTo(sx(p1.x), sy(p1.y));
      ctx.stroke();
    }
    ctx.restore();
  }

  function hexA(hex, alpha) {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function drawShip(p, t) {
    const x = sx(p.x);
    const y = sy(p.y);
    const s = Math.max(0.62, view.scale);
    const size = 15 * s;
    const isMe = p.id === state.myId;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.an);

    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 3.4);
    glow.addColorStop(0, hexA(p.c, 0.34));
    glow.addColorStop(1, hexA(p.c, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, size * 3.4, 0, Math.PI * 2);
    ctx.fill();

    // Hull: a dart, with a notch at the back so heading is unambiguous.
    ctx.beginPath();
    ctx.moveTo(size * 1.25, 0);
    ctx.lineTo(-size * 0.75, size * 0.78);
    ctx.lineTo(-size * 0.42, 0);
    ctx.lineTo(-size * 0.75, -size * 0.78);
    ctx.closePath();
    ctx.fillStyle = p.c;
    ctx.shadowColor = p.c;
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(6, 10, 20, 0.65)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Engine flare while moving.
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 30) {
      const flame = Math.min(1, sp / 340) * (0.7 + Math.random() * 0.3);
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, size * 0.28);
      ctx.lineTo(-size * 0.5 - size * 1.5 * flame, 0);
      ctx.lineTo(-size * 0.5, -size * 0.28);
      ctx.closePath();
      ctx.fillStyle = hexA(p.c, 0.35 * flame);
      ctx.fill();
    }
    ctx.restore();

    // Grace shield.
    if (p.g) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.75, t * 2, t * 2 + Math.PI * 1.7);
      ctx.stroke();
      ctx.restore();
    }

    // My ship gets a reticle and ability arcs.
    if (isMe) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.95, 0, Math.PI * 2);
      ctx.stroke();

      const boostReady = 1 - p.bc / 3.2;
      ctx.strokeStyle = 'rgba(87, 230, 255, 0.9)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(x, y, size * 2.35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, boostReady)));
      ctx.stroke();

      for (let i = 0; i < p.f; i++) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(x - 8 + i * 16, y + size * 2.9, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Callsign.
    ctx.save();
    ctx.font = `${Math.max(9, 10 * Math.min(1.35, s * 1.5))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? 'rgba(255, 255, 255, 0.92)' : 'rgba(233, 238, 252, 0.62)';
    ctx.fillText(p.n, x, y - size * 2.7);
    if (p.b) {
      ctx.fillStyle = 'rgba(233, 238, 252, 0.3)';
      ctx.font = '8px "Cascadia Mono", Consolas, monospace';
      ctx.fillText('BOT', x, y - size * 2.7 - 11);
    }
    ctx.restore();
  }

  function drawParticles(dt) {
    const arr = state.particles;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.life -= dt;
      if (p.life <= 0) { arr.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.8 * dt;
      p.vy *= 1 - 1.8 * dt;
      const a = Math.max(0, Math.min(1, p.life / 0.6));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), p.size * Math.max(0.5, view.scale) * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (let i = state.waves.length - 1; i >= 0; i--) {
      const w = state.waves[i];
      w.r += (w.maxR - w.r) * Math.min(1, dt * 7);
      w.life -= dt * 1.6;
      if (w.life <= 0) { state.waves.splice(i, 1); continue; }
      ctx.strokeStyle = hexA(w.color, Math.max(0, w.life) * 0.55);
      ctx.lineWidth = w.w;
      ctx.beginPath();
      ctx.arc(sx(w.x), sy(w.y), w.r * view.scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(view.cx, view.cy, Math.min(W(), H()) * 0.32, view.cx, view.cy, Math.max(W(), H()) * 0.78);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W(), H());
  }

  // ---------- main loop ----------

  let prev = performance.now();
  let hudAt = 0;
  let trialTick = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    const t = now / 1000;

    if (state.started) {
      sendTimer += dt * 1000;
      if (sendTimer >= SEND_EVERY) {
        sendTimer = 0;
        pumpInput();
      }
    }

    processEvents();

    const s = sample(now);
    const cfg = (s && s.cfg) || { arenaR: 620, starR: 60, shipR: 13 };

    ctx.save();
    ctx.clearRect(0, 0, W(), H());
    drawBackground(t);

    if (state.shake > 0.1) {
      const m = state.shake;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      state.shake *= 1 - Math.min(1, dt * 8);
    }

    drawArena(cfg, t);
    drawStar(cfg, t);

    if (s) {
      drawPickups(s.pickups, t);

      // Update trails from the interpolated state so they line up with the ship.
      const seen = new Set();
      for (const p of s.players) {
        seen.add(p.id);
        if (!p.a) continue;
        let tr = state.trails.get(p.id);
        if (!tr) { tr = []; state.trails.set(p.id, tr); }
        tr.push({ x: p.x, y: p.y });
        if (tr.length > 18) tr.shift();
      }
      for (const id of state.trails.keys()) if (!seen.has(id)) state.trails.delete(id);
      for (const p of s.players) if (!p.a) state.trails.delete(p.id);

      for (const p of s.players) drawTrail(p.id, p.c);
      for (const p of s.players) if (p.a) drawShip(p, t);
      drawParticles(dt);
    } else {
      drawParticles(dt);
    }

    ctx.restore();
    drawVignette();

    if (now - hudAt > 90) {
      hudAt = now;
      updateHud(s);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
