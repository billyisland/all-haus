"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  motion,
  animate,
  useDragControls,
  useMotionValue,
} from "framer-motion";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import {
  snap,
  GRID,
  VESSEL_MIN_W as MIN_W,
  VESSEL_MIN_H as MIN_H,
  VESSEL_MAX_W as MAX_W,
  VESSEL_MAX_H as MAX_H,
} from "../../lib/workspace/grid";
import {
  AUTOPAN_MARGIN,
  AUTOPAN_MAX_SPEED,
  FACTORY_W,
} from "../../lib/workspace/layout";
import { CARD_DRAG_MIME, cardDragOrigin } from "../../lib/workspace/cardDrag";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import {
  paletteFor,
  DEFAULT_ORIENTATION,
  VESSEL_WALL,
  VESSEL_PAD,
  VESSEL_GAP,
  type Brightness,
  type Orientation,
} from "./tokens";
import { VesselBar, BAR_H } from "./VesselBar";
import { PullToRefresh } from "./PullToRefresh";
import { useColorScheme } from "../../stores/colorScheme";
import { useExplainable } from "./ExplainProvider";

// Vessel — the ⊔ chassis, per WIREFRAME-DECISIONS-CONSOLIDATED.md Step 1.
//
// On the columnar floor (WORKSPACE-COLUMN-LAYOUT-ADR) the vessel no longer owns
// a position: it RENDERS a slot's derived rect and reports GESTURES. A drag
// hands back the pointer and the host resolves it to a slot (§IV.2); a resize
// hands back a proposed size the host clamps against the column (§IV.3). The
// vessel commits no coordinates, so it can no longer place itself anywhere the
// layout model forbids.
//
// Brightness drives a resolved palette across walls, interior, name label, and
// (via prop) the cards inside. Orientation toggles the chassis between vertical
// (⊔: left + right + bottom walls, opening at the top) and horizontal (⊐: top +
// right + bottom walls, opening on the LEFT) — cards lay out in a row when
// horizontal. The open end tracks where new items arrive (top for vertical,
// left for the newest-first row), so the mouth is the arrival end in both.
// (Density is a per-feed control too, but it's applied to the cards in
// WorkspaceView's CardContext, not threaded through the Vessel.)

// Side-wall thickness. Exported so overlays launched from a feed (the reader /
// profile Glasshouse) can frame themselves at the SAME thickness as the feed's
// vessel wall — the frame echoes the container the surface came from.
// The three vessel numbers live in tokens.ts — the profile pane reproduces them
// exactly (PROFILE-PANE-REDESIGN-ADR §9.2), and one home is what stops the two
// surfaces drifting. Re-exported under the local names this file has always
// used. NOTE: the card rhythm a reader sees is GAP + the card's own
// `GAP_PX.feed` margin = 20px, not GAP.
export { VESSEL_WALL as WALL } from "./tokens";
const WALL = VESSEL_WALL; // px
const PAD = VESSEL_PAD; // px interior padding (top zone left open per Step 1: "Opening: full width of the vessel interior")
const GAP = VESSEL_GAP; // px inter-card gap

const ROUNDEL_TOKENS = {
  bg: "var(--ah-ink-925)",
  fg: "var(--ah-bone)",
};

// The size envelope comes from the shared grid module — one definition for the
// component's clamps and the layout module's SLOT_MIN_*. Minimums per spec
// ("below which content becomes illegible"); spec says no maximum, we clamp at
// sane upper bounds defensively.

interface VesselProps {
  children: ReactNode;
  feedId: string;
  numeral: number;
  descriptiveName?: string;
  // Explain engine (EXPLAIN-ADR D4/D7): the vessel registers as a root keyed by
  // feedId, ordered by sort_rank, carrying the copy-fork inputs off the feed.
  sortRank?: number;
  fromStarter?: boolean;
  onNameClick?: () => void;
  onSourceAdded?: () => void;
  /** The slot's DERIVED rect (lib/workspace/layout.ts::deriveGeometry). Final
   *  canvas coordinates — centring already applied — because derivation is the
   *  one conversion seam and there is no origin left to compensate. */
  position: { x: number; y: number };
  size?: { w?: number; h?: number };
  brightness?: Brightness;
  orientation?: Orientation;
  hidden?: boolean;
  onHide?: () => void;
  onSizeCommit?: (size: { w: number; h: number }) => void;
  /** Clamp a proposed size to what the slot's column can hold (§IV.3: width
   *  free, height bounded by the stack remainder). Applied per FRAME, so the
   *  handle visibly stops where the commit would. */
  clampResize?: (proposed: { w: number; h: number }) => { w: number; h: number };
  /** Live resize proposal, so the host can feed it through derivation and let
   *  the columns to the right slide WITH the handle. `null` clears it. */
  onResizeFrame?: (size: { w: number; h: number } | null) => void;
  onDragStart?: () => void;
  /**
   * Per-frame cursor position in VIEWPORT coordinates. The pointer is the whole
   * question now: §IV.2 resolves the drop from it (edge bands → insertion,
   * central region → merge), so the host needs no rect probe and the vessel
   * hands back no coordinates. It rides free over a layout that is held stable
   * for the whole gesture (§IV.1).
   */
  onDragFrame?: (pointer: { x: number; y: number }) => void;
  /** Released. The host commits whatever the last frame resolved to; this
   *  vessel springs back to its derived rect either way (a held-open slot is
   *  also the snap-back target for a cancelled drop). */
  onDragEnd?: () => void;
  /** This vessel is the armed merge target: the dragged vessel is riding over
   *  its central region and releasing here will offer to combine them. */
  armed?: boolean;
  /** A live resize proposal is reflowing the floor: settle to a changed rect
   *  by direct set instead of a spring, so the columns to the right of the
   *  handle track it exactly rather than chasing it with a spring restarted
   *  every frame. */
  snapSettle?: boolean;
  /**
   * The scroll viewport the floor lives in. Used for edge-proximity auto-pan
   * (§IV.1) — never as a framer `dragConstraints` box, which would box the
   * vessel into the viewport.
   */
  floorRef?: RefObject<HTMLElement>;
  onCardDrop?: (data: string) => void;
  onRefresh?: () => Promise<void>;
  /** Infinite scroll: called when the scroll body nears its end so the host can
   *  append the next (older) page. The host guards against concurrent/exhausted
   *  loads. */
  onLoadMore?: (feedId: string) => void;
  caughtUp?: boolean;
  onCaughtUpDismiss?: () => void;
  /** Virtualization (WORKSPACE-COLUMN-LAYOUT-ADR §VII): `false` PARKS the
   *  vessel — chassis, numeral and bar stay mounted (so it remains a drag
   *  obstacle, a merge target and an explainable root), while the card tree is
   *  unmounted and the interior renders as a flat wash. The vessel instance
   *  survives, so it owns the two things an unmount would otherwise lose: the
   *  scroll body's scroll position, and — for an intrinsic-height vessel — its
   *  measured height (dormant on the columnar floor — every slot has a derived
   *  height — but retained for a caller that passes none). Defaults to
   *  mounted. */
  contentsMounted?: boolean;
}

export function Vessel({
  children,
  feedId,
  numeral,
  descriptiveName,
  sortRank,
  fromStarter,
  onNameClick,
  onSourceAdded,
  position,
  size,
  brightness,
  orientation,
  hidden,
  onHide,
  onSizeCommit,
  clampResize,
  onResizeFrame,
  onDragStart: onDragStartProp,
  onDragFrame,
  onDragEnd: onDragEndProp,
  armed,
  snapSettle,
  floorRef,
  onCardDrop,
  onRefresh,
  onLoadMore,
  caughtUp,
  onCaughtUpDismiss,
  contentsMounted = true,
}: VesselProps) {
  const parked = !contentsMounted;
  const dragControls = useDragControls();
  const [isDragTarget, setIsDragTarget] = useState(false);
  const vesselRef = useRef<HTMLDivElement>(null);
  // Register the vessel as an explainable root (EXPLAIN-ADR D4). Reuses the
  // existing vesselRef so the registration tracks the live node through drag /
  // reorder; the copy fork (D7) reads feedName/fromStarter off params.
  useExplainable("vessel", {
    ref: vesselRef,
    key: feedId,
    order: sortRank,
    params: { feedName: descriptiveName ?? null, fromStarter: !!fromStarter },
  });
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(position.x);
  const my = useMotionValue(position.y);
  const [roundelHovered, setRoundelHovered] = useState(false);
  const [liveSize, setLiveSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  // Parked-vessel height pin (see `contentsMounted`): `pinnedH` freezes the
  // last measured chassis height for the wash so an INTRINSIC-height vessel
  // doesn't collapse the moment its cards unmount. DORMANT on the columnar
  // floor — `deriveGeometry` gives every slot an explicit height, so
  // `heightSet` is always true and both effects below return immediately. Kept
  // because the height prop is still optional; nothing reads the DOM for
  // geometry any more (the free-coordinate floor's readFloorRects is gone).
  const measuredHRef = useRef<number | null>(null);
  const [pinnedH, setPinnedH] = useState<number | null>(null);
  // Scroll position survives a park: the DOM node keeps its scrollTop only for
  // as long as it has content to scroll.
  const savedScrollRef = useRef({ top: 0, left: 0 });
  const resizeStateRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    maxW: number;
    maxH: number;
    // Extra width accumulated by the right-edge auto-grow (below): holding the
    // handle at the viewport edge adds to this, so the slot keeps widening into
    // new floor territory even though the pointer can travel no further.
    growth: number;
    // Whether the pointer ever actually travelled — a bare click must be a
    // no-op (see handleResizePointerUp), and a zero-delta pointermove's snap
    // rounding must not be able to fake a "change".
    moved: boolean;
  } | null>(null);

  const effOrientation = orientation ?? DEFAULT_ORIENTATION;
  // The colourway renders in the global mode's light/dark variant; the vessel
  // stays islanded (LIGHT_ISLAND_STYLE) so the derived text slugs the palette
  // references resolve canonical regardless of mode.
  const globalDark = useColorScheme((s) => s.dark);
  const palette = paletteFor(brightness, globalDark);
  const isHorizontal = effOrientation === "horizontal";

  const isDraggingRef = useRef(false);
  // Drag raises the vessel above its neighbours so it visibly RIDES OVER an
  // armed merge target rather than disappearing behind it. Transient only —
  // no z-order is persisted, and the resting floor stays flat.
  const [isDragging, setIsDragging] = useState(false);
  const prevScrollTopRef = useRef(0);

  useEffect(() => {
    // Parked: the card tree is unmounted and the browser clamps scrollTop to
    // 0, firing a scroll event — which must not read as "the user scrolled
    // up" and dismiss an unseen caught-up banner.
    if (parked || !caughtUp || !onCaughtUpDismiss) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    prevScrollTopRef.current = el.scrollTop;
    function onScroll() {
      if (!el) return;
      if (el.scrollTop < prevScrollTopRef.current) {
        onCaughtUpDismiss!();
      }
      prevScrollTopRef.current = el.scrollTop;
    }
    function onWheel(e: WheelEvent) {
      if (!el) return;
      if (el.scrollTop === 0 && e.deltaY < 0) {
        onCaughtUpDismiss!();
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [parked, caughtUp, onCaughtUpDismiss]);

  // Infinite scroll: fire onLoadMore when the scroll position nears the end so
  // older content keeps flowing in. The threshold (a card-or-two ahead of the
  // edge) makes the load feel seamless. Fires on the active axis only.
  useEffect(() => {
    // Parked: the wash is height:100%, so scrollHeight ≈ clientHeight and
    // "near end" is ALWAYS true — the unmount's scroll-clamp event would
    // fetch a page for an off-screen feed, and every park cycle another
    // (§VII: parking tears down nothing and refetches nothing).
    if (parked || !onLoadMore) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const THRESHOLD = 320;
    function onScroll() {
      if (!el) return;
      const nearEnd = isHorizontal
        ? el.scrollWidth - el.scrollLeft - el.clientWidth < THRESHOLD
        : el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD;
      if (nearEnd) onLoadMore!(feedId);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [parked, onLoadMore, feedId, isHorizontal]);

  // Spring the vessel to its DERIVED rect. Runs on every real geometry change
  // (a neighbour's drop shunted this column, a resize widened the one to the
  // left) and once more explicitly at drag end — a drop that resolves to a
  // no-op leaves `position` untouched, so without that call the released vessel
  // would sit wherever the gesture dropped it forever.
  const positionRef = useRef(position);
  positionRef.current = position;
  const snapSettleRef = useRef(!!snapSettle);
  snapSettleRef.current = !!snapSettle;
  const settleToPosition = useCallback(() => {
    const { x, y } = positionRef.current;
    const dx = Math.abs(mx.get() - x);
    const dy = Math.abs(my.get() - y);
    if ((dx > 1 || dy > 1) && !snapSettleRef.current && !prefersReducedMotion()) {
      const spring = {
        type: "spring" as const,
        stiffness: 600,
        damping: 40,
        mass: 0.6,
      };
      animate(mx, x, spring);
      animate(my, y, spring);
    } else {
      mx.set(x);
      my.set(y);
    }
  }, [mx, my]);

  useEffect(() => {
    if (isDraggingRef.current) return;
    settleToPosition();
  }, [position.x, position.y, settleToPosition]);

  // ── Edge auto-pan (§IV.1) ────────────────────────────────────────────────
  // The taut floor has no gesture slack to drag into, so holding the drag near
  // a viewport edge pans the floor under it — the only way a drag reaches an
  // off-screen column.
  //
  // Panning moves the canvas beneath an absolutely-positioned vessel, so
  // without compensation the vessel would slide out from under the cursor.
  // framer owns `mx` during a drag and rewrites it as `dragOrigin + offset` on
  // every pointermove, so the accumulated pan CANNOT live in the motion value
  // alone: we track framer's own last write (`framerBaseRef`) and re-apply the
  // accumulated pan on top of it, both in the rAF loop (pointer held still, no
  // framer write) and in `onDrag` (pointer moving, framer just overwrote).
  const panAccumRef = useRef(0);
  const framerBaseRef = useRef({ x: 0, y: 0 });
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const autoPanRafRef = useRef<number | null>(null);

  const stopAutoPan = useCallback(() => {
    if (autoPanRafRef.current !== null)
      cancelAnimationFrame(autoPanRafRef.current);
    autoPanRafRef.current = null;
  }, []);

  const startAutoPan = useCallback(() => {
    if (autoPanRafRef.current !== null) return;
    const step = () => {
      autoPanRafRef.current = null;
      if (!isDraggingRef.current) return;
      const floor = floorRef?.current;
      const pointer = lastPointerRef.current;
      if (floor && pointer) {
        const r = floor.getBoundingClientRect();
        const fromLeft = pointer.x - r.left;
        const fromRight = r.right - pointer.x;
        let speed = 0;
        if (fromLeft < AUTOPAN_MARGIN)
          speed =
            -AUTOPAN_MAX_SPEED *
            Math.min(1, (AUTOPAN_MARGIN - fromLeft) / AUTOPAN_MARGIN);
        else if (fromRight < AUTOPAN_MARGIN)
          speed =
            AUTOPAN_MAX_SPEED *
            Math.min(1, (AUTOPAN_MARGIN - fromRight) / AUTOPAN_MARGIN);
        if (speed !== 0) {
          const before = floor.scrollLeft;
          floor.scrollLeft = before + speed;
          // The APPLIED delta, not the requested one — at either end of the
          // floor the browser clamps, and compensating for a scroll that never
          // happened would walk the vessel off the cursor.
          const applied = floor.scrollLeft - before;
          if (applied !== 0) {
            panAccumRef.current += applied;
            mx.set(framerBaseRef.current.x + panAccumRef.current);
            onDragFrame?.(pointer);
          }
        }
      }
      autoPanRafRef.current = requestAnimationFrame(step);
    };
    autoPanRafRef.current = requestAnimationFrame(step);
  }, [floorRef, mx, onDragFrame]);

  useEffect(() => stopAutoPan, [stopAutoPan]);

  // ── Resize edge auto-grow (mirror of the drag auto-pan) ──────────────────
  // The taut floor has no slack to the RIGHT of the last feed, so widening the
  // rightmost vessel used to stall the instant the handle reached the viewport
  // edge: there is no off-screen territory to drag into and — unlike a drag —
  // nothing scrolled to make room. (Widening a feed BETWEEN two others felt free
  // only because its handle starts far from the edge.) Now holding the handle
  // near the right edge GROWS the slot continuously (a `growth` term added to the
  // pointer delta) and scrolls the floor to reveal the new width — so pushing a
  // feed into new workspace width is exactly as easy at the right end as it is
  // in the middle. The commit path is unchanged: `growth` folds into the same
  // `liveSize` the pointer drives, so pointer-up commits it like any resize.
  const resizePanRafRef = useRef<number | null>(null);
  const lastResizePointerRef = useRef<{ x: number; y: number } | null>(null);

  const applyResizeFrame = (
    clientX: number,
    clientY: number,
  ): { w: number; h: number } | null => {
    const state = resizeStateRef.current;
    if (!state) return null;
    const dx = clientX - state.startX + state.growth;
    const dy = clientY - state.startY;
    if (dx !== 0 || dy !== 0) state.moved = true;
    const w = snap(Math.max(MIN_W, Math.min(state.maxW, state.startW + dx)));
    const h = snap(Math.max(MIN_H, Math.min(state.maxH, state.startH + dy)));
    const next = clampResize ? clampResize({ w, h }) : { w, h };
    setLiveSize(next);
    // Feed the proposal back through derivation so the columns to the right
    // slide WITH the handle rather than jumping on release.
    onResizeFrame?.(next);
    return next;
  };
  // Kept fresh in a ref so the long-lived auto-grow rAF (started once per
  // gesture) always applies the current render's clamps / callbacks.
  const applyResizeRef = useRef(applyResizeFrame);
  applyResizeRef.current = applyResizeFrame;

  const stopResizePan = useCallback(() => {
    if (resizePanRafRef.current !== null)
      cancelAnimationFrame(resizePanRafRef.current);
    resizePanRafRef.current = null;
  }, []);

  const startResizePan = useCallback(() => {
    if (resizePanRafRef.current !== null) return;
    const step = () => {
      resizePanRafRef.current = null;
      const state = resizeStateRef.current;
      const floor = floorRef?.current;
      const pointer = lastResizePointerRef.current;
      if (state && floor && pointer) {
        const r = floor.getBoundingClientRect();
        const fromRight = r.right - pointer.x;
        if (fromRight < AUTOPAN_MARGIN) {
          const speed =
            AUTOPAN_MAX_SPEED *
            Math.min(1, (AUTOPAN_MARGIN - fromRight) / AUTOPAN_MARGIN);
          // Grow the slot, capped so `growth` can't run away past the width
          // envelope (a clamped width would otherwise take an equal leftward
          // drag to undo).
          state.growth = Math.min(
            state.growth + speed,
            state.maxW - state.startW,
          );
          const next = applyResizeRef.current(pointer.x, pointer.y);
          // Scroll so the HANDLE stays under the cursor (not to the floor's far
          // right — that would jump away from a middle feed grown near the edge).
          // The handle's canvas-x is this vessel's left (`position.x`, stable
          // during its own resize) + the new width; target the scroll that keeps
          // it at the pointer. The browser clamps until the prior frame's commit
          // widens the floor, so it converges within a frame.
          if (next) {
            const handleX = positionRef.current.x + next.w;
            floor.scrollLeft = handleX - (pointer.x - r.left);
          }
        }
        resizePanRafRef.current = requestAnimationFrame(step);
      }
    };
    resizePanRafRef.current = requestAnimationFrame(step);
  }, [floorRef]);

  useEffect(() => stopResizePan, [stopResizePan]);

  function startDrag(event: React.PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='button']"))
      return;
    dragControls.start(event);
  }

  // Effective dimensions: liveSize during a resize gesture wins; otherwise
  // committed size from props; otherwise intrinsic defaults.
  const effW = liveSize?.w ?? size?.w ?? FACTORY_W;
  const effH = liveSize?.h ?? size?.h; // undefined = intrinsic content height
  const heightSet = effH !== undefined;
  // An explicit height needs no pin. Otherwise a parked vessel wears its last
  // measured height, and the body flexes to fill it so the bar stays welded to
  // the bottom edge exactly as it is when the cards are up.
  const chassisH = heightSet ? effH : parked ? (pinnedH ?? undefined) : undefined;
  const bodyFills = heightSet || (parked && pinnedH !== null);

  // Track the intrinsic chassis height while the contents are mounted. A
  // ResizeObserver keeps this off the render path — the vessel re-renders on
  // every drag frame, and an offsetHeight read there would force layout each
  // time.
  useEffect(() => {
    if (parked || heightSet) return;
    const chassis = vesselRef.current?.querySelector(
      "[data-vessel-chassis]",
    ) as HTMLElement | null;
    if (!chassis) return;
    const record = () => {
      measuredHRef.current = chassis.offsetHeight;
    };
    record();
    const ro = new ResizeObserver(record);
    ro.observe(chassis);
    return () => ro.disconnect();
  }, [parked, heightSet]);

  // Freeze / release the pin at the park boundary. A layout effect so the
  // pinned height lands in the same frame the cards leave — no collapsed frame
  // ever paints. A vessel parked before it was ever measured (an intrinsic
  // vessel that started outside the band) has no height to freeze, so it wears
  // MIN_H until it enters the band and measures itself — bounded, rather than
  // collapsing to the bar and under-reporting to the floor's geometry readers.
  useLayoutEffect(() => {
    setPinnedH(
      parked && !heightSet ? (measuredHRef.current ?? MIN_H) : null,
    );
  }, [parked, heightSet]);

  // Hold the scroll position across a park. Recorded continuously while
  // mounted (the node's own scrollTop is lost with its content), restored
  // pre-paint on the way back in.
  useEffect(() => {
    if (parked) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const onScroll = () => {
      savedScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [parked]);
  useLayoutEffect(() => {
    if (parked) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const { top, left } = savedScrollRef.current;
    if (top) el.scrollTop = top;
    if (left) el.scrollLeft = left;
  }, [parked]);

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!onSizeCommit) return;
    event.preventDefault();
    event.stopPropagation();
    const startW = effW;
    const chassisEl = vesselRef.current?.querySelector(
      "[data-vessel-chassis]",
    ) as HTMLElement | null;
    // Floor the seed to the lattice: a measured height is fractional, and a
    // press-with-no-move commits this seed as-is — a round-NEAREST snap would
    // grow it up to half a cell. Flooring only ever shrinks.
    const measuredH = effH ?? chassisEl?.getBoundingClientRect().height ?? MIN_H;
    const startH = Math.max(MIN_H, Math.floor(measuredH / GRID) * GRID);
    // Both axes are bounded by `clampResize` (the slot's column and the stack
    // remainder, §IV.3) — these are only the defensive envelope.
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startW,
      startH,
      maxW: MAX_W,
      maxH: MAX_H,
      growth: 0,
      moved: false,
    };
    lastResizePointerRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    setLiveSize({ w: startW, h: startH });
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStateRef.current) return;
    lastResizePointerRef.current = { x: event.clientX, y: event.clientY };
    // Start the right-edge auto-grow loop on the FIRST real move (not on
    // pointer-down), so a bare click on a handle that already sits near the edge
    // can't accidentally start widening. No-ops if the loop is already running.
    startResizePan();
    applyResizeFrame(event.clientX, event.clientY);
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    stopResizePan();
    const state = resizeStateRef.current;
    resizeStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the gesture was cancelled.
    }
    // A release at the seed size is a no-op and commits NOTHING — the resize
    // twin of `dropIsNoop`. Committing a zero-movement press would freeze an
    // `h: null` fill slot to a number, bake a squeezed height into the stored
    // layout, and (under the regimented view) stamp the parade over the
    // custom layout on a bare click of the grip.
    const unchanged =
      state && liveSize
        ? !state.moved ||
          (liveSize.w === state.startW && liveSize.h === state.startH)
        : true;
    if (!state || !liveSize || !onSizeCommit || unchanged) {
      setLiveSize(null);
      onResizeFrame?.(null);
      return;
    }
    onSizeCommit({ w: liveSize.w, h: liveSize.h });
    setLiveSize(null);
    onResizeFrame?.(null);
  }

  // A cancelled gesture (browser steals the pointer: alt-tab, OS edge swipe)
  // ABORTS — reverting to the derived rect — rather than committing the
  // half-dragged size the pointer happened to be at.
  function handleResizePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    stopResizePan();
    resizeStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    setLiveSize(null);
    onResizeFrame?.(null);
  }

  function handleChassisDragOver(e: React.DragEvent) {
    if (!onCardDrop) return;
    if (!e.dataTransfer.types.includes(CARD_DRAG_MIME)) return;
    // The feed the card came from is not a destination: leaving it unarmed (no
    // preventDefault, so the cursor reads "no drop") is what makes the real
    // targets legible — every vessel lighting up says nothing.
    if (cardDragOrigin() === feedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!isDragTarget) setIsDragTarget(true);
  }

  function handleChassisDragLeave(e: React.DragEvent) {
    const chassis = e.currentTarget as HTMLElement;
    if (chassis.contains(e.relatedTarget as Node)) return;
    setIsDragTarget(false);
  }

  function handleChassisDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragTarget(false);
    const raw = e.dataTransfer.getData(CARD_DRAG_MIME);
    if (!raw || !onCardDrop) return;
    onCardDrop(raw);
  }

  // Wall arrangement per orientation. The bottom wall is replaced by VesselBar,
  // so only left/right (vertical) or top/right (horizontal) get thin borders.
  // Horizontal opens on the LEFT, where newest items arrive (newest-first row,
  // scroll-right-for-older) — the mouth tracks the arrival end, matching the
  // vertical ⊔ whose open top is where new items drop in.
  const wallStyle = isHorizontal
    ? {
        borderTop: `${WALL}px solid ${palette.walls}`,
        borderRight: `${WALL}px solid ${palette.walls}`,
      }
    : {
        borderLeft: `${WALL}px solid ${palette.walls}`,
        borderRight: `${WALL}px solid ${palette.walls}`,
      };

  return (
    <motion.div
      ref={vesselRef}
      data-vessel-id={feedId}
      data-vessel-inert={hidden ? "true" : undefined}
      role="region"
      aria-label={
        descriptiveName
          ? `Feed ${numeral}: ${descriptiveName}`
          : `Feed ${numeral}`
      }
      drag
      dragListener={false}
      dragControls={dragControls}
      // No dragConstraints: framer would box the vessel into the scroll
      // viewport, and a drag must be free to ride anywhere — the drop
      // resolver maps every release point to a legal slot (§IV.2).
      dragMomentum={false}
      dragElastic={0}
      onPointerDown={startDrag}
      onDragStart={() => {
        isDraggingRef.current = true;
        setIsDragging(true);
        panAccumRef.current = 0;
        framerBaseRef.current = { x: mx.get(), y: my.get() };
        startAutoPan();
        onDragStartProp?.();
      }}
      onDrag={(_, info) => {
        // framer has just written `dragOrigin + offset`; that is the base the
        // accumulated auto-pan rides on top of.
        framerBaseRef.current = { x: mx.get(), y: my.get() };
        if (panAccumRef.current !== 0)
          mx.set(framerBaseRef.current.x + panAccumRef.current);
        lastPointerRef.current = info.point;
        onDragFrame?.(info.point);
      }}
      onDragEnd={() => {
        isDraggingRef.current = false;
        setIsDragging(false);
        stopAutoPan();
        panAccumRef.current = 0;
        lastPointerRef.current = null;
        onDragEndProp?.();
        // The host may have committed a drop (new rect arrives as a prop) or
        // resolved to a no-op (prop unchanged). Either way the vessel belongs
        // at its derived rect, so settle unconditionally.
        settleToPosition();
      }}
      style={{
        // Light island: desktop vessels keep their per-scheme colours
        // regardless of the global light/dark mode (web/src/lib/palette/island.ts).
        ...LIGHT_ISLAND_STYLE,
        position: "absolute",
        x: mx,
        y: my,
        width: effW,
        zIndex: isDragging ? 5 : undefined,
        touchAction: "none",
        cursor: hidden ? undefined : "grab",
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : undefined,
      }}
    >
      {/* The vessel chassis. Position relative so chrome controls (resize +
          brightness / density / orientation) can pin to its corners. When the
          user has fixed a height, the body becomes a scroll container;
          otherwise it grows with content. */}
      <div
        data-vessel-chassis
        onDragOver={handleChassisDragOver}
        onDragLeave={handleChassisDragLeave}
        onDrop={handleChassisDrop}
        style={{
          position: "relative",
          ...wallStyle,
          background: palette.interior,
          height: chassisH,
          display: "flex",
          flexDirection: "column",
          // A merge-armed vessel answers in its own wall colour (the feed it is
          // about to absorb becomes part of it). A card-drop target answers in
          // crimson: the wall colour would be painting the wall its own colour
          // on two of the four sides, which is no answer at all.
          outline: isDragTarget
            ? `4px solid ${palette.crimson}`
            : armed
              ? `4px solid ${palette.walls}`
              : undefined,
          outlineOffset: -4,
          transition: "outline-color 120ms ease-out",
        }}
      >
        {/* Feed numeral — bottom-left corner. Doubles as the vessel name/drag
            handle (double-click renames, drag repositions) → Explain `vessel.name`. */}
        <div
          data-explain="vessel.name"
          onMouseEnter={() => setRoundelHovered(true)}
          onMouseLeave={() => setRoundelHovered(false)}
          onDoubleClick={() => onNameClick?.()}
          className="select-none font-sans"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: BAR_H,
            height: BAR_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ah-white)",
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1,
            cursor: "grab",
            zIndex: 6,
          }}
        >
          {numeral}
          {descriptiveName && (
            <div
              className="label-ui"
              style={{
                position: "absolute",
                left: 0,
                bottom: "100%",
                marginBottom: 4,
                background: ROUNDEL_TOKENS.bg,
                color: ROUNDEL_TOKENS.fg,
                padding: "3px 8px",
                whiteSpace: "nowrap",
                boxShadow: "0 2px 6px rgba(0, 0, 0, 0.15)",
                opacity: roundelHovered ? 1 : 0,
                pointerEvents: "none",
                transition: "opacity 120ms ease-out",
              }}
            >
              {descriptiveName}
            </div>
          )}
        </div>

        <div
          ref={scrollBodyRef}
          data-vessel-scroll=""
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            padding: `${PAD}px`,
            flex: bodyFills ? "1 1 0" : undefined,
            minHeight: 0,
            overflowY: heightSet && !isHorizontal ? "auto" : undefined,
            overflowX: isHorizontal ? "auto" : undefined,
            // A horizontal feed OWNS the sideways axis inside its walls. Left to
            // chain, a swipe toward the mouth ran the feed to its start, then
            // panned the floor, then — once the floor was also at its end — was
            // handed to the browser as a back-navigation gesture, so the one
            // gesture meant three things depending on scroll state you cannot
            // see. Contained, it means one: scroll the feed, and at the mouth,
            // pull to refresh. Pan the floor from the floor, the muster, or
            // Ctrl+←/→.
            overscrollBehaviorX: isHorizontal ? "contain" : undefined,
            cursor: "default",
          }}
        >
          {/* The gap lives on the element that actually contains the cards, not
              on the scroll body (whose only direct child is PullToRefresh). */}
          {parked ? (
            // Parked: a flat wash over the interior. No cards, no media, and no
            // PullToRefresh listeners — the chassis around it is unchanged.
            <div aria-hidden style={{ width: "100%", height: "100%" }} />
          ) : onRefresh ? (
            <PullToRefresh
              onRefresh={onRefresh}
              scrollRef={scrollBodyRef}
              axis={isHorizontal ? "horizontal" : "vertical"}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: isHorizontal ? "row" : "column",
                  gap: `${GAP}px`,
                }}
              >
                {children}
              </div>
            </PullToRefresh>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: isHorizontal ? "row" : "column",
                gap: `${GAP}px`,
              }}
            >
              {children}
            </div>
          )}
        </div>

        {/* VesselBar replaces the bottom wall — gear + hide + source input.
            Appearance controls moved into the FeedComposer modal (task 8). */}
        <VesselBar
          feedId={feedId}
          palette={palette}
          onSourceAdded={onSourceAdded}
          onNameClick={onNameClick}
          onHide={onHide}
        />

        {onSizeCommit && (
          <div
            role="button"
            aria-label="Resize vessel"
            data-explain="vessel.resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerCancel}
            style={{
              position: "absolute",
              // Both orientations now carry a right wall (vertical: left+right;
              // horizontal: top+right, open left), so the grip overhangs it.
              right: -WALL,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: "nwse-resize",
              touchAction: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: 3,
                bottom: 3,
                width: 8,
                height: 8,
                borderRight: `2px solid ${palette.barTextMuted}`,
                borderBottom: `2px solid ${palette.barTextMuted}`,
                opacity: 0.7,
              }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}
