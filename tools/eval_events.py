#!/usr/bin/env python3
"""Score detected match events against Metrica's hand-labelled event log.

usage: eval_events.py [--verbose] GAME_DIR EVENTS_JSONL

GAME_DIR is a Metrica sample game folder (with *_RawEventsData.csv);
EVENTS_JSONL is the server's -events-out file from replaying that game.

Detected and labelled events of the same type are paired one-to-one, closest
in time first, within a per-type tolerance. Precision is the share of
detections that match a real event; recall is the share of real events
detected.
"""
import csv
import glob
import json
import os
import statistics
import sys

# Seconds a detection may be off from the labelled time.
TOLERANCE = {"goal": 4, "kickoff": 3, "throw_in": 4, "corner": 6, "shot": 2}


def shot_outcome(subtype):
    if "GOAL" in subtype:
        return "goal"
    if "BLOCKED" in subtype:
        return "blocked"
    if "ON TARGET" in subtype:
        return "on_target"
    return "off_target"


def load_truth(game_dir):
    path = glob.glob(os.path.join(game_dir, "*_RawEventsData.csv"))[0]
    rows = list(csv.DictReader(open(path)))
    team = {"Home": 0, "Away": 1}
    kickoffs = sorted((float(r["Start Time [s]"]), team.get(r["Team"], -1)) for r in rows
                      if r["Type"] == "SET PIECE" and r["Subtype"] == "KICK OFF")
    truth = [{"type": "kickoff", "t": t, "team": side} for t, side in kickoffs]
    for r in rows:
        t, sub, when = r["Type"], r["Subtype"], float(r["Start Time [s]"])
        side = team.get(r["Team"], -1)
        if t == "SET PIECE" and sub == "THROW IN":
            truth.append({"type": "throw_in", "t": when, "team": side})
        elif t == "SET PIECE" and sub == "CORNER KICK":
            truth.append({"type": "corner", "t": when, "team": side})
        elif t == "SHOT":
            truth.append({"type": "shot", "t": when, "team": side, "detail": shot_outcome(sub)})
        if t in ("SHOT", "BALL OUT") and sub.endswith("GOAL"):
            # The labelled team is whoever touched the ball last, which is wrong
            # for own goals; the conceding team takes the next kick-off.
            nxt = next((s for w, s in kickoffs if w > when), -1)
            truth.append({"type": "goal", "t": when, "team": 1 - nxt if nxt in (0, 1) else side})
    return truth


def load_detected(path):
    out = []
    for line in open(path):
        ev = json.loads(line)
        out.append({"type": ev["type"], "t": ev["clock"] / 1000, "team": ev.get("team", -1),
                    "detail": ev.get("detail")})
    return out


def match(truth, detected, tol):
    pairs = sorted(
        (abs(d["t"] - g["t"]), i, j)
        for i, g in enumerate(truth) for j, d in enumerate(detected)
        if abs(d["t"] - g["t"]) <= tol
    )
    used_t, used_d, out = set(), set(), []
    for dt, i, j in pairs:
        if i in used_t or j in used_d:
            continue
        used_t.add(i)
        used_d.add(j)
        out.append((truth[i], detected[j], dt))
    return out


def clock(t):
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def main():
    args = [a for a in sys.argv[1:] if a != "--verbose"]
    verbose = len(args) < len(sys.argv) - 1
    if len(args) != 2:
        sys.exit(__doc__)
    truth, detected = load_truth(args[0]), load_detected(args[1])
    misses = []
    types = ["goal", "kickoff", "shot", "corner", "throw_in"]
    print(f"{'event':10s} {'real':>5s} {'found':>5s} {'match':>5s} {'precision':>9s} {'recall':>6s}"
          f" {'F1':>5s} {'team ok':>7s} {'Δt med':>6s}")
    for kind in types:
        g = [e for e in truth if e["type"] == kind]
        d = [e for e in detected if e["type"] == kind]
        m = match(g, d, TOLERANCE[kind])
        p = len(m) / len(d) if d else 0
        r = len(m) / len(g) if g else 0
        f1 = 2 * p * r / (p + r) if p + r else 0
        team = sum(a["team"] == b["team"] for a, b, _ in m) / len(m) if m else 0
        dt = statistics.median(x for _, _, x in m) if m else 0
        print(f"{kind:10s} {len(g):5d} {len(d):5d} {len(m):5d} {p:9.0%} {r:6.0%} {f1:5.2f} {team:7.0%} {dt:5.1f}s")
        hit_t = {id(a) for a, _, _ in m}
        hit_d = {id(b) for _, b, _ in m}
        misses += [(e["t"], "missed", kind, e) for e in g if id(e) not in hit_t]
        misses += [(e["t"], "false alarm", kind, e) for e in d if id(e) not in hit_d]
        if kind == "shot" and m:
            ok = sum(a["detail"] == b["detail"] for a, b, _ in m)
            print(f"{'':10s} shot outcome correct for {ok}/{len(m)} matched shots")
    if verbose:
        print()
        for t, what, kind, e in sorted(misses, key=lambda x: x[0]):
            near = min(detected, key=lambda d: abs(d["t"] - t))
            print(f"  {clock(t)}  {what:11s} {kind:9s} team={e['team']:2d}"
                  f"  nearest detection: {near['type']} at {clock(near['t'])}")
    extra = sorted({e["type"] for e in detected} - set(types))
    for kind in extra:
        n = sum(e["type"] == kind for e in detected)
        print(f"{kind:10s}     - {n:5d}     -  (no ground truth in Metrica's log)")


if __name__ == "__main__":
    main()
