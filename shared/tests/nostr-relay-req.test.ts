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
  events?: Array<Record<string, unknown>>;
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
    for (const ev of script.events ?? []) {
      setTimeout(
        () =>
          this.emit("message", Buffer.from(JSON.stringify(["EVENT", subId, ev]))),
        script.eventDelayMs ?? 1,
      );
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

const { openRelayReq, relayReq, relayCandidates, NOSTR_FALLBACK_RELAYS } =
  await import("../src/lib/nostr-relay-req.js");

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
