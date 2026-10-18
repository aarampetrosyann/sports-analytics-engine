# sports-analytics-engine

A real-time tactical tracking and analytics engine for soccer. An edge device streams 2D positions for 22 players and the ball at 20 Hz, either by replaying **real recorded matches** or from a synthetic simulation. A Go server turns the stream into live match metrics, and a browser dashboard draws the match on an HTML5 canvas as it happens.

Tracking data for real matches: [Metrica Sports sample data](https://github.com/metrica-sports/sample-data).

```
┌──────────────────┐  UDP / JSON   ┌────────────────────┐  WebSocket   ┌──────────────────┐
│ edge (Rust)      │ ────────────▶ │  server (Go)       │ ───────────▶ │  web (JS/canvas) │
│ replay or synth  │   :9000       │  metrics + fan-out │   :8080/ws   │  pitch + HUD     │
└──────────────────┘               └────────────────────┘              └──────────────────┘
```

## Quick start

Requirements: Rust (cargo) and Go 1.22 or newer.

```bash
make server   # terminal 1: ingestion server + dashboard
make replay   # terminal 2: stream a real match (downloads it on first run)
```

Then open http://localhost:8080.

Other options:

```bash
make replay GAME=2              # Metrica sample game 1 or 2
make replay SPEED=4 START=58:00 # fast-forward, starting at 58:00
make sim                        # synthetic match instead of a recording
```

## Components

### `simulator/` — edge device (Rust)

**Replay mode** (`--replay DIR`) streams a recorded match as if it were live:

- Reads Metrica's home and away tracking CSVs in lockstep, one line at a time, so memory stays flat for a full 90 minutes.
- Resamples the 25 Hz recording to the output rate by interpolating between frames, and converts normalized coordinates to meters.
- Flips each half as needed, based on where the teams line up at kick-off, so Home always defends the left goal.
- Handles real-data quirks: substitutes (absent until they come on), frames where the ball isn't tracked (the last known position is kept), and inconsistent headers.
- Flags: `--speed X` (fast-forward), `--start MM:SS`, `--loop`.

**Synthetic mode** (default) is useful for stress tests and endless streams:

- Runs a 105 × 68 m match with two 4-3-3 teams. Players respect a top speed (~32 km/h) and an acceleration limit, so their movement looks like real tracking data.
- Simulates dribbling, passing to an open teammate, tackles, shots, goalkeeper saves, and restarts (throw-ins, goal kicks, corners, kick-offs). When the ball goes out, its position is still emitted so downstream systems can see it.
- Sends one JSON datagram per tick over UDP using `serde`. After start-up the send loop allocates nothing: the output buffer and player array are reused every tick.
- Flags: `--target HOST:PORT` (default `127.0.0.1:9000`), `--hz N` (default 20), `--seed N` (for a reproducible match).

Frame format (about 1.1 KB). `ts` is wall-clock time and `mt` is match time, so metrics stay correct when a replay runs faster than real time:

```json
{"seq":812,"ts":1792189570735,"mt":40600,"period":1,"ball":{"x":61.2,"y":30.4},
 "players":[{"id":1,"team":0,"num":1,"x":5.1,"y":34.0}, ...]}
```

Team 0 (Home) defends the left goal; team 1 (Away) defends the right.

### `server/` — ingestion and processing (Go)

- **Ingest goroutine:** reads the UDP socket, decodes frames, and passes them to the engine over a buffered channel. If the engine falls behind, frames are dropped rather than queued, so positions never go stale.
- **Engine goroutine:** owns all match state and computes:
  - **Possession:** the player closest to the ball, and whether they control it (within 3 m). Team possession % stays with the last team in control, so loose balls are not counted as turnovers.
  - **Distance covered and speed per player:** displacements faster than 12 m/s are treated as resets and ignored.
  - **Geofencing:** entry events when the ball crosses into either penalty box.
  - **Goals:** tracking data has no ball height, so a ball crossing the line between the posts may have gone over the bar. Instead, a goal is confirmed by the **kick-off** that follows it: both teams line up in their own halves, then the ball is played from the centre spot. The ball's last visit to a goal mouth says which side scored. Kick-offs at the start of a half aren't preceded by one, so they don't count. This waits on the players lining up rather than on the ball, because recorded data often loses the ball during dead time.
  - **Stream health:** ingest rate, packets lost (from sequence gaps), decode errors, edge→server latency, and processing time per frame. If the simulator restarts, the engine detects it and resets the match.
- **Hub:** sends each encoded state message to every WebSocket client (Gorilla WebSocket). Slow clients skip frames instead of blocking others. New clients first receive a `hello` message with the pitch geometry, zones, and event history.
- Flags: `-udp :9000`, `-http :8080`, `-web web`.

### `web/` — dashboard (vanilla JS)

- Canvas pitch with full markings, cached on an offscreen layer and redrawn only on resize.
- Players are drawn as team-colored dots with shirt numbers. The player on the ball gets a yellow ring, and the ball has a fading trail. A penalty box is tinted while the ball is inside it and flashes on entry.
- Optional interpolation renders one frame behind and blends between frames for smooth 60 fps motion.
- Sidebar shows the score, match clock, possession bar, who is on the ball, box entries, distance and speed tables per team, an event feed, and telemetry.
- Reconnects automatically and shows "No signal from edge" when frames stop arriving.

## Validation against real matches

Replaying both Metrica sample games through the engine reproduces the real results:

| | Detected | Actual (from Metrica's event data) |
|---|---|---|
| Game 1 | Home 3–1 Away: 01:32, 58:19 (own goal), 60:01, 66:01 | 3–1, same minutes |
| Game 2 | Home 3–2 Away: 08:08, 35:22, 49:19, 76:40, 80:42 | 3–2, same minutes |

Distance covered comes out at 9.5–11.3 km for outfield players who play the full match and 3–5 km for goalkeepers, which is in line with professional soccer.

To reproduce, replay a full match at 100× speed (about a minute) with the dashboard open:

```bash
cargo run --release --manifest-path simulator/Cargo.toml -- --replay data/metrica/Sample_Game_1 --speed 100 --hz 1000
```

## Development

```bash
make test    # simulator tests, go vet, server tests
make data    # download Metrica sample games 1 and 2 into data/ (git-ignored)
make build   # release binaries: simulator/target/release/pitch-sim, bin/server
```

To print a statistics report for five simulated 90-minute matches (box entries, goals, possession):

```bash
cargo test --release --manifest-path simulator/Cargo.toml full_match_report -- --ignored --nocapture
```

## Data

Real-match tracking data comes from the [Metrica Sports sample data](https://github.com/metrica-sports/sample-data) (anonymized matches). It is downloaded on demand and not stored in this repository.
