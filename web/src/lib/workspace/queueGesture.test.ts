import { describe, it, expect } from "vitest";
import {
  EDGE_ARM_IDLE_MS,
  EDGE_PULL_PX,
  IDLE,
  MOMENTUM_MAX_STEPS,
  REDUCED_STEP_PX,
  START_PX,
  atRest,
  end,
  isNewGesture,
  wheel,
  type GestureOptions,
  type GestureState,
  type WheelOutcome,
} from "./queueGesture";

// WORKSPACE-QUEUE-ADR §VI.4, §VII.6. What a trackpad does is not reproducible
// here; what each wheel event MEANS is, and that is the part with rules.
//
// MUTATION LOG (each applied to queueGesture.ts, the suite re-run, reverted):
//   1. (2026-09-23, chaining) the carry dropped — `acc` reset to 0 at a
//      commit ⇒ the carry, per-D and one-per-event cases fail. DETECTED
//   1b. (chaining) the wall cap removed ⇒ "stops flipping at an end"
//      fails.                                                      DETECTED
//   2. no vertical hysteresis before a drag ⇒ "needs a decisive sideways
//      event inside a vertical scroll" fails.                     DETECTED
//   3. mid-drag noise counted like travel ⇒ "swallows mid-drag noise"
//      fails.                                                     DETECTED
//   4. (2026-09-26, the probe) START_PX set to 0 ⇒ "a pull's stray sideways
//      pixel starts no drag" fails.                               DETECTED
//   5. (the edge pull) the rest requirement dropped ⇒ "the swipe that
//      arrives at the head is not an edge pull" fails.            DETECTED
//   6. (the edge pull) `!o.canStep(-1)` dropped ⇒ "only at the head" fails.
//                                                                 DETECTED
//   7. (2026-09-27) the turn-back's `edge: 0` dropped ⇒ "turned back past
//      zero" fails; the interrupt's dropped ⇒ "interrupted by a new swipe"
//      fails.                                                     DETECTED
//   8. (2026-09-27, S2) the interrupt's `from` dropped — the new gesture
//      judged against the old focal ⇒ "judges the new gesture's first event
//      from where the old one completes" fails.                   DETECTED
//   9. (2026-10-01, the trackpad pass) the momentum cap's `capped` forced
//      false ⇒ "momentum adds at most one feed" fails.            DETECTED
//  10. (the same) `isFalling(recent)` replaced by `true` ⇒ "a swipe's own
//      travel is not momentum" fails.                             DETECTED
//  11. (the same) the guard's `!midVertical` dropped ⇒ "a pull's stray
//      sideways pixel" fails; `ax >= GUARD_MIN_PX` dropped ⇒ the same.
//                                                                 DETECTED

const D = 300;
const both = { D, reduced: false, canStep: () => true, exempt: false };

function run(
  events: Array<[number, number] | [number, number, boolean]>,
  o: Partial<GestureOptions> = {},
  from: GestureState = IDLE,
): { s: GestureState; outs: WheelOutcome[] } {
  let s = from;
  const outs: WheelOutcome[] = [];
  events.forEach(([dx, dy, shift = false], i) => {
    const r = wheel(s, { dx, dy, shift, t: 1000 + i * 16 }, { ...both, ...o });
    s = r.state;
    outs.push(r);
  });
  return { s, outs };
}

describe("wheel — classification", () => {
  it("leaves a vertical event alone", () => {
    const { s, outs } = run([[2, 10]]);
    expect(outs[0].claim).toBe(false);
    expect(s.phase).toBe("idle");
  });

  it("claims a horizontal one and starts a drag", () => {
    const { s, outs } = run([[12, 3]]);
    expect(outs[0]).toMatchObject({ claim: true, counted: true, started: true });
    expect(s.phase).toBe("drag");
    expect(outs[0].u).toBeCloseTo(12 / D);
  });

  it("turns a shifted mouse wheel sideways", () => {
    const { outs } = run([[0, 30, true]]);
    expect(outs[0].claim).toBe(true);
    expect(outs[0].u).toBeCloseTo(30 / D);
  });

  it("leaves a horizontal event over a sideways scroller alone", () => {
    const { s, outs } = run([[12, 0]], { exempt: true });
    expect(outs[0].claim).toBe(false);
    expect(s.phase).toBe("idle");
  });

  it("needs a decisive sideways event to start a drag inside a vertical scroll", () => {
    // A diagonal event in the middle of a vertical flick is part of the flick.
    const { s, outs } = run([
      [0, 20],
      [0, 18],
      [10, 7],
    ]);
    expect(outs[2].claim).toBe(false);
    expect(s.phase).toBe("idle");
    // …but a plainly sideways one still starts.
    const r = run([[0, 20], [15, 5]]);
    expect(r.outs[1].claim).toBe(true);
  });

  it("swallows mid-drag noise without counting it or restarting the clock", () => {
    const { s, outs } = run([
      [30, 0],
      [2, 20],
    ]);
    expect(outs[1]).toMatchObject({ claim: true, counted: false });
    expect(s.acc).toBe(30);
    expect(outs[1].u).toBeCloseTo(30 / D);
  });
});

describe("wheel — a swipe flips through as many feeds as it travels", () => {
  it("commits at full travel and carries the rest into the next feed", () => {
    const { s, outs } = run([
      [150, 0],
      [160, 0],
      [80, 0],
      [40, 0],
    ]);
    expect(outs[1].commit).toBe(1);
    expect(outs[1].u).toBe(0);
    expect(s.phase).toBe("drag");
    expect(outs[2]).toMatchObject({ claim: true, counted: true });
    expect(outs[2].u).toBeCloseTo(90 / D);
    expect(outs[3].commit).toBeUndefined();
    expect(s.acc).toBe(130);
  });

  it("flips one feed per D of travel", () => {
    const { s, outs } = run([
      [200, 0],
      [200, 0],
      [200, 0],
      [200, 0],
      [200, 0],
    ]);
    expect(outs.map((o) => o.commit)).toEqual([undefined, 1, 1, undefined, 1]);
    expect(s.acc).toBe(100);
  });

  it("commits at most one step per event, and the next event commits the next", () => {
    const { s, outs } = run([
      [1000, 0],
      [10, 0],
    ]);
    expect(outs[0].commit).toBe(1);
    expect(outs[1].commit).toBe(1);
    expect(s.acc).toBeCloseTo(0.99 * D + 10 - D);
  });

  it("stops flipping at an end, resists there, and banks no more than one step", () => {
    // A queue with two feeds ahead: the third step is not there.
    let pos = 0;
    const canStep = (d: 1 | -1) => (d === 1 ? pos < 2 : pos > 0);
    let s: GestureState = IDLE;
    const outs: WheelOutcome[] = [];
    for (const dx of [250, 250, 250, 250, 250, 250, 250, 250, -100]) {
      const r = wheel(s, { dx, dy: 0, shift: false, t: 1000 + outs.length * 16 }, { ...both, canStep });
      s = r.state;
      if (r.commit) pos += r.commit;
      outs.push(r);
    }
    expect(outs.filter((o) => o.commit).length).toBe(2);
    expect(pos).toBe(2);
    expect(Math.abs(outs[7].u)).toBeLessThanOrEqual(0.15);
    // 1,500px pushed into the wall, then 100 back: the reversal shows at once.
    expect(outs[8].u).toBeCloseTo((200 / D) * 0.15);
    expect(end(s, { ...both, canStep })).toEqual({ kind: "spring" });
  });

  it("commits backward on negative travel", () => {
    const { outs } = run([
      [-200, 0],
      [-120, 0],
    ]);
    expect(outs[1].commit).toBe(-1);
  });

  it("resists at an end and never commits", () => {
    const { outs } = run(
      [
        [200, 0],
        [400, 0],
        [400, 0],
      ],
      { canStep: (d) => d === -1 },
    );
    expect(outs.every((o) => o.commit === undefined)).toBe(true);
    expect(outs[0].u).toBeCloseTo((200 / D) * 0.15);
    expect(outs[2].u).toBeCloseTo(0.15);
  });

  it("tracks a reversal within one drag", () => {
    const { outs } = run([
      [120, 0],
      [-180, 0],
    ]);
    expect(outs[1].u).toBeCloseTo(-60 / D);
  });
});

describe("wheel — a new gesture inside a tail", () => {
  it("is recognised as a rise after three falling events", () => {
    expect(isNewGesture([40, 30, 20], 31)).toBe(true);
    expect(isNewGesture([40, 30, 20], 29)).toBe(false);
    expect(isNewGesture([30, 20], 60)).toBe(false);
    expect(isNewGesture([40, 30, 30], 60)).toBe(false);
  });

  it("is not a tail's last-pixel jitter", () => {
    expect(isNewGesture([5, 3, 1], 2)).toBe(false);
    expect(isNewGesture([9, 5, 2], 6)).toBe(true);
  });

  it("lets a second quick swipe carry on from the first", () => {
    // Swipe one commits; its tail keeps travelling (122px of the next feed:
    // past 0.3 but short of the nearest-feed 0.5, so it springs back), and
    // swipe two rising out of it starts its own step.
    const { outs } = run([
      [180, 0],
      [140, 0],
      [60, 0],
      [30, 0],
      [12, 0],
      [60, 0],
      [200, 0],
      [100, 0],
    ]);
    expect(outs[1].commit).toBe(1);
    expect(outs[5]).toMatchObject({ started: true, ended: { kind: "spring" } });
    expect(outs.filter((o) => o.commit).length).toBe(2);
  });

  it("ends an uncommitted drag on the way in, completing it past 0.3", () => {
    const { outs } = run([
      [60, 0],
      [40, 0],
      [20, 0],
      [5, 0],
      [40, 0],
    ]);
    // 125px of 300 is past 0.3: the first gesture completes.
    expect(outs[4].ended).toEqual({ kind: "complete", dir: 1 });
    expect(outs[4].started).toBe(true);
  });

  it("judges the new gesture's first event from where the old one completes", () => {
    // One feed ahead: the interrupted drag completes into it, so the new
    // swipe starts at the last feed and its first event is resisted. Judged
    // from the old focal, it ran unresisted for that event.
    const canStep = (d: 1 | -1, from?: 1 | -1) => (d === 1 ? !from : true);
    const { outs } = run(
      [
        [60, 0],
        [40, 0],
        [20, 0],
        [5, 0],
        [40, 0],
      ],
      { canStep },
    );
    expect(outs[4].ended).toEqual({ kind: "complete", dir: 1 });
    expect(outs[4].commit).toBeUndefined();
    expect(outs[4].u).toBeCloseTo((40 / D) * 0.15);
  });
});

describe("end", () => {
  const drag = (acc: number): GestureState => ({ ...IDLE, phase: "drag", acc });

  it("completes past 0.3 and springs back below it", () => {
    expect(end(drag(0.31 * D), both)).toEqual({ kind: "complete", dir: 1 });
    expect(end(drag(-0.31 * D), both)).toEqual({ kind: "complete", dir: -1 });
    expect(end(drag(0.29 * D), both)).toEqual({ kind: "spring" });
  });

  it("once a gesture has stepped, lands on the nearer feed", () => {
    const stepped = (acc: number): GestureState => ({ ...drag(acc), stepped: true });
    expect(end(stepped(0.49 * D), both)).toEqual({ kind: "spring" });
    expect(end(stepped(0.51 * D), both)).toEqual({ kind: "complete", dir: 1 });
    expect(end(stepped(-0.49 * D), both)).toEqual({ kind: "spring" });
    expect(end(stepped(-0.51 * D), both)).toEqual({ kind: "complete", dir: -1 });
  });

  it("marks a gesture stepped at its first commit, and a new gesture starts unstepped", () => {
    const { s, outs } = run([
      [200, 0],
      [200, 0],
    ]);
    expect(outs[0].state.stepped).toBe(false);
    expect(s.stepped).toBe(true);
    expect(end({ ...s, acc: 0.4 * D }, both)).toEqual({ kind: "spring" });
    expect(IDLE.stepped).toBe(false);
  });

  it("springs back at an end whatever the travel", () => {
    expect(end(drag(0.9 * D), { ...both, canStep: () => false })).toEqual({
      kind: "spring",
    });
  });

  it("does nothing after a reduced-motion step", () => {
    expect(end({ ...IDLE, phase: "spent", acc: D }, both)).toEqual({ kind: "none" });
  });
});

describe("reduced motion", () => {
  const reduced = { reduced: true };

  it("shows no progress and steps at 90px", () => {
    const { outs } = run(
      [
        [50, 0],
        [REDUCED_STEP_PX - 50, 0],
        [200, 0],
      ],
      reduced,
    );
    expect(outs[0].u).toBe(0);
    expect(outs[1].commit).toBe(1);
    expect(outs[2].commit).toBeUndefined();
  });

  it("never completes or springs at the end", () => {
    expect(end({ ...IDLE, phase: "drag", acc: 80 }, { ...both, ...reduced })).toEqual({
      kind: "none",
    });
  });

  it("swallows the whole tail, rises and all", () => {
    const { outs } = run(
      [
        [100, 0],
        [60, 0],
        [30, 0],
        [10, 0],
        [80, 0],
        [120, 0],
      ],
      reduced,
    );
    expect(outs.filter((o) => o.commit).length).toBe(1);
  });
});

describe("wheel — a drag is earned (2026-09-26)", () => {
  it("a pull's stray sideways pixel starts no drag, and the pull passes through", () => {
    // A trackpad pull toward a feed's top: the first event is a pixel sideways.
    const { s, outs } = run([
      [-1, 0],
      [0, -4],
      [-1, -9],
      [0, -14],
      [-2, -1],
      [0, -12],
    ]);
    expect(outs.every((o) => !o.claim)).toBe(true);
    // Nor is any of it default-prevented: the list scrolls under the pull.
    expect(outs.every((o) => !o.guard)).toBe(true);
    expect(s.phase).toBe("idle");
  });

  it("guards a sideways run from its first event, before it is claimed (2026-10-01, g9)", () => {
    // A browser decides its history swipe from a scroll's first events.
    const { outs } = run([
      [3, 0],
      [3, 1],
      [4, 0],
    ]);
    expect(outs[0]).toMatchObject({ claim: false, guard: true });
    expect(outs[1]).toMatchObject({ claim: false, guard: true });
    expect(outs[2].claim).toBe(true);
  });

  it("never guards over something that scrolls sideways itself", () => {
    const { outs } = run([[6, 0]], { exempt: true });
    expect(outs[0].guard).toBeUndefined();
  });

  it("a run of sideways events starts a drag once it has travelled, keeping what it probed", () => {
    const { s, outs } = run([
      [3, 0],
      [3, 1],
      [4, 0],
    ]);
    expect(outs[0].claim).toBe(false);
    expect(outs[1].claim).toBe(false);
    expect(outs[2]).toMatchObject({ claim: true, started: true });
    expect(s.acc).toBe(10);
    expect(START_PX).toBeLessThanOrEqual(10);
  });

  it("a vertical-ish event ends the run", () => {
    const { s, outs } = run([
      [5, 0],
      [1, 6],
      [5, 0],
    ]);
    expect(outs.every((o) => !o.claim)).toBe(true);
    expect(s.phase).toBe("idle");
  });
});

describe("wheel — the edge pull (2026-09-26)", () => {
  const head = { canStep: (dir: 1 | -1) => dir === 1 };
  const at = (t: number, dx: number, dy = 0) => ({ dx, dy, shift: false, t });

  function pull(from: GestureState, start: number, n: number, dx = -20) {
    let s = from;
    const outs: WheelOutcome[] = [];
    for (let i = 0; i < n; i++) {
      const r = wheel(s, at(start + i * 16, dx), { ...both, ...head });
      s = r.state;
      outs.push(r);
    }
    return { s, outs };
  }

  it("fires once, at the feed pull's travel, and spends the rest", () => {
    const { s, outs } = pull(IDLE, 1000, Math.ceil(EDGE_PULL_PX / 20) + 3);
    const fired = outs.filter((o) => o.pull);
    expect(fired).toHaveLength(1);
    expect(outs.findIndex((o) => o.pull)).toBe(Math.ceil(EDGE_PULL_PX / 20) - 1);
    expect(outs.every((o) => o.commit === undefined && o.u === 0)).toBe(true);
    expect(outs[0].edge).toBeCloseTo(20 / EDGE_PULL_PX);
    expect(s.phase).toBe("spent");
  });

  it("the swipe that arrives at the head is not an edge pull", () => {
    // Events ending at t = 1000, then a new run 150ms later: not rested.
    const busy = { ...IDLE, lastT: 1000 };
    const { outs } = pull(busy, 1000 + 150, 12);
    expect(outs.some((o) => o.pull)).toBe(false);
    expect(outs.some((o) => o.edge !== undefined)).toBe(false);
    // …and after a rest it is.
    const rested = { ...IDLE, lastT: 1000 };
    const r = pull(rested, 1000 + EDGE_ARM_IDLE_MS, 12);
    expect(r.outs.some((o) => o.pull)).toBe(true);
  });

  it("only at the head, and only toward it", () => {
    const mid = pull(IDLE, 1000, 12);
    expect(mid.outs.some((o) => o.pull)).toBe(true);
    let s: GestureState = IDLE;
    let fired = false;
    for (let i = 0; i < 12; i++) {
      const r = wheel(s, at(1000 + i * 16, -20), both);
      s = r.state;
      fired ||= !!r.pull;
    }
    expect(fired).toBe(false);
    const away = pull(IDLE, 1000, 3, 20);
    expect(away.outs.some((o) => o.edge !== undefined)).toBe(false);
  });

  it("turned back past zero, it closes the strip (audit 2026-09-27, 2)", () => {
    const { s } = pull(IDLE, 1000, 3);
    expect(s.edge).toBe(true);
    const r = wheel(s, at(1000 + 3 * 16, 80), { ...both, ...head });
    // Nothing else writes `edge` for this gesture: without the 0 the strip
    // stayed part-open until the next edge pull.
    expect(r.edge).toBe(0);
    expect(r.state.edge).toBe(false);
    expect(r.state.phase).toBe("drag");
  });

  it("interrupted by a new swipe, it closes the strip", () => {
    let s: GestureState = IDLE;
    for (const [i, dx] of [-40, -30, -20, -10].entries()) {
      s = wheel(s, at(1000 + i * 16, dx), { ...both, ...head }).state;
    }
    expect(s).toMatchObject({ edge: true, phase: "drag" });
    const r = wheel(s, at(1000 + 4 * 16, -40), { ...both, ...head });
    expect(r.started).toBe(true);
    expect(r.state.edge).toBe(false);
    expect(r.edge).toBe(0);
  });

  it("let go short of its travel, it ends with no step", () => {
    const { s } = pull(IDLE, 1000, 3);
    expect(s.edge).toBe(true);
    expect(end(s, { ...both, ...head })).toEqual({ kind: "none" });
    expect(atRest(s)).toMatchObject({ phase: "idle", edge: false, lastT: s.lastT });
  });
});

describe("wheel — momentum adds at most one feed (2026-10-01, the trackpad pass)", () => {
  // A long swipe's fingers, then its fling: a decaying run of events.
  const fling = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => [Math.round(from * 0.85 ** i), 0] as [number, number]);

  it("momentum adds at most one feed", () => {
    expect(MOMENTUM_MAX_STEPS).toBe(1);
    // Fingers travel exactly one step (steady, so not momentum), then a fling
    // of about two steps' travel: uncapped it would flip two more feeds.
    const flingTravel = fling(100, 40).reduce((a, [dx]) => a + dx, 0);
    expect(flingTravel).toBeGreaterThan(2 * D);
    const { s, outs } = run([...Array(10).fill([30, 0]), ...fling(100, 40)]);
    expect(outs.filter((o) => o.commit)).toHaveLength(1 + MOMENTUM_MAX_STEPS);
    expect(outs.filter((o) => o.landed)).toHaveLength(1);
    // Spent where it landed: the tail is swallowed, and the end does nothing.
    expect(s.phase).toBe("spent");
    expect(outs.at(-1)!.claim).toBe(true);
    expect(end(s, both)).toEqual({ kind: "none" });
  });

  it("a swipe's own travel is not momentum", () => {
    // Steady finger travel of three whole steps flips three feeds.
    const { s, outs } = run(Array(30).fill([30, 0]));
    expect(outs.filter((o) => o.commit)).toHaveLength(3);
    expect(outs.some((o) => o.landed)).toBe(false);
    expect(s.phase).toBe("drag");
  });

  it("a new swipe out of a spent tail is a gesture of its own", () => {
    const flung = run([...Array(9).fill([30, 0]), ...fling(120, 12)]);
    expect(flung.s.phase).toBe("spent");
    const tail = flung.s.recent.at(-1)!;
    const next = wheel(
      flung.s,
      { dx: tail * 3 + 10, dy: 0, shift: false, t: 5000 },
      both,
    );
    expect(next).toMatchObject({ started: true, ended: { kind: "none" } });
    expect(next.state).toMatchObject({ phase: "drag", coasted: 0 });
  });
});
