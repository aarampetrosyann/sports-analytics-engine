package main

import "math"

// Set-piece detection from positions alone.
//
// The ball is "dead" while it is off the pitch, or while its position is
// frozen: recorded tracking stops updating the ball when it is lost, which
// mostly happens during stoppages. Play restarts when the ball moves again
// inside the pitch, and where that happens says what kind of restart it was:
// on a touchline it is a throw-in, by a corner flag a corner, in a goal area
// a goal kick. Kick-offs are detected separately (see updateGoals).

const (
	frozenDead   = 1.0 // s without any ball movement before the ball counts as dead
	minDead      = 2.0 // s a stoppage must last before its restart is reported
	liveSpeed    = 1.5 // m/s; slower movement inside the pitch is still a stoppage
	throwInBand  = 1.5 // m from a touchline
	cornerRadius = 9.0 // m from a corner flag (tracking often re-acquires late)
	cornerDepth  = 6.0 // m from the goal line
	goalKickArea = 7.0 // m from the goal line...
	goalKickHalf = 11  // ...and within this distance of the centre line of the goal
	centreSpot   = 3.0 // m; restarts here are kick-offs, reported elsewhere
)

// Event types and the tallies kept for them.
var tallyTypes = []string{"goal", "shot", "on_target", "corner", "throw_in", "goal_kick"}

type restartState struct {
	lastBall  Point
	haveBall  bool
	frozenFor float64
	dead      bool
	deadFor   float64
	overGoal  bool // the stoppage began with the ball crossing a goal line
}

// updateRestarts returns a throw-in, corner or goal-kick event when play
// restarts after a stoppage.
func (e *Engine) updateRestarts(ball Point, clock int64, dt float64) []Event {
	r := &e.restart
	moved := 0.0
	if r.haveBall {
		moved = math.Hypot(ball.X-r.lastBall.X, ball.Y-r.lastBall.Y)
	}
	r.lastBall, r.haveBall = ball, true
	if moved == 0 {
		r.frozenFor += dt
	} else {
		r.frozenFor = 0
	}
	inside := ball.X >= 0 && ball.X <= pitchW && ball.Y >= 0 && ball.Y <= pitchH

	if !r.dead {
		if !inside || r.frozenFor >= frozenDead {
			r.dead, r.deadFor = true, 0
			r.overGoal = ball.X < 0 || ball.X > pitchW
		}
		return nil
	}
	r.deadFor += dt
	if !inside || moved == 0 || dt <= 0 || moved/dt < liveSpeed {
		return nil
	}
	r.dead = false
	if r.deadFor < minDead {
		return nil
	}
	kind := classifyRestart(ball, r.overGoal)
	if kind == "" {
		return nil
	}
	return []Event{{Type: kind, Clock: clock, Team: e.nearestTeam(ball)}}
}

// classifyRestart names the restart taken from p, or "" if it is none of the
// set pieces we detect (kick-offs, free kicks, drop balls). overGoal says the
// ball went out over a goal line, which rules out a throw-in: a restart on
// the touchline near the flag is then a corner whose ball was picked up late.
func classifyRestart(p Point, overGoal bool) string {
	toGoalLine := math.Min(p.X, pitchW-p.X)
	toTouchline := math.Min(p.Y, pitchH-p.Y)
	switch {
	case math.Hypot(p.X-pitchW/2, p.Y-pitchH/2) < centreSpot:
		return ""
	case toGoalLine < cornerDepth && math.Hypot(toGoalLine, toTouchline) < cornerRadius:
		return "corner"
	case overGoal && toTouchline < throwInBand && toGoalLine < 2*cornerRadius:
		return "corner"
	case toTouchline < throwInBand:
		return "throw_in"
	case toGoalLine < goalKickArea && math.Abs(p.Y-pitchH/2) < goalKickHalf:
		return "goal_kick"
	}
	return ""
}

// nearestTeam is the team of the active player closest to p, or -1.
func (e *Engine) nearestTeam(p Point) int {
	team, best := -1, math.Inf(1)
	for _, pl := range e.players {
		if !pl.active {
			continue
		}
		if d := math.Hypot(pl.x-p.X, pl.y-p.Y); d < best {
			team, best = pl.team, d
		}
	}
	return team
}

// tally counts an event towards its team's match stats.
func (e *Engine) tally(ev Event) {
	if ev.Team < 0 || ev.Team > 1 {
		return
	}
	if _, ok := e.tallies[ev.Type]; ok {
		t := e.tallies[ev.Type]
		t[ev.Team]++
		e.tallies[ev.Type] = t
	}
	if ev.Type == "shot" && (ev.Detail == "on_target" || ev.Detail == "goal") {
		t := e.tallies["on_target"]
		t[ev.Team]++
		e.tallies["on_target"] = t
	}
}

// Shot detection. A shot is a kick: within about 0.15 s the ball's velocity
// jumps by at least shotKick, leaving it faster than shotSpeed, heading for
// the goal the kicker's team attacks (within shotMargin of the posts), from
// inside shotRange, with a player of that team within shotReach of the ball.
// Velocity is measured on both sides of the contact, so a header that
// redirects a cross is judged by where the ball goes after it.
//
// Its outcome is decided by what follows: the ball crossing the goal line
// wide (off target), the defending goalkeeper taking control (saved, so on
// target), the ball being stopped next to a defender (blocked). If the ball
// ends in the goal mouth, the next restart decides: a kick-off means a goal,
// anything else means it went over the bar. Thresholds were chosen on
// Metrica sample games 1 and 2 (see tools/eval_events.py).
const (
	shotSpeed   = 12.0 // m/s after contact
	shotKick    = 12.0 // m/s change in velocity at contact
	shotRange   = 25.0 // m from the goal
	shotMargin  = 7.0  // m outside the posts
	shotReach   = 4.0  // m from the ball to the nearest player
	shotWindow  = 3    // frames on each side of the contact
	shotGap     = 1500 // ms between shots
	shotResolve = 3000 // ms to settle an outcome before calling it off target
	saveReach   = 1.5  // m: the keeper is in control of the ball
	blockDrop   = 0.4  // the ball slows to this fraction of its shot speed
)

type ballSample struct {
	clock int64
	p     Point
}

type shotState struct {
	hist    []ballSample // most recent last
	last    int64        // clock of the last shot
	pending *pendingShot
}

type pendingShot struct {
	ev      Event
	speed   float64
	right   bool // aimed at the right-hand goal
	inMouth bool
}

// updateShots detects shots and reports them once their outcome is known.
// restarts are the goal, kick-off and restart events found this frame.
func (e *Engine) updateShots(ball Point, clock int64, restarts []Event) []Event {
	var out []Event
	if p := e.shot.pending; p != nil {
		if detail := e.shotOutcome(p, ball, clock, restarts); detail != "" {
			p.ev.Detail = detail
			out = append(out, p.ev)
			e.shot.pending = nil
		}
	}

	s := &e.shot
	s.hist = append(s.hist, ballSample{clock, ball})
	if len(s.hist) > 2*shotWindow+1 {
		s.hist = s.hist[1:]
	}
	if len(s.hist) < 2*shotWindow+1 || clock-s.last < shotGap {
		return out
	}
	a, b, c := s.hist[0], s.hist[shotWindow], s.hist[2*shotWindow]
	dt0, dt1 := float64(b.clock-a.clock)/1000, float64(c.clock-b.clock)/1000
	if dt0 <= 0 || dt1 <= 0 || dt0 > 0.3 || dt1 > 0.3 {
		return out
	}
	v0x, v0y := (b.p.X-a.p.X)/dt0, (b.p.Y-a.p.Y)/dt0
	v1x, v1y := (c.p.X-b.p.X)/dt1, (c.p.Y-b.p.Y)/dt1
	speed := math.Hypot(v1x, v1y)
	if speed < shotSpeed || math.Hypot(v1x-v0x, v1y-v0y) < shotKick || v1x == 0 {
		return out
	}
	right := v1x > 0
	goalX := 0.0
	if right {
		goalX = pitchW
	}
	if math.Hypot(goalX-b.p.X, pitchH/2-b.p.Y) > shotRange {
		return out
	}
	if yAtLine := b.p.Y + v1y*(goalX-b.p.X)/v1x; math.Abs(yAtLine-pitchH/2) > goalHalfWidth+shotMargin {
		return out
	}
	kicker := e.nearestPlayer(b.p)
	if kicker == nil || math.Hypot(kicker.x-b.p.X, kicker.y-b.p.Y) > shotReach {
		return out
	}
	if (kicker.team == 0) != right { // Home attacks the right-hand goal
		return out
	}

	if e.shot.pending != nil { // a second shot before the first settled: a rebound
		e.shot.pending.ev.Detail = "blocked"
		out = append(out, e.shot.pending.ev)
	}
	s.last = b.clock
	e.shot.pending = &pendingShot{
		ev:    Event{Type: "shot", Clock: b.clock, Team: kicker.team, Player: kicker.id},
		speed: speed,
		right: right,
	}
	return out
}

// shotOutcome returns the outcome of a pending shot, or "" while unsettled.
func (e *Engine) shotOutcome(p *pendingShot, ball Point, clock int64, restarts []Event) string {
	if p.inMouth {
		for _, ev := range restarts {
			switch ev.Type {
			case "goal":
				return "goal"
			case "corner", "goal_kick", "throw_in":
				return "off_target" // went over the bar
			}
		}
		if clock-p.ev.Clock > mouthWindow {
			return "off_target"
		}
		return ""
	}
	goalX := 0.0
	if p.right {
		goalX = pitchW
	}
	beyond := (p.right && ball.X > pitchW-mouthDepth) || (!p.right && ball.X < mouthDepth)
	if beyond {
		if math.Abs(ball.Y-pitchH/2) < goalHalfWidth+mouthDepth {
			p.inMouth = true
			return ""
		}
		if ball.X < 0 || ball.X > pitchW {
			return "off_target"
		}
	}

	defending := 1 - p.ev.Team
	if pl := e.nearestPlayer(ball); pl != nil && pl.team == defending {
		d := math.Hypot(pl.x-ball.X, pl.y-ball.Y)
		if d < saveReach && pl == e.goalkeeper(defending, goalX) {
			return "on_target"
		}
		if d < saveReach && e.ballSpeed() < blockDrop*p.speed && clock-p.ev.Clock < 1000 {
			return "blocked"
		}
	}
	if clock-p.ev.Clock > shotResolve {
		return "off_target"
	}
	return ""
}

// nearestPlayer is the active player closest to p, or nil.
func (e *Engine) nearestPlayer(p Point) *playerStat {
	var best *playerStat
	bestD := math.Inf(1)
	for _, pl := range e.players {
		if !pl.active {
			continue
		}
		if d := math.Hypot(pl.x-p.X, pl.y-p.Y); d < bestD {
			best, bestD = pl, d
		}
	}
	return best
}

// goalkeeper guesses team's keeper: its player closest to the goal at goalX.
func (e *Engine) goalkeeper(team int, goalX float64) *playerStat {
	var best *playerStat
	bestD := math.Inf(1)
	for _, pl := range e.players {
		if !pl.active || pl.team != team {
			continue
		}
		if d := math.Hypot(pl.x-goalX, pl.y-pitchH/2); d < bestD {
			best, bestD = pl, d
		}
	}
	return best
}

// ballSpeed is the ball's speed over the last two samples, in m/s.
func (e *Engine) ballSpeed() float64 {
	h := e.shot.hist
	if len(h) < 2 {
		return 0
	}
	a, b := h[len(h)-2], h[len(h)-1]
	dt := float64(b.clock-a.clock) / 1000
	if dt <= 0 {
		return 0
	}
	return math.Hypot(b.p.X-a.p.X, b.p.Y-a.p.Y) / dt
}
