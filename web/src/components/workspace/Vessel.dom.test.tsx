// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// WORKSPACE-QUEUE-ADR §VII.2 / D3: `Vessel` is split into the floor's shell
// and the shared `VesselChassis`, and the floor must render BYTE-IDENTICALLY
// across the split. The snapshots below were written against the unsplit
// `Vessel` (2026-09-23, before `VesselChassis` existed) and pin its DOM in
// every configuration the floor passes: mounted with a refresh, parked,
// horizontal, resizable, without a refresh, and armed. A change to any of
// them is a change to the floor, and needs saying so, not a snapshot update.

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
  // The workspace components are compiled with the classic JSX runtime here
  // and do not import React themselves.
  g.React = React;
});

const { Vessel } = await import("./Vessel");
const { useFeedSeen } = await import("../../stores/feedSeen");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  useFeedSeen.setState({ windows: {}, passed: {} });
  delete (window as { matchMedia?: unknown }).matchMedia;
  host?.remove();
  root = null;
  host = null;
});

function render(el: React.ReactElement): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host.innerHTML;
}

const base = {
  feedId: "f-1",
  numeral: 3,
  descriptiveName: "Philosophy",
  sortRank: 3,
  position: { x: 8, y: 8 },
  size: { w: 640, h: 600 },
  brightness: "spring" as const,
  countsSeen: true,
  inView: true,
  tailSpacer: true,
};

const cards = (
  <>
    <div data-card="a">A</div>
    <div data-card="b">B</div>
  </>
);

describe("Vessel DOM (the floor, pinned across the VesselChassis split)", () => {
  it("mounted, with a refresh, resizable", () => {
    expect(
      render(
        <Vessel
          {...base}
          onRefresh={async () => {}}
          onSizeCommit={() => {}}
          onHide={() => {}}
          onCardDrop={() => {}}
        >
          {cards}
        </Vessel>,
      ),
    ).toMatchSnapshot();
  });

  it("parked", () => {
    expect(
      render(
        <Vessel {...base} contentsMounted={false} onRefresh={async () => {}}>
          {cards}
        </Vessel>,
      ),
    ).toMatchSnapshot();
  });

  it("horizontal", () => {
    expect(
      render(
        <Vessel {...base} orientation="horizontal" onRefresh={async () => {}}>
          {cards}
        </Vessel>,
      ),
    ).toMatchSnapshot();
  });

  it("no refresh, no name, armed, hidden", () => {
    expect(
      render(
        <Vessel
          {...base}
          descriptiveName={undefined}
          armed
          hidden
          tailSpacer={false}
        >
          {cards}
        </Vessel>,
      ),
    ).toMatchSnapshot();
  });

  // B3 (§VII.12): `BarButton`, the pills and the resolver input are extracted
  // from `VesselBar`, which must render byte-identically afterwards. This case
  // was snapshotted BEFORE the extraction, with a window held so the bar's
  // pills render — new, unread and truncated.
  it("with counts on the bar", () => {
    // The pills ask for reduced motion; answer yes, so the tick's initial
    // frame is not in the snapshot. Stubbed here only: the other cases were
    // pinned with no `matchMedia` at all.
    window.matchMedia = ((q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const now = Math.floor(Date.parse("2026-09-23T12:00:00Z") / 1000);
    useFeedSeen.setState({
      windows: {
        "f-1": {
          asOf: "2026-09-23T12:00:00.000000Z",
          seenBaselineAt: "2026-09-22T12:00:00.000000Z",
          windowStart: "2026-09-16T12:00:00.000000Z",
          items: [
            { id: "p1", publishedAt: now, isNew: true },
            { id: "p2", publishedAt: now - 60, isNew: true },
            { id: "p3", publishedAt: now - 7200, isNew: false },
          ],
          truncated: true,
        },
      },
      passed: {},
    });
    expect(
      render(
        <Vessel {...base} onRefresh={async () => {}} onHide={() => {}}>
          {cards}
        </Vessel>,
      ),
    ).toMatchSnapshot();
  });
});
