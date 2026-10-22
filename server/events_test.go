package main

import "testing"

func TestClassifyRestart(t *testing.T) {
	cases := []struct {
		p        Point
		overGoal bool
		want     string
	}{
		{Point{40, 0.3}, false, "throw_in"},
		{Point{70, 67.9}, false, "throw_in"},
		{Point{104.5, 0.6}, true, "corner"},
		{Point{1.5, 64}, true, "corner"},
		{Point{9, 67.5}, true, "corner"}, // ball picked up late, but it went out over the goal line
		{Point{9, 67.5}, false, "throw_in"},
		{Point{5, 30}, true, "goal_kick"},
		{Point{52.5, 34.5}, false, ""}, // kick-off, reported elsewhere
		{Point{60, 30}, false, ""},     // free kick: not detected
	}
	for _, c := range cases {
		if got := classifyRestart(c.p, c.overGoal); got != c.want {
			t.Errorf("classifyRestart(%v, overGoal=%v) = %q, want %q", c.p, c.overGoal, got, c.want)
		}
	}
}

// roll sends frames with the ball moving from `from` at velocity v
// (m/s) for d seconds, with two players at fixed spots.
func (m *matchFeed) roll(d float64, from Point, vx, vy float64, home, away Point) Point {
	b := from
	for i := 0; i < int(d*20); i++ {
		b = Point{b.X + vx*0.05, b.Y + vy*0.05}
		m.hold(0.05, 1, b, home, away)
	}
	return b
}

func TestShotSavedByKeeper(t *testing.T) {
	m := newFeed()
	keeper := Point{102, 34}
	striker := Point{84, 30}
	m.roll(1, Point{80, 30}, 3, 0, striker, keeper)                  // dribbling
	b := m.roll(0.6, Point{84, 30}, 24, 4.8, striker, keeper)        // shot at goal
	m.hold(0.5, 1, Point{keeper.X + 0.5, keeper.Y}, striker, keeper) // keeper holds it
	_ = b
	if got := m.e.tallies["shot"]; got != [2]int{1, 0} {
		t.Fatalf("shots = %v, want [1 0]", got)
	}
	if got := m.e.tallies["on_target"]; got != [2]int{1, 0} {
		t.Fatalf("on target = %v, want [1 0]", got)
	}
}

func TestShotWideIsOffTarget(t *testing.T) {
	m := newFeed()
	striker := Point{84, 30}
	keeper := Point{102, 34}
	m.roll(1, Point{80, 30}, 3, 0, striker, keeper)
	m.roll(1.5, Point{84, 30}, 24, -6, striker, keeper) // crosses the line wide of the post
	var shots []Event
	for _, ev := range m.e.events {
		if ev.Type == "shot" {
			shots = append(shots, ev)
		}
	}
	if len(shots) != 1 || shots[0].Detail != "off_target" || shots[0].Team != 0 {
		t.Fatalf("shots = %+v, want one off-target Home shot", shots)
	}
}

func TestClearanceTowardsOwnGoalIsNotAShot(t *testing.T) {
	m := newFeed()
	defender := Point{20, 34} // Home defends the left goal
	m.roll(1, Point{24, 34}, -3, 0, defender, Point{60, 30})
	m.roll(1, Point{20, 34}, -20, 0, defender, Point{60, 30}) // fast back-pass to the keeper
	if got := m.e.tallies["shot"]; got != [2]int{0, 0} {
		t.Fatalf("shots = %v, want none", got)
	}
}
