//! Replays recorded Metrica Sports tracking data as if it were a live edge
//! feed (https://github.com/metrica-sports/sample-data).
//!
//! The home and away CSVs are read in lockstep one line at a time, so memory
//! stays flat however long the match is. Positions are converted from the
//! normalized 0..1 pitch to meters, and each half is flipped as needed so
//! Home always defends the left goal, matching the synthetic simulator.

use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::Path;

use crate::math::V2;
use crate::sim::{PITCH_H, PITCH_W};

#[derive(Clone, Copy)]
pub struct Pos {
    pub id: u8,
    pub team: u8,
    pub p: V2,
}

#[derive(Default)]
struct Sample {
    frame: u64,
    period: u8,
    time: f64,
    players: Vec<Pos>,
    ball: Option<V2>,
}

/// One team's tracking CSV.
struct TeamFile {
    reader: BufReader<File>,
    team: u8,
    line: String,
    fields: Vec<f64>,
    /// (player id, column of its x coordinate; y is the next column)
    players: Vec<(u8, usize)>,
    ball_col: Option<usize>,
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

impl TeamFile {
    fn open(path: &Path, team: u8) -> io::Result<Self> {
        let mut reader = BufReader::new(File::open(path)?);
        let mut header = String::new();
        // Row 1: team names, row 2: player numbers, row 3: column names.
        for _ in 0..3 {
            header.clear();
            reader.read_line(&mut header)?;
        }
        let mut players = Vec::new();
        let mut ball_col = None;
        for (col, name) in header.trim_end().split(',').enumerate() {
            if let Some(n) = name.strip_prefix("Player") {
                // trim: Game 2's header has a stray "Player 26".
                let id = n
                    .trim()
                    .parse()
                    .map_err(|_| invalid(format!("{}: bad column {name}", path.display())))?;
                players.push((id, col));
            } else if name == "Ball" {
                ball_col = Some(col);
            }
        }
        if players.is_empty() {
            return Err(invalid(format!("{}: no Player columns in header", path.display())));
        }
        Ok(Self {
            reader,
            team,
            line: String::new(),
            fields: Vec::new(),
            players,
            ball_col,
        })
    }

    /// Reads the next row. Returns (frame, period, time), or None at the end.
    fn read_row(&mut self) -> io::Result<Option<(u64, u8, f64)>> {
        self.line.clear();
        if self.reader.read_line(&mut self.line)? == 0 {
            return Ok(None);
        }
        self.fields.clear();
        for f in self.line.trim_end().split(',') {
            // Rust parses "NaN" as NaN; empty cells also become NaN.
            self.fields.push(f.parse().unwrap_or(f64::NAN));
        }
        if self.fields.len() < 3 {
            return Ok(None);
        }
        Ok(Some((self.fields[1] as u64, self.fields[0] as u8, self.fields[2])))
    }

    fn xy(&self, col: usize) -> Option<V2> {
        let x = *self.fields.get(col)?;
        let y = *self.fields.get(col + 1)?;
        (x.is_finite() && y.is_finite()).then(|| V2::new(x as f32, y as f32))
    }

    fn append_players(&self, out: &mut Vec<Pos>) {
        for &(id, col) in &self.players {
            if let Some(p) = self.xy(col) {
                out.push(Pos { id, team: self.team, p });
            }
        }
    }
}

pub struct Replay {
    home: TeamFile,
    away: TeamFile,
    prev: Sample,
    next: Sample,
    /// Whether each period (1-based) must be rotated 180°.
    flip: [Option<bool>; 8],
    last_ball: V2,
    pub start_time: f64,
}

/// Finds the home and away tracking CSVs in a Metrica game directory.
fn find_files(dir: &Path) -> io::Result<(std::path::PathBuf, std::path::PathBuf)> {
    let mut home = None;
    let mut away = None;
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".csv") || !name.contains("TrackingData") {
            continue;
        }
        if name.contains("Home") {
            home = Some(path);
        } else if name.contains("Away") {
            away = Some(path);
        }
    }
    match (home, away) {
        (Some(h), Some(a)) => Ok((h, a)),
        _ => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "{}: expected *TrackingData_Home_Team.csv and *TrackingData_Away_Team.csv",
                dir.display()
            ),
        )),
    }
}

impl Replay {
    pub fn open(dir: &Path) -> io::Result<Self> {
        let (home, away) = find_files(dir)?;
        let mut r = Self {
            home: TeamFile::open(&home, 0)?,
            away: TeamFile::open(&away, 1)?,
            prev: Sample::default(),
            next: Sample::default(),
            flip: [None; 8],
            last_ball: V2::new(PITCH_W / 2.0, PITCH_H / 2.0),
            start_time: 0.0,
        };
        if !r.read_next()? {
            return Err(invalid(format!("{}: no tracking rows", dir.display())));
        }
        std::mem::swap(&mut r.prev, &mut r.next);
        if !r.read_next()? {
            return Err(invalid(format!("{}: only one tracking row", dir.display())));
        }
        r.start_time = r.prev.time;
        Ok(r)
    }

    /// Reads the next row of both files into `self.next`. Returns false at the end.
    fn read_next(&mut self) -> io::Result<bool> {
        let (Some(h), Some(a)) = (self.home.read_row()?, self.away.read_row()?) else {
            return Ok(false);
        };
        if h.0 != a.0 {
            return Err(invalid(format!("home/away files out of sync: frame {} vs {}", h.0, a.0)));
        }
        let s = &mut self.next;
        (s.frame, s.period, s.time) = h;
        s.players.clear();
        self.home.append_players(&mut s.players);
        self.away.append_players(&mut s.players);
        s.ball = self.home.ball_col.and_then(|c| self.home.xy(c));

        // Decide each half's orientation from its first frame: Home should
        // be in the left half at kick-off.
        let slot = (s.period as usize).min(self.flip.len() - 1);
        let flip = *self.flip[slot].get_or_insert_with(|| {
            let home: Vec<f32> = s.players.iter().filter(|p| p.team == 0).map(|p| p.p.x).collect();
            !home.is_empty() && home.iter().sum::<f32>() / (home.len() as f32) > 0.5
        });
        let to_m = |v: V2| {
            let v = if flip { V2::new(1.0 - v.x, 1.0 - v.y) } else { v };
            V2::new(v.x * PITCH_W, v.y * PITCH_H)
        };
        for p in s.players.iter_mut() {
            p.p = to_m(p.p);
        }
        s.ball = s.ball.map(to_m);
        Ok(true)
    }

    /// Writes the interpolated state at match time `t` (seconds). Returns
    /// None once the recording is exhausted, otherwise the period number.
    pub fn sample(&mut self, t: f64, players: &mut Vec<Pos>, ball: &mut V2) -> io::Result<Option<u8>> {
        while self.next.time < t {
            std::mem::swap(&mut self.prev, &mut self.next);
            if !self.read_next()? {
                return Ok(None);
            }
        }
        let (a, b) = (&self.prev, &self.next);
        // Never blend across half-time: the pitch is flipped between halves.
        let alpha = if a.period != b.period || b.time <= a.time {
            1.0
        } else {
            (((t - a.time) / (b.time - a.time)).clamp(0.0, 1.0)) as f32
        };
        let lerp = |p: V2, q: V2| p + (q - p) * alpha;

        players.clear();
        for q in &b.players {
            let p = a.players.iter().find(|p| p.id == q.id).map_or(q.p, |p| lerp(p.p, q.p));
            players.push(Pos { p, ..*q });
        }
        *ball = match (a.ball, b.ball) {
            (Some(p), Some(q)) => lerp(p, q),
            (_, Some(q)) => q,
            (Some(p), None) => p,
            (None, None) => self.last_ball,
        };
        self.last_ball = *ball;
        Ok(Some(b.period))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "\
,,,Home,,Home,,Home,,,
,,,1,,2,,3,,,
Period,Frame,Time [s],Player1,,Player2,,Player3,,Ball,
1,1,0.04,0.1,0.5,0.4,0.2,NaN,NaN,0.5,0.5
1,2,0.08,0.2,0.5,0.4,0.2,NaN,NaN,NaN,NaN
2,3,0.12,0.9,0.5,0.6,0.8,0.7,0.7,0.5,0.5
";
    const AWAY: &str = "\
,,,Away,,,
,,,4,,,
Period,Frame,Time [s],Player 4,,
1,1,0.04,0.9,0.5
1,2,0.08,0.8,0.5
2,3,0.12,0.1,0.5
";

    fn fixture() -> Replay {
        let dir = std::env::temp_dir().join(format!("pitch-sim-replay-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("G_RawTrackingData_Home_Team.csv"), HOME).unwrap();
        fs::write(dir.join("G_RawTrackingData_Away_Team.csv"), AWAY).unwrap();
        Replay::open(&dir).unwrap()
    }

    fn find(players: &[Pos], id: u8) -> Option<V2> {
        players.iter().find(|p| p.id == id).map(|p| p.p)
    }

    #[test]
    fn interpolates_converts_and_flips_halves() {
        let mut r = fixture();
        let (mut players, mut ball) = (Vec::new(), V2::ZERO);

        // Halfway between frames 1 and 2; Player3 is a substitute (NaN).
        assert_eq!(r.sample(0.06, &mut players, &mut ball).unwrap(), Some(1));
        let p1 = find(&players, 1).unwrap();
        assert!((p1.x - 0.15 * PITCH_W).abs() < 1e-3 && (p1.y - 0.5 * PITCH_H).abs() < 1e-3);
        assert!(find(&players, 3).is_none());
        assert_eq!(players.len(), 3);
        // Ball is missing in frame 2, so the last known position is kept.
        assert!((ball.x - 0.5 * PITCH_W).abs() < 1e-3);

        // Second half: Home starts on the right, so the pitch is rotated and
        // the substitute appears.
        assert_eq!(r.sample(0.12, &mut players, &mut ball).unwrap(), Some(2));
        let p1 = find(&players, 1).unwrap();
        assert!((p1.x - 0.1 * PITCH_W).abs() < 1e-3);
        let p3 = find(&players, 3).unwrap();
        assert!((p3.x - 0.3 * PITCH_W).abs() < 1e-3 && (p3.y - 0.3 * PITCH_H).abs() < 1e-3);

        assert_eq!(r.sample(0.2, &mut players, &mut ball).unwrap(), None);
    }
}
