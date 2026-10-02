// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSeenPolling, type SeenPollingOptions } from "./useSeenPolling";

// The queue's clock (WORKSPACE-QUEUE-ADR §VI.5 *Fetched on a timer, shown on
// a gesture*): a first pass spread over the whole interval, then one read per
// feed per interval, and a `poke` that reads a feed NOW and restarts its
// clock — so the timer never re-reads a feed a pull has just refreshed.
//
// MUTATION LOG (each applied to useSeenPolling.ts, the suite re-run, reverted):
//   1. `poke` fires without clearing the slot's timer ⇒ "restarts its clock"
//      fails (the old timer still fires at 7 min).                 DETECTED
//   2. `firstPass` ignored (always the 10s spread) ⇒ "spreads its first pass
//      over the interval" fails.                                   DETECTED
//   3. the in-flight check dropped from `fire` ⇒ "one read at a time" fails
//      (three concurrent reads).                                   DETECTED
//   4. `again` never set (a fire in flight is simply skipped) ⇒ "one read at
//      a time" fails (no read after the first lands).              DETECTED
//   5. `onReturn` ignored (always the spread) ⇒ "reads only what fell due"
//      fails (a is re-read on return).                             DETECTED
//   6. `poke` fires every feed at once ⇒ "several are spread" fails.
//                                                                   DETECTED

const MIN = 60_000;
let root: Root;
let host: HTMLDivElement;
let poke: (ids: readonly string[]) => void = () => {};

function Probe({ ids, opts }: { ids: string[]; opts: SeenPollingOptions }) {
  poke = useSeenPolling(ids, true, opts);
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useSeenPolling — the queue's clock", () => {
  it("spreads its first pass over the interval, then reads each feed once per interval", async () => {
    const fire = vi.fn(async (_id: string) => {});
    act(() =>
      root.render(
        <Probe ids={["a", "b"]} opts={{ intervalMs: 7 * MIN, fire, firstPass: "interval" }} />,
      ),
    );
    await advance(3 * MIN);
    expect(fire).not.toHaveBeenCalled();
    await advance(1 * MIN); // 3.5 min: a's slot
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["a"]);
    await advance(3.5 * MIN); // 7 min: b's slot
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    await advance(3.5 * MIN); // 10.5 min: a again
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b", "a"]);
  });

  it("a poke reads the feed now and restarts its clock", async () => {
    const fire = vi.fn(async (_id: string) => {});
    act(() =>
      root.render(
        <Probe ids={["a"]} opts={{ intervalMs: 7 * MIN, fire, firstPass: "interval" }} />,
      ),
    );
    await advance(5 * MIN);
    act(() => poke(["a"]));
    await advance(0);
    expect(fire).toHaveBeenCalledTimes(1);
    // The first-pass timer (due at 7 min) is gone: the next read is 7 min
    // after the poke.
    await advance(6.9 * MIN);
    expect(fire).toHaveBeenCalledTimes(1);
    await advance(0.2 * MIN);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("a poke for a feed it is not polling does nothing", async () => {
    const fire = vi.fn(async (_id: string) => {});
    act(() => root.render(<Probe ids={["a"]} opts={{ intervalMs: 7 * MIN, fire }} />));
    act(() => poke(["zzz"]));
    await advance(0);
    expect(fire).not.toHaveBeenCalledWith("zzz");
  });

  it("one read at a time: a poke in flight asks for exactly one more after it", async () => {
    let live = 0;
    let most = 0;
    const pending: (() => void)[] = [];
    const fire = vi.fn(
      (_id: string) =>
        new Promise<void>((resolve) => {
          live++;
          most = Math.max(most, live);
          pending.push(() => {
            live--;
            resolve();
          });
        }),
    );
    act(() => root.render(<Probe ids={["a"]} opts={{ intervalMs: 7 * MIN, fire, firstPass: "interval" }} />));
    act(() => poke(["a"]));
    await advance(0);
    act(() => poke(["a"]));
    act(() => poke(["a"]));
    await advance(0);
    expect(fire).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()!());
    await advance(0);
    expect(fire).toHaveBeenCalledTimes(2);
    await act(async () => pending.shift()!());
    await advance(0);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it("several pokes are spread over the pass, the first read now", async () => {
    const fire = vi.fn(async (_id: string) => {});
    act(() =>
      root.render(
        <Probe ids={["a", "b", "c"]} opts={{ intervalMs: 7 * MIN, fire, firstPass: "interval" }} />,
      ),
    );
    act(() => poke(["c", "a", "b"]));
    await advance(0);
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["c"]);
    await advance(3_400);
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["c", "a"]);
    await advance(3_400);
    expect(fire.mock.calls.map((c) => c[0])).toEqual(["c", "a", "b"]);
  });

  describe("a return to the tab", () => {
    let vis: DocumentVisibilityState = "visible";
    beforeEach(() => {
      vis = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => vis,
      });
    });
    const setVisible = (v: DocumentVisibilityState) =>
      act(() => {
        vis = v;
        document.dispatchEvent(new Event("visibilitychange"));
      });

    it('with onReturn "due", reads only what fell due while hidden', async () => {
      const fire = vi.fn(async (_id: string) => {});
      act(() =>
        root.render(
          <Probe
            ids={["a", "b"]}
            opts={{ intervalMs: 7 * MIN, fire, firstPass: "interval", onReturn: "due" }}
          />,
        ),
      );
      await advance(5 * MIN); // a read at 3.5 (next 10.5); b due at 7
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a"]);
      setVisible("hidden");
      await advance(4 * MIN); // 9 min: b fell due, a has not
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a"]);
      setVisible("visible");
      await advance(0);
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
      await advance(1.4 * MIN); // 10.4
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
      await advance(0.2 * MIN); // 10.6: a at the time it was due
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b", "a"]);
    });

    it("by default, re-reads every feed over the pass", async () => {
      const fire = vi.fn(async (_id: string) => {});
      act(() => root.render(<Probe ids={["a", "b"]} opts={{ intervalMs: 2 * MIN, fire }} />));
      await advance(6_000); // the first pass: a at 0, b at 5s
      expect(fire).toHaveBeenCalledTimes(2);
      setVisible("hidden");
      setVisible("visible");
      await advance(6_000);
      expect(fire.mock.calls.map((c) => c[0])).toEqual(["a", "b", "a", "b"]);
    });
  });
});
