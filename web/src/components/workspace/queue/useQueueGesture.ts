"use client";

import { useEffect, useRef, type RefObject } from "react";
import { animate, type AnimationPlaybackControls, type MotionValue } from "framer-motion";
import {
  GESTURE_END_MS,
  GESTURE_END_MS_REDUCED,
  IDLE,
  atRest,
  axes,
  end,
  progress,
  wheel,
  type EndOutcome,
  type GestureState,
} from "../../../lib/workspace/queueGesture";
import { QUEUE_EASE, QUEUE_MOTION_MS } from "../tokens";

// The queue's sideways drag, the DOM half (WORKSPACE-QUEUE-ADR §VI.4,
// §VII.6). What each wheel event MEANS is `lib/workspace/queueGesture.ts`;
// this listens, claims, keeps the end timer and plays the settle.
//
// WHEEL OWNERSHIP. The listener sits on the queue's container in the CAPTURE
// phase and is not passive, so an event the gesture claims is stopped before
// it reaches its target — and so before React's delegated `onWheel` on the
// focal feed's `PullToRefresh`, which listens at the root in the bubble phase.
// A vertical event is not ours, and neither is a sideways one over something
// that itself scrolls sideways that way (a `<pre>` in an external note).
//
// NOTHING RENDERS DURING A DRAG. Progress goes to one `MotionValue`, `u`, and
// the styles bound to it (`queueBinding.ts`) follow synchronously. React
// hears about a gesture twice: `onBusy(true)` when it starts, `onBusy(false)`
// when it has settled. A commit is the caller's `commit(dir)`, which resets
// `u` and applies the step in one task.
//
// THE EDGE PULL has its own number, `edge` (0..1), which the indicator at the
// queue's left edge is bound to; reaching 1 is `onEdgePull()`, which owns the
// strip from there (it says what the pull found, then goes).
//
// THE LANDING IS SAID AS SOON AS IT IS KNOWN (the operator's trackpad pass,
// 2026-10-01, g3): `onLanding(dir)` names the feed the gesture will rest on —
// `dir` steps from focal — when the quiet decides it (before the settle
// plays, not after) or when momentum's cap spends the gesture. A feed a long
// swipe flipped onto is a wash with no cards, and waiting for the settle's
// end left its preview rows standing half a second too long.
//
// A SETTLE IS INTERRUPTIBLE. A new drag that starts while the last one is
// still completing or springing back finishes it at once — completes the
// step, or lands at rest — and starts from 0.

export interface QueueGestureOptions {
  u: MotionValue<number>;
  /** The edge pull's progress, 0..1. */
  edge: MotionValue<number>;
  /** The edge pull reached its travel: refresh every feed. */
  onEdgePull: () => void;
  /** Travel for one step, px. */
  D: number;
  reduced: boolean;
  /** `from`: see `GestureOptions.canStep`. */
  canStep: (dir: 1 | -1, from?: 1 | -1) => boolean;
  /** The gesture will rest `dir` steps from focal: draw that feed now. */
  onLanding: (dir: 0 | 1 | -1) => void;
  /** Apply one step now; the caller resets `u` in the same task. */
  commit: (dir: 1 | -1) => void;
  /** A walk is playing, or the queue is not shown yet: sideways events are
   *  claimed and ignored. */
  locked: () => boolean;
  /** Called as a drag starts: disarm any pull (§VI.4). */
  onStart: () => void;
  /** True from the first claimed event until the settle has ended (§VII.6's
   *  `gestureInProgress`). */
  onBusy: (busy: boolean) => void;
}

/** Whether something between the target and the queue scrolls sideways in
 *  the direction of travel, and so owns this event. */
function scrollsSideways(target: EventTarget | null, root: HTMLElement, dx: number) {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || el.scrollWidth <= el.clientWidth) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    if (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    if (dx < 0 && el.scrollLeft > 0) return true;
  }
  return false;
}

export function useQueueGesture(
  containerRef: RefObject<HTMLElement>,
  opts: QueueGestureOptions,
) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let state: GestureState = IDLE;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busy = false;
    // The settle in flight, and what finishing it means.
    let settling: { controls: AnimationPlaybackControls; target: 0 | 1 | -1 } | null =
      null;

    const setBusy = (b: boolean) => {
      if (b === busy) return;
      busy = b;
      optsRef.current.onBusy(b);
    };

    /** Finish a settle now: the step it was completing commits; a spring
     *  back lands at rest. */
    const finishSettle = () => {
      if (!settling) return;
      const { controls, target } = settling;
      settling = null;
      controls.stop();
      if (target === 0) optsRef.current.u.jump(0);
      else optsRef.current.commit(target);
    };

    const settle = (out: EndOutcome) => {
      const o = optsRef.current;
      if (out.kind === "none") {
        o.u.jump(0);
        setBusy(false);
        return;
      }
      // Never reduced: `end` answers "none" under reduced motion, where every
      // step committed as it happened.
      const target: 0 | 1 | -1 = out.kind === "complete" ? out.dir : 0;
      const controls = animate(o.u, target, {
        duration: QUEUE_MOTION_MS / 1000,
        ease: QUEUE_EASE,
      });
      const mine = { controls, target };
      settling = mine;
      void controls.then(() => {
        // Superseded by a new drag, which finished it itself.
        if (settling !== mine) return;
        settling = null;
        if (target !== 0) optsRef.current.commit(target);
        setBusy(false);
      });
    };

    const onQuiet = () => {
      timer = null;
      const o = optsRef.current;
      const out = end(state, o);
      // An edge pull let go short of its travel springs back. Nothing need
      // hold on to the animation: `animate` registers it on the value, so the
      // next gesture's `stop()` or `jump()` ends it.
      if (state.edge && state.phase === "drag" && o.edge.get() !== 0) {
        if (o.reduced) o.edge.jump(0);
        else void animate(o.edge, 0, { duration: 0.2, ease: QUEUE_EASE });
      }
      // An edge pull that fired is already over: `r.pull` set busy false, so
      // a walk may have started in its momentum tail, and the settle's
      // `u.jump(0)` would stop that walk's animation — which snaps it.
      const pulled = state.edge && state.phase === "spent";
      state = atRest(state);
      if (pulled) return;
      if (!o.reduced) o.onLanding(out.kind === "complete" ? out.dir : 0);
      settle(out);
    };

    function onWheel(e: WheelEvent) {
      const o = optsRef.current;
      const scale =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root!.clientWidth : 1;
      const ev = { dx: e.deltaX * scale, dy: e.deltaY * scale, shift: e.shiftKey, t: e.timeStamp };

      if (o.locked()) {
        const { dx, dy } = axes(ev);
        if (Math.abs(dx) > Math.abs(dy)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // The walk up the tree reads layout, so it is paid only where the
      // answer matters: an idle, sideways-dominant event (`wheel` passes
      // every vertical one to the list regardless).
      const { dx, dy } = axes(ev);
      const exempt =
        state.phase === "idle" &&
        Math.abs(dx) > Math.abs(dy) &&
        scrollsSideways(e.target, root!, dx);
      const r = wheel(state, ev, { D: o.D, reduced: o.reduced, canStep: o.canStep, exempt });
      state = r.state;
      if (!r.claim) {
        if (r.guard) e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      if (r.ended) {
        // A new swipe rose out of the last one's tail: that gesture is over
        // now, not in 110ms, and without a settle animation to wait for.
        if (r.ended.kind === "complete") o.commit(r.ended.dir);
      }
      if (r.started) {
        finishSettle();
        // Whatever still animates the strip (a spring-back, the edge pull's
        // line) is over: an edge drag drives it from this event, and anything
        // else closes it. A bare `stop()` on an ordinary swipe would freeze it
        // part-open; `set()` stops nothing, so a drag over a running spring
        // was overwritten every frame.
        if (state.edge) o.edge.stop();
        else o.edge.jump(0);
        setBusy(true);
        o.onStart();
      }
      if (r.commit) {
        o.commit(r.commit);
        // The carry into the next feed, read against the focal just committed.
        const carry = progress(state.acc, o).u;
        if (carry !== 0) o.u.set(carry);
      } else o.u.set(r.u);
      if (r.landed) o.onLanding(0);
      if (r.edge !== undefined) o.edge.set(r.edge);
      if (r.pull) {
        // The rest of the gesture is swallowed, but the queue is no longer
        // moving: the sort the pull asks for must not wait out its momentum.
        setBusy(false);
        o.onEdgePull();
      }

      if (r.counted) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onQuiet, o.reduced ? GESTURE_END_MS_REDUCED : GESTURE_END_MS);
      }
    }

    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      root.removeEventListener("wheel", onWheel, { capture: true });
      if (timer) clearTimeout(timer);
      settling?.controls.stop();
      settling = null;
      if (busy) optsRef.current.onBusy(false);
    };
  }, [containerRef]);
}
