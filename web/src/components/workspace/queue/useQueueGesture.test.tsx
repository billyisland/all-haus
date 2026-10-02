// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
// Framer's frame loop takes `requestAnimationFrame` when it is imported, so
// the clock is faked before any import, for the whole file.
vi.hoisted(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
    ],
  });
});
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { animate, motionValue, type MotionValue } from "framer-motion";
import { useQueueGesture, type QueueGestureOptions } from "./useQueueGesture";
import { EDGE_ARM_IDLE_MS, EDGE_PULL_PX, GESTURE_END_MS } from "../../../lib/workspace/queueGesture";

// The DOM half of the queue's gesture (WORKSPACE-QUEUE-ADR §VI.4, §VII.6):
// what it does to the two motion values once the pure half has spoken. Audit
// 2026-09-27, (11) and (12). Framer's frame loop runs on the faked clock, so
// a spring's frames are driven here by advancing it — ASYNC, because framer
// caches "now" until a microtask clears it, and a sync advance leaves every
// animation started from a stale clock, so it completes on its first frame.
// Every case checks the animation MOVED, or a stalled loop would pass it
// vacuously (mutation 1 did, before the async advance).
//
// MUTATION LOG (each applied to useQueueGesture.ts, the suite re-run, reverted):
//   1. the `o.edge.stop()` at a gesture's start removed ⇒ "an edge drag over
//      the spring-back is not overwritten" fails.                 DETECTED
//   2. the `o.edge.jump(0)` removed ⇒ "an ordinary swipe closes the strip"
//      fails.                                                     DETECTED
//   3. the `pulled` skip removed from `onQuiet` ⇒ "a walk started in an edge
//      pull's tail is not snapped" fails.                         DETECTED
//   4. the sideways-dominant gate removed from `exempt` (audit (8)) ⇒ "a
//      vertical wheel reads no layout" fails.                     DETECTED

let root: Root;
let host: HTMLDivElement;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Rig {
  u: MotionValue<number>;
  edge: MotionValue<number>;
  el: HTMLDivElement;
  pulls: number;
}

function mount(canStep: QueueGestureOptions["canStep"]): Rig {
  const rig = { u: motionValue(0), edge: motionValue(0), pulls: 0 } as Rig;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useQueueGesture(ref, {
      u: rig.u,
      edge: rig.edge,
      onEdgePull: () => {
        rig.pulls++;
      },
      D: 300,
      reduced: false,
      canStep,
      commit: () => rig.u.jump(0),
      onLanding: () => {},
      locked: () => false,
      onStart: () => {},
      onBusy: () => {},
    });
    return (
      <div ref={ref} data-testid="q">
        <div data-testid="c" />
      </div>
    );
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
  rig.el = host.querySelector("[data-testid=q]") as HTMLDivElement;
  return rig;
}

/** One wheel event, at the faked clock (jsdom stamps `timeStamp` off it). */
function wheel(rig: Rig, dx: number) {
  rig.el.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, bubbles: true, cancelable: true }));
}

const atHead = (dir: 1 | -1) => dir === 1;

describe("useQueueGesture — the edge strip", () => {
  it("an edge drag over the spring-back is not overwritten", async () => {
    const rig = mount(atHead);
    await vi.advanceTimersByTimeAsync(EDGE_ARM_IDLE_MS + 10);
    // An edge drag let go short: 0.4 of its travel, then quiet.
    wheel(rig, -0.2 * EDGE_PULL_PX);
    wheel(rig, -0.2 * EDGE_PULL_PX);
    expect(rig.edge.get()).toBeCloseTo(0.4);
    // The spring-back starts at GESTURE_END_MS; a new edge pull arms only
    // after EDGE_ARM_IDLE_MS of quiet, inside the spring's 200ms.
    await vi.advanceTimersByTimeAsync(EDGE_ARM_IDLE_MS + 10);
    expect(rig.edge.isAnimating()).toBe(true);
    expect(rig.edge.get()).toBeLessThan(0.4);
    wheel(rig, -0.2 * EDGE_PULL_PX);
    const shown = rig.edge.get();
    expect(shown).toBeCloseTo(0.2);
    await vi.advanceTimersByTimeAsync(48);
    expect(rig.edge.get()).toBeCloseTo(shown);
  });

  it("an ordinary swipe closes the strip", async () => {
    const rig = mount(() => true);
    // The edge pull's line, holding the strip open.
    void animate(rig.edge, 0.6, { duration: 0.15 });
    await vi.advanceTimersByTimeAsync(40);
    expect(rig.edge.get()).toBeGreaterThan(0);
    wheel(rig, 30);
    expect(rig.edge.get()).toBe(0);
    expect(rig.edge.isAnimating()).toBe(false);
  });
});

describe("useQueueGesture — after an edge pull", () => {
  it("a walk started in the pull's tail is not snapped", async () => {
    const rig = mount(atHead);
    await vi.advanceTimersByTimeAsync(EDGE_ARM_IDLE_MS + 10);
    for (let i = 0; i < 6; i++) wheel(rig, -30);
    expect(rig.pulls).toBe(1);
    // The pull set busy false: a key starts a walk, which animates `u`.
    void animate(rig.u, 1, { duration: 1 });
    await vi.advanceTimersByTimeAsync(GESTURE_END_MS + 20);
    expect(rig.u.isAnimating()).toBe(true);
    expect(rig.u.get()).toBeGreaterThan(0);
  });
});

describe("useQueueGesture — what a wheel event costs", () => {
  it("a vertical wheel reads no layout; a sideways one asks if it scrolls", () => {
    mount(() => true);
    const child = host.querySelector("[data-testid=c]") as HTMLDivElement;
    let reads = 0;
    Object.defineProperty(child, "scrollWidth", {
      configurable: true,
      get: () => {
        reads++;
        return 0;
      },
    });
    for (let i = 0; i < 5; i++)
      child.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 40, deltaX: 2, bubbles: true, cancelable: true }),
      );
    expect(reads).toBe(0);
    child.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 40, bubbles: true, cancelable: true }),
    );
    expect(reads).toBe(1);
  });
});
