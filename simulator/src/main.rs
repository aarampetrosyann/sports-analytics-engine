//! Edge device simulator: runs the match simulation and streams one JSON
//! frame per tick over UDP. After start-up the hot loop does not allocate:
//! the output buffer and player array are reused every tick.

mod math;
mod sim;

use serde::Serialize;
use std::net::UdpSocket;
use std::process;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sim::{World, NUM_PLAYERS};

#[derive(Serialize)]
struct Frame<'a> {
    seq: u64,
    /// Unix time in milliseconds when the frame was produced.
    ts: u64,
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
}

const USAGE: &str = "usage: pitch-sim [--target HOST:PORT] [--hz N] [--seed N]

  --target  where to send frames (default 127.0.0.1:9000)
  --hz      frames per second (default 20)
  --seed    simulation seed (default: from the clock)";

impl Config {
    fn from_args() -> Self {
        let mut cfg = Config {
            target: "127.0.0.1:9000".to_string(),
            hz: 20,
            seed: now_ms(),
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
        cfg
    }
}

fn parse_or_exit<T: std::str::FromStr>(s: &str, name: &str) -> T {
    s.parse().unwrap_or_else(|_| {
        eprintln!("invalid value for {name}: {s}");
        process::exit(2);
    })
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

fn main() -> std::io::Result<()> {
    let cfg = Config::from_args();
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(&cfg.target)?;

    let period = Duration::from_secs_f64(1.0 / cfg.hz as f64);
    let dt = period.as_secs_f32();
    let mut world = World::new(cfg.seed);
    let mut players = [PlayerOut::default(); NUM_PLAYERS];
    let mut buf: Vec<u8> = Vec::with_capacity(4096);

    println!(
        "[sim] streaming {} players + ball at {} Hz to udp://{} (seed {})",
        NUM_PLAYERS, cfg.hz, cfg.target, cfg.seed
    );

    let mut seq: u64 = 0;
    let mut sent: u64 = 0;
    let mut errors: u64 = 0;
    let mut next = Instant::now();
    let mut last_report = Instant::now();

    loop {
        world.step(dt);
        for (out, p) in players.iter_mut().zip(world.players.iter()) {
            *out = PlayerOut {
                id: p.id,
                team: p.team,
                num: p.num,
                x: round2(p.pos.x),
                y: round2(p.pos.y),
            };
        }
        let frame = Frame {
            seq,
            ts: now_ms(),
            ball: Point { x: round2(world.ball.x), y: round2(world.ball.y) },
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
            println!("[sim] seq={seq} sent={sent} send_errors={errors} frame_bytes={}", buf.len());
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
