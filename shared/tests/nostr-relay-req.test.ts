import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// =============================================================================
// The shared REQ/EOSE primitive (STRUCTURAL-SIMPLIFICATION-ADR §9).
//
// This module is now the one socket dance under five relay clients, so the
// lifecycle guards each of those clients had learned separately are pinned
// HERE rather than in whichever caller happened to cover them. Two of them had
// no test anywhere before this file:
//
//   - close-before-open. A fan-out that resolves early hangs up every relay,
//     including one still pinning DNS. If the pin resolving afterwards opens a
//     socket anyway, the request leaks a connection past its own answer. The
//     gateway carried this guard and nothing exercised it — proved by mutation
//     (delete the `closedEarly` check and the whole gateway suite stays green).
//   - the polite CLOSE frame. Some relays treat an abrupt disconnect with no
//     prior CLOSE as abuse, which is invisible locally and shows up as a relay
//     that has quietly stopped answering us.
//
// Sockets are a scriptable fake; fake timers make "settled at this instant"
// a deterministic assertion rather than a wall-clock race.
// =============================================================================

interface RelayScript {
  /** `unknown` on purpose — the point of the payload-shape tests below is to
   *  put things at msg[2] that are NOT events, which a typed array forbids. */
  events?: unknown[];
  eventDelayMs?: number;
  eoseAfterMs?: number | null;
  errorAfterMs?: number;
  ctorThrows?: boolean;
}
const SCRIPTS: Record<string, RelayScript> = {};
/** Every frame each fake socket was asked to send, in order. */
const SENT: Record<string, string[][]> = {};
let constructed: string[] = [];

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  url: string;
  constructor(url: string) {
    super();
    constructed.push(url);
    if (SCRIPTS[url]?.ctorThrows) throw new Error("sync ctor throw");
    this.url = url;
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    }, 0);
  }
  send(raw: string) {
    const msg = JSON.parse(raw) as string[];
    (SENT[this.url] ??= []).push(msg);
    if (msg[0] !== "REQ") return;
    const subId = msg[1];
    const script = SCRIPTS[this.url];
    if (!script) return;
    // ONE timer for the whole script, emitting in order. Every event shares the
    // same delay, so this is the same arrival order at the same instant; one
    // timer PER event made the 2,250-event cap case cost ~1.2s of fake-timer
    // bookkeeping alone, which under a loaded full `shared` run crossed the 5s
    // test timeout and failed on an unchanged tree.
    const events = script.events ?? [];
    if (events.length > 0) {
      setTimeout(() => {
        for (const ev of events) {
          this.emit("message", Buffer.from(JSON.stringify(["EVENT", subId, ev])));
        }
      }, script.eventDelayMs ?? 1);
    }
    if (script.eoseAfterMs != null) {
      setTimeout(
        () => this.emit("message", Buffer.from(JSON.stringify(["EOSE", subId]))),
        script.eoseAfterMs,
      );
    }
    if (script.errorAfterMs != null) {
      setTimeout(
        () => this.emit("error", new Error("relay blew up")),
        script.errorAfterMs,
      );
    }
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    setTimeout(() => this.emit("close"), 0);
  }
}

vi.mock("ws", () => ({ WebSocket: MockWebSocket }));

// A pin that never resolves until we let it, so close-before-open is testable.
let pinGate: (() => void) | null = null;
vi.mock("../src/lib/http-client.js", () => ({
  pinnedWebSocketOptions: vi.fn(async (url: string) => {
    if (url === "wss://slow-pin.example") {
      await new Promise<void>((r) => {
        pinGate = r;
      });
    }
    if (url === "wss://blocked.example") throw new Error("SSRF: private address");
    return {};
  }),
}));

const {
  openRelayReq,
  relayReq,
  relayCandidates,
  NOSTR_FALLBACK_RELAYS,
  MAX_EVENTS_PER_REQ,
} = await import("../src/lib/nostr-relay-req.js");

const ev = (id: string) => ({
  id,
  pubkey: "a".repeat(64),
  created_at: 1,
  kind: 1,
  tags: [],
  content: "",
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(SCRIPTS)) delete SCRIPTS[k];
  for (const k of Object.keys(SENT)) delete SENT[k];
  constructed = [];
  pinGate = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("openRelayReq lifecycle", () => {
  it("collects events until EOSE and settles", async () => {
    SCRIPTS["wss://a.example"] = { events: [ev("a1"), ev("a2")], eoseAfterMs: 5 };
    const done = relayReq("wss://a.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await done).map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("drops a non-object EVENT payload and keeps the rest of the batch", async () => {
    // The frame's TAG was checked and its PAYLOAD was not, so whatever sat at
    // msg[2] was pushed into the array and handed to the caller as a `T`.
    // `["EVENT", <sub>, null]` is well-formed JSON any relay can send, and
    // `null` survives every optional chain a consumer might defend itself
    // with — `validateNostrEvents` reads `event.created_at` unguarded, first,
    // inside a `Promise.all`, so ONE such frame rejected the whole batch and
    // took a source's entire backfill with it, again on every retry for as
    // long as the relay kept sending it.
    //
    // The assertion is deliberately not "it did not throw": the old code did
    // not throw here either, it threw two modules away in the consumer. What
    // this pins is that the bad frame never enters the array, and — the half
    // that makes it a fix rather than a bail-out — that the good events on
    // either side of it still do.
    SCRIPTS["wss://a.example"] = {
      events: [ev("a1"), null, "a string", 42, ["an", "array"], ev("a2")],
      eoseAfterMs: 5,
    };
    const done = relayReq("wss://a.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    const got = await done;
    expect(got.map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("does not count a dropped frame against the event cap", async () => {
    // A relay that answers only with junk must still reach EOSE or the timeout
    // rather than filling the cap with nothing and settling early.
    SCRIPTS["wss://a.example"] = {
      events: Array.from({ length: 50 }, () => null),
      eoseAfterMs: 5,
    };
    const done = relayReq("wss://a.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toEqual([]);
    expect(SENT["wss://a.example"].map((f) => f[0])).toEqual(["REQ", "CLOSE"]);
  });

  it("sends CLOSE before tearing the socket down", async () => {
    SCRIPTS["wss://a.example"] = { events: [ev("a1")], eoseAfterMs: 5 };
    const done = relayReq("wss://a.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    await done;
    const frames = SENT["wss://a.example"].map((f) => f[0]);
    expect(frames).toEqual(["REQ", "CLOSE"]);
  });

  it("settles with what arrived when the relay hangs past the timeout", async () => {
    SCRIPTS["wss://hung.example"] = {
      events: [ev("h1")],
      eoseAfterMs: null, // connects, never EOSEs
    };
    const done = relayReq("wss://hung.example", [{ kinds: [1] }], {
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void done.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect((await done).map((e) => e.id)).toEqual(["h1"]);
  });

  it("close() before the socket opens never opens one", async () => {
    const handle = openRelayReq("wss://slow-pin.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(0);
    // Still pinning DNS — nothing constructed yet.
    expect(constructed).toEqual([]);
    handle.close();
    expect(await handle.done).toEqual([]);
    // Let the pin resolve *after* the hang-up: it must not build a socket.
    pinGate?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(constructed).toEqual([]);
  });

  it("treats an SSRF-rejected host as a dead relay, not an error", async () => {
    const onPinError = vi.fn();
    const done = relayReq("wss://blocked.example", [{ kinds: [1] }], {
      onPinError,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await done).toEqual([]);
    expect(onPinError).toHaveBeenCalledOnce();
  });

  it("a synchronous WebSocket ctor throw settles rather than hanging", async () => {
    SCRIPTS["wss://ctor.example"] = { ctorThrows: true };
    const done = relayReq("wss://ctor.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await done).toEqual([]);
  });

  it("settles once when timeout, EOSE and close all fire", async () => {
    SCRIPTS["wss://a.example"] = { events: [ev("a1")], eoseAfterMs: 5 };
    const seen: unknown[] = [];
    const done = relayReq("wss://a.example", [{ kinds: [1] }], { timeoutMs: 10 });
    void done.then((v) => seen.push(v));
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(seen).toHaveLength(1);
  });
});

describe("onSocketError", () => {
  it("resolves with what arrived by default — a broken relay returned less", async () => {
    SCRIPTS["wss://err.example"] = { events: [ev("e1")], errorAfterMs: 5 };
    const done = relayReq("wss://err.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await done).map((e) => e.id)).toEqual(["e1"]);
  });

  it("rejects when the caller is an ingest path", async () => {
    // feed-ingest's contract: a relay outage must reach the job, never read as
    // "this author posted nothing" — otherwise the cursor ratchets past a gap
    // that no later run will look at again.
    SCRIPTS["wss://err.example"] = { events: [ev("e1")], errorAfterMs: 5 };
    const done = relayReq("wss://err.example", [{ kinds: [1] }], {
      onSocketError: "reject",
    });
    const caught = done.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20);
    expect(await caught).toBe("relay blew up");
  });
});

describe("onEvent", () => {
  it("returning false keeps the event out of the collected array", async () => {
    SCRIPTS["wss://a.example"] = { events: [ev("a1"), ev("a2")], eoseAfterMs: 5 };
    const seen: string[] = [];
    const done = relayReq("wss://a.example", [{ kinds: [1] }], {
      onEvent: (e) => {
        seen.push(e.id);
        return false;
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual(["a1", "a2"]);
    expect(await done).toEqual([]);
  });
});

describe("relayCandidates", () => {
  it("puts hints before extras before fallbacks, so a cap cannot evict a hint", () => {
    const out = relayCandidates(["wss://hint.example"], 3, ["wss://extra.example"]);
    expect(out).toEqual([
      "wss://hint.example",
      "wss://extra.example",
      NOSTR_FALLBACK_RELAYS[0],
    ]);
  });

  it("dedupes, drops non-ws schemes, and honours the cap", () => {
    const out = relayCandidates(
      ["wss://a.example", "wss://a.example", "https://not-a-relay.example"],
      2,
    );
    expect(out).toEqual(["wss://a.example", NOSTR_FALLBACK_RELAYS[0]]);
  });
});

// =============================================================================
// Unbounded buffering (MIRROR-AUDIT §3 *Security*, S16)
//
// Relay URLs are user-steerable — an nprofile's TLVs, a remote
// `.well-known/nostr.json`, a source's own hints — so "a relay" means "a host
// somebody typed into a form". Two things were unbounded against that: the
// `ws` library's 100 MiB default frame size (closed in `pinnedWebSocketOptions`,
// where a caller cannot forget it, and covered in http-client.test.ts), and the
// collected-events array here, which retained everything a chatty relay sent for
// the whole timeout window.
// =============================================================================
describe("openRelayReq — the event cap", () => {
  it("stops collecting at the cap and settles with what it has", async () => {
    SCRIPTS["wss://firehose.example"] = {
      // Comfortably past the cap, all individually tiny — the shape `maxPayload`
      // cannot see, because no single frame is large.
      events: Array.from({ length: MAX_EVENTS_PER_REQ + 250 }, (_, i) =>
        ev(String(i).padStart(64, "0")),
      ),
      eoseAfterMs: null,
    };
    const { done } = openRelayReq("wss://firehose.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(50);
    const got = await done;
    expect(got).toHaveLength(MAX_EVENTS_PER_REQ);
  });

  it("settles rather than failing, even for a caller that rejects on error", async () => {
    // An ingest caller passes `onSocketError: 'reject'` so a broken relay cannot
    // read as "this author posted nothing". A FULL relay is a different thing —
    // a truncated answer is still an answer — so the cap must not be routed
    // through the failure path.
    SCRIPTS["wss://firehose2.example"] = {
      events: Array.from({ length: MAX_EVENTS_PER_REQ + 10 }, (_, i) =>
        ev(String(i).padStart(64, "1")),
      ),
      eoseAfterMs: null,
    };
    const { done } = openRelayReq("wss://firehose2.example", [{ kinds: [1] }], {
      onSocketError: "reject",
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(done).resolves.toHaveLength(MAX_EVENTS_PER_REQ);
  });

  it("leaves an ordinary relay untouched", async () => {
    // The cap is a ceiling, not a page size: nothing real approaches it, and a
    // suite that only tested the cap would be green against one set to 1.
    SCRIPTS["wss://ordinary.example"] = {
      events: [ev("a".repeat(64)), ev("b".repeat(64))],
      eoseAfterMs: 5,
    };
    const { done } = openRelayReq("wss://ordinary.example", [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toHaveLength(2);
  });
});
