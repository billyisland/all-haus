import { useEffect, type RefObject } from "react";
import { useFeedSeen } from "../stores/feedSeen";

// =============================================================================
// usePassTracker — a feed card becomes PASSED when the reader WATCHES it leave
// through the top of its scroller (WORKSPACE-QUEUE-ADR §IV.7).
//
// "Watched" is the rule, not a detail. An IntersectionObserver fires an initial
// report for every element it starts observing, and a card already above the
// top edge at that moment satisfies the geometric test. Cards sit there
// whenever the view was PUT there rather than scrolled there — a restored
// scroll position, `preserveCardPosition` compensating for rows weeded above —
// and marking them would pass posts the reader never had on screen. So:
//
//   · a card's FIRST report arms nothing and marks nothing;
//   · a later report with the card intersecting ARMS it;
//   · an armed card whose exit report puts its trailing edge at or above the
//     scroller's leading edge (top; left for a ⊐ vessel) is marked and
//     unobserved;
//   · an exit the other way disarms it. A card carried from below the view to
//     above it in one jump (End, a scrollbar drag) was never on screen and is
//     not marked.
//
// Because the first report is spent, a card needs a SECOND crossing to arm, so
// the observer takes several thresholds: a card fully in view at attach arms
// the moment it starts to leave (it falls below 1), and a card too tall ever to
// be wholly in view arms on the small ones. Both err toward counting more.
//
// The scroller is passed EXPLICITLY — nothing inside the workspace may assume
// the document scrolls (`.claude/rules/posts.md` › scroll takes its container).
// Only elements carrying `data-seen-at` are tracked: the feed card shell sets
// it, and the cards inside an expanded conversation do not, because expanding a
// conversation never marks anything passed (§IV.7).
//
// Passed is EXPOSURE, not attention: nothing here touches the reading log
// (§IV.6).
// =============================================================================

const THRESHOLDS = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.99, 1];
const TRACKED = "[data-seen-at]";

export function usePassTracker(
  scrollerRef: RefObject<HTMLElement>,
  feedId: string,
  opts: { enabled: boolean; horizontal: boolean },
): void {
  const { enabled, horizontal } = opts;
  useEffect(() => {
    if (!enabled) return;
    const root = scrollerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    const observed = new WeakSet<Element>();
    const reported = new WeakSet<Element>();
    const armed = new WeakSet<Element>();

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target;
          // A card REMOVED from the list (weeded on a collapse, dropped by a
          // refresh) reports a zero rect, which would read as "above the top".
          if (!el.isConnected) {
            armed.delete(el);
            io.unobserve(el);
            continue;
          }
          // The initial report: geometry the reader did not produce.
          if (!reported.has(el)) {
            reported.add(el);
            continue;
          }
          if (e.isIntersecting) {
            armed.add(el);
            continue;
          }
          if (!armed.has(el)) continue;
          armed.delete(el);
          const bounds = e.rootBounds;
          if (!bounds) continue;
          const gone = horizontal
            ? e.boundingClientRect.right <= bounds.left
            : e.boundingClientRect.bottom <= bounds.top;
          if (!gone) continue;
          const postId = (el as HTMLElement).dataset.postId;
          const at = Number((el as HTMLElement).dataset.seenAt);
          if (!postId) continue;
          io.unobserve(el);
          useFeedSeen
            .getState()
            .markPassed(feedId, postId, Number.isFinite(at) ? at : undefined);
        }
      },
      { root, threshold: THRESHOLDS },
    );

    const observeAll = () => {
      for (const el of root.querySelectorAll(TRACKED)) {
        if (observed.has(el)) continue;
        observed.add(el);
        io.observe(el);
      }
    };
    observeAll();
    // Pages arrive, a conversation collapses back into its card, a refresh
    // swaps the list: each brings shells the observer has not met.
    const mo = new MutationObserver(observeAll);
    mo.observe(root, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, [scrollerRef, feedId, enabled, horizontal]);
}
