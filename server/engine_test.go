package main

import (
	"encoding/json"
	"testing"
)

// matchFeed builds frames for a two-player match (one per team), 20 Hz.
type matchFeed struct {
	e   *Engine
	seq uint64
	mt  int64
}

func newFeed() *matchFeed {
	return &matchFeed{e: NewEngine(&IngestStats{}, NewHub())}
}

// hold sends identical frames for d seconds and returns the last state.
func (m *matchFeed) hold(d float64, period int, ball, home, away Point) StateMsg {
	var st StateMsg
	for i := 0; i < int(d*20); i++ {
		m.seq++
		m.mt += 50
		mt := m.mt
		f := Frame{
			Seq: m.seq, TS: mt, MT: &mt, Period: period, Ball: ball,
			Players: []PlayerFrame{
				{ID: 1, Team: 0, Num: 1, X: home.X, Y: home.Y},
				{ID: 2, Team: 1, Num: 2, X: away.X, Y: away.Y},
			},
		}
		if b := m.e.process(f); b != nil {
			if err := json.Unmarshal(b, &st); err != nil {
				panic(err)
			}
		}
	}
	return st
}

var (
	spot     = Point{52.5, 34}
	homeHalf = Point{40, 30}
	awayHalf = Point{65, 30}
	midfield = Point{30, 20}
)

func TestKickOffAfterGoalMouthCountsAsGoal(t *testing.T) {
	m := newFeed()
	m.hold(1, 1, spot, homeHalf, awayHalf) // opening kick-off: no goal
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	m.hold(0.5, 1, Point{105.3, 35}, Point{100, 34}, awayHalf) // ball in the right goal
	m.hold(30, 1, Point{80, 34}, Point{70, 34}, awayHalf)      // celebrations
	st := m.hold(1, 1, spot, homeHalf, awayHalf)               // kick-off confirms

	if st.Score != [2]int{1, 0} {
		t.Fatalf("score = %v, want [1 0]", st.Score)
	}
	ev := m.e.goals[len(m.e.goals)-1]
	if ev.Type != "goal" || ev.Team != 0 || ev.Confirmed <= ev.Clock {
		t.Fatalf("goal event = %+v", ev)
	}
}

func TestShotOverTheBarIsNotAGoal(t *testing.T) {
	m := newFeed()
	m.hold(1, 1, Point{-0.5, 33}, homeHalf, awayHalf) // crosses between the posts
	m.hold(1, 2, midfield, homeHalf, awayHalf)        // half-time passes
	st := m.hold(1, 2, spot, homeHalf, awayHalf)      // second-half kick-off

	if st.Score != [2]int{0, 0} {
		t.Fatalf("score = %v, want [0 0]", st.Score)
	}
}

func TestKickOffNeedsTeamsInOwnHalves(t *testing.T) {
	m := newFeed()
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	m.hold(0.5, 1, Point{-0.3, 34}, homeHalf, Point{10, 34}) // ball in the left goal
	// Ball rolls through the centre spot during open play.
	st := m.hold(1, 1, spot, Point{60, 34}, awayHalf)
	if st.Score != [2]int{0, 0} {
		t.Fatalf("open play counted as kick-off: score = %v", st.Score)
	}
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	st = m.hold(1, 1, spot, homeHalf, awayHalf)
	if st.Score != [2]int{0, 1} {
		t.Fatalf("score = %v, want [0 1]", st.Score)
	}
}

func TestSubstitutedPlayersAreInactive(t *testing.T) {
	m := newFeed()
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	m.seq++
	m.mt += 50
	mt := m.mt
	b := m.e.process(Frame{Seq: m.seq, TS: mt, MT: &mt, Period: 1, Ball: midfield,
		Players: []PlayerFrame{{ID: 1, Team: 0, Num: 1, X: 40, Y: 30}}})
	var st StateMsg
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	for _, p := range st.Players {
		if p.ID == 2 && p.Active {
			t.Fatalf("player 2 left the frame but is still active")
		}
	}
	if st.Poss.Player != 1 {
		t.Fatalf("possession given to inactive player %d", st.Poss.Player)
	}
}

// Recorded tracking often freezes the ball where it went dead and only
// re-acquires it on the centre spot as the kick-off is taken.
func TestKickOffWithBallReacquiredOnSpot(t *testing.T) {
	m := newFeed()
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	m.hold(1, 1, Point{101, 34.5}, Point{99, 34}, awayHalf) // shot
	goalAt := m.mt
	m.hold(40, 1, Point{105.8, 37.2}, Point{99, 34}, awayHalf) // ball frozen in the net
	m.hold(2, 1, Point{105.8, 37.2}, homeHalf, awayHalf)       // teams line up
	m.hold(0.2, 1, spot, homeHalf, awayHalf)                   // kicked almost at once
	st := m.hold(1, 1, Point{60, 35}, homeHalf, awayHalf)

	if st.Score != [2]int{1, 0} {
		t.Fatalf("score = %v, want [1 0]", st.Score)
	}
	ev := m.e.goals[len(m.e.goals)-1]
	if ev.Clock < goalAt || ev.Clock > goalAt+1000 {
		t.Fatalf("goal clock %d, want just after %d (when the ball entered the goal)", ev.Clock, goalAt)
	}
}

func TestHelloEncodesEmptyListsAsArrays(t *testing.T) {
	var hello map[string]any
	if err := json.Unmarshal(newFeed().e.Welcome()[0], &hello); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"events", "goals", "zones"} {
		if _, ok := hello[k].([]any); !ok {
			t.Errorf("hello.%s = %v, want an array", k, hello[k])
		}
	}
}

func TestLateClientGetsLatestState(t *testing.T) {
	m := newFeed()
	if n := len(m.e.Welcome()); n != 1 {
		t.Fatalf("before any frames: %d welcome messages, want 1 (hello only)", n)
	}
	m.hold(1, 1, midfield, homeHalf, awayHalf)
	w := m.e.Welcome()
	var st StateMsg
	if len(w) != 2 || json.Unmarshal(w[1], &st) != nil || st.Type != "state" || st.Clock != m.mt {
		t.Fatalf("welcome after frames does not end with the latest state")
	}
}
