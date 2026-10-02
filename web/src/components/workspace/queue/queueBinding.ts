"use client";

import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import type { MotionValue } from "framer-motion";

// The queue's one moving number, and the binding every moving style hangs off
// (WORKSPACE-QUEUE-ADR §VII.6: "every width and opacity is a transform of
// it; no React state changes during a drag").
//
// WRITTEN BY HAND, SYNCHRONOUSLY, NOT THROUGH `motion.*` OR `useTransform`.
// Both of framer's paths batch to the next animation frame, and a commit
// needs the opposite: it resets `u` to 0 and swaps every entry's place in ONE
// task (`u.jump(0)` then a `flushSync`), so the browser paints only the state
// after. A batched write lands a frame late — one frame of the OLD places at
// rest, the new focal flashing back to where it came from. `MotionValue`'s own
// change event is synchronous, so a binding here writes the style in the same
// call stack as the change, and re-binds in a layout effect after every
// render, before paint.
//
// Outside the queue there is no provider and a binding does nothing, so the
// floor's shared chassis renders exactly what it rendered before.

export const QueueMotionContext = createContext<MotionValue<number> | null>(null);

export type QueueBinding = (u: number) => number;

/** Bind `el.style[prop]` to `at(u)`. Re-binds after every render (the
 *  functions are rebuilt with each render's places); a render never happens
 *  mid-drag, so the cost is paid at rest. */
export function useQueueBinding(
  ref: RefObject<HTMLElement | null>,
  prop: "width" | "opacity",
  at: QueueBinding | undefined,
) {
  const u = useContext(QueueMotionContext);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !u || !at) return;
    // Most places are constant over most of `u` (an entry two or more steps
    // from focal does not move), so an unchanged value is not written again.
    let last: string | null = null;
    const apply = (v: number) => {
      const next = prop === "width" ? `${at(v)}px` : String(at(v));
      if (next === last) return;
      last = next;
      el.style[prop] = next;
    };
    apply(u.get());
    const off = u.on("change", apply);
    return () => {
      off();
      // The next binding (or React) states it afresh in the same commit.
      el.style[prop] = "";
    };
  });
}
