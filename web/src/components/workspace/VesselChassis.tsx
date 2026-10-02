"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DOMAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { usePassTracker } from "../../hooks/usePassTracker";
import { useFeedSeenDwell } from "../../hooks/useFeedSeenDwell";
import { INERT } from "../../lib/inert";
import {
  VESSEL_WALL,
  VESSEL_PAD,
  VESSEL_GAP,
  type VesselPalette,
} from "./tokens";
import { VesselBar, BAR_H } from "./VesselBar";
import {
  PullToRefresh,
  type PullToRefreshHandle,
  type RefreshResult,
} from "./PullToRefresh";
import { ROUNDEL_HOST, RoundelLabel } from "./RoundelLabel";
import { useQueueBinding, type QueueBinding } from "./queue/queueBinding";

// VesselChassis — the ⊔ itself, shared by the floor and the queue
// (WORKSPACE-QUEUE-ADR §VII.2, D3).
//
// `Vessel` is a FLOOR object: an absolutely positioned motion.div with drag
// controls, motion values, resize, edge auto-pan and card-drop. The queue needs
// the ⊔ — walls, interior, numeral, scroll body, pull-to-refresh, tail, bar,
// dwell and pass tracker — inside a clip whose width animates, and none of the
// floor behaviour. So the ⊔ lives here, and each mode wraps it in its own
// shell: `Vessel` on the floor, `QueueEntry` in the queue. There is one ⊔.
//
// NOTHING ABOUT PLACEMENT COMES IN. The props are what the ⊔ needs; where it
// sits, how big the floor says it is, and whether it can be dragged are the
// shell's. The floor's DOM is pinned byte-identical across the split
// (`Vessel.dom.test.tsx`), so a shell passing what `Vessel` passes renders
// exactly what `Vessel` rendered before.
//
// ENGAGEMENT IS THE SHELL'S TOO. What counts as attention differs by mode
// (§IV.4: on the floor, in view and attended to; in the queue, focal with no
// gesture in progress), so the shell computes `engaged` and the chassis only
// clocks it toward a dwell.

const WALL = VESSEL_WALL;
const PAD = VESSEL_PAD;
const GAP = VESSEL_GAP;

/** What the interior holds. `full` is the card tree; `parked` is a flat wash
 *  (the floor's virtualisation, COLUMN-LAYOUT §VII); `compact` is a feed ahead
 *  in the queue — no card tree, and the preview layer when there is one
 *  (§VI.2, §VII.3). */
export type ChassisContents = "full" | "compact" | "parked";

export interface VesselChassisProps {
  children: ReactNode;
  feedId: string;
  numeral?: number;
  descriptiveName?: string;
  palette: VesselPalette;
  horizontal: boolean;
  contents: ChassisContents;
  /** The shell's answer to "is this feed being attended to right now?". */
  engaged: boolean;
  /** Called once when an engagement becomes a dwell (the queue's `settle`). */
  onDwell?: () => void;
  /** The reading counts apply: the pass tracker, and the tail the last card
   *  leaves through (§IV.7). */
  countsSeen: boolean;
  /** The pass tracker is live. Default true; the queue keeps a neighbour's
   *  tail (so its restored position survives becoming focal) while tracking
   *  only the focal list (§VII.10). */
  tracking?: boolean;
  tailSpacer: boolean;
  /** What the tail says at its top: "loading" while the next page is on its
   *  way, "end" once there is none. A fast flick outruns the next page into
   *  the tail, and a blank tail cannot tell waiting from finished (the
   *  operator's trackpad pass, 2026-10-01, g6). Absent, the tail is blank. */
  tailNote?: "loading" | "end";
  /** The card list is laid out but not live: `inert` and `aria-hidden` — a
   *  queue neighbour's full list, pre-mounted (§VII.3). What hides it is
   *  `listOpacityAt`, the queue's binding. */
  listHidden?: boolean;
  /** Called with the scroll body each time the card list mounts — after the
   *  tail is in place and before the pass tracker attaches — to put the reader
   *  back where they were (the queue's anchors, §VII.3). The capture is the
   *  shell's: by the time a chassis could see its list going, React has
   *  already removed it. */
  restoreScroll?: (scroller: HTMLElement) => void;
  /** The chassis height, or undefined for an intrinsic one. */
  height?: number;
  /** The scroll body is a scroller (an explicit height is set). */
  scrolls: boolean;
  /** The scroll body flexes to fill the chassis height. */
  bodyFills: boolean;
  /** The chassis outline — a drop target or an armed merge, the shell's call. */
  outline?: string;
  /** How the outline comes and goes; the floor's is a 120ms colour ease. The
   *  queue's flash fades slower (§VII.8). */
  outlineTransition?: string;
  /** Handlers the shell hangs on the chassis element (the floor's card-drop). */
  chassisHandlers?: Pick<
    DOMAttributes<HTMLDivElement>,
    "onDragOver" | "onDragLeave" | "onDrop"
  >;
  /** The numeral's cursor: the floor's drag handle wears `grab`. */
  numeralCursor?: CSSProperties["cursor"];
  /** The scroll body's tab stop — the queue's roving tabindex (§VI.7). */
  scrollTabIndex?: number;
  /** The queue's name for its one tab stop (§VI.7): the scroll body becomes a
   *  named group with the sitewide keyboard ring, drawn inside it. The floor
   *  passes none and renders as it did. */
  scrollLabel?: string;
  /** The scroll body, when the shell needs to reach it too. */
  scrollBodyRef?: RefObject<HTMLDivElement>;
  /** Replaces the floor bar (the queue's compact bar). */
  bar?: ReactNode;
  /** A layer over the interior, beside the scroll body and never inside it —
   *  the queue's preview rows (§VII.2, §VII.5), which the pass tracker must not
   *  see. It positions itself; the floor passes none. */
  previewLayer?: ReactNode;
  /** Rendered last inside the chassis (the floor's resize grip). */
  overlay?: ReactNode;
  /** The pull-to-refresh handle, for the queue's drag to cancel a pull
   *  (§VI.4). */
  pullRef?: Ref<PullToRefreshHandle>;
  /** The queue's gesture drives these (§VII.6): the card list's opacity, and
   *  the bar's and numeral's together. Absent on the floor, where nothing
   *  binds and the DOM is what it was. */
  listOpacityAt?: QueueBinding;
  barOpacityAt?: QueueBinding;
  onNameClick?: () => void;
  onSourceAdded?: () => void;
  onHide?: () => void;
  /** May resolve to the line the mouth says once it has (§VII.9). */
  onRefresh?: () => Promise<RefreshResult | void>;
  onLoadMore?: (feedId: string) => void;
  caughtUp?: boolean;
  onCaughtUpDismiss?: () => void;
}

export function VesselChassis({
  children,
  feedId,
  numeral,
  descriptiveName,
  palette,
  horizontal: isHorizontal,
  contents,
  engaged,
  onDwell,
  countsSeen,
  tracking = true,
  tailSpacer,
  tailNote,
  listHidden = false,
  restoreScroll,
  height,
  scrolls,
  bodyFills,
  outline,
  outlineTransition = "outline-color 120ms ease-out",
  chassisHandlers,
  numeralCursor,
  scrollTabIndex,
  scrollLabel,
  scrollBodyRef: externalScrollRef,
  bar,
  previewLayer,
  overlay,
  pullRef,
  listOpacityAt,
  barOpacityAt,
  onNameClick,
  onSourceAdded,
  onHide,
  onRefresh,
  onLoadMore,
  caughtUp,
  onCaughtUpDismiss,
}: VesselChassisProps) {
  const parked = contents !== "full";
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollBodyRef = externalScrollRef ?? internalScrollRef;
  // Scroll position survives a park: the DOM node keeps its scrollTop only for
  // as long as it has content to scroll.
  const savedScrollRef = useRef({ top: 0, left: 0 });

  const numeralRef = useRef<HTMLDivElement>(null);
  const barWrapRef = useRef<HTMLDivElement>(null);
  useQueueBinding(scrollBodyRef, "opacity", listOpacityAt);
  useQueueBinding(numeralRef, "opacity", barOpacityAt);
  useQueueBinding(barWrapRef, "opacity", barOpacityAt);

  useFeedSeenDwell(feedId, engaged, onDwell);
  usePassTracker(scrollBodyRef, feedId, {
    enabled: countsSeen && tracking && !parked,
    horizontal: isHorizontal,
  });

  // The tail after the last card, one scroller's extent, so the LAST card can
  // leave through the top edge and be passed too (§IV.7). Measured, because a
  // percentage of a scroll container's own height does not resolve.
  const tailRef = useRef<HTMLDivElement>(null);
  const [tailPx, setTailPx] = useState(0);
  const wantsTail = countsSeen && tailSpacer && !parked;
  // A layout effect that also writes the node, so a restore later in the same
  // commit already scrolls against the full extent — a position in the last
  // screenful would otherwise be clamped before the tail arrived.
  useLayoutEffect(() => {
    if (!wantsTail) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const measure = () => {
      const px = isHorizontal ? el.clientWidth : el.clientHeight;
      const t = tailRef.current;
      if (t) t.style[isHorizontal ? "width" : "height"] = `${px}px`;
      setTailPx(px);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wantsTail, isHorizontal, scrollBodyRef]);
  const tail = wantsTail ? (
    <div
      ref={tailRef}
      aria-hidden
      style={
        isHorizontal
          ? { flex: "0 0 auto", width: tailPx }
          : { flex: "0 0 auto", height: tailPx }
      }
    >
      {tailNote && !isHorizontal && (
        <div style={{ paddingTop: GAP, textAlign: "center" }}>
          <span className="label-ui" style={{ color: palette.cardMeta }}>
            {tailNote === "loading" ? "Loading more" : "End of channel"}
          </span>
        </div>
      )}
    </div>
  ) : null;

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
  }, [parked, caughtUp, onCaughtUpDismiss, scrollBodyRef]);

  // Infinite scroll: fire onLoadMore when the scroll position nears the end so
  // older content keeps flowing in. The threshold (a card-or-two ahead of the
  // edge) makes the load feel seamless. Fires on the active axis only.
  //
  // A `scroll` EVENT IS NOT THE CONDITION, IT IS ONE THING THAT CHANGES IT.
  // "Near the end" is a fact about geometry, and a tall vessel at headline or
  // condensed density holds its whole first page without overflowing — so
  // nothing ever scrolls, no event ever fires, and the feed stops at page one
  // for good while looking merely short. The other two things that change it
  // are the content growing (a page arrives) and the box changing size (a
  // resize, a density switch, a drag), so one ResizeObserver watching the
  // scroller AND its content covers both, with the check itself unchanged.
  //
  // Re-firing is safe and is the point: `loadMoreVesselItems` is guarded by the
  // vessel's own `nextCursor` and a synchronous ref latch, so the loop fills
  // the vessel and then stops of its own accord when the cursor exhausts.
  useEffect(() => {
    // Parked: the wash is height:100%, so scrollHeight ≈ clientHeight and
    // "near end" is ALWAYS true — the unmount's scroll-clamp event would
    // fetch a page for an off-screen feed, and every park cycle another
    // (§VII: parking tears down nothing and refetches nothing).
    if (parked || !onLoadMore) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    function check() {
      if (!el) return;
      // A card or two ahead was too late for a trackpad flick, which outran
      // the fetch into the blank tail (the trackpad pass, 2026-10-01, g6):
      // ask a screenful and a half ahead, never less than the old 320px.
      const THRESHOLD = Math.max(
        320,
        1.5 * (isHorizontal ? el.clientWidth : el.clientHeight),
      );
      // The reading counts' tail is not content: "near the end" is near the
      // last CARD, or the next page would wait until the tail was scrolled.
      const t = tailRef.current;
      const tailSize = t ? (isHorizontal ? t.offsetWidth : t.offsetHeight) : 0;
      const nearEnd = isHorizontal
        ? el.scrollWidth - tailSize - el.scrollLeft - el.clientWidth < THRESHOLD
        : el.scrollHeight - tailSize - el.scrollTop - el.clientHeight < THRESHOLD;
      if (nearEnd) onLoadMore!(feedId);
    }
    el.addEventListener("scroll", check, { passive: true });

    // The card column, not the scroll body: the body's own size is set by the
    // vessel, while `scrollHeight` tracks the column inside it.
    const content = el.firstElementChild;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (content) ro.observe(content);
    // ResizeObserver delivers an initial callback for every observed element,
    // so the mount-time check comes free.

    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [parked, onLoadMore, feedId, isHorizontal, scrollBodyRef]);

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
  }, [parked, scrollBodyRef]);
  useLayoutEffect(() => {
    if (parked) return;
    const el = scrollBodyRef.current;
    if (!el) return;
    const { top, left } = savedScrollRef.current;
    if (top) el.scrollTop = top;
    if (left) el.scrollLeft = left;
  }, [parked, scrollBodyRef]);

  // The queue's anchors (§VII.3). Restored once per mount of the card list —
  // at the first commit, and again after every park — later than the raw
  // `savedScrollRef` above, which it overrides: an offset saved from a list
  // that has since had posts merged in above points at the wrong card.
  //
  // A LAYOUT effect, and that is what orders it before the pass tracker: the
  // tracker attaches in a passive effect, which React runs after every layout
  // effect of the same commit, so its first report sees the position the
  // reader LEFT and never the top of a fresh list (§VI.2).
  const restoredRef = useRef(false);
  const restoreRef = useRef(restoreScroll);
  restoreRef.current = restoreScroll;
  useLayoutEffect(() => {
    if (parked) {
      restoredRef.current = false;
      return;
    }
    const el = scrollBodyRef.current;
    const restore = restoreRef.current;
    if (restoredRef.current || !el || !restore) return;
    restoredRef.current = true;
    restore(el);
  }, [parked, scrollBodyRef]);

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

  const barElement = bar ?? (
    <VesselBar
      feedId={feedId}
      palette={palette}
      onSourceAdded={onSourceAdded}
      onNameClick={onNameClick}
      onHide={onHide}
    />
  );

  return (
    // The vessel chassis. Position relative so chrome controls (resize +
    // brightness / density / orientation) can pin to its corners. When the
    // user has fixed a height, the body becomes a scroll container;
    // otherwise it grows with content.
    <div
      data-vessel-chassis
      {...chassisHandlers}
      style={{
        position: "relative",
        ...wallStyle,
        background: palette.interior,
        height,
        display: "flex",
        flexDirection: "column",
        outline,
        outlineOffset: -4,
        transition: outlineTransition,
      }}
    >
      {/* Feed numeral — bottom-left corner. Doubles as the vessel name/drag
          handle (double-click renames, drag repositions) → Explain `vessel.name`. */}
      <div
        ref={numeralRef}
        data-explain="vessel.name"
        onDoubleClick={() => onNameClick?.()}
        // The label's hover host (`RoundelLabel.tsx`): in the queue this
        // numeral slides away under a still pointer on every step.
        className={`${ROUNDEL_HOST} select-none font-sans`}
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
          cursor: numeralCursor,
          zIndex: 6,
        }}
      >
        {numeral}
        {descriptiveName && (
          <RoundelLabel
            place={{
              position: "absolute",
              left: 0,
              bottom: "100%",
              marginBottom: 4,
            }}
          >
            {descriptiveName}
          </RoundelLabel>
        )}
      </div>

      <div
        ref={scrollBodyRef}
        data-vessel-scroll=""
        {...(listHidden ? INERT : undefined)}
        tabIndex={scrollTabIndex}
        {...(scrollLabel
          ? { role: "group", "aria-label": scrollLabel, className: "focus-ring-inset" }
          : undefined)}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          padding: `${PAD}px`,
          flex: bodyFills ? "1 1 0" : undefined,
          minHeight: 0,
          overflowY: scrolls && !isHorizontal ? "auto" : undefined,
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
            ref={pullRef}
            onRefresh={onRefresh}
            scrollRef={scrollBodyRef}
            axis={isHorizontal ? "horizontal" : "vertical"}
            messageColor={palette.cardMeta}
          >
            <div
              style={{
                display: "flex",
                flexDirection: isHorizontal ? "row" : "column",
                gap: `${GAP}px`,
              }}
            >
              {children}
              {tail}
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
            {tail}
          </div>
        )}
      </div>

      {previewLayer}

      {/* VesselBar replaces the bottom wall — gear + hide + source input.
          Appearance controls moved into the FeedComposer modal (task 8). */}
      {barOpacityAt ? (
        <div ref={barWrapRef} style={{ flex: "0 0 auto" }}>
          {barElement}
        </div>
      ) : (
        barElement
      )}

      {overlay}
    </div>
  );
}
