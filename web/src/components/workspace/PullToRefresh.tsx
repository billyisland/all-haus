"use client";

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  type RefObject,
} from "react";

// Which way the feed scrolls. Vertical (⊔, open top): the mouth is the top, the
// gesture runs on scrollTop/clientY/deltaY and the indicator grows downward.
// Horizontal (⊐, open left): the mouth is the left, the gesture runs on
// scrollLeft/clientX/deltaX and the indicator grows rightward from the left edge.
// In both, "toward the mouth" is a POSITIVE touch delta (finger follows content
// back past the start) and a NEGATIVE wheel delta (scrolling before scroll-0).
type Axis = "vertical" | "horizontal";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
  axis?: Axis;
}

const THRESHOLD = 60;
const WHEEL_DECAY_MS = 400;
// How long the feed must rest at the mouth (no toward-mouth wheel events) before
// a fresh scroll toward it is treated as an intentional refresh gesture. This
// keeps the single continuous scroll-to-start that opens the first card's
// conversation from rolling straight into a refresh — the user must stop, then
// scroll toward the mouth again.
const ARM_IDLE_MS = 220;

function findScrollParent(el: HTMLElement, axis: Axis): HTMLElement {
  let cur = el.parentElement;
  while (cur) {
    const style = getComputedStyle(cur);
    const overflow = axis === "horizontal" ? style.overflowX : style.overflowY;
    if (overflow === "auto" || overflow === "scroll") return cur;
    cur = cur.parentElement;
  }
  return el;
}

// NOTE: a horizontal feed's scroller sets `overscroll-behavior-x: contain`
// (Vessel.tsx), so a toward-mouth scroll at the mouth no longer chains out to
// the floor pan or on to the browser's back gesture. That removes the ambiguity
// this component used to arbitrate with a `floorCanConsume` guard — which, kept,
// would now simply refuse to refresh whenever the floor happened to be panned.
// The arm-after-idle rule below is the whole guard: come to rest at the mouth,
// then scroll toward it again.

export function PullToRefresh({
  onRefresh,
  children,
  scrollRef,
  axis = "vertical",
}: PullToRefreshProps) {
  const horizontal = axis === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startPos = useRef(0);
  const active = useRef(false);
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refresh is "armed" only once the feed has settled at the mouth; until then,
  // toward-mouth wheel deltas are ignored so the scroll-to-start gesture itself
  // can't trigger a refresh.
  const armed = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The mouth-ward scroll offset (scrollLeft when horizontal, scrollTop else):
  // 0 means the feed is resting at the mouth, where a pull is allowed.
  const scrollOffsetOf = useCallback(
    (scroller: HTMLElement) =>
      horizontal ? scroller.scrollLeft : scroller.scrollTop,
    [horizontal],
  );

  const doRefresh = useCallback(() => {
    armed.current = false;
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setRefreshing(true);
    setPullDistance(THRESHOLD * 0.6);
    void onRefresh().finally(() => {
      setRefreshing(false);
      setPullDistance(0);
      setPulling(false);
    });
  }, [onRefresh]);

  // Touch handlers (mobile)
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el) return;
      const scroller = scrollRef?.current ?? findScrollParent(el, axis);
      if (scrollOffsetOf(scroller) > 0) return;
      const t = e.touches[0];
      startPos.current = horizontal ? t.clientX : t.clientY;
      active.current = true;
    },
    [refreshing, scrollRef, axis, horizontal, scrollOffsetOf],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!active.current || refreshing) return;
      const t = e.touches[0];
      const delta = (horizontal ? t.clientX : t.clientY) - startPos.current;
      if (delta <= 0) {
        setPullDistance(0);
        setPulling(false);
        return;
      }
      const dampened = Math.min(delta * 0.5, THRESHOLD * 1.5);
      setPullDistance(dampened);
      setPulling(dampened >= THRESHOLD);
    },
    [refreshing, horizontal],
  );

  const onTouchEnd = useCallback(() => {
    if (!active.current) return;
    active.current = false;

    if (pulling && !refreshing) {
      doRefresh();
    } else {
      setPullDistance(0);
      setPulling(false);
    }
  }, [pulling, refreshing, doRefresh]);

  // Wheel handler (desktop): accumulate toward-mouth scroll while at the mouth.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el) return;
      const scroller = scrollRef?.current ?? findScrollParent(el, axis);
      // Horizontal wheel: trackpads emit deltaX; a plain mouse wheel over an
      // overflow-x scroller emits deltaY that the browser applies horizontally —
      // accept either, preferring the axis-native one.
      const delta = horizontal ? e.deltaX || e.deltaY : e.deltaY;
      if (scrollOffsetOf(scroller) > 0 || delta >= 0) {
        // Scrolling through content or away from the mouth: disarm. Reaching the
        // mouth via this gesture must not count toward a refresh.
        wheelAccum.current = 0;
        armed.current = false;
        if (armTimer.current) {
          clearTimeout(armTimer.current);
          armTimer.current = null;
        }
        if (pullDistance > 0 && !refreshing) {
          setPullDistance(0);
          setPulling(false);
        }
        return;
      }
      // At the mouth, scrolling toward it. If not yet armed, this is (the tail
      // of) the gesture that brought us here — don't accumulate. Instead wait for
      // a quiet gap: a continuous gesture keeps resetting this timer, so it only
      // fires once the feed has come to rest, arming the next scroll toward.
      if (!armed.current) {
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => {
          armed.current = true;
          armTimer.current = null;
        }, ARM_IDLE_MS);
        return;
      }
      wheelAccum.current += Math.abs(delta);
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        wheelAccum.current = 0;
        if (!refreshing) {
          setPullDistance(0);
          setPulling(false);
        }
      }, WHEEL_DECAY_MS);

      const dampened = Math.min(wheelAccum.current * 0.4, THRESHOLD * 1.5);
      setPullDistance(dampened);
      if (dampened >= THRESHOLD) {
        wheelAccum.current = 0;
        if (wheelTimer.current) clearTimeout(wheelTimer.current);
        setPulling(false);
        doRefresh();
      } else {
        setPulling(dampened >= THRESHOLD * 0.8);
      }
    },
    [refreshing, pullDistance, doRefresh, scrollRef, axis, horizontal, scrollOffsetOf],
  );

  useEffect(() => {
    return () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, []);

  const label = refreshing
    ? "REFRESHING..."
    : pulling
      ? "RELEASE TO REFRESH"
      : horizontal
        ? "← PULL TO REFRESH"
        : "↑ PULL TO REFRESH";

  return (
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onWheel={onWheel}
      style={{
        position: "relative",
        // Horizontal: the indicator sits left of the card row and grows it
        // rightward, mirroring the vertical push-down.
        ...(horizontal
          ? { display: "flex", flexDirection: "row", alignItems: "stretch" }
          : {}),
      }}
    >
      {(pullDistance > 0 || refreshing) && (
        <div
          className="flex items-center justify-center"
          style={
            horizontal
              ? {
                  width: pullDistance,
                  flex: "0 0 auto",
                  overflow: "hidden",
                  transition: active.current ? "none" : "width 0.2s ease",
                }
              : {
                  height: pullDistance,
                  overflow: "hidden",
                  transition: active.current ? "none" : "height 0.2s ease",
                }
          }
        >
          <span
            className="label-ui text-grey-400"
            style={
              horizontal
                ? { writingMode: "vertical-rl", whiteSpace: "nowrap" }
                : undefined
            }
          >
            {label}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
