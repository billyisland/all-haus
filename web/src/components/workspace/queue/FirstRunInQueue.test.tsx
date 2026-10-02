// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The first-run tour STARTS in queue mode (T1, WORKSPACE-QUEUE-ADR §XI.6).
//
// Before T1 the controller waited for a `vessel` Explain root that only the
// floor's `Vessel` registered, so in the queue it polled for ever: the tour
// never opened and `onboarded_at` — stamped by the host in `onOpened` — was
// never written. The queue's focal entry is now that root. These cases mount
// the real `QueueEntry` inside the real provider and controller, and assert
// the tour OPENED, anchored on the focal feed, and fired `onOpened`.
//
// MUTATION LOG (each applied, the suite re-run, reverted):
//   1. QueueEntry's `enabled: state === "focal" && !!children` → `false` ⇒
//      "opens the tour on the focal entry" fails.                 DETECTED
//   2. `enabled` → `!!children` (every chassis a root) ⇒ "a compact entry is
//      not an anchor" fails.                                      DETECTED
//   3. ExplainProvider's `canWrite === true` → `!== true` ⇒ "a reader's ∀
//      beat" fails.                                               DETECTED

vi.mock("../../../lib/api/articles", () => ({
  readingLog: { list: vi.fn(async () => ({ items: [] })) },
}));

import { ExplainProvider, FirstRunController } from "../ExplainProvider";
import { QueueEntry, type QueueEntryState } from "./QueueEntry";
import { queueGeometry } from "../../../lib/workspace/queueGeometry";
import { paletteFor } from "../tokens";
import { useExplain } from "../../../stores/explain";
import { useAuth } from "../../../stores/auth";
import { FIRST_RUN_COPY } from "../../../lib/explain/copy";
import type { MeResponse } from "../../../lib/api";

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.clear();
  useExplain.getState().close();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const geom = queueGeometry({ w: 1400, h: 800 });

function setUser(canWrite: boolean) {
  useAuth.setState({
    user: { id: "u1", canWrite, onboardedAt: null } as unknown as MeResponse,
  });
}

function mount(entries: { id: string; state: QueueEntryState }[], onOpened: () => void) {
  act(() =>
    root.render(
      <ExplainProvider>
        {entries.map((e, i) => (
          <QueueEntry
            key={e.id}
            state={e.state}
            geom={geom}
            palette={paletteFor("basic")}
            label={`Feed ${i + 1}`}
            feedId={e.id}
            onWalk={() => {}}
            widthAt={(u) => u}
            reduced
            explain={{ order: i + 1, fromStarter: true, feedName: null }}
          >
            <div>
              <div data-explain="vessel.addSource" />
              <span data-explain="card.byline">A writer</span>
            </div>
          </QueueEntry>
        ))}
        <FirstRunController userId="u1" armed onOpened={onOpened} />
      </ExplainProvider>,
    ),
  );
}

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("the first-run tour in queue mode", () => {
  it("opens the tour on the focal entry and stamps (onOpened)", async () => {
    setUser(true);
    const onOpened = vi.fn();
    mount(
      [
        { id: "passed", state: "line" },
        { id: "focal", state: "focal" },
        { id: "ahead", state: "compact" },
      ],
      onOpened,
    );
    await settle(1000);
    const s = useExplain.getState();
    expect(s.isActive).toBe(true);
    expect(s.program?.kind).toBe("firstrun");
    // Beats 1 and 2 anchor on the feed being read, and beat 1 took its
    // provenance fork from that entry's registration.
    expect(s.annotations[0]).toMatchObject({ kind: "vessel", key: "focal" });
    expect(s.annotations[0].copy).toBe(FIRST_RUN_COPY.vesselStarter);
    expect(s.annotations[1]).toMatchObject({ kind: "vessel.addSource", key: "focal" });
    expect(s.annotations[3].copy).toBe(FIRST_RUN_COPY.disc);
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("a compact entry is not an anchor: with no focal, the tour waits", async () => {
    setUser(true);
    const onOpened = vi.fn();
    mount([{ id: "ahead", state: "compact" }], onOpened);
    await settle(10_000);
    expect(useExplain.getState().isActive).toBe(false);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("a reader's ∀ beat does not promise writing", async () => {
    setUser(false);
    const onOpened = vi.fn();
    mount([{ id: "focal", state: "focal" }], onOpened);
    await settle(1000);
    const s = useExplain.getState();
    expect(s.annotations[3]).toMatchObject({
      kind: "disc",
      copy: FIRST_RUN_COPY.discReader,
    });
  });
});
