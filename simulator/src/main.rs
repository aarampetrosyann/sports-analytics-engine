//! Edge device simulator: produces one JSON frame per tick and streams it
//! over UDP. Positions come from either the synthetic match simulation or a
//! replay of recorded tracking data. After start-up the hot loop does not
//! allocate: the output buffer and player list are reused every tick.

mod math;
mod replay;
mod sim;

use serde::Serialize;
use std::io;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use math::V2;
use replay::{Pos, Replay};
use sim::World;

#[derive(Serialize)]
struct Frame<'a> {
    seq: u64,
    /// Unix time in milliseconds when the frame was produced.
    ts: u64,
    /// Match time in milliseconds (advances faster than `ts` with --speed).
    mt: u64,
    period: u8,
    ball: Point,
    players: &'a [PlayerOut],
}

#[derive(Serialize, Clone, Copy, Default)]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Serialize, Clone, Copy, Default)]
struct PlayerOut {
    id: u8,
    team: u8,
    num: u8,
    x: f32,
    y: f32,
}

struct Config {
    target: String,
    hz: u32,
    seed: u64,
    replay: Option<PathBuf>,
    speed: f64,
    start: f64,
    looped: bool,
}

const USAGE: &str = "usage: pitch-sim [--target HOST:PORT] [--hz N] [--seed N]
       pitch-sim --replay DIR [--speed X] [--start MM:SS] [--loop] [--target HOST:PORT] [--hz N]

  --target  where to send frames (default 127.0.0.1:9000)
  --hz      frames per second (default 20)
  --seed    synthetic match seed (default: from the clock)
  --replay  stream a recorded Metrica match from DIR instead of simulating
  --speed   replay speed multiplier (default 1)
  --start   replay start position as match time MM:SS (default 00:00)
  --loop    restart the replay when it ends";

impl Config {
    fn from_args() -> Self {
        let mut cfg = Config {
            target: "127.0.0.1:9000".to_string(),
            hz: 20,
            seed: now_ms(),
            replay: None,
            speed: 1.0,
            start: 0.0,
            looped: false,
        };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            let mut value = |name: &str| {
                args.next().unwrap_or_else(|| {
                    eprintln!("{name} needs a value\n\n{USAGE}");
                    process::exit(2);
                })
            };
            match arg.as_str() {
                "--target" => cfg.target = value("--target"),
                "--hz" => cfg.hz = parse_or_exit(&value("--hz"), "--hz"),
                "--seed" => cfg.seed = parse_or_exit(&value("--seed"), "--seed"),
                "--replay" => cfg.replay = Some(PathBuf::from(value("--replay"))),
                "--speed" => cfg.speed = parse_or_exit(&value("--speed"), "--speed"),
                "--start" => {
                    let v = value("--start");
                    cfg.start = parse_clock(&v).unwrap_or_else(|| {
                        eprintln!("invalid value for --start: {v} (expected MM:SS)");
                        process::exit(2);
                    })
                }
                "--loop" => cfg.looped = true,
                "-h" | "--help" => {
                    println!("{USAGE}");
                    process::exit(0);
                }
                other => {
                    eprintln!("unknown argument: {other}\n\n{USAGE}");
                    process::exit(2);
                }
            }
        }
        if cfg.hz == 0 {
            eprintln!("--hz must be greater than zero");
            process::exit(2);
        }
        if !(cfg.speed > 0.0 && cfg.speed <= 100.0) {
            eprintln!("--speed must be in (0, 100]");
            process::exit(2);
        }
        cfg
    }
}

fn parse_or_exit<T: std::str::FromStr>(s: &str, name: &str) -> T {
    s.parse().unwrap_or_else(|_| {
        eprintln!("invalid value for {name}: {s}");
        process::exit(2);
    })
}

fn parse_clock(s: &str) -> Option<f64> {
    let (m, sec) = s.split_once(':')?;
    let m: u32 = m.parse().ok()?;
    let sec: f64 = sec.parse().ok()?;
    (0.0..60.0).contains(&sec).then(|| m as f64 * 60.0 + sec)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// Where positions come from.
enum Source {
    Synthetic(World),
    Replay { replay: Replay, t: f64, scratch: Vec<Pos> },
}

impl Source {
    fn open(cfg: &Config) -> io::Result<Self> {
        match &cfg.replay {
            None => Ok(Source::Synthetic(World::new(cfg.seed))),
            Some(dir) => {
                let replay = Replay::open(dir)?;
                let t = replay.start_time.max(cfg.start);
                Ok(Source::Replay { replay, t, scratch: Vec::with_capacity(32) })
            }
        }
    }

    /// Advances by `dt` match seconds and fills the frame. Returns the period,
    /// or None when a replay has run out.
    fn tick(&mut self, dt: f64, players: &mut Vec<PlayerOut>, ball: &mut V2, mt: &mut f64) -> io::Result<Option<u8>> {
        players.clear();
        match self {
            Source::Synthetic(world) => {
                world.step(dt as f32);
                *mt += dt;
                *ball = world.ball;
                players.extend(world.players.iter().map(|p| PlayerOut {
                    id: p.id,
                    team: p.team,
                    num: p.num,
                    x: round2(p.pos.x),
                    y: round2(p.pos.y),
                }));
                Ok(Some(1))
            }
            Source::Replay { replay, t, scratch } => {
                *t += dt;
                let Some(period) = replay.sample(*t, scratch, ball)? else {
                    return Ok(None);
                };
                *mt = *t;
                players.extend(scratch.iter().map(|p| PlayerOut {
                    id: p.id,
                    team: p.team,
                    num: p.id,
                    x: round2(p.p.x),
                    y: round2(p.p.y),
                }));
                Ok(Some(period))
            }
        }
    }
}

fn main() -> io::Result<()> {
    let cfg = Config::from_args();
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(&cfg.target)?;

    let open = || {
        Source::open(&cfg).unwrap_or_else(|e| {
            eprintln!("[sim] cannot open replay: {e}");
            process::exit(1);
        })
    };
    let mut source = open();

    let period = Duration::from_secs_f64(1.0 / cfg.hz as f64);
    let dt = period.as_secs_f64() * cfg.speed;
    let mut players: Vec<PlayerOut> = Vec::with_capacity(32);
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut ball = V2::ZERO;
    let mut mt = 0.0;

    match &cfg.replay {
        Some(dir) => println!(
            "[sim] replaying {} at {}x from {:02}:{:02}, {} Hz to udp://{}",
            dir.display(),
            cfg.speed,
            (cfg.start / 60.0) as u32,
            (cfg.start % 60.0) as u32,
            cfg.hz,
            cfg.target
        ),
        None => println!(
            "[sim] simulating a match at {} Hz to udp://{} (seed {})",
            cfg.hz, cfg.target, cfg.seed
        ),
    }

    let mut seq: u64 = 0;
    let mut sent: u64 = 0;
    let mut errors: u64 = 0;
    let mut next = Instant::now();
    let mut last_report = Instant::now();

    loop {
        let Some(half) = source.tick(dt, &mut players, &mut ball, &mut mt)? else {
            if !cfg.looped {
                println!("[sim] replay finished after {seq} frames");
                return Ok(());
            }
            println!("[sim] replay finished; restarting");
            source = open();
            seq = 0; // lets the server detect the restart and reset its state
            continue;
        };

        let frame = Frame {
            seq,
            ts: now_ms(),
            mt: (mt * 1000.0) as u64,
            period: half,
            ball: Point { x: round2(ball.x), y: round2(ball.y) },
            players: &players,
        };
        buf.clear();
        serde_json::to_writer(&mut buf, &frame).expect("frame serializes");
        // Fire and forget: with no listener the OS may report "connection refused".
        match socket.send(&buf) {
            Ok(_) => sent += 1,
            Err(_) => errors += 1,
        }
        seq += 1;

        if last_report.elapsed() >= Duration::from_secs(5) {
            println!(
                "[sim] seq={seq} match_time={:02}:{:02} sent={sent} send_errors={errors} frame_bytes={}",
                (mt / 60.0) as u32,
                (mt % 60.0) as u32,
                buf.len()
            );
            last_report = Instant::now();
        }

        // Fixed-rate schedule; resync if we fall far behind (e.g. laptop sleep).
        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 5 {
            next = now;
        }
    }
}
