"use client";

import React, {
  forwardRef,
  useImperativeHandle,
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

/** What a refresh found, said in the mouth once it has RESOLVED — never while
 *  it is in flight, which is the feed's own waiting state (WORKSPACE-QUEUE-ADR
 *  §VI.5, §VII.9). This is a result, not a wait, which is the only reason it
 *  is not the withdrawn in-flight label come back. */
export interface RefreshResult {
  message?: string;
  /** How long the line stays, ms. */
  holdMs?: number;
}

interface PullToRefreshProps {
  onRefresh: () => Promise<RefreshResult | void>;
  children: ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
  axis?: Axis;
  /** The result line's colour — the feed palette's `cardMeta`. */
  messageColor?: string;
}

const THRESHOLD = 60;
// The mouth's result line stands as tall as the old in-flight label did.
const MESSAGE_H = THRESHOLD * 0.6;
const MESSAGE_HOLD_MS = 1200;
const WHEEL_DECAY_MS = 400;
// How long the feed must rest at the mouth (no toward-mouth wheel events) before
// a fresh scroll toward it is treated as an intentional refresh gesture. This
// keeps the single continuous scroll-to-start that opens the first card's
// conversation from rolling straight into a refresh — the user must stop, then
// scroll toward the mouth again.
const ARM_IDLE_MS = 220;
// How long an armed feed stays armed with no toward-mouth pull. Arming used to
// be sticky: a feed scrolled to its top and left there was armed for the rest
// of the session, and the idle rule above did nothing for it. On the columnar
// floor a trackpad gesture's sideways component pans the floor under a
// stationary pointer, so a NEIGHBOURING vessel could slide under the cursor
// mid-pull, already armed from minutes ago, and refresh off the tail of a
// gesture aimed at the vessel beside it. Past this window the pull has to be
// earned again — rest at the mouth, then pull — so a feed you have not touched
// in a while behaves like one you have just scrolled to.
const ARM_TTL_MS = 4000;

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
// The arm-after-idle rule below is the guard: come to rest at the mouth, then
// scroll toward it again — and the arm it grants is held only while the pointer
// stays on this feed and only for ARM_TTL_MS, so it cannot outlive the gesture
// that earned it.

/** Disarm and withdraw a pull in progress. The queue's sideways drag calls it
 *  as it starts (WORKSPACE-QUEUE-ADR §VI.4): an arm earned just before the
 *  drag must not outlive it, and a half-open indicator must not ride along
 *  under the reader's fingers. A refresh already in flight is not cancelled —
 *  it was asked for. */
export interface PullToRefreshHandle {
  cancel: () => void;
}

export const PullToRefresh = forwardRef<PullToRefreshHandle, PullToRefreshProps>(
  function PullToRefresh(
    { onRefresh, children, scrollRef, axis = "vertical", messageColor },
    ref,
  ) {
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
    const armExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const alive = useRef(true);

    // The mouth-ward scroll offset (scrollLeft when horizontal, scrollTop else):
    // 0 means the feed is resting at the mouth, where a pull is allowed.
    const scrollOffsetOf = useCallback(
      (scroller: HTMLElement) =>
        horizontal ? scroller.scrollLeft : scroller.scrollTop,
      [horizontal],
    );

    // The one way out of the armed state. Clears the pending arm (a gesture
    // still settling) and the expiry (an arm still standing) together, so no
    // timer can re-arm or re-clear a feed behind the caller's back.
    const disarm = useCallback(() => {
      armed.current = false;
      if (armTimer.current) {
        clearTimeout(armTimer.current);
        armTimer.current = null;
      }
      if (armExpiry.current) {
        clearTimeout(armExpiry.current);
        armExpiry.current = null;
      }
    }, []);

    // (Re)start the armed window. Called when the feed arms and on every
    // toward-mouth pull while armed, so a slow deliberate pull keeps its arm and
    // only a feed left alone loses it. On expiry the indicator is withdrawn too:
    // a partial pull that never finished must not sit half-open on the feed.
    const scheduleArmExpiry = useCallback(() => {
      if (armExpiry.current) clearTimeout(armExpiry.current);
      armExpiry.current = setTimeout(() => {
        armExpiry.current = null;
        armed.current = false;
        wheelAccum.current = 0;
        if (wheelTimer.current) {
          clearTimeout(wheelTimer.current);
          wheelTimer.current = null;
        }
        setPullDistance((d) => (d > 0 ? 0 : d));
        setPulling(false);
      }, ARM_TTL_MS);
    }, []);

    const doRefresh = useCallback(() => {
      disarm();
      setRefreshing(true);
      // The indicator withdraws the moment the refresh starts — it held open at
      // `THRESHOLD * 0.6` to carry a "REFRESHING…" label, and that label is gone.
      // The wait belongs to the feed's own LOADING… hint, which is already up:
      // two waiting states stacked one above the other said the same thing twice.
      // `refreshing` still gates every input handler, so the pull cannot re-arm
      // underneath the fetch.
      setPullDistance(0);
      if (messageTimer.current) clearTimeout(messageTimer.current);
      setMessage(null);
      void onRefresh()
        .then((result) => {
          if (!alive.current || !result?.message) return;
          setMessage(result.message);
          messageTimer.current = setTimeout(() => {
            messageTimer.current = null;
            setMessage(null);
          }, result.holdMs ?? MESSAGE_HOLD_MS);
        })
        .catch(() => {})
        .finally(() => {
          setRefreshing(false);
          setPullDistance(0);
          setPulling(false);
        });
    }, [onRefresh, disarm]);

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
          disarm();
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
            scheduleArmExpiry();
          }, ARM_IDLE_MS);
          return;
        }
        scheduleArmExpiry();
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
      [
        refreshing,
        pullDistance,
        doRefresh,
        disarm,
        scheduleArmExpiry,
        scrollRef,
        axis,
        horizontal,
        scrollOffsetOf,
      ],
    );

    // The pointer leaving the feed ends its claim on the next pull. Mouse only:
    // a lifted finger fires pointerleave too, just before touchend, and the touch
    // path neither arms nor reads `armed` — resetting its indicator here would
    // race the release that is about to refresh. Without this, moving the mouse
    // from a feed left resting at its mouth to the one beside it carried the
    // first feed's arm with it, and any later pan that slid the first feed back
    // under the cursor refreshed it off a gesture meant for the second.
    const onPointerLeave = useCallback(
      (e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        disarm();
        wheelAccum.current = 0;
        if (wheelTimer.current) {
          clearTimeout(wheelTimer.current);
          wheelTimer.current = null;
        }
        if (!refreshing && pullDistance > 0) {
          setPullDistance(0);
          setPulling(false);
        }
      },
      [disarm, refreshing, pullDistance],
    );

    useImperativeHandle(
      ref,
      () => ({
        cancel() {
          disarm();
          wheelAccum.current = 0;
          if (wheelTimer.current) {
            clearTimeout(wheelTimer.current);
            wheelTimer.current = null;
          }
          active.current = false;
          setPullDistance((d) => (d > 0 ? 0 : d));
          setPulling(false);
        },
      }),
      [disarm],
    );

    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
        if (messageTimer.current) clearTimeout(messageTimer.current);
        if (wheelTimer.current) clearTimeout(wheelTimer.current);
        if (armTimer.current) clearTimeout(armTimer.current);
        if (armExpiry.current) clearTimeout(armExpiry.current);
      };
    }, []);

    // Only the two INVITATIONS — there is no in-flight label (see `doRefresh`).
    const label = pulling
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
        onPointerLeave={onPointerLeave}
        style={{
          position: "relative",
          // Horizontal: the indicator sits left of the card row and grows it
          // rightward, mirroring the vertical push-down.
          ...(horizontal
            ? { display: "flex", flexDirection: "row", alignItems: "stretch" }
            : {}),
        }}
      >
        {pullDistance > 0 && !refreshing && (
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
        {message !== null && !refreshing && pullDistance === 0 && (
          <div
            className="flex items-center justify-center"
            // The queue's live region says it in sentences (§VII.9).
            aria-hidden
            style={
              horizontal
                ? { width: MESSAGE_H, flex: "0 0 auto" }
                : { height: MESSAGE_H }
            }
          >
            <span
              className="label-ui"
              style={{
                color: messageColor,
                whiteSpace: "nowrap",
                ...(horizontal ? { writingMode: "vertical-rl" as const } : {}),
              }}
            >
              {message}
            </span>
          </div>
        )}
        {children}
      </div>
    );
  },
);
