package main

import (
	"encoding/json"
	"log"
	"math"
	"sort"
	"sync"
	"time"
)

const (
	pitchW = 105.0
	pitchH = 68.0

	// The closest player is "in control" when within this distance of the ball.
	controlRadius = 3.0
	// Displacements implying a faster speed are treated as resets and not
	// counted towards distance covered.
	maxPlayerSpeed = 12.0 // m/s
	goalHalfWidth  = 3.66
	centerCircle   = 9.15
	// Kick-off: ball on the centre spot after every player has been in their
	// own half (with a little tolerance for tracking noise) for koHold. The
	// hold is on the players, not the ball: tracking systems often lose the
	// ball during dead time and only pick it up again as it is kicked.
	koSpotRadius = 1.5
	koHalfSlack  = 1.0
	koHold       = 0.5 // s
	// A kick-off only confirms a goal if the ball was in a goal mouth
	// shortly before it.
	mouthDepth  = 0.5   // m beyond/inside the goal line
	mouthWindow = 120e3 // ms
	maxEvents   = 400   // a full match has roughly 150 events
	// A sequence number this far below the last one means the edge restarted.
	seqRestartGap = 100
)

// Zone is an axis-aligned geofence on the pitch.
type Zone struct {
	Name  string  `json:"name"`
	Label string  `json:"label"`
	X0    float64 `json:"x0"`
	Y0    float64 `json:"y0"`
	X1    float64 `json:"x1"`
	Y1    float64 `json:"y1"`
}

func (z Zone) Contains(p Point) bool {
	return p.X >= z.X0 && p.X <= z.X1 && p.Y >= z.Y0 && p.Y <= z.Y1
}

// Home (team 0) defends the left goal; Away (team 1) the right.
var zones = []Zone{
	{Name: "left_box", Label: "Home penalty box", X0: 0, Y0: 13.84, X1: 16.5, Y1: 54.16},
	{Name: "right_box", Label: "Away penalty box", X0: 88.5, Y0: 13.84, X1: 105, Y1: 54.16},
}

var teamNames = [2]string{"Home", "Away"}

type Event struct {
	Type      string `json:"type"` // goal, kickoff, shot, corner, throw_in, goal_kick
	Clock     int64  `json:"clock"`
	Zone      string `json:"zone,omitempty"`
	Team      int    `json:"team"` // team in possession / scoring team, -1 if unknown
	Player    int    `json:"player,omitempty"`
	Confirmed int64  `json:"confirmed,omitempty"` // goals: clock of the confirming kick-off
	Detail    string `json:"detail,omitempty"`    // shots: goal, on_target, off_target, blocked
}

// goalMouth records the ball's last visit to a goal mouth.
type goalMouth struct {
	clock int64
	left  bool // the left (Home) goal
}

type playerStat struct {
	id, team, num int
	x, y          float64
	dist          float64
	speed         float64 // smoothed, m/s
	top           float64
	seen          bool
	active        bool // present in the latest frame (false once substituted)
}

type PlayerOut struct {
	ID     int     `json:"id"`
	Team   int     `json:"team"`
	Num    int     `json:"num"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Dist   float64 `json:"dist"`
	Speed  float64 `json:"speed"`
	Top    float64 `json:"top"`
	Active bool    `json:"active"`
}

type PossOut struct {
	Player  int     `json:"player"` // id of the closest player
	Num     int     `json:"num"`
	Team    int     `json:"team"` // team of the closest player
	Dist    float64 `json:"dist"`
	Control bool    `json:"control"`
	Holder  int     `json:"holder"` // team credited with possession, -1 before the first touch
}

type StatsOut struct {
	FPS          float64 `json:"fps"`
	Packets      uint64  `json:"packets"`
	Lost         uint64  `json:"lost"`
	DecodeErrors uint64  `json:"decodeErrors"`
	Dropped      uint64  `json:"dropped"`
	EdgeLatency  float64 `json:"edgeLatencyMs"`
	ProcUs       int64   `json:"procUs"`
	Clients      int     `json:"clients"`
}

type StateMsg struct {
	Type    string            `json:"type"`
	Seq     uint64            `json:"seq"`
	Clock   int64             `json:"clock"` // match time in ms
	Period  int               `json:"period"`
	Ball    Point             `json:"ball"`
	Players []PlayerOut       `json:"players"`
	Poss    PossOut           `json:"poss"`
	PossPct [2]float64        `json:"possPct"`
	Zones   map[string]bool   `json:"zones"`
	Entries map[string]int    `json:"entries"`
	Score   [2]int            `json:"score"`
	Tallies map[string][2]int `json:"tallies"`          // per-team counts by event type
	Events  []Event           `json:"events,omitempty"` // new since the previous message
	Stats   StatsOut          `json:"stats"`
	SrvTS   int64             `json:"srvTs"`
}

type helloMsg struct {
	Type   string             `json:"type"`
	Pitch  map[string]float64 `json:"pitch"`
	Zones  []Zone             `json:"zones"`
	Teams  [2]string          `json:"teams"`
	Events []Event            `json:"events"`
	Goals  []Event            `json:"goals"` // every goal, even those beyond the event history
}

// Engine owns all match state. Only the Run goroutine touches it, except for
// the cached hello and latest state messages, which are guarded by helloMu.
type Engine struct {
	ingest *IngestStats
	hub    *Hub

	players map[int]*playerStat
	order   []int

	haveSeq bool
	firstTS int64
	lastSeq uint64
	lastTS  int64
	lastMT  int64
	lost    uint64

	possTeam   int
	possFrames [2]uint64

	inZone  map[string]bool
	entries map[string]int
	score   [2]int
	events  []Event
	goals   []Event
	tallies map[string][2]int
	restart restartState
	shot    shotState

	// OnEvent, if set, is called for every detected event (e.g. to log them).
	OnEvent func(Event)

	period   int
	mouth    *goalMouth
	inMouth  bool
	koHeld   float64
	koArmed  bool
	lastTick int64

	fpsWindow time.Time
	fpsCount  int
	fps       float64
	edgeLat   float64
	procUs    int64

	helloMu   sync.RWMutex
	hello     []byte
	lastState []byte
}

func NewEngine(ingest *IngestStats, hub *Hub) *Engine {
	e := &Engine{ingest: ingest, hub: hub}
	e.reset()
	return e
}

func (e *Engine) reset() {
	e.players = make(map[int]*playerStat)
	e.order = e.order[:0]
	e.haveSeq = false
	e.lost = 0
	e.possTeam = -1
	e.possFrames = [2]uint64{}
	e.inZone = make(map[string]bool)
	e.entries = make(map[string]int)
	for _, z := range zones {
		e.entries[z.Name] = 0
	}
	e.score = [2]int{}
	e.period = 0
	e.mouth = nil
	e.inMouth = false
	e.koHeld = 0
	e.koArmed = true
	e.lastTick = 0
	e.events = []Event{} // encode as [] rather than null
	e.goals = []Event{}
	e.tallies = make(map[string][2]int)
	for _, t := range tallyTypes {
		e.tallies[t] = [2]int{}
	}
	e.restart = restartState{}
	e.shot = shotState{last: -shotGap} // allow a shot straight away
	e.refreshHello()
}

// Welcome returns the messages a newly connected client needs: the hello
// message and, if the match has started, the latest state.
func (e *Engine) Welcome() [][]byte {
	e.helloMu.RLock()
	defer e.helloMu.RUnlock()
	if e.lastState == nil {
		return [][]byte{e.hello}
	}
	return [][]byte{e.hello, e.lastState}
}

func (e *Engine) refreshHello() {
	b, err := json.Marshal(helloMsg{
		Type:   "hello",
		Pitch:  map[string]float64{"w": pitchW, "h": pitchH},
		Zones:  zones,
		Teams:  teamNames,
		Events: e.events,
		Goals:  e.goals,
	})
	if err != nil {
		log.Printf("engine: marshal hello: %v", err)
		return
	}
	e.helloMu.Lock()
	e.hello = b
	e.lastState = nil
	e.helloMu.Unlock()
}

func (e *Engine) Run(frames <-chan Frame) {
	for f := range frames {
		if msg := e.process(f); msg != nil {
			e.hub.Broadcast(msg)
		}
	}
}

// process folds one frame into the match state and returns the encoded
// state message to broadcast, or nil if the frame was discarded.
func (e *Engine) process(f Frame) []byte {
	start := time.Now()

	gap := uint64(1)
	if e.haveSeq {
		switch {
		case f.Seq+seqRestartGap < e.lastSeq:
			log.Printf("engine: edge sequence restarted (%d -> %d); resetting match state", e.lastSeq, f.Seq)
			e.reset()
		case f.Seq <= e.lastSeq:
			return nil // duplicate or reordered datagram
		default:
			gap = f.Seq - e.lastSeq
			e.lost += gap - 1
		}
	}
	// Prefer match time: it stays correct when the edge replays faster than
	// real time. Fall back to wall-clock timestamps for older edges.
	dt := 0.05 * float64(gap)
	switch {
	case e.haveSeq && f.MT != nil && *f.MT > e.lastMT:
		dt = float64(*f.MT-e.lastMT) / 1000
	case e.haveSeq && f.MT == nil && f.TS > e.lastTS:
		dt = float64(f.TS-e.lastTS) / 1000
	}
	if !e.haveSeq {
		e.firstTS = f.TS
		e.haveSeq = true
	}
	clock := f.TS - e.firstTS
	if f.MT != nil {
		clock = *f.MT
		e.lastMT = *f.MT
	}
	e.lastSeq, e.lastTS = f.Seq, f.TS

	e.updateRate(f)
	e.updatePlayers(f, dt)
	poss := e.updatePossession(f.Ball, gap)
	e.updateGeofences(f.Ball)
	newEvents := e.updateGoals(f, clock)
	newEvents = append(newEvents, e.updateRestarts(f.Ball, clock, dt)...)
	newEvents = append(newEvents, e.updateShots(f.Ball, clock, newEvents)...)
	e.recordEvents(newEvents)

	msg := StateMsg{
		Type:    "state",
		Seq:     f.Seq,
		Clock:   clock,
		Period:  f.Period,
		Ball:    Point{r2(f.Ball.X), r2(f.Ball.Y)},
		Players: make([]PlayerOut, 0, len(e.order)),
		Poss:    poss,
		PossPct: e.possessionPct(),
		Zones:   e.inZone,
		Entries: e.entries,
		Score:   e.score,
		Tallies: e.tallies,
		Events:  newEvents,
		Stats: StatsOut{
			FPS:          r2(e.fps),
			Packets:      e.ingest.Packets.Load(),
			Lost:         e.lost,
			DecodeErrors: e.ingest.DecodeErrors.Load(),
			Dropped:      e.ingest.ChannelDrops.Load(),
			EdgeLatency:  r2(e.edgeLat),
			ProcUs:       e.procUs,
			Clients:      e.hub.Count(),
		},
		SrvTS: time.Now().UnixMilli(),
	}
	for _, id := range e.order {
		p := e.players[id]
		msg.Players = append(msg.Players, PlayerOut{
			ID: p.id, Team: p.team, Num: p.num,
			X: r2(p.x), Y: r2(p.y),
			Dist: r2(p.dist), Speed: r2(p.speed), Top: r2(p.top),
			Active: p.active,
		})
	}

	b, err := json.Marshal(msg)
	if err != nil {
		log.Printf("engine: marshal state: %v", err)
		return nil
	}
	e.procUs = time.Since(start).Microseconds()
	e.helloMu.Lock()
	e.lastState = b
	e.helloMu.Unlock()
	return b
}

func (e *Engine) updateRate(f Frame) {
	lat := float64(f.recvAt.UnixMilli() - f.TS)
	if e.edgeLat == 0 {
		e.edgeLat = lat
	} else {
		e.edgeLat = e.edgeLat*0.9 + lat*0.1
	}
	if e.fpsWindow.IsZero() {
		e.fpsWindow = f.recvAt
	}
	e.fpsCount++
	if el := f.recvAt.Sub(e.fpsWindow); el >= time.Second {
		e.fps = float64(e.fpsCount) / el.Seconds()
		e.fpsCount = 0
		e.fpsWindow = f.recvAt
	}
}

func (e *Engine) updatePlayers(f Frame, dt float64) {
	added := false
	for _, p := range e.players {
		p.active = false
	}
	for _, pf := range f.Players {
		p, ok := e.players[pf.ID]
		if !ok {
			p = &playerStat{id: pf.ID}
			e.players[pf.ID] = p
			e.order = append(e.order, pf.ID)
			added = true
		}
		p.team, p.num = pf.Team, pf.Num
		if p.seen && dt > 0 {
			d := math.Hypot(pf.X-p.x, pf.Y-p.y)
			if d <= maxPlayerSpeed*dt {
				p.dist += d
				p.speed = p.speed*0.7 + (d/dt)*0.3
				p.top = math.Max(p.top, p.speed)
			}
		}
		p.x, p.y, p.seen, p.active = pf.X, pf.Y, true, true
	}
	if added {
		sort.Ints(e.order)
	}
}

func (e *Engine) updatePossession(ball Point, gap uint64) PossOut {
	var best *playerStat
	bestD := math.Inf(1)
	for _, p := range e.players {
		if !p.active {
			continue
		}
		if d := math.Hypot(p.x-ball.X, p.y-ball.Y); d < bestD {
			best, bestD = p, d
		}
	}
	if best == nil {
		return PossOut{Team: -1, Holder: -1}
	}
	control := bestD <= controlRadius
	// Possession stays with the last team in control until the other team
	// takes it, so loose balls in flight are not counted as turnovers.
	if control {
		e.possTeam = best.team
	}
	if e.possTeam >= 0 {
		e.possFrames[e.possTeam] += gap
	}
	return PossOut{
		Player: best.id, Num: best.num, Team: best.team,
		Dist: r2(bestD), Control: control, Holder: e.possTeam,
	}
}

func (e *Engine) possessionPct() [2]float64 {
	total := e.possFrames[0] + e.possFrames[1]
	if total == 0 {
		return [2]float64{50, 50}
	}
	home := r2(100 * float64(e.possFrames[0]) / float64(total))
	return [2]float64{home, r2(100 - home)}
}

// updateGeofences counts ball entries into each zone. They are frequent, so
// they are kept as counters rather than reported as events.
func (e *Engine) updateGeofences(ball Point) {
	for _, z := range zones {
		in := z.Contains(ball)
		if in && !e.inZone[z.Name] {
			e.entries[z.Name]++
		}
		e.inZone[z.Name] = in
	}
}

// updateGoals detects goals. Tracking data has no ball height, so a ball
// crossing the goal line between the posts may have gone over the bar.
// Instead a goal is confirmed by what follows it: a kick-off (ball on the
// centre spot, both teams in their own halves) shortly after the ball was in
// a goal mouth. The goal mouth tells us which side scored. Kick-offs that
// start a half are not preceded by a goal-mouth visit in that half.
func (e *Engine) updateGoals(f Frame, clock int64) []Event {
	if f.Period != e.period {
		e.period = f.Period
		e.mouth = nil
	}
	dt := float64(clock-e.lastTick) / 1000
	e.lastTick = clock

	// Remember when the ball entered a goal mouth (not when it left: the
	// ball's position often freezes there until play restarts).
	ball := f.Ball
	near := math.Abs(ball.Y-pitchH/2) < goalHalfWidth+mouthDepth
	left, right := near && ball.X < mouthDepth, near && ball.X > pitchW-mouthDepth
	if (left || right) && !e.inMouth {
		e.mouth = &goalMouth{clock: clock, left: left}
	}
	e.inMouth = left || right

	dc := math.Hypot(ball.X-pitchW/2, ball.Y-pitchH/2)
	if dc > centerCircle {
		e.koArmed = true
	}
	if e.teamsInOwnHalves() {
		e.koHeld += math.Max(dt, 0)
	} else {
		e.koHeld = 0
	}
	if !e.koArmed || e.koHeld < koHold || dc >= koSpotRadius {
		return nil
	}
	e.koArmed = false
	kickoff := Event{Type: "kickoff", Clock: clock, Team: e.nearestTeam(ball)}

	m := e.mouth
	e.mouth = nil
	if m == nil || clock-m.clock > mouthWindow {
		return []Event{kickoff} // kick-off at the start of a half
	}
	scorer := 0 // Home scores in the right goal
	if m.left {
		scorer = 1
	}
	e.score[scorer]++
	goal := Event{Type: "goal", Clock: m.clock, Team: scorer, Confirmed: clock}
	e.goals = append(e.goals, goal)
	return []Event{goal, kickoff}
}

// teamsInOwnHalves reports whether Home is in the left half and Away in the right.
func (e *Engine) teamsInOwnHalves() bool {
	for _, p := range e.players {
		if !p.active {
			continue
		}
		if (p.team == 0 && p.x > pitchW/2+koHalfSlack) || (p.team == 1 && p.x < pitchW/2-koHalfSlack) {
			return false
		}
	}
	return true
}

func (e *Engine) recordEvents(out []Event) {
	for _, ev := range out {
		e.tally(ev)
		if e.OnEvent != nil {
			e.OnEvent(ev)
		}
	}
	if len(out) > 0 {
		e.events = append(e.events, out...)
		if len(e.events) > maxEvents {
			e.events = e.events[len(e.events)-maxEvents:]
		}
		e.refreshHello()
	}
}

func r2(v float64) float64 {
	return math.Round(v*100) / 100
}
