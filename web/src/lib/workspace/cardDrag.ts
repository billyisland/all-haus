// =============================================================================
// Card-drag signal — the HTML5 "drag a card into another feed" gesture.
//
// The payload rides `dataTransfer` under CARD_DRAG_MIME, but `getData` is
// deliberately unreadable during `dragover` (the browser only releases it on
// drop), so a vessel cannot tell from the event alone whether the card came
// from itself. Without that, every vessel — including the one the card is being
// dragged OUT of — lights up as a target, which is exactly the feedback that
// makes the real targets hard to pick out.
//
// So the origin feed is published here for the life of the gesture: set on
// dragstart, cleared on dragend. Module-level because a drag is singular by
// construction (one pointer, one payload) and the two ends of it live in
// different component trees (post/chassis → workspace/Vessel).
// =============================================================================

export const CARD_DRAG_MIME = "application/x-vessel-card";

let originFeedId: string | null = null;

export function beginCardDrag(feedId: string | undefined) {
  originFeedId = feedId ?? null;
}

export function endCardDrag() {
  originFeedId = null;
}

/** The feed the in-flight card came from, or null when no card drag is live. */
export function cardDragOrigin(): string | null {
  return originFeedId;
}
