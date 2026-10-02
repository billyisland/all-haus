// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

// WORKSPACE-QUEUE-ADR §IV.7: a card is passed only when the reader WATCHED it
// leave through the top. The observer is scripted, so each case states exactly
// which reports the browser delivered and in what order — the thing that
// decides the rule, and the thing a real layout engine would not let a test
// choose.
//
// MUTATION LOG (each applied to usePassTracker.ts, the suite re-run, reverted):
//   1. the first-report skip removed ⇒ "the first report never marks, even
//      if the view then jumps past it" fails.                       DETECTED
//   2. `armed.has` check removed ⇒ "a card put above the view", "the first
//      report never marks" and "an exit through the bottom" fail.   DETECTED
//   3. the isConnected guard removed ⇒ "a card removed while armed is not
//      passed" fails.                                               DETECTED

const markPassed = vi.hoisted(() => vi.fn());
vi.mock("../stores/feedSeen", () => ({
  useFeedSeen: { getState: () => ({ markPassed }) },
}));

const { usePassTracker } = await import("./usePassTracker");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// ---- a scripted IntersectionObserver ----------------------------------------

type Cb = (entries: IntersectionObserverEntry[]) => void;
let observer: { cb: Cb; targets: Set<Element> } | null = null;

class FakeIO {
  private rec: { cb: Cb; targets: Set<Element> };
  constructor(cb: Cb) {
    this.rec = { cb, targets: new Set() };
    observer = this.rec;
  }
  observe(el: Element) {
    this.rec.targets.add(el);
  }
  unobserve(el: Element) {
    this.rec.targets.delete(el);
  }
  disconnect() {
    this.rec.targets.clear();
  }
}

const ROOT = { top: 100, left: 50, bottom: 600, right: 450 };

/** Deliver one report for `el`. `edge` is where its trailing edge sits. */
function report(
  el: Element,
  r: { intersecting: boolean; bottom?: number; right?: number },
) {
  if (!observer) throw new Error("no observer");
  if (!observer.targets.has(el)) return;
  const entry = {
    target: el,
    isIntersecting: r.intersecting,
    rootBounds: ROOT,
    boundingClientRect: {
      bottom: r.bottom ?? 300,
      right: r.right ?? 300,
    },
  } as unknown as IntersectionObserverEntry;
  act(() => observer!.cb([entry]));
}

const ABOVE = { intersecting: false, bottom: 90 }; // wholly above the top
const BELOW = { intersecting: false, bottom: 900 }; // wholly below the bottom
const IN = { intersecting: true, bottom: 300 };

// ---- the host ----------------------------------------------------------------

function Host({
  ids,
  horizontal = false,
  untracked = [],
}: {
  ids: string[];
  horizontal?: boolean;
  untracked?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePassTracker(ref, "feed-1", { enabled: true, horizontal });
  return (
    <div ref={ref}>
      {ids.map((id) => (
        <div key={id} data-post-id={id} data-seen-at="1700000000" />
      ))}
      {untracked.map((id) => (
        <div key={id} data-post-id={id} />
      ))}
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;

function mount(el: React.ReactElement) {
  act(() => root.render(el));
}
const card = (id: string) =>
  host.querySelector(`[data-post-id="${id}"]`) as Element;

beforeEach(() => {
  markPassed.mockReset();
  observer = null;
  vi.stubGlobal("IntersectionObserver", FakeIO);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("usePassTracker", () => {
  it("passes a card watched leaving through the top", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), BELOW); // initial report: arms nothing
    report(card("a"), IN); // scrolled into view: armed
    report(card("a"), ABOVE); // scrolled out of the top
    expect(markPassed).toHaveBeenCalledWith("feed-1", "a", 1700000000);
  });

  it("a card fully in view at attach is passed once it is scrolled away", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), IN); // initial report, on screen
    report(card("a"), IN); // starts to leave (ratio falls below 1)
    report(card("a"), ABOVE);
    expect(markPassed).toHaveBeenCalledTimes(1);
  });

  it("a card put above the view is never passed (a restored position)", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), ABOVE); // initial report, already above the top
    report(card("a"), ABOVE);
    expect(markPassed).not.toHaveBeenCalled();
  });

  it("the first report never marks, even if the view then jumps past it", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), IN); // initial, at scrollTop 0 before the restore
    report(card("a"), ABOVE); // the restore jumps it above: never watched
    expect(markPassed).not.toHaveBeenCalled();
  });

  it("an exit through the bottom does not count, and disarms", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), BELOW);
    report(card("a"), IN);
    report(card("a"), BELOW); // out through the bottom
    report(card("a"), ABOVE); // then carried above in one jump (End)
    expect(markPassed).not.toHaveBeenCalled();
  });

  it("a card removed while armed is not passed", () => {
    mount(<Host ids={["a", "b"]} />);
    const a = card("a");
    report(a, BELOW);
    report(a, IN);
    mount(<Host ids={["b"]} />); // weeded / refreshed away
    report(a, { intersecting: false, bottom: 0 });
    expect(markPassed).not.toHaveBeenCalled();
  });

  it("a horizontal vessel passes through the LEFT edge", () => {
    mount(<Host ids={["a"]} horizontal />);
    report(card("a"), { intersecting: false, right: 900 });
    report(card("a"), IN);
    report(card("a"), { intersecting: false, bottom: 90, right: 900 });
    expect(markPassed).not.toHaveBeenCalled(); // above, but not left of
    report(card("a"), IN);
    report(card("a"), { intersecting: false, right: 40 });
    expect(markPassed).toHaveBeenCalledTimes(1);
  });

  it("tracks only counted cards, and meets cards that arrive later", async () => {
    mount(<Host ids={["a"]} untracked={["thread-node"]} />);
    expect(observer!.targets.has(card("thread-node"))).toBe(false);
    mount(<Host ids={["a", "b"]} untracked={["thread-node"]} />);
    // MutationObserver delivers on a microtask.
    await act(async () => {});
    expect(observer!.targets.has(card("b"))).toBe(true);
  });

  it("a passed card is unobserved and not marked twice", () => {
    mount(<Host ids={["a"]} />);
    report(card("a"), BELOW);
    report(card("a"), IN);
    report(card("a"), ABOVE);
    report(card("a"), IN);
    report(card("a"), ABOVE);
    expect(markPassed).toHaveBeenCalledTimes(1);
  });
});
