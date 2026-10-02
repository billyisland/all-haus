import { describe, it, expect } from "vitest";
import { isSeenEnough, SEEN_MIN_PX } from "../src/lib/post/seen";

// The thing this predicate exists to refuse. Weeding is destructive from the
// reader's side — the card leaves their feed — so the cases that must answer
// FALSE carry the same weight as the ones that must answer true. A suite of
// positives alone passes green against `() => true`, which is precisely the
// "rendered, not seen" bug.
describe("isSeenEnough", () => {
  it("refuses a card that has only just crossed into view", () => {
    expect(
      isSeenEnough({ ratio: 0.01, visibleHeight: 3, cardHeight: 300 }),
    ).toBe(false);
  });

  it("refuses a tall card showing less than the minimum run", () => {
    expect(
      isSeenEnough({
        ratio: 0.05,
        visibleHeight: SEEN_MIN_PX - 1,
        cardHeight: 900,
      }),
    ).toBe(false);
  });

  it("accepts a short card that is halfway in", () => {
    expect(
      isSeenEnough({ ratio: 0.5, visibleHeight: 60, cardHeight: 120 }),
    ).toBe(true);
  });

  // The arm a ratio-only predicate silently lacks: this card can never reach
  // half a viewport, so without it a reader could sit in a long focal post for
  // a minute and it would never count as read.
  it("accepts a tall card showing the minimum run, well below half", () => {
    expect(
      isSeenEnough({ ratio: 0.2, visibleHeight: SEEN_MIN_PX, cardHeight: 900 }),
    ).toBe(true);
  });

  // The converse arm, and the ONLY fixture that reaches it. `ratio` is an AREA
  // fraction, not a height one, so a short card whose full height is on screen
  // can still report a low ratio when something clips it horizontally — which a
  // horizontal vessel does. Without the `min`, such a card is held to a run
  // taller than it will ever be and can never be seen. A test using a
  // vertically-clipped short card cannot catch that: there, ratio >= 0.5 holds
  // whenever the height test would, and the first arm answers before this one
  // is ever consulted (verified by mutation — dropping the `min` left a
  // ratio-only suite entirely green).
  it("accepts a short card showing its whole height but clipped horizontally", () => {
    expect(isSeenEnough({ ratio: 0.3, visibleHeight: 40, cardHeight: 40 })).toBe(
      true,
    );
  });

  it("refuses a zero-height card rather than dividing by it", () => {
    expect(isSeenEnough({ ratio: 0, visibleHeight: 0, cardHeight: 0 })).toBe(
      false,
    );
  });
});
