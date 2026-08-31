"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WorkspaceFeed } from "../../lib/api";
import { PullToRefresh } from "./PullToRefresh";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import { useMobileActiveFeed } from "../../stores/mobileActiveFeed";

// =============================================================================
// MobileWorkspace — the mobile workspace shell (MOBILE-LAYOUT-ADR §III–§IV).
//
// Not a responsive reflow of the canvas: one feed per screen, paged
// horizontally in rank order, identity carried by the indicator pips. The shell
// is a thin bar (wordmark · indicator strip · the ∀, docked by ForallMenu's
// `anchor="bar"`) over a full-bleed active feed. No vessel chassis renders
// here — position / size / orientation / merge are canvas properties and stay
// on the desktop; colour scheme and density are feed character and travel.
//
// Gesture contract (§VI, axis orthogonality):
//   - vertical = scroll / pull-to-refresh inside the active feed (native);
//   - horizontal = the pager, claimed only once a drag is DECISIVELY
//     horizontal (axis-lock with a pan threshold), and never when the drag
//     began inside a horizontally-scrollable element (wide embeds, code
//     blocks) or on the pip ([data-pip-trigger] — the pip wins);
//   - the indicator strip is the non-negotiable visible form of the rank
//     order: tap-to-jump, and tapping the ACTIVE pip opens that feed's
//     settings sheet (the FeedComposer — §VI).
//
// Resume keys off the feed `id`, never the pip index (§IV): the active pip
// shifts under reorder / delete / hide, so a stored index would silently point
// at the wrong feed.
// =============================================================================

export const MOBILE_BAR_H = 48;

// Claim thresholds for the axis lock. A drag is the pager's only when it has
// moved >= CLAIM_PX and is clearly flatter than 1:1.4 against the vertical;
// a drag that goes >= REJECT_PX mostly-vertical first is the feed's scroll.
const CLAIM_PX = 12;
const REJECT_PX = 10;
// Commit a page turn past a quarter screen, or on a decisive fling.
const COMMIT_FRACTION = 0.25;
const FLING_VX = 0.4; // px/ms
const FLING_MIN_PX = 24;

const resumeKey = (userId: string) => `ah:mobile-feed:${userId}`;

function readResume(userId: string): string | null {
  try {
    return localStorage.getItem(resumeKey(userId));
  } catch {
    return null;
  }
}

function writeResume(userId: string, feedId: string) {
  try {
    localStorage.setItem(resumeKey(userId), feedId);
  } catch {
    // Private mode / quota — resume just falls back to feed 1 next visit.
  }
}

// True when the touch began inside an element that can itself scroll
// horizontally (§VI hazard 2) — the pager must leave that gesture alone.
function beganInHorizontalScroller(
  start: HTMLElement,
  root: HTMLElement,
): boolean {
  let cur: HTMLElement | null = start;
  while (cur && cur !== root) {
    if (cur.scrollWidth > cur.clientWidth + 1) {
      const { overflowX } = getComputedStyle(cur);
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

interface MobileWorkspaceProps {
  /** Visible feeds in rank order — the swipe sequence. Hidden feeds are
   *  excluded upstream (§V), so the pip POSITIONS are gapless 1..N. The spoken
   *  feed NUMBER is not (NAV-ROW-MUSTER-ADR §III: the numeral is stable
   *  identity, so it gap-numbers on the gapless strip) — the aria-label
   *  announces both. */
  feeds: WorkspaceFeed[];
  /** Stable identity numeral for a feed (NAV-ROW-MUSTER-ADR §III) — matches the
   *  desktop badge and the FeedComposer rank list, gaps and all. Spoken in the
   *  aria-label alongside the gapless pip position; does not drive the swipe. */
  numeralFor: (feedId: string) => number;
  /** Stable per-user key for resume-by-id. */
  userId: string;
  /** Interior ground colour for a feed's page (its scheme's interior). */
  interiorFor: (feedId: string) => string;
  /** The feed's card list — the same children the desktop vessel renders. */
  renderFeedContents: (feedId: string) => ReactNode;
  onRefresh: (feedId: string) => Promise<void>;
  onLoadMore: (feedId: string) => void;
  /** Open the per-feed settings sheet (the FeedComposer). */
  onOpenFeedSettings: (feedId: string) => void;
}

export function MobileWorkspace({
  feeds,
  numeralFor,
  userId,
  interiorFor,
  renderFeedContents,
  onRefresh,
  onLoadMore,
  onOpenFeedSettings,
}: MobileWorkspaceProps) {
  const ids = feeds.map((f) => f.id);
  const count = ids.length;

  const [activeId, setActiveId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readResume(userId),
  );
  // Resolve the active page: resume id when it still exists and is visible,
  // else the first feed. Index derives from id on every render, so reorder /
  // hide / delete keep the same feed under the reader's thumb when possible.
  const activeIndex = activeId ? Math.max(0, ids.indexOf(activeId)) : 0;

  // Keyed on the id string, not the `ids` array (fresh identity every render)
  // — otherwise this writes localStorage on every render.
  //
  // Only persist when the displayed feed is the chosen one (or nothing was
  // chosen yet). When the resume feed is hidden, display falls back to feed 1
  // but the stored id must survive so un-hiding restores the reader's spot —
  // an explicit swipe sets activeId to a visible feed and resumes writing.
  const activeFeedId = ids[activeIndex];
  useEffect(() => {
    if (activeFeedId && (activeId === null || activeId === activeFeedId))
      writeResume(userId, activeFeedId);
  }, [activeFeedId, activeId, userId]);

  // Publish the feed under the reader's thumb so the ∀ menu can offer a
  // feed-scoped "Feed settings" row relativised to it (the discoverable twin of
  // tapping the active pip). Cleared on unmount so the desktop canvas — where
  // there is no single active feed — never shows the row.
  const setMobileActiveFeed = useMobileActiveFeed((s) => s.set);
  useEffect(() => {
    setMobileActiveFeed(activeFeedId ?? null);
  }, [activeFeedId, setMobileActiveFeed]);
  useEffect(() => () => setMobileActiveFeed(null), [setMobileActiveFeed]);

  const pagerRef = useRef<HTMLDivElement>(null);
  // The in-flight drag writes its transform straight to the track element —
  // a setState per touchmove would re-render every mounted page (every card
  // on every feed) per pixel of swipe. React only renders the settled
  // per-page positions; `settleTrack` normalises the DOM back to that form
  // whenever a gesture ends or is abandoned.
  const trackRef = useRef<HTMLDivElement>(null);

  // Gesture state lives in refs so the native listeners attach once; the
  // commit path reads the live index/count through refs too.
  const gestureRef = useRef({
    startX: 0,
    startY: 0,
    claimed: false,
    rejected: false,
    lastX: 0,
    lastT: 0,
    vx: 0,
  });
  const dragDxRef = useRef(0);
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const countRef = useRef(count);
  countRef.current = count;
  const jumpRef = useRef<(index: number) => void>(() => {});
  jumpRef.current = (index: number) => {
    const next = Math.max(0, Math.min(count - 1, index));
    if (ids[next]) setActiveId(ids[next]);
  };

  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;

    // Animate the track to a settled page position (also normalises away any
    // in-flight drag offset written directly to the element).
    function settleTrack(index: number) {
      const track = trackRef.current;
      const n = countRef.current;
      if (!track || n < 1) return;
      track.style.transition = "transform 240ms ease-out";
      track.style.transform = `translateX(${(-index * 100) / n}%)`;
    }

    function onTouchStart(e: TouchEvent) {
      const s = gestureRef.current;
      if (s.claimed) {
        // A second finger landed mid page-turn: the gesture is abandoned, so
        // settle the track back — touchend will early-return as unclaimed and
        // must not strand the track translated part-way between pages.
        dragDxRef.current = 0;
        settleTrack(activeIndexRef.current);
      }
      s.claimed = false;
      s.vx = 0;
      if (e.touches.length !== 1 || countRef.current < 2) {
        s.rejected = true;
        return;
      }
      const t = e.touches[0];
      s.startX = t.clientX;
      s.startY = t.clientY;
      s.lastX = t.clientX;
      s.lastT = performance.now();
      const target = e.target as HTMLElement | null;
      s.rejected =
        !!target &&
        (!!target.closest?.("[data-pip-trigger]") ||
          beganInHorizontalScroller(target, el!));
    }

    function onTouchMove(e: TouchEvent) {
      const s = gestureRef.current;
      if (s.rejected) return;
      const t = e.touches[0];
      const dx = t.clientX - s.startX;
      const dy = t.clientY - s.startY;
      if (!s.claimed) {
        // Axis lock: mostly-vertical hands the gesture to the feed's scroll
        // for good; decisively-horizontal claims it for the pager.
        if (Math.abs(dy) > REJECT_PX && Math.abs(dy) >= Math.abs(dx)) {
          s.rejected = true;
          return;
        }
        if (Math.abs(dx) > CLAIM_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
          s.claimed = true;
          if (trackRef.current) trackRef.current.style.transition = "none";
        } else {
          return;
        }
      }
      e.preventDefault();
      const now = performance.now();
      if (now > s.lastT) s.vx = (t.clientX - s.lastX) / (now - s.lastT);
      s.lastX = t.clientX;
      s.lastT = now;
      // Rubber-band past the first/last page.
      const i = activeIndexRef.current;
      const n = countRef.current;
      const atEdge = (i === 0 && dx > 0) || (i === n - 1 && dx < 0);
      const eff = atEdge ? dx * 0.3 : dx;
      dragDxRef.current = eff;
      if (trackRef.current)
        trackRef.current.style.transform = `translateX(calc(${(-i * 100) / n}% + ${eff}px))`;
    }

    function onTouchEnd() {
      const s = gestureRef.current;
      const wasClaimed = s.claimed;
      s.claimed = false;
      s.rejected = false;
      if (!wasClaimed) return;
      const dx = dragDxRef.current;
      const vw = el!.clientWidth || 1;
      const fling = Math.abs(s.vx) > FLING_VX;
      let dir = 0;
      if (dx < -vw * COMMIT_FRACTION || (fling && s.vx < 0 && dx < -FLING_MIN_PX))
        dir = 1;
      else if (
        dx > vw * COMMIT_FRACTION ||
        (fling && s.vx > 0 && dx > FLING_MIN_PX)
      )
        dir = -1;
      dragDxRef.current = 0;
      const target = Math.max(
        0,
        Math.min(countRef.current - 1, activeIndexRef.current + dir),
      );
      settleTrack(target);
      if (target !== activeIndexRef.current) jumpRef.current(target);
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    // Non-passive: once claimed, each move preventDefaults to keep the feed's
    // vertical scroll (and pull-to-refresh) out of a horizontal page-turn.
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  return (
    <>
      {/* The thin mobile bar — NOT the black <Nav> (§III): every affordance
          here opens an overlay or sheet; none navigates to a platform route.
          The ∀ trigger itself is docked into the bar's right end by
          ForallMenu anchor="bar" (rendered by WorkspaceView at z-60).

          PERSISTENT CHROME: `position: fixed` at z-58 — above every Glasshouse
          pane (scrim z-[55] / pane z-[56], inset below the bar on mobile) but
          below the ∀ disc (z-60). So the bar (and the ∀ on it) stays in place in
          ALL mobile views — over any open sheet, at any scroll position — never
          hidden by an overlay. Floor's `overflow:hidden` can't clip a fixed
          child (no transformed ancestor), and Floor sets no z-index, so this
          z-58 competes at the root against the panes. */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: MOBILE_BAR_H,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 56px 0 12px", // right clears the docked ∀ disc
          background: "var(--ah-bone)",
          zIndex: 58,
        }}
      >
        <span
          className="font-sans text-[15px] font-medium leading-none flex-shrink-0 select-none"
          style={{ color: "var(--ah-ink)", letterSpacing: "-0.01em" }}
          aria-label="all.haus"
        >
          all.haus
        </span>

        {/* Indicator strip (§IV) — the visible form of the rank order, a row of
            pips rather than numerals: the filled pip's ordinal position is the
            active feed. Tap a pip to jump; tap the active pip to open that
            feed's settings sheet (the FeedComposer — §VI). */}
        <div
          role="tablist"
          aria-label={`Feeds, ${activeIndex + 1} of ${count}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            marginLeft: "auto",
            overflowX: "auto",
            scrollbarWidth: "none",
          }}
        >
          {feeds.map((f, i) => {
            const isActive = i === activeIndex;
            const name = f.name.trim();
            // Stable identity number (may have gaps) AND gapless strip position
            // (NAV-ROW-MUSTER-ADR §III.1): "Feed 4, 3 of 4" — the number matches
            // the desktop badge, the position tells a linear scan where it is.
            const label = `Feed ${numeralFor(f.id)}, ${i + 1} of ${count}${
              name ? `: ${name}` : ""
            }`;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={isActive ? `${label} — feed settings` : `Go to ${label}`}
                onClick={() =>
                  isActive ? onOpenFeedSettings(f.id) : jumpRef.current(i)
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  // Generous touch target around a small visible pip.
                  width: 16,
                  height: 28,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {/* The active pip elongates into a pill; inactive pips are dots.
                    Position in the row is the ordinal — no numeral needed. */}
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    height: 6,
                    width: isActive ? 16 : 6,
                    borderRadius: 3,
                    background: isActive
                      ? "var(--ah-ink)"
                      : "var(--ah-stone-350)",
                    transition:
                      "width 160ms ease-out, background 160ms ease-out",
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* The pager — full-bleed active feed below the bar. All pages stay
          mounted (the desktop canvas mounts every vessel too); the track
          slides between them. */}
      <div
        ref={pagerRef}
        style={{
          position: "absolute",
          top: MOBILE_BAR_H,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
        }}
      >
        {count === 0 ? (
          <div
            className="label-ui text-center"
            style={{
              color: "var(--ah-stone-350)",
              position: "absolute",
              top: "50%",
              left: 24,
              right: 24,
              transform: "translateY(-50%)",
            }}
          >
            ALL FEEDS HIDDEN — RESTORE THEM FROM THE ∀ MENU
          </div>
        ) : (
          <div
            ref={trackRef}
            style={{
              display: "flex",
              height: "100%",
              width: `${count * 100}%`,
              transform: `translateX(${(-activeIndex * 100) / count}%)`,
              transition: "transform 240ms ease-out",
              willChange: "transform",
            }}
          >
            {feeds.map((f) => (
              <div
                key={f.id}
                style={{
                  // Island the page like a desktop vessel: the feed renders its
                  // colourway's light/dark variant (chosen by paletteFor in the
                  // parent), and the island keeps the derived text slugs the
                  // palette references resolving canonical regardless of mode.
                  // The mobile bar above is NOT islanded — it is global chrome
                  // and inverts with the toggle.
                  ...LIGHT_ISLAND_STYLE,
                  width: `${100 / count}%`,
                  height: "100%",
                  overflowY: "auto",
                  WebkitOverflowScrolling: "touch",
                  background: interiorFor(f.id),
                }}
                onScroll={(e) => {
                  const sc = e.currentTarget;
                  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 320)
                    onLoadMore(f.id);
                }}
              >
                <PullToRefresh onRefresh={() => onRefresh(f.id)}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                      padding: 16,
                    }}
                  >
                    {renderFeedContents(f.id)}
                  </div>
                </PullToRefresh>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
