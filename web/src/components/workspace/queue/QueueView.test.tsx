// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedSeenWindow } from "../../../lib/api";
import type { QueueFeed } from "./QueueView";

// QueueView's hold for the first sort (WORKSPACE-QUEUE-ADR §VII.10): the queue
// is not SHOWN until the counts have landed, and nothing may move it
// meanwhile. Audit 2026-09-27, (3) and (4).
//
// MUTATION LOG (each applied to QueueView.tsx, the suite re-run, reverted):
//   1. the `setSorted(true)` on an empty ask removed ⇒ "windows that land
//      before the hold's effect still show the queue" fails.      DETECTED
//   2. `!sortedRef.current` dropped from the keydown guard ⇒ "a key does not
//      move the queue behind the loading line" fails.             DETECTED
//   3. `!sortedRef.current` dropped from `locked` ⇒ "a sideways swipe does
//      not move the queue behind the loading line" fails.         DETECTED
//   4. the re-target's `setWalk` back to `if (|at − p| > 1)` only ⇒ "a walk
//      re-targeted to one step lands on a mounted list" fails.    DETECTED

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = NoopObserver;
  g.IntersectionObserver = NoopObserver;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

const { QueueView } = await import("./QueueView");
const { useFeedSeen } = await import("../../../stores/feedSeen");
const { paletteFor } = await import("../tokens");

const realFetchWindow = useFeedSeen.getState().fetchWindow;
beforeEach(() => {
  // Every window read hangs: the hold is released only by what a case does.
  useFeedSeen.setState({ windows: {}, fetchWindow: () => new Promise<void>(() => {}) });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useFeedSeen.setState({ windows: {}, fetchWindow: realFetchWindow });
});

const win: FeedSeenWindow = {
  asOf: "2026-09-27T00:00:00Z",
  seenBaselineAt: "2026-09-26T00:00:00Z",
  windowStart: "2026-09-20T00:00:00Z",
  items: [],
  truncated: false,
};

function feed(id: string, numeral: number): QueueFeed {
  return {
    id,
    numeral,
    name: `Feed ${id}`,
    hidden: false,
    createdAt: "2026-09-01T00:00:00Z",
    palette: paletteFor("basic"),
    hasItems: false,
    fromStarter: false,
  };
}

const noop = () => {};

function mount(
  before?: React.ReactNode,
  opts: {
    ids?: string[];
    ref?: React.Ref<import("./QueueView").QueueViewHandle>;
    renderContents?: (id: string) => React.ReactNode;
  } = {},
) {
  const ids = opts.ids ?? ["a", "b", "c"];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <>
        {before}
        <QueueView
          ref={opts.ref}
          feeds={ids.map((id, i) => feed(id, i + 1))}
          vp={{ w: 1400, h: 800 }}
          hiddenPalette={paletteFor("basic")}
          attentionElsewhere={false}
          renderContents={opts.renderContents ?? (() => null)}
          renderPreview={() => null}
          onReveal={() => null}
          onRevealAll={() => new Map()}
          onLoadMore={noop}
          onCaughtUpDismiss={noop}
          onNameClick={noop}
          onSourceAdded={noop}
          onHide={noop}
          onRestore={noop}
          onFocalChange={noop}
        />
      </>,
    ),
  );
  return { host };
}

const loading = (h: HTMLElement) => h.textContent?.includes("Loading…") ?? false;

describe("QueueView — the first sort's hold", () => {
  it("windows that land before the hold's effect still show the queue", () => {
    // Rendered ahead of QueueView, so its effect runs after QueueView's first
    // render and before QueueView's own effect: the window lands in the gap.
    function Land() {
      useEffect(() => {
        useFeedSeen.setState({ windows: { a: win, b: win, c: win } });
      }, []);
      return null;
    }
    const { host } = mount(<Land />);
    expect(loading(host)).toBe(false);
  });

  it("a key does not move the queue behind the loading line", () => {
    const { host } = mount();
    expect(loading(host)).toBe(true);
    // The handler takes a key (preventDefault) only when it walks.
    for (const key of ["ArrowRight", "End"]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => {
        document.body.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it("a sideways swipe does not move the queue behind the loading line", () => {
    const { host } = mount();
    const region = host.querySelector<HTMLElement>('[role="region"]')!;
    let claimed = 0;
    act(() => {
      for (let i = 0; i < 12; i++) {
        const ev = new WheelEvent("wheel", { deltaX: 200, bubbles: true, cancelable: true });
        region.dispatchEvent(ev);
        if (ev.defaultPrevented) claimed++;
      }
    });
    // Claimed, so nothing behind the loading line scrolls either.
    expect(claimed).toBe(12);
    // The windows land, the hold releases, and the queue is shown where it
    // was put: on the first feed. A step taken behind the loading line would
    // show it moved, and unsorted.
    act(() => {
      useFeedSeen.setState({ windows: { a: win, b: win, c: win } });
    });
    expect(loading(host)).toBe(false);
    const focal = host.querySelector('[data-queue-entry="focal"]');
    expect(focal?.getAttribute("data-queue-feed")).toBe("a");
  });
});

describe("QueueView — a walk", () => {
  it("a walk re-targeted to one step lands on a mounted list", () => {
    const ids = ["a", "b", "c", "d", "e"];
    useFeedSeen.setState({ windows: Object.fromEntries(ids.map((id) => [id, win])) });
    const ref = React.createRef<import("./QueueView").QueueViewHandle>();
    const { host } = mount(undefined, {
      ids,
      ref,
      renderContents: (id) => <div data-list={id} />,
    });
    expect(loading(host)).toBe(false);
    const lists = () =>
      [...host.querySelectorAll("[data-list]")].map((el) => el.getAttribute("data-list")).sort();
    // A walk of three steps holds where it started and where it lands.
    act(() => ref.current!.walkTo("d"));
    expect(lists()).toEqual(["a", "d"]);
    // Re-targeted, before any step lands, to the neighbour: the landing moves
    // with it, and the old target's list goes.
    act(() => ref.current!.walkTo("b"));
    expect(lists()).toEqual(["a", "b"]);
  });
});
