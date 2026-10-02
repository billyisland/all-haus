// =============================================================================
// preserveCardPosition — hold one card still while the list around it changes.
// captureCardAnchor / restoreCardAnchor — put a list back where the reader
// left it after its scroller was unmounted.
//
// The workspace feed is CHRONOLOGICAL (since migration 202), but a list still
// changes above the reader's eye: posts pulled into a conversation are weeded
// on collapse wherever they sat, and a refresh merges new posts in at the top.
// Either way the card the reader was on moves, and the scroll offset that
// pointed at it now points at something else.
//
// The browser's own scroll anchoring solves the in-place case — in Chrome and
// Firefox. Safari implements none of it, so the jump is real there and
// `preserveCardPosition` is the compensation: measure the anchor card's
// viewport top before the change, and after it scroll the scroller by however
// far the card moved.
//
// The anchor pair is for the case no browser covers: the queue unmounts a
// feed's card tree when it walks away (WORKSPACE-QUEUE-ADR §VI.2), so there is
// no scroller left to anchor, and a raw `scrollTop` saved from it points at the
// wrong card as soon as anything lands above. So the position is kept as the
// CARD the reader was on and how far it sat from the top edge, and put back by
// finding that card again in the remounted list. `scrollTop` rides along as the
// fallback for a card that has gone.
//
// Two things none of these assume. The anchor NODE is not stable — collapsing
// swaps the focal card for the feed card, a remount builds a new one — so it
// is re-found by id rather than held as a reference. And the scroller is a
// PARAMETER wherever the caller knows it (`.claude/rules/posts.md` › anything
// that measures scroll takes its container): the queue has up to three lists
// mounted at once, and the same post can be a card in two of them. Only the
// compensator's caller without one — the mobile page, which scrolls the
// document — still walks up.
// =============================================================================

/** The nearest ancestor that actually scrolls vertically, or null where the
 *  document does. Also used by PostThread's rail pointers. */
export function scrollParent(el: Element): HTMLElement | null {
  let cur = el.parentElement;
  while (cur) {
    const overflowY = getComputedStyle(cur).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      cur.scrollHeight > cur.clientHeight
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null; // the document scrolls
}

// The same post can be a card in two feeds at once, so an id is not unique in
// the document. Scoped to a scroller, take the first there; unscoped, take the
// match nearest the viewport's middle — on any surface where this is called,
// that is the one the reader is looking at.
function findCard(postId: string, scope?: HTMLElement): HTMLElement | null {
  const matches = Array.from(
    (scope ?? document).querySelectorAll<HTMLElement>(
      `[data-post-id="${CSS.escape(postId)}"]`,
    ),
  ).filter((el) => !scope || isOutermost(el, scope));
  if (matches.length === 0) return null;
  if (matches.length === 1 || scope) return matches[0];
  const mid = window.innerHeight / 2;
  let best = matches[0];
  let bestDist = Infinity;
  for (const el of matches) {
    const r = el.getBoundingClientRect();
    const dist = Math.abs(r.top + r.height / 2 - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }
  return best;
}

// A card inside another card (a post rendered within one) is not a place in
// the list; the card around it is. Without this, a post quoted higher up and
// shown as its own card lower down would restore to the quote.
function isOutermost(el: HTMLElement, scope: HTMLElement): boolean {
  const outer = el.parentElement?.closest("[data-post-id]");
  return !outer || !scope.contains(outer);
}

/**
 * Measure now; call the returned function once the DOM has settled to put the
 * card back where it was. A no-op when the card cannot be found on either side.
 * Pass the scroller when you know it; without one the card is found anywhere
 * in the document and its scroller by walking up.
 */
export function preserveCardPosition(
  postId: string,
  scroller?: HTMLElement | null,
): () => void {
  if (typeof window === "undefined") return () => {};
  const scope = scroller ?? undefined;
  const before = findCard(postId, scope);
  if (!before) return () => {};
  const top = before.getBoundingClientRect().top;
  const target = scroller ?? scrollParent(before);
  return () => {
    const after = findCard(postId, scope);
    if (!after) return;
    const delta = after.getBoundingClientRect().top - top;
    if (Math.abs(delta) < 1) return;
    if (target) target.scrollTop += delta;
    else window.scrollBy(0, delta);
  };
}

/** Where a reader was in a list: the card at the top edge and how far it sat
 *  from it (negative when it started above), with the raw offset as the
 *  fallback for a card that is no longer there. */
export interface CardAnchor {
  postId: string | null;
  offset: number;
  scrollTop: number;
}

/**
 * The first card whose bottom is below the scroller's top edge — the one the
 * reader is on — and its top's distance from that edge. Measured against the
 * scroller's own box, so where the scroller sits on screen does not matter.
 */
export function captureCardAnchor(scroller: HTMLElement): CardAnchor {
  const edge = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-post-id]")) {
    if (!isOutermost(el, scroller)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= edge) continue;
    return {
      postId: el.dataset.postId ?? null,
      offset: r.top - edge,
      scrollTop: scroller.scrollTop,
    };
  }
  return { postId: null, offset: 0, scrollTop: scroller.scrollTop };
}

/**
 * Put the anchor's card back at its offset from the top edge. Returns false
 * when the card is not in the list and the raw offset was used instead.
 */
export function restoreCardAnchor(
  scroller: HTMLElement,
  anchor: CardAnchor,
): boolean {
  const card = anchor.postId ? findCard(anchor.postId, scroller) : null;
  if (!card) {
    scroller.scrollTop = anchor.scrollTop;
    return false;
  }
  const edge = scroller.getBoundingClientRect().top;
  scroller.scrollTop += card.getBoundingClientRect().top - edge - anchor.offset;
  return true;
}
