// The queue's sideways gesture, as a pure function of wheel events
// (WORKSPACE-QUEUE-ADR §VI.4, §VII.6). `useQueueGesture` is the DOM half: it
// listens, owns the end timer and the settle animation, and asks this what
// each event means. Nothing here reads the DOM or the clock; an event carries
// its own timestamp.
//
// A GESTURE FLIPS THROUGH AS MANY FEEDS AS IT TRAVELS (the operator,
// 2026-09-23, amending §VI.4's one step per gesture). Progress `u = acc / D`
// tracks the trackpad continuously; when `|u|` reaches 1 the step commits at
// once and the travel past it CARRIES into the next feed (`acc − dir·D`), so a
// long swipe — momentum tail included — keeps flipping, one feed per `D`, and
// the release snaps to the nearest feed. At most one step commits per event:
// the carry is held under a whole step, and the next event commits the next.
// With no step available in the direction of travel, the displayed value is
// `u × 0.15` and nothing commits (resistance); the travel banked against a
// wall is capped at one step, so a reversal is not spent unwinding it.
//
// A GESTURE ENDS after a quiet interval — browsers expose no trackpad phase —
// and at the end `0.3 < |u| < 1` completes the step and anything less springs
// back: a short deliberate swipe needs only a third of the way to count. But
// once a gesture has flipped a feed, what is left over is the tail of a long
// swipe, not an intention, and 0.3 made it roll on into a feed it had barely
// entered (the operator: "a Roulette-wheel sense of things not always landing
// quite where it looks like they're going"). So a gesture that has stepped
// lands on the NEARER feed, at 0.5.
//
// MOMENTUM ADDS AT MOST ONE FEED (the operator's trackpad pass, 2026-10-01:
// Chrome's fling overshot). Once the run is FALLING — the shape of momentum,
// as below — a commit is counted as momentum's, and after
// `MOMENTUM_MAX_STEPS` of them the gesture is spent: the rest of the tail is
// swallowed and it lands where it is, at once (`landed`), so the caller can
// draw that feed's cards while the tail is still arriving.
//
// THE FIRST SIDEWAYS EVENT IS GUARDED (the same pass, g9: Firefox and
// WebKitGTK swiped back a page). A browser decides its history swipe from
// the first events of a scroll, and a probe that passed them through let it.
// So a sideways run's events are default-prevented (`guard`) from the first,
// though NOT stopped: the pull and the list still hear them. Never a jitter
// pixel (`GUARD_MIN_PX`), never inside a vertical scroll's gesture, never
// over something that scrolls sideways itself.
//
// A NEW GESTURE inside a momentum tail is told apart by shape: momentum
// decays monotonically and a fresh swipe does not, so a rise of more than 50%
// after three falling events starts a new one. Without that, a quick second
// swipe is eaten as the first one's tail.
//
// A DRAG IS EARNED, NEVER ASSUMED (the operator, 2026-09-26: pulling a queue
// feed's top was "hard, though not impossible"). A trackpad's first events of
// a vertical pull often carry a pixel of sideways travel — (−1, 0) — and a
// drag that started on the first event with `|dx| > |dy|` cancelled the armed
// pull and swallowed the rest of it as mid-drag noise. So before a drag, the
// sideways events are PROBED, unclaimed: a drag starts only once the run of
// them has travelled `START_PX` (decisively so inside a vertical scroll), and
// any vertical-ish event ends the run. What was probed counts toward the
// drag, so a swipe loses nothing by it; what passed through went to the list
// and its pull exactly as it does on the floor.
//
// THE EDGE PULL (the operator, 2026-09-26): the feed's pull turned on its
// side. At the head of the queue, with nothing to step back to, a sideways
// gesture TOWARD the head refreshes every feed and ranks the queue again —
// but only a gesture that began there after a rest (`EDGE_ARM_IDLE_MS`, the
// feed pull's own arming rule), never the tail of the swipe that arrived. It
// fires once, at `EDGE_PULL_PX` of travel (the feed pull's travel), mid-
// gesture as the feed pull does, and the rest of the gesture is spent.
//
// REDUCED MOTION shows no progress at all: a step is discrete, at 90px of
// accumulated travel, and the tail is swallowed until a longer quiet — so it
// keeps ONE step per gesture (`spent`). Chained instant jumps with no motion
// between them would be a flick that teleports an unknown distance.

export interface GestureEvent {
  /** Pixels (the caller has already scaled line and page deltas). */
  dx: number;
  dy: number;
  shift: boolean;
  /** `event.timeStamp`, ms. */
  t: number;
}

export type GesturePhase = "idle" | "drag" | "spent";

/** Sideways travel seen before a drag, not yet claimed. */
export interface Probe {
  /** Signed. */
  dx: number;
  /** Summed magnitudes. */
  ax: number;
  ay: number;
  /** The last event in the run. */
  t: number;
  /** How long the queue had been quiet when the run began, ms. */
  quiet: number;
}

export interface GestureState {
  readonly phase: GesturePhase;
  /** Counted travel this gesture, px. */
  readonly acc: number;
  /** `|dx|` of the last few counted events, newest last. */
  readonly recent: readonly number[];
  /** When the last event this gesture did NOT claim was a vertical scroll. */
  readonly verticalAt: number;
  /** This gesture has committed a step, so its end snaps to the NEAREST feed. */
  readonly stepped: boolean;
  /** This gesture is an edge pull, not a drag. */
  readonly edge: boolean;
  /** The sideways run before a drag, or null. */
  readonly probe: Probe | null;
  /** The last wheel event the queue saw, of any kind. */
  readonly lastT: number;
  /** Steps this gesture committed while its run was falling (momentum). */
  readonly coasted: number;
}

export const IDLE: GestureState = {
  phase: "idle",
  acc: 0,
  recent: [],
  verticalAt: -Infinity,
  stepped: false,
  edge: false,
  probe: null,
  lastT: -Infinity,
  coasted: 0,
};

/** A gesture is over: back to idle, keeping what outlives a gesture. */
export function atRest(s: GestureState): GestureState {
  return { ...IDLE, verticalAt: s.verticalAt, lastT: s.lastT };
}

export interface GestureOptions {
  /** Travel for one whole step: `QUEUE_STEP_RATIO × FW`. */
  D: number;
  reduced: boolean;
  /** Whether a step that way exists (`step(q, dir) !== q`) — from the
   *  feed `from` steps away from focal, where given. Only a new gesture's
   *  first event asks from elsewhere: the one it interrupted completes a
   *  step the caller has not committed yet. */
  canStep: (dir: 1 | -1, from?: 1 | -1) => boolean;
  /** The event's target scrolls sideways in its direction of travel (a
   *  `<pre>` in an external note), so it is not ours. Asked only before a
   *  drag: once one is under way, every horizontal event is the queue's. */
  exempt: boolean;
}

export type EndOutcome =
  | { kind: "none" }
  | { kind: "spring" }
  | { kind: "complete"; dir: 1 | -1 };

export interface WheelOutcome {
  state: GestureState;
  /** `preventDefault()` + `stopPropagation()`. */
  claim: boolean;
  /** Unclaimed, but `preventDefault()` alone: a sideways event the queue has
   *  not taken yet, kept from the browser's history swipe. */
  guard?: true;
  /** The gesture has just decided where it lands: on the current focal. Its
   *  cards can be drawn now, while the swallowed tail still arrives. */
  landed?: true;
  /** Counted toward the gesture, so it restarts the end timer. Noise that is
   *  claimed but not counted does not, or a vertical scroll straight after a
   *  drag would be swallowed for as long as it lasted. */
  counted: boolean;
  /** A gesture began with this event. */
  started: boolean;
  /** The gesture this event interrupted, when it began a new one. */
  ended?: EndOutcome;
  /** The progress to display. After a commit it is 0, and the caller shows
   *  the carry against the NEW focal (`progress(state.acc, …)`), because
   *  only it can say whether a step beyond that exists. */
  u: number;
  /** A step to commit now. */
  commit?: 1 | -1;
  /** An edge pull's progress to display, 0..1 — 0 as a drag leaves one —
   *  and absent where there is nothing to say. */
  edge?: number;
  /** The edge pull reached its travel: refresh every feed, now. */
  pull?: true;
}

/** Quiet before a gesture is over, ms. */
export const GESTURE_END_MS = 110;
export const GESTURE_END_MS_REDUCED = 240;
/** Reduced motion: travel for one discrete step, px. */
export const REDUCED_STEP_PX = 90;
/** At a gesture's end, past this share of a step it completes… */
export const COMMIT_AT = 0.3;
/** …unless it has already flipped a feed, when it lands on the nearer one. */
export const SNAP_NEAREST = 0.5;
/** With nothing that way, the drag shows this share of itself. */
export const RESISTANCE = 0.15;
/** Sideways travel a run must make before it is a drag, px. */
export const START_PX = 8;
/** An edge pull arms only after this long at rest (PullToRefresh's
 *  ARM_IDLE_MS). */
export const EDGE_ARM_IDLE_MS = 220;
/** An edge pull's travel (PullToRefresh's wheel: THRESHOLD 60 at 0.4). */
export const EDGE_PULL_PX = 150;
/** A new gesture inside a tail must rise by this factor over the last event… */
export const NEW_GESTURE_RISE = 1.5;
/** …after this many falling events… */
export const NEW_GESTURE_FALLS = 3;
/** …and by at least this much. A tail's last few events jitter by a pixel or
 *  two (5, 3, 1, 2), and a 1 → 2 rise is not a swipe. */
export const NEW_GESTURE_MIN_DX = 4;

/** Steps momentum may commit before the gesture is spent. */
export const MOMENTUM_MAX_STEPS = 1;
/** A sideways event this small is a pull's jitter, never guarded. */
export const GUARD_MIN_PX = 2;

const RECENT = NEW_GESTURE_FALLS + 1;

/** Shift with no `dx` turns a mouse wheel sideways (§VII.6). */
export function axes(ev: GestureEvent): { dx: number; dy: number } {
  return ev.shift && ev.dx === 0 ? { dx: ev.dy, dy: 0 } : { dx: ev.dx, dy: ev.dy };
}

const sign = (v: number): 1 | -1 => (v < 0 ? -1 : 1);
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

function push(recent: readonly number[], a: number): number[] {
  const r = [...recent, a];
  return r.length > RECENT ? r.slice(r.length - RECENT) : r;
}

/** The last `NEW_GESTURE_FALLS` events fall, each below the one before: the
 *  shape of momentum. */
export function isFalling(recent: readonly number[]): boolean {
  const n = recent.length;
  if (n < NEW_GESTURE_FALLS) return false;
  for (let i = n - NEW_GESTURE_FALLS + 1; i < n; i++) {
    if (!(recent[i] < recent[i - 1])) return false;
  }
  return true;
}

/** Momentum decays monotonically; a fresh swipe rises out of it. */
export function isNewGesture(recent: readonly number[], a: number): boolean {
  if (!isFalling(recent)) return false;
  const last = recent[recent.length - 1];
  return a > NEW_GESTURE_RISE * last && a - last >= NEW_GESTURE_MIN_DX;
}

/** What `acc` px of travel shows, and whether it has earned a step. */
export function progress(
  acc: number,
  o: Pick<GestureOptions, "D" | "reduced" | "canStep">,
): { u: number; commit?: 1 | -1 } {
  if (acc === 0) return { u: 0 };
  const dir = sign(acc);
  if (o.reduced) {
    return Math.abs(acc) >= REDUCED_STEP_PX && o.canStep(dir)
      ? { u: 0, commit: dir }
      : { u: 0 };
  }
  const raw = acc / o.D;
  if (!o.canStep(dir)) return { u: clamp1(raw) * RESISTANCE };
  if (Math.abs(raw) >= 1) return { u: 0, commit: dir };
  return { u: raw };
}

/** The carry after a commit stays under a whole step, so one event commits
 *  at most one step. */
const CARRY_MAX = 0.99;

function advance(
  s: GestureState,
  dx: number,
  o: GestureOptions,
  started: boolean,
): WheelOutcome {
  if (s.edge && s.acc + dx < 0) {
    const acc = Math.max(s.acc + dx, -EDGE_PULL_PX);
    const recent = push(s.recent, Math.abs(dx));
    const pull = acc <= -EDGE_PULL_PX;
    return {
      state: { ...s, phase: pull ? "spent" : "drag", acc, recent },
      claim: true,
      counted: true,
      started,
      u: 0,
      edge: pull ? 0 : -acc / EDGE_PULL_PX,
      ...(pull ? { pull: true as const } : {}),
    };
  }
  // Turned back from the edge: an ordinary drag from here, and the strip
  // closes — nothing else will ever write `edge` for this gesture.
  const closeEdge = s.edge;
  if (s.edge) s = { ...s, edge: false };
  let acc = s.acc + dx;
  const recent = push(s.recent, Math.abs(dx));
  const p = progress(acc, o);
  if (p.commit && !o.reduced) {
    // Chain: what travelled past the step belongs to the next feed.
    acc -= p.commit * o.D;
    if (Math.abs(acc) > CARRY_MAX * o.D) acc = sign(acc) * CARRY_MAX * o.D;
  } else if (!p.commit && acc !== 0 && !o.canStep(sign(acc))) {
    // Against a wall: bank no more than one step.
    acc = sign(acc) * Math.min(Math.abs(acc), o.D);
  }
  // Momentum's step: counted, and the last it may take spends the gesture
  // where it lands.
  const coasted =
    s.coasted + (p.commit && !o.reduced && isFalling(recent) ? 1 : 0);
  const capped = coasted > s.coasted && coasted >= MOMENTUM_MAX_STEPS;
  if (capped) acc = 0;
  const phase = (p.commit && o.reduced) || capped ? "spent" : "drag";
  return {
    state: {
      ...s,
      phase,
      acc,
      recent,
      stepped: s.stepped || p.commit !== undefined,
      coasted,
    },
    claim: true,
    counted: true,
    started,
    u: p.u,
    commit: p.commit,
    ...(capped ? { landed: true as const } : {}),
    ...(closeEdge ? { edge: 0 } : {}),
  };
}

/** One wheel event. */
export function wheel(
  s: GestureState,
  ev: GestureEvent,
  o: GestureOptions,
): WheelOutcome {
  const { dx, dy } = axes(ev);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  const lastT = s.lastT;
  s = { ...s, lastT: ev.t };

  if (s.phase === "idle") {
    const pass = (state: GestureState, guard = false): WheelOutcome => ({
      state,
      claim: false,
      counted: false,
      started: false,
      u: 0,
      ...(guard ? { guard: true as const } : {}),
    });
    // A vertical-ish event is the list's, and ends any sideways run.
    if (ax <= ay || o.exempt) {
      return pass({ ...s, probe: null, verticalAt: ay > 0 ? ev.t : s.verticalAt });
    }
    // A sideways event joins the run, or starts one after a pause.
    const prev = s.probe && ev.t - s.probe.t < GESTURE_END_MS ? s.probe : null;
    const probe: Probe = {
      dx: (prev?.dx ?? 0) + dx,
      ax: (prev?.ax ?? 0) + ax,
      ay: (prev?.ay ?? 0) + ay,
      t: ev.t,
      quiet: prev ? prev.quiet : ev.t - lastT,
    };
    // Inside a vertical scroll's own gesture it must be decisively sideways,
    // or one diagonal event in a vertical flick would start a drag and freeze
    // the scroll under it.
    const midVertical = ev.t - s.verticalAt < GESTURE_END_MS;
    if (probe.ax < START_PX || (midVertical && probe.ax <= 2 * probe.ay)) {
      return pass({ ...s, probe }, !midVertical && ax >= GUARD_MIN_PX);
    }
    const edge =
      probe.dx < 0 && !o.canStep(-1) && probe.quiet >= EDGE_ARM_IDLE_MS;
    return advance(
      { ...atRest(s), edge },
      probe.dx,
      o,
      true,
    );
  }

  // Mid-gesture noise is swallowed, not passed through: the focal list must
  // not jitter vertically under a sideways drag, and a pull must not arm.
  if (ax < 0.5 * ay) {
    return {
      state: s,
      claim: true,
      counted: false,
      started: false,
      u: s.phase === "drag" && !s.edge ? progress(s.acc, o).u : 0,
      ...(s.edge && s.phase === "drag" ? { edge: -s.acc / EDGE_PULL_PX } : {}),
    };
  }

  if (!o.reduced && isNewGesture(s.recent, ax)) {
    const ended = end(s, o);
    // The caller commits `ended` before it applies this event, so the event
    // is judged from where that leaves focal. Against the old one, one
    // event ran unresisted at a wall, or banked against one that was not
    // there, and the next corrected it.
    const from = ended.kind === "complete" ? ended.dir : undefined;
    const next = advance(
      atRest(s),
      dx,
      from ? { ...o, canStep: (dir) => o.canStep(dir, from) } : o,
      true,
    );
    // An edge drag it interrupted closes its strip.
    return s.edge && s.phase === "drag" ? { ...next, ended, edge: 0 } : { ...next, ended };
  }

  if (s.phase === "spent") {
    return {
      state: { ...s, recent: push(s.recent, ax) },
      claim: true,
      counted: true,
      started: false,
      u: 0,
    };
  }
  return advance(s, dx, o, false);
}

/** The gesture went quiet (or a new one interrupted it). */
export function end(
  s: GestureState,
  o: Pick<GestureOptions, "D" | "reduced" | "canStep">,
): EndOutcome {
  if (s.phase !== "drag" || s.edge || o.reduced || s.acc === 0) return { kind: "none" };
  const dir = sign(s.acc);
  if (o.canStep(dir) && Math.abs(s.acc / o.D) > (s.stepped ? SNAP_NEAREST : COMMIT_AT)) {
    return { kind: "complete", dir };
  }
  return progress(s.acc, o).u === 0 ? { kind: "none" } : { kind: "spring" };
}
