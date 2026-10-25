# Perihelion

Perihelion is a browser-based multiplayer zero-gravity sumo game. Players
collect flares and use momentum, dashes, and pulses to push rivals into the
star or beyond the arena rim.

## Live Demo

Play Perihelion at <https://perihelion-eksv.onrender.com>.

## Run locally

Requirements: Node.js 18 or newer.

```powershell
npm install
npm start
```

Open <http://localhost:3000>. Set `PORT` to use another port:

```powershell
$env:PORT = 8080
npm start
```

## Verify

```powershell
npm test
npm run test:browser
npm run cover
```

The test command runs deterministic simulation checks and an HTTP/WebSocket
integration suite. The browser test uses headless Chromium; install it once
with `npx playwright install chromium`. `npm run cover` generates
`public/cover.svg`.

## Deploy with Docker

```powershell
docker build -t perihelion .
docker run --rm -p 3000:3000 perihelion
```

The container exposes port 3000 and includes the `/healthz` endpoint for
container or platform health checks. Prometheus-compatible counters are
available at `/metrics`. WebSocket connections use the same origin as the
HTTP client.

Pull requests and pushes to `main` or `master` run the simulation suite,
browser smoke test, cover generation, and Docker image build through
`.github/workflows/ci.yml`.

## Controls

- **WASD** or arrow keys: thrust
- **Shift**: dash
- **Space**: pulse
- On touch devices, use the virtual stick and action buttons

Use **Create a private room** to generate an invite link and room code. Friends
can open the invite link or enter the code on the start screen. Empty seats are
filled by bots, and disconnected players can reclaim their seat briefly.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP and WebSocket listening port |
| `RECONNECT_GRACE_MS` | `20000` | Seat retention after disconnect |

## License

MIT
