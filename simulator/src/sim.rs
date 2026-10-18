//! Physics-constrained match simulation.
//!
//! Coordinates are meters on a 105 x 68 pitch with the origin at the top-left
//! corner. Team 0 ("Home") defends the left goal and attacks towards +x;
//! team 1 ("Away") is mirrored. Players obey a top speed and an acceleration
//! limit, so the stream looks like real tracking data rather than teleports.

use crate::math::{Rng, V2};

pub const PITCH_W: f32 = 105.0;
pub const PITCH_H: f32 = 68.0;
pub const NUM_PLAYERS: usize = 22;

const CENTER: V2 = V2::new(PITCH_W / 2.0, PITCH_H / 2.0);
const GOAL_HALF_W: f32 = 3.66;
const PENALTY_DEPTH: f32 = 16.5;
const PENALTY_HALF_W: f32 = 20.16;

const MAX_SPEED: f32 = 8.8; // m/s (~32 km/h sprint)
const MAX_ACCEL: f32 = 5.5; // m/s^2
const DRIBBLE_SPEED: f32 = 6.0;
const JOG_SPEED: f32 = 7.0;
const CONTROL_RADIUS: f32 = 1.1;
const KEEPER_RADIUS: f32 = 2.2;
const BALL_DRAG: f32 = 0.55; // exponential rolling-resistance coefficient (1/s)

/// 4-3-3 shape for the team attacking +x, in its own half.
const FORMATION: [(f32, f32); 11] = [
    (4.0, 34.0), // GK
    (18.0, 10.0),
    (16.0, 26.0),
    (16.0, 42.0),
    (18.0, 58.0),
    (32.0, 20.0),
    (29.0, 34.0),
    (32.0, 48.0),
    (45.0, 12.0),
    (47.0, 34.0),
    (45.0, 56.0),
];
const SHIRTS: [u8; 11] = [1, 2, 4, 5, 3, 8, 6, 10, 7, 9, 11];

fn attack_dir(team: u8) -> f32 {
    if team == 0 {
        1.0
    } else {
        -1.0
    }
}

fn own_goal(team: u8) -> V2 {
    if team == 0 {
        V2::new(0.0, CENTER.y)
    } else {
        V2::new(PITCH_W, CENTER.y)
    }
}

fn opp_goal(team: u8) -> V2 {
    own_goal(1 - team)
}

fn in_own_box(team: u8, p: V2) -> bool {
    let depth = if team == 0 { p.x } else { PITCH_W - p.x };
    depth <= PENALTY_DEPTH && (p.y - CENTER.y).abs() <= PENALTY_HALF_W
}

pub struct Player {
    pub id: u8,
    pub team: u8,
    pub num: u8,
    pub pos: V2,
    vel: V2,
    home: V2,
    is_gk: bool,
    pace: f32,
    wander: V2,
    wander_t: f32,
}

#[derive(Clone, Copy)]
struct Restart {
    spot: V2,
    team: u8,
    kickoff: bool,
}

pub struct World {
    pub players: Vec<Player>,
    pub ball: V2,
    ball_vel: V2,
    owner: Option<usize>,
    last_touch: u8,
    /// Only this team may collect the ball (set-pieces and kick-offs).
    restricted: Option<u8>,
    /// Nobody may collect the ball until this reaches zero.
    hold: f32,
    /// The player who just released the ball cannot immediately re-collect it.
    no_pick: Option<usize>,
    no_pick_t: f32,
    /// Intended target of the pass in flight; runs onto the ball.
    receiver: Option<usize>,
    /// Ball is out of play; restart after the timer expires.
    dead: Option<(f32, Restart)>,
    kickoff: bool,
    rng: Rng,
}

impl World {
    pub fn new(seed: u64) -> Self {
        let mut rng = Rng::new(seed);
        let mut players = Vec::with_capacity(NUM_PLAYERS);
        for team in 0..2u8 {
            for (k, &(fx, fy)) in FORMATION.iter().enumerate() {
                let home = if team == 0 {
                    V2::new(fx, fy)
                } else {
                    V2::new(PITCH_W - fx, PITCH_H - fy)
                };
                players.push(Player {
                    id: team * 11 + k as u8 + 1,
                    team,
                    num: SHIRTS[k],
                    pos: home,
                    vel: V2::ZERO,
                    home,
                    is_gk: k == 0,
                    pace: rng.range(0.9, 1.05),
                    wander: V2::ZERO,
                    wander_t: 0.0,
                });
            }
        }
        Self {
            players,
            ball: CENTER,
            ball_vel: V2::ZERO,
            owner: None,
            last_touch: 0,
            restricted: Some(0),
            hold: 1.0,
            no_pick: None,
            no_pick_t: 0.0,
            receiver: None,
            dead: None,
            kickoff: true,
            rng,
        }
    }

    pub fn step(&mut self, dt: f32) {
        if let Some((timer, restart)) = self.dead.as_mut() {
            *timer -= dt;
            if *timer <= 0.0 {
                let r = *restart;
                self.apply_restart(r);
            }
        }
        self.update_wander(dt);
        let targets = self.plan();
        self.move_players(&targets, dt);
        if self.dead.is_none() {
            self.update_ball(dt);
        }
    }

    fn update_wander(&mut self, dt: f32) {
        let rng = &mut self.rng;
        for p in self.players.iter_mut() {
            p.wander_t -= dt;
            if p.wander_t <= 0.0 {
                p.wander = V2::new(rng.range(-4.0, 4.0), rng.range(-4.0, 4.0));
                p.wander_t = rng.range(1.5, 4.0);
            }
        }
    }

    fn poss_team(&self) -> Option<u8> {
        self.owner.map(|i| self.players[i].team)
    }

    /// The player from `team` who should go for the ball, if any.
    fn chaser(&self, team: u8) -> Option<usize> {
        if self.dead.is_some() || self.poss_team() == Some(team) {
            return None;
        }
        if matches!(self.restricted, Some(r) if r != team) {
            return None;
        }
        if let Some(r) = self.receiver.filter(|&r| self.players[r].team == team) {
            return Some(r);
        }
        self.players
            .iter()
            .enumerate()
            .filter(|&(i, p)| {
                p.team == team && Some(i) != self.no_pick && (!p.is_gk || in_own_box(team, self.ball))
            })
            .map(|(i, p)| (i, p.pos.dist(self.ball)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(i, _)| i)
    }

    /// Target position and desired speed for every player.
    fn plan(&self) -> [(V2, f32); NUM_PLAYERS] {
        let ball = self.ball;
        let poss = self.poss_team();
        let chasers = [self.chaser(0), self.chaser(1)];
        let mut out = [(V2::ZERO, 0.0); NUM_PLAYERS];

        for (i, p) in self.players.iter().enumerate() {
            let dir = attack_dir(p.team);
            out[i] = if self.owner == Some(i) {
                let goal = opp_goal(p.team);
                let y = (CENTER.y + p.wander.y * 3.0).clamp(10.0, PITCH_H - 10.0);
                (V2::new(goal.x, y), DRIBBLE_SPEED * p.pace)
            } else if chasers[p.team as usize] == Some(i) {
                (ball + self.ball_vel * 0.35, MAX_SPEED * p.pace)
            } else if p.is_gk {
                let depth = if poss == Some(p.team) { 8.0 } else { 3.0 };
                let x = own_goal(p.team).x + dir * depth;
                let y = (CENTER.y + (ball.y - CENTER.y) * 0.2).clamp(30.0, 38.0);
                (V2::new(x, y), 5.0)
            } else if self.kickoff {
                (p.home, JOG_SPEED * p.pace)
            } else {
                // Hold team shape, sliding with the ball and pushing up in possession.
                let mut x = p.home.x + (ball.x - CENTER.x) * 0.6;
                match poss {
                    // Attack: push up and stretch the forwards beyond the ball.
                    Some(t) if t == p.team => {
                        let depth = dir * (p.home.x - own_goal(p.team).x); // 0 at own goal line
                        x += dir * (8.0 + depth * 0.25);
                    }
                    Some(_) => x -= dir * 4.0,
                    None => {}
                }
                let y = p.home.y + (ball.y - CENTER.y) * 0.3;
                let t = V2::new(x, y) + p.wander;
                let t = V2::new(t.x.clamp(2.0, PITCH_W - 2.0), t.y.clamp(1.5, PITCH_H - 1.5));
                let speed = (t.dist(p.pos) * 0.9).min(JOG_SPEED) * p.pace;
                (t, speed)
            };
        }
        out
    }

    fn move_players(&mut self, targets: &[(V2, f32); NUM_PLAYERS], dt: f32) {
        for (p, &(target, speed)) in self.players.iter_mut().zip(targets.iter()) {
            let to = target - p.pos;
            let dist = to.len();
            // Arrive behaviour: slow down when close instead of overshooting.
            let desired = if dist < 0.3 {
                V2::ZERO
            } else {
                to.norm() * speed.min(dist * 2.0)
            };
            let dv = (desired - p.vel).clamp_len(MAX_ACCEL * dt);
            p.vel = (p.vel + dv).clamp_len(MAX_SPEED * p.pace);
            p.pos += p.vel * dt;
            p.pos.x = p.pos.x.clamp(-1.0, PITCH_W + 1.0);
            p.pos.y = p.pos.y.clamp(-1.0, PITCH_H + 1.0);
        }
    }

    fn update_ball(&mut self, dt: f32) {
        if self.no_pick_t > 0.0 {
            self.no_pick_t -= dt;
            if self.no_pick_t <= 0.0 {
                self.no_pick = None;
            }
        }
        if self.hold > 0.0 {
            self.hold -= dt;
        }

        match self.owner {
            Some(i) => {
                let p = &self.players[i];
                let heading = if p.vel.len() > 0.3 {
                    p.vel.norm()
                } else {
                    V2::new(attack_dir(p.team), 0.0)
                };
                self.ball = p.pos + heading * 0.7;
                self.ball_vel = p.vel;
                self.on_ball(i);
            }
            None => {
                self.ball += self.ball_vel * dt;
                self.ball_vel = self.ball_vel * (-BALL_DRAG * dt).exp();
            }
        }

        let b = self.ball;
        if b.x < 0.0 || b.x > PITCH_W || b.y < 0.0 || b.y > PITCH_H {
            self.ball_out();
        } else if self.owner.is_none() {
            self.try_pickup();
        }
    }

    /// Decide what the player in possession does this tick.
    fn on_ball(&mut self, i: usize) {
        let me_pos = self.players[i].pos;
        let team = self.players[i].team;

        let (nearest_opp, pressure) = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, p)| p.team != team)
            .map(|(j, p)| (j, p.pos.dist(me_pos)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap_or((i, f32::MAX));

        if pressure < 1.3 && self.rng.chance(0.06) {
            // Tackled: the ball is poked loose.
            let poke = V2::new(1.0, 0.0).rotate(self.rng.range(0.0, std::f32::consts::TAU));
            let speed = self.rng.range(2.0, 6.0);
            self.release(i, poke * speed);
            self.last_touch = self.players[nearest_opp].team;
            return;
        }

        let goal = opp_goal(team);
        let d_goal = me_pos.dist(goal);
        if d_goal < 25.0 && self.rng.chance(0.015 + (1.0 - d_goal / 25.0) * 0.12) {
            let aim = V2::new(goal.x + attack_dir(team), goal.y + self.rng.range(-5.5, 5.5));
            let speed = self.rng.range(22.0, 30.0);
            self.release(i, (aim - me_pos).norm() * speed);
            return;
        }

        let pass_p = if pressure < 3.0 { 0.10 } else { 0.025 };
        if self.rng.chance(pass_p) {
            if let Some(j) = self.pick_receiver(i) {
                let mate = &self.players[j];
                let lead = mate.pos + mate.vel * 0.6;
                let dist = lead.dist(me_pos);
                let speed = (8.0 + dist * 0.45).min(24.0);
                let noise = self.rng.range(-0.06, 0.06);
                let v = (lead - me_pos).norm().rotate(noise) * speed;
                self.release(i, v);
                self.receiver = Some(j);
            }
        }
    }

    fn pick_receiver(&mut self, i: usize) -> Option<usize> {
        let me = &self.players[i];
        let dir = attack_dir(me.team);
        let mut best: Option<(usize, f32)> = None;
        for (j, mate) in self.players.iter().enumerate() {
            if j == i || mate.team != me.team {
                continue;
            }
            let d = mate.pos.dist(me.pos);
            if !(6.0..=45.0).contains(&d) {
                continue;
            }
            let openness = self
                .players
                .iter()
                .filter(|o| o.team != me.team)
                .map(|o| o.pos.dist(mate.pos))
                .fold(f32::MAX, f32::min)
                .min(10.0);
            let progress = dir * (mate.pos.x - me.pos.x);
            let score = progress * 0.08 + openness * 0.1 + self.rng.range(0.0, 1.0);
            if best.map_or(true, |(_, s)| score > s) {
                best = Some((j, score));
            }
        }
        best.map(|(j, _)| j)
    }

    fn release(&mut self, i: usize, vel: V2) {
        self.owner = None;
        self.receiver = None;
        self.ball_vel = vel;
        self.no_pick = Some(i);
        self.no_pick_t = 0.35;
        self.last_touch = self.players[i].team;
    }

    fn try_pickup(&mut self) {
        if self.hold > 0.0 {
            return;
        }
        let ball = self.ball;
        let mut best: Option<(usize, f32)> = None;
        for (j, p) in self.players.iter().enumerate() {
            if Some(j) == self.no_pick || matches!(self.restricted, Some(r) if r != p.team) {
                continue;
            }
            let radius = if p.is_gk && in_own_box(p.team, ball) {
                KEEPER_RADIUS
            } else {
                CONTROL_RADIUS
            };
            let d = p.pos.dist(ball);
            if d < radius && best.map_or(true, |(_, bd)| d < bd) {
                best = Some((j, d));
            }
        }
        if let Some((j, _)) = best {
            // Fast balls are hard to control for outfield players.
            let fast = self.ball_vel.len() > 14.0 && !self.players[j].is_gk;
            if !fast || self.rng.chance(0.35) {
                self.owner = Some(j);
                self.receiver = None;
                self.restricted = None;
                self.kickoff = false;
                self.last_touch = self.players[j].team;
            }
        }
    }

    fn ball_out(&mut self) {
        let b = self.ball;
        let restart = if b.x < 0.0 || b.x > PITCH_W {
            let left = b.x < 0.0;
            let defending = if left { 0 } else { 1 };
            if (b.y - CENTER.y).abs() < GOAL_HALF_W {
                Restart { spot: CENTER, team: defending, kickoff: true }
            } else if self.last_touch == defending {
                let x = if left { 0.5 } else { PITCH_W - 0.5 };
                let y = if b.y < CENTER.y { 0.5 } else { PITCH_H - 0.5 };
                Restart { spot: V2::new(x, y), team: 1 - defending, kickoff: false }
            } else {
                let x = if left { 5.5 } else { PITCH_W - 5.5 };
                Restart { spot: V2::new(x, CENTER.y), team: defending, kickoff: false }
            }
        } else {
            let y = if b.y < 0.0 { 0.3 } else { PITCH_H - 0.3 };
            let spot = V2::new(b.x.clamp(0.5, PITCH_W - 0.5), y);
            Restart { spot, team: 1 - self.last_touch, kickoff: false }
        };

        // Freeze the ball where it left the pitch so consumers can see it go out.
        self.ball = V2::new(b.x.clamp(-2.0, PITCH_W + 2.0), b.y.clamp(-2.0, PITCH_H + 2.0));
        self.ball_vel = V2::ZERO;
        self.owner = None;
        self.receiver = None;
        self.kickoff = restart.kickoff;
        let delay = if restart.kickoff { 2.5 } else { 1.0 };
        self.dead = Some((delay, restart));
    }

    fn apply_restart(&mut self, r: Restart) {
        self.dead = None;
        self.ball = r.spot;
        self.ball_vel = V2::ZERO;
        self.owner = None;
        self.restricted = Some(r.team);
        self.hold = if r.kickoff { 1.5 } else { 0.3 };
        self.no_pick = None;
        self.kickoff = r.kickoff;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Summary {
        box_entries: u32,
        goals: u32,
        max_speed: f32,
        owned_ticks: u32,
        ticks: u32,
    }

    fn run(seed: u64, minutes: f32) -> Summary {
        let dt = 0.05;
        let mut w = World::new(seed);
        let mut s = Summary { box_entries: 0, goals: 0, max_speed: 0.0, owned_ticks: 0, ticks: 0 };
        let mut in_box = [false; 2];
        let mut was_out = false;
        let mut last: Vec<V2> = w.players.iter().map(|p| p.pos).collect();
        for _ in 0..(minutes * 60.0 / dt) as u32 {
            w.step(dt);
            s.ticks += 1;
            if w.owner.is_some() {
                s.owned_ticks += 1;
            }
            for (p, l) in w.players.iter().zip(last.iter_mut()) {
                s.max_speed = s.max_speed.max(p.pos.dist(*l) / dt);
                *l = p.pos;
            }
            for team in 0..2u8 {
                let inside = in_own_box(team, w.ball) && w.ball.x >= 0.0 && w.ball.x <= PITCH_W;
                if inside && !in_box[team as usize] {
                    s.box_entries += 1;
                }
                in_box[team as usize] = inside;
            }
            let out = w.ball.x < 0.0 || w.ball.x > PITCH_W;
            if out && !was_out && (w.ball.y - CENTER.y).abs() < GOAL_HALF_W {
                s.goals += 1;
            }
            was_out = out;
        }
        s
    }

    #[test]
    #[ignore]
    fn full_match_report() {
        for seed in 1..=5 {
            let s = run(seed, 90.0);
            println!(
                "seed {seed}: box entries={} goals={} owned={:.0}%",
                s.box_entries,
                s.goals,
                100.0 * s.owned_ticks as f32 / s.ticks as f32
            );
        }
    }

    #[test]
    fn players_respect_speed_limit() {
        let s = run(7, 10.0);
        assert!(s.max_speed <= MAX_SPEED * 1.05 + 0.01, "max speed {}", s.max_speed);
    }

    #[test]
    fn play_reaches_both_penalty_boxes() {
        let s = run(42, 10.0);
        println!(
            "10 min: box entries={} goals={} owned={:.0}% max_speed={:.1}",
            s.box_entries,
            s.goals,
            100.0 * s.owned_ticks as f32 / s.ticks as f32,
            s.max_speed
        );
        assert!(s.box_entries >= 10, "only {} box entries in 10 minutes", s.box_entries);
    }
}
