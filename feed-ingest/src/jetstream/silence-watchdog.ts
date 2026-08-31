// =============================================================================
// Silence watchdog — the half-open-socket detector the Jetstream listener
// lacked (prod incident 2026-08-12; dev reproduction the same day).
//
// THE FAILURE IT CLOSES. The listener reconnected only on the socket's `close`
// or `error` events. A half-open TCP connection emits NEITHER: the peer stops
// sending, our side keeps the socket ESTABLISHED, and the listener waits
// forever believing it is connected. The designed safety net could not fire
// either — `jetstream_healthy` is only set false from the close path, so the
// flag that means "the listener is wedged" could only be written by a listener
// that shut down CLEANLY, and the atproto polling fallback never engaged.
//
// WHAT THIS IS *NOT* THE FIX FOR, recorded because it is how this module came
// to be written. Dev showed 38 hours of "connected, zero Bluesky items" and it
// looked exactly like a half-open socket; measuring the interface showed the
// container pulling 113 MB every 30 seconds. The socket was fine and the
// listener was replaying a month-old cursor through the whole firehose, every
// event a duplicate — resume-cursor.ts has that one. A watchdog would not have
// helped, and must never be widened to "no ROWS inserted lately", which would
// terminate a healthy socket doing exactly what it was asked to.
//
// It is kept because the failure it does cover is real, cheap to guard, and
// otherwise unbounded: nothing else in the listener can end a silent socket.
//
// WHY SILENCE IS A SOUND SIGNAL HERE, measured rather than assumed. Probing
// wss://jetstream1.us-east.bsky.network with a subscription to one nonexistent
// DID (so no data events at all): the server answered our ping with a pong in
// ~100ms, and sent its OWN ping every 30 seconds unprompted. So a healthy
// connection is never quiet for more than ~30s regardless of how little the
// subscribed accounts post — which matters because prod runs in FILTERED mode
// (55 DIDs), where genuine data silence overnight is normal and would make
// "no messages" useless on its own. Inbound frames of ANY kind are the signal:
// message, server ping, or pong to our probe.
//
// This is deliberately its own module with injected callbacks and clock. The
// listener's own connect() reaches for the network, a pinned DNS resolution and
// a database, so a watchdog embedded in it could only be tested by mocking all
// three; here the decision is a pure function of time and can be driven with
// fake timers. `attachLiveness` is extracted for the same reason and is not
// ceremony: a watchdog that MISSES activity is worse than the bug it fixes —
// it would terminate a perfectly healthy socket every timeout window and turn
// a rare wedge into a permanent reconnect loop — so the wiring is pinned too.
// =============================================================================

import type { EventEmitter } from "node:events";

export interface SilenceWatchdogOptions {
  /** How often to check, and to send our own probe ping. */
  intervalMs: number;
  /** Inbound silence beyond this means the socket is wedged. */
  timeoutMs: number;
  /** Send a liveness probe (a WebSocket ping). Called on every quiet tick. */
  onProbe: () => void;
  /** The socket is wedged. The watchdog has already stopped itself. */
  onSilent: (idleMs: number) => void;
  /** Injected clock, for tests. */
  now?: () => number;
}

export class SilenceWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: SilenceWatchdogOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Begin watching. Treats the moment of starting as activity. */
  start(): void {
    this.stop();
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  markActivity(): void {
    this.lastActivityAt = this.now();
  }

  private tick(): void {
    const idleMs = this.now() - this.lastActivityAt;
    if (idleMs > this.opts.timeoutMs) {
      // Stop BEFORE the callback. onSilent terminates the socket, whose close
      // handler starts a reconnect that installs a fresh watchdog; a timer left
      // running here would go on firing against a socket nobody holds and
      // terminate its replacement on the next tick.
      this.stop();
      this.opts.onSilent(idleMs);
      return;
    }
    this.opts.onProbe();
  }
}

/**
 * Count every inbound frame as proof of life.
 *
 * All three matter and none is redundant: `message` covers a busy wildcard
 * subscription, `ping` is the server's own 30s keepalive (which `ws` answers
 * automatically — we only need to notice it), and `pong` is the reply to our
 * probe, the one signal that still arrives when the subscription is genuinely
 * quiet AND the server has stopped its keepalive.
 */
export function attachLiveness(socket: EventEmitter, watchdog: SilenceWatchdog): void {
  const mark = () => watchdog.markActivity();
  socket.on("message", mark);
  socket.on("ping", mark);
  socket.on("pong", mark);
}
