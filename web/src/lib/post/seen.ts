// =============================================================================
// The seen predicate — what counts as having READ a post inside a conversation.
//
// The workspace weeds a conversation's bystanders out of the feed when it
// collapses, so this is the line between "the reader has already had this" and
// "we are about to delete something they never saw". A thread mounts its whole
// ancestor chain and a page of replies at once, and a reader who reads three
// and closes has not read the rest — so RENDERED is not the test, and a
// predicate that answered `true` for anything mounted would be the same class
// of bug as every other place in this repo where an absence gets the
// reassuring reading.
//
// TWO ARMS, and the second is the substance. Half the card in view is the
// ordinary answer. But a card too tall to ever reach half a viewport — a long
// focal, an article at the head of a chain — would then never be seen however
// long the reader spent in it, so a fixed run of it counts instead. A suite
// that tests only the ratio arm passes green against a predicate with no tall
// arm at all, and vice versa; both need their own fixtures, and so does the
// barely-peeking case that separates either from "rendered".
// =============================================================================

// A card showing at least this much of itself has been put in front of the
// reader, whatever fraction of the whole that is.
export const SEEN_MIN_PX = 120;

export function isSeenEnough({
  ratio,
  visibleHeight,
  cardHeight,
}: {
  // IntersectionObserver's intersectionRatio.
  ratio: number;
  // intersectionRect.height — how much of the card is actually on screen.
  visibleHeight: number;
  // boundingClientRect.height — the card's full height.
  cardHeight: number;
}): boolean {
  if (cardHeight <= 0) return false;
  if (ratio >= 0.5) return true;
  // `min` so a card SHORTER than the run isn't held to a bar it cannot clear.
  // It looks redundant beside the ratio arm and is not: `ratio` is an AREA
  // fraction, so a short card whose whole HEIGHT is on screen still reports a
  // low ratio when something clips it horizontally — which a horizontal vessel
  // does. That is the only case this term decides, and it is the only case a
  // mutation of it can be caught by; see the test's note.
  return visibleHeight >= Math.min(cardHeight, SEEN_MIN_PX);
}
