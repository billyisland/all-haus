// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// WORKSPACE-QUEUE-ADR §VII.4. The compact bar drops its pills' words where
// they do not fit, and the room it fits them against is the `width` prop —
// never the bar's live width, which the binding sets to a line's (0) or the
// focal's through a step. jsdom lays nothing out, so every live width here
// is 0: exactly a bar mounted on a line wash.
//
// MUTATION LOG (each applied to QueueBar.tsx, the suite re-run, reverted):
//   1. (2026-09-27) the room read from `bar.clientWidth` again ⇒ "keeps the
//      words where they fit" fails (the line-wash mount).        DETECTED
//   2. `width` dropped from the fit key ⇒ "tries again at a new width,
//      either way" fails (narrow → wide keeps the words dropped).
//                                                                 DETECTED

vi.mock("../../../stores/feedSeen", () => ({
  useFeedSeenCounts: () => ({
    new: 2,
    unread: 8,
    truncated: false,
    newTruncated: false,
  }),
}));

/** What the pills measure, whatever the bar's width. */
const PILLS_W = 120;

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  // A pill asks whether motion is reduced, and so does framer.
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return PILLS_W;
    },
  });
});

const { QueueBar } = await import("./QueueBar");
const { paletteFor } = await import("../tokens");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function bar(width: number) {
  return (
    <QueueBar
      palette={paletteFor("basic", false)}
      label="Feed 1: Test"
      width={width}
      widthAt={() => width}
      onWalk={() => {}}
      feedId="f1"
    />
  );
}

function render(width: number): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(bar(width)));
  return host;
}

/** A bare pill carries its word in `title`. */
const isBare = (h: HTMLElement) => h.querySelector("[title]") !== null;

describe("QueueBar — the words' fit", () => {
  it("keeps the words where they fit, whatever the bar's live width", () => {
    const h = render(300);
    expect(h.textContent).toMatch(/new/i);
    expect(isBare(h)).toBe(false);
  });

  it("drops the words where they do not fit", () => {
    const h = render(150);
    expect(isBare(h)).toBe(true);
  });

  it("tries again at a new width, either way", () => {
    const h = render(300);
    expect(isBare(h)).toBe(false);
    act(() => root!.render(bar(150)));
    expect(isBare(h)).toBe(true);
    // Wider again: the words come back, because the fit is keyed on width.
    act(() => root!.render(bar(300)));
    expect(isBare(h)).toBe(false);
  });
});
