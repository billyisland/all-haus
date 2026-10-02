// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// WORKSPACE-QUEUE-ADR §VI.2 / §VII.3: a queue list's position is put back by
// the shell's `restoreScroll`, and the ORDER is the contract — after the tail
// is in place (or a position in the last screenful is clamped before the tail
// exists), before the pass tracker attaches (or its first report sees the top
// of a fresh list, not the place the reader left), and once per mount of the
// card list (a list re-mounted after a park restores again, because the
// neighbours' raw scroll offset is stale the moment posts merge above).
//
// MUTATION LOG (each applied to VesselChassis.tsx, the suite re-run, reverted):
//   1. the restore made a passive `useEffect` ⇒ "restores before the tracker
//      attaches" fails.                                             DETECTED
//   2. the tail measured in a passive `useEffect` again ⇒ "restores against
//      the full extent" fails.                                      DETECTED
//   3. `restoredRef` not reset on a park ⇒ "restores again after a park"
//      fails.                                                       DETECTED
//   4. `tracking` dropped from the tracker's `enabled` ⇒ "an untracked list
//      attaches no tracker" fails.                                  DETECTED

const log: string[] = [];

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class LoggingIO {
  observe() {
    log.push("observe");
  }
  unobserve() {}
  disconnect() {}
}

const clientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = NoopResizeObserver;
  g.IntersectionObserver = LoggingIO;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  // The scroll body is 500 tall; nothing else is laid out.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-vessel-scroll") ? 500 : 0;
    },
  });
});
afterAll(() => {
  if (clientHeight)
    Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
});

const { VesselChassis } = await import("./VesselChassis");
const { paletteFor } = await import("./tokens");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  log.length = 0;
});

function render(props: {
  tracking?: boolean;
  contents?: "full" | "compact";
  listHidden?: boolean;
  onRestore: (el: HTMLElement) => void;
}) {
  const el = (
    <VesselChassis
      feedId="f-1"
      numeral={3}
      palette={paletteFor("spring", false)}
      horizontal={false}
      contents={props.contents ?? "full"}
      engaged={false}
      countsSeen
      tracking={props.tracking}
      listHidden={props.listHidden}
      restoreScroll={props.onRestore}
      tailSpacer
      height={600}
      scrolls
      bodyFills
      bar={<div />}
    >
      <div data-post-id="a" data-seen-at="1">
        A
      </div>
    </VesselChassis>
  );
  act(() => {
    if (!root) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
    root.render(el);
  });
}

function tail(): HTMLElement {
  const t = host!.querySelector<HTMLElement>(
    '[data-vessel-scroll] [aria-hidden="true"]',
  );
  if (!t) throw new Error("no tail");
  return t;
}

describe("VesselChassis restoreScroll", () => {
  it("restores before the tracker attaches", () => {
    render({ onRestore: () => log.push("restore") });
    expect(log[0]).toBe("restore");
    expect(log).toContain("observe");
  });

  it("restores against the full extent: the tail is already sized", () => {
    let tailAtRestore = "";
    render({ onRestore: () => (tailAtRestore = tail().style.height) });
    expect(tailAtRestore).toBe("500px");
  });

  it("restores once per mount of the list, not on every render", () => {
    let n = 0;
    const onRestore = () => n++;
    render({ onRestore });
    render({ onRestore, tracking: false });
    render({ onRestore, tracking: true });
    expect(n).toBe(1);
  });

  it("restores again after a park", () => {
    let n = 0;
    const onRestore = () => n++;
    render({ onRestore });
    render({ onRestore, contents: "compact" });
    render({ onRestore });
    expect(n).toBe(2);
  });

  it("an untracked list attaches no tracker until it is tracked", () => {
    render({ onRestore: () => {}, tracking: false });
    expect(log).not.toContain("observe");
    render({ onRestore: () => {}, tracking: true });
    expect(log).toContain("observe");
  });

  it("a hidden list is inert and out of the accessibility tree", () => {
    render({ onRestore: () => {}, tracking: false, listHidden: true });
    const body = host!.querySelector("[data-vessel-scroll]")!;
    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.getAttribute("aria-hidden")).toBe("true");
    render({ onRestore: () => {}, tracking: true, listHidden: false });
    expect(body.hasAttribute("inert")).toBe(false);
    expect(body.hasAttribute("aria-hidden")).toBe(false);
  });
});
