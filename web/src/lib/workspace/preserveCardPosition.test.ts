// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  captureCardAnchor,
  preserveCardPosition,
  restoreCardAnchor,
} from "./preserveCardPosition";

// WORKSPACE-QUEUE-ADR §VI.2 / §VII.3: a list's position outlives its mount as
// the CARD the reader was on and its offset from the top edge, not as a raw
// `scrollTop`. jsdom lays nothing out, so the scroller below is a small layout
// model: each card has a height, cards stack with no gap, and every rect is
// derived from `scrollTop` the way a browser's would be.
//
// MUTATION LOG (each applied to preserveCardPosition.ts, the suite re-run,
// reverted):
//   1. capture takes the first card at all (drop the `bottom <= edge` skip)
//      ⇒ "takes the card at the top edge" and "survives posts merged above"
//      fail.                                                        DETECTED
//   2. restore sets `scrollTop = anchor.scrollTop` even when the card is
//      found ⇒ "survives posts merged above" fails.                 DETECTED
//   3. `isOutermost` always true ⇒ "restores to the card, not a quote of it"
//      fails.                                                       DETECTED
//   4. the scoped `findCard` searches the document ⇒ "holds the card in the
//      scroller it is given" fails.                                 DETECTED

// jsdom has no CSS.escape; the ids here need none.
const g = globalThis as { CSS?: { escape?: (s: string) => string } };
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s;

const EDGE = 100; // the scroller's top on screen
const VIEW = 400;

interface Model {
  scroller: HTMLElement;
  setCards: (cards: { id: string; h: number; quotes?: string }[]) => void;
}

function makeScroller(): Model {
  const scroller = document.createElement("div");
  let scrollTop = 0;
  let heights = new Map<Element, number>();
  const maxTop = () =>
    Math.max(0, [...heights.values()].reduce((a, b) => a + b, 0) - VIEW);
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.min(Math.max(0, v), maxTop());
    },
  });
  scroller.getBoundingClientRect = () =>
    ({ top: EDGE, bottom: EDGE + VIEW, height: VIEW }) as DOMRect;
  document.body.appendChild(scroller);

  const layoutTop = (el: Element): number => {
    let y = 0;
    for (const c of scroller.children) {
      if (c === el || c.contains(el)) return y + (c === el ? 0 : 8);
      y += heights.get(c) ?? 0;
    }
    return NaN;
  };

  return {
    scroller,
    setCards(cards) {
      scroller.replaceChildren();
      heights = new Map();
      for (const c of cards) {
        const el = document.createElement("div");
        el.dataset.postId = c.id;
        if (c.quotes) {
          const q = document.createElement("div");
          q.dataset.postId = c.quotes;
          q.getBoundingClientRect = () => {
            const top = EDGE + layoutTop(q) - scrollTop;
            return { top, bottom: top + 20, height: 20 } as DOMRect;
          };
          el.appendChild(q);
        }
        el.getBoundingClientRect = () => {
          const top = EDGE + layoutTop(el) - scrollTop;
          return { top, bottom: top + c.h, height: c.h } as DOMRect;
        };
        heights.set(el, c.h);
        scroller.appendChild(el);
      }
    },
  };
}

const cards = (ids: string[], h = 100) => ids.map((id) => ({ id, h }));

let m: Model;
beforeEach(() => {
  m = makeScroller();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("captureCardAnchor", () => {
  it("takes the card at the top edge, with its offset from it", () => {
    m.setCards(cards(["a", "b", "c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 230; // a, b gone; c's top 30px above the edge
    expect(captureCardAnchor(m.scroller)).toEqual({
      postId: "c",
      offset: -30,
      scrollTop: 230,
    });
  });

  it("does not take a card whose bottom sits exactly on the edge", () => {
    m.setCards(cards(["a", "b", "c", "d", "e", "f"]));
    m.scroller.scrollTop = 100;
    expect(captureCardAnchor(m.scroller).postId).toBe("b");
  });

  it("names no card in an empty list, and keeps the offset", () => {
    m.setCards([]);
    expect(captureCardAnchor(m.scroller)).toEqual({
      postId: null,
      offset: 0,
      scrollTop: 0,
    });
  });
});

describe("restoreCardAnchor", () => {
  it("survives posts merged above — the case a raw scrollTop gets wrong", () => {
    m.setCards(cards(["a", "b", "c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 230;
    const anchor = captureCardAnchor(m.scroller);

    // The list remounts with three new posts at the top, at the top.
    m.setCards(cards(["n1", "n2", "n3", "a", "b", "c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 0;
    expect(restoreCardAnchor(m.scroller, anchor)).toBe(true);

    expect(m.scroller.scrollTop).toBe(530);
    expect(captureCardAnchor(m.scroller)).toMatchObject({
      postId: "c",
      offset: -30,
    });
  });

  it("falls back to the raw offset when the card has gone", () => {
    m.setCards(cards(["a", "b", "c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 230;
    const anchor = captureCardAnchor(m.scroller);
    m.setCards(cards(["a", "b", "d", "e", "f", "g", "h"]));
    m.scroller.scrollTop = 0;
    expect(restoreCardAnchor(m.scroller, anchor)).toBe(false);
    expect(m.scroller.scrollTop).toBe(230);
  });

  it("restores to the card, not a quote of it higher up", () => {
    m.setCards(cards(["a", "b", "c", "d", "e", "f", "g", "h", "i"]));
    m.scroller.scrollTop = 400; // e at the edge
    const anchor = captureCardAnchor(m.scroller);
    expect(anchor.postId).toBe("e");

    m.setCards([
      { id: "a", h: 100, quotes: "e" },
      ...cards(["b", "c", "d", "e", "f", "g", "h", "i"]),
    ]);
    m.scroller.scrollTop = 0;
    restoreCardAnchor(m.scroller, anchor);
    expect(m.scroller.scrollTop).toBe(400);
  });
});

describe("preserveCardPosition", () => {
  it("holds the card in the scroller it is given, when another list has it too", () => {
    // The other list comes FIRST in the document, so a search that ignored
    // the scroller would find its card before this one.
    const other = makeScroller();
    document.body.prepend(other.scroller);
    other.setCards(cards(["x", "y", "c", "z", "w", "v"]));
    other.scroller.scrollTop = 0;

    m.setCards(cards(["a", "b", "c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 230;
    const restore = preserveCardPosition("c", m.scroller);
    // Two cards above c are weeded.
    m.setCards(cards(["c", "d", "e", "f", "g"]));
    m.scroller.scrollTop = 230;
    restore();
    expect(m.scroller.scrollTop).toBe(30);
    expect(other.scroller.scrollTop).toBe(0);
  });
});
