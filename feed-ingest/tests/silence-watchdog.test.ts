import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  SilenceWatchdog,
  attachLiveness,
} from "../src/jetstream/silence-watchdog.js";

// =============================================================================
// The half-open-socket detector (see silence-watchdog.ts for the incident).
//
// Two failure directions, and the second is the dangerous one. Missing a wedge
// costs another silent outage; FALSELY declaring one kills a healthy socket
// every timeout window and turns a rare fault into a permanent reconnect loop —
// so "does not fire while frames are arriving" is tested for each frame kind
// the wiring counts, not just for the happy path in aggregate.
//
// Fake timers throughout: the thing under test is a decision about elapsed
// time, and a test that really waited 90 seconds would be one nobody runs.
// =============================================================================

const INTERVAL = 30_000;
const TIMEOUT = 90_000;

/** A watchdog on the fake clock, with its two callbacks recorded. */
function build() {
  const probes = vi.fn();
  const silent = vi.fn();
  const watchdog = new SilenceWatchdog({
    intervalMs: INTERVAL,
    timeoutMs: TIMEOUT,
    onProbe: probes,
    onSilent: silent,
    now: () => Date.now(),
  });
  return { watchdog, probes, silent };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SilenceWatchdog", () => {
  it("probes on every quiet tick and does not cry wedge inside the window", () => {
    const { watchdog, probes, silent } = build();
    watchdog.start();

    vi.advanceTimersByTime(INTERVAL * 3); // 90s — the boundary, not past it
    expect(probes).toHaveBeenCalledTimes(3);
    expect(silent).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("declares the socket wedged once silence passes the window", () => {
    const { watchdog, probes, silent } = build();
    watchdog.start();

    vi.advanceTimersByTime(INTERVAL * 4); // 120s > 90s
    expect(silent).toHaveBeenCalledTimes(1);
    expect(silent.mock.calls[0][0]).toBeGreaterThan(TIMEOUT);
    // And it stopped ITSELF before calling back. A watchdog still ticking after
    // it fired would ping a terminated socket and then terminate its
    // replacement on the next tick — the reconnect loop this must not cause.
    expect(watchdog.running).toBe(false);
    const probesAtFiring = probes.mock.calls.length;
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(silent).toHaveBeenCalledTimes(1);
    expect(probes).toHaveBeenCalledTimes(probesAtFiring);
  });

  it("never fires while frames keep arriving, however long it runs", () => {
    const { watchdog, silent } = build();
    watchdog.start();

    // Jetstream's own keepalive cadence, measured: one inbound ping every 30s.
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(INTERVAL);
      watchdog.markActivity();
    }
    expect(silent).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("fires when activity STOPS, having run healthy for hours first", () => {
    const { watchdog, silent } = build();
    watchdog.start();
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(INTERVAL);
      watchdog.markActivity();
    }
    // The peer goes quiet without closing — the actual prod/dev failure.
    vi.advanceTimersByTime(INTERVAL * 4);
    expect(silent).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly and goes silent itself", () => {
    const { watchdog, probes, silent } = build();
    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(INTERVAL * 10);
    expect(probes).not.toHaveBeenCalled();
    expect(silent).not.toHaveBeenCalled();
    expect(watchdog.running).toBe(false);
  });

  it("start() re-arms rather than stacking a second timer", () => {
    const { watchdog, probes } = build();
    watchdog.start();
    watchdog.start();
    vi.advanceTimersByTime(INTERVAL);
    // Two timers would probe twice per tick and, worse, double the effective
    // rate at which a false wedge could be declared.
    expect(probes).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });
});

describe("attachLiveness — what counts as proof of life", () => {
  // Each frame kind is the ONLY signal in some real state, so each is tested
  // alone rather than together: `message` in wildcard mode, `ping` (the
  // server's 30s keepalive) on a quiet filtered subscription, `pong` when the
  // server's keepalive has stopped and our probe is all that is left.
  it.each(["message", "ping", "pong"] as const)(
    "counts an inbound %s as activity",
    (frame) => {
      const { watchdog, silent } = build();
      const socket = new EventEmitter();
      attachLiveness(socket, watchdog);
      watchdog.start();

      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(INTERVAL);
        socket.emit(frame);
      }
      expect(silent).not.toHaveBeenCalled();
      watchdog.stop();
    },
  );

  it("still fires when the socket emits nothing at all", () => {
    const { watchdog, silent } = build();
    const socket = new EventEmitter();
    attachLiveness(socket, watchdog);
    watchdog.start();
    vi.advanceTimersByTime(INTERVAL * 4);
    expect(silent).toHaveBeenCalledTimes(1);
  });
});
