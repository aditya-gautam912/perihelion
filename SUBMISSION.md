# Perihelion — contest entry

Ready-to-paste fields for the Handshake AI Skills Studio x OpenAI
"Create a Multiplayer Game" mission.

## Project title

Perihelion

## Project cover image

`public/cover.png` (1200×630). Regenerate any time with:

```powershell
npm run cover
```

## Project link / URL

<https://perihelion-eksv.onrender.com>

## Project description

One star. One flare. Nothing brakes.

Perihelion is a real-time multiplayer arena for 2–6 players. Every ship orbits
a dying star in a gravity well with no brakes: you steer by thrusting, so you
are always carrying momentum, and the only way to stop someone else is to
shove them into the star or past the ring.

Each round, one flare drifts through the ring. Collect **four** before anyone
else to take the round; win **three rounds** to take the match. Being thrown
into the star or lost to the void costs 2.4 seconds in the respawn queue, not
the round, so matches stay aggressive. Every flare you bank also reloads your
pulse, so the more you collect, the harder you are to move.

- **Physics, not scripts.** Thrust, orbital momentum, elastic collisions, and a
  central gravity well. The core skill is steering a mass that will not turn on
  a dime.
- **Three abilities, one verb.** Thrust (WASD/arrows), dash (Shift) for a
  committed burst, and pulse (Space) to knock every nearby rival away — all
  playable on touch with a virtual stick.
- **Zero friction.** Opening the link drops you straight into a live public
  arena. Empty seats are held by bots, so a solo player gets a real four-ship
  match in the first second — no lobby, no download, no account.
- **Play with anyone.** "Create a private room" mints a room code and an invite
  link. Friends on any device can join mid-match; bots are replaced by humans
  as they arrive.
- **Server-authoritative.** The simulation runs at a fixed 60 Hz on the server
  and snapshots are sent at 20 Hz; the client interpolates ~110 ms in the past
  for smooth motion with no prediction bugs. Dropped connections hold their seat
  for 20 seconds, so a refresh gets you back into the same ship.

## Judging notes

Against the four criteria:

- **Execution** — the whole match loop is implemented end to end: lobby
  countdown, rounds, respawns, round wins, match wins, and reset. The
  simulation is deterministic and covered by an automated suite (26 checks:
  headless simulation invariants plus live HTTP/WebSocket integration, and a
  headless-browser render test).
- **Creativity** — the hook is a physics constraint rather than a new weapon:
  in a well with no brakes, the shortest path is usually wrong. Flare spawns
  also drift deeper in the last 15 seconds, turning the finale into a risk
  trade with the star itself.
- **Usefulness / Value** — anyone can play immediately in a browser tab, alone
  or with friends, on desktop or phone, with no account or install.
- **Polish & Thoughtfulness** — kill-death handling, reconnect grace, spectator
  fallback when an arena is full, bot-only fill, input flood protection,
  `prefers-reduced-motion` support, synthesized audio with a mute toggle, and
  generated social artwork.

## Run and verify

```powershell
npm install
npm start                # http://localhost:3000
npm test                 # simulation + HTTP/WebSocket integration
npm run test:browser     # headless Chromium smoke test
npm run cover            # regenerate public/cover.png and cover.svg
```

Source: <https://github.com/aditya-gautam912/perihelion>
