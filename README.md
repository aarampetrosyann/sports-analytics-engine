# sports-analytics-engine

A real-time tactical tracking and analytics engine for soccer. A simulated edge device streams 2D positions for 22 players and the ball at 20 Hz. A Go server turns the stream into live match metrics, and a browser dashboard draws the match on an HTML5 canvas as it happens.

```
┌──────────────────┐  UDP / JSON   ┌────────────────────┐  WebSocket   ┌──────────────────┐
│ simulator (Rust) │ ────────────▶ │  server (Go)       │ ───────────▶ │  web (JS/canvas) │
│ 20 Hz edge feed  │   :9000       │  metrics + fan-out │   :8080/ws   │  pitch + HUD     │
└──────────────────┘               └────────────────────┘              └──────────────────┘
```

## Quick start

Requirements: Rust (cargo) and Go 1.22 or newer.

```bash
make server   # terminal 1: ingestion server + dashboard
make sim      # terminal 2: edge simulator
```

Then open http://localhost:8080.

## Components

### `simulator/` — edge device (Rust)

- Runs a 105 × 68 m match with two 4-3-3 teams. Players respect a top speed (~32 km/h) and an acceleration limit, so their movement looks like real tracking data.
- Simulates dribbling, passing to an open teammate, tackles, shots, goalkeeper saves, and restarts (throw-ins, goal kicks, corners, kick-offs). When the ball goes out, its position is still emitted so downstream systems can see it.
- Sends one JSON datagram per tick over UDP using `serde`. After start-up the send loop allocates nothing: the output buffer and player array are reused every tick.
- Flags: `--target HOST:PORT` (default `127.0.0.1:9000`), `--hz N` (default 20), `--seed N` (for a reproducible match).

Frame format (about 1.1 KB):

```json
{"seq":812,"ts":1792189570735,"ball":{"x":61.2,"y":30.4},
 "players":[{"id":1,"team":0,"num":1,"x":5.1,"y":34.0}, ...]}
```

Team 0 (Home) defends the left goal; team 1 (Away) defends the right.

### `server/` — ingestion and processing (Go)

- **Ingest goroutine:** reads the UDP socket, decodes frames, and passes them to the engine over a buffered channel. If the engine falls behind, frames are dropped rather than queued, so positions never go stale.
- **Engine goroutine:** owns all match state and computes:
  - **Possession:** the player closest to the ball, and whether they control it (within 3 m). Team possession % stays with the last team in control, so loose balls are not counted as turnovers.
  - **Distance covered and speed per player:** displacements faster than 12 m/s are treated as resets and ignored.
  - **Geofencing:** entry events when the ball crosses into either penalty box, plus goal detection when the ball crosses the goal line between the posts.
  - **Stream health:** ingest rate, packets lost (from sequence gaps), decode errors, edge→server latency, and processing time per frame. If the simulator restarts, the engine detects it and resets the match.
- **Hub:** sends each encoded state message to every WebSocket client (Gorilla WebSocket). Slow clients skip frames instead of blocking others. New clients first receive a `hello` message with the pitch geometry, zones, and event history.
- Flags: `-udp :9000`, `-http :8080`, `-web web`.

### `web/` — dashboard (vanilla JS)

- Canvas pitch with full markings, cached on an offscreen layer and redrawn only on resize.
- Players are drawn as team-colored dots with shirt numbers. The player on the ball gets a yellow ring, and the ball has a fading trail. A penalty box is tinted while the ball is inside it and flashes on entry.
- Optional interpolation renders one frame behind and blends between frames for smooth 60 fps motion.
- Sidebar shows the score, match clock, possession bar, who is on the ball, box entries, distance and speed tables per team, an event feed, and telemetry.
- Reconnects automatically and shows "No signal from edge" when frames stop arriving.

## Development

```bash
make test    # simulator tests + go vet
make build   # release binaries: simulator/target/release/pitch-sim, bin/server
```

To print a statistics report for five simulated 90-minute matches (box entries, goals, possession):

```bash
cargo test --release --manifest-path simulator/Cargo.toml full_match_report -- --ignored --nocapture
```
