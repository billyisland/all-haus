import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FeedSeenWindow } from "../lib/api";

// WORKSPACE-QUEUE-ADR §VIII, slice A2's *Done when*: first contact, a seen
// response adopted with no flicker, two tabs losing no pass, pruning at the
// floor, the quota fallback, and no badge before the first window.
//
// Each "tab" is a FRESH MODULE INSTANCE (vi.resetModules) over one shared
// localStorage stub, so the two-tab cases exercise two real stores with
// separate memory — the thing that actually races — rather than one store
// talking to itself.

const api = vi.hoisted(() => ({
  seen: vi.fn(),
  markSeen: vi.fn(),
}));
vi.mock("../lib/api", () => ({ workspaceFeeds: api }));

type Mod = typeof import("./feedSeen");

// ---- the browser, stubbed ---------------------------------------------------

const disk = new Map<string, string>();
let setItemImpl: (k: string, v: string) => void = (k, v) =>
  void disk.set(k, v);
const localStorage = {
  get length() {
    return disk.size;
  },
  key: (i: number) => [...disk.keys()][i] ?? null,
  getItem: (k: string) => disk.get(k) ?? null,
  setItem: (k: string, v: string) => setItemImpl(k, v),
  removeItem: (k: string) => void disk.delete(k),
};

/** One listener registry per tab, so an event can be delivered to one tab —
 *  the way a real `storage` event reaches every tab BUT the writer. */
interface Tab {
  mod: Mod;
  listeners: Map<string, ((e: unknown) => void)[]>;
}

async function openTab(): Promise<Tab> {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const on = (type: string, fn: (e: unknown) => void) =>
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage, addEventListener: on };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    visibilityState: "visible",
    addEventListener: on,
  };
  vi.resetModules();
  const mod = await import("./feedSeen");
  return { mod, listeners };
}

function fire(tab: Tab, type: string, e: unknown = {}) {
  for (const fn of tab.listeners.get(type) ?? []) fn(e);
}

/** Deliver a write made by another tab, as the browser would. */
function deliverStorage(tab: Tab, key: string) {
  fire(tab, "storage", { key, newValue: disk.get(key) ?? null });
}

const flushWrites = () => vi.advanceTimersByTime(250);
const settle = async () => {
  // Let resolved promises run their continuations.
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const KEY = (u: string, f: string) => `workspace:passed:v1:${u}:${f}`;
const stored = (u: string, f: string) => {
  const raw = disk.get(KEY(u, f));
  return raw ? (JSON.parse(raw) as { floor: number | null; passed: Record<string, number> }) : null;
};

// ---- fixtures ---------------------------------------------------------------

// windowStart 2026-09-15 12:00:00+00 → unix 1789473600
const WS = "2026-09-15 12:00:00.5+00";
const WS_S = Date.parse("2026-09-15T12:00:00Z") / 1000;

function win(
  items: [id: string, isNew: boolean][],
  over: Partial<FeedSeenWindow> = {},
): FeedSeenWindow {
  return {
    asOf: "2026-09-22 12:00:00.000001+00",
    seenBaselineAt: "2026-09-21 12:00:00+00",
    windowStart: WS,
    items: items.map(([id, isNew], i) => ({
      id,
      isNew,
      publishedAt: WS_S + 1000 - i,
    })),
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  disk.clear();
  setItemImpl = (k, v) => void disk.set(k, v);
  api.seen.mockReset();
  api.markSeen.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).document;
});

// ---- the asOf token ---------------------------------------------------------

describe("asOfMicros — the token compared at Postgres precision", () => {
  it("orders below a millisecond, which a Date cannot", async () => {
    const { mod } = await openTab();
    const a = mod.asOfMicros("2026-09-22 12:00:00.1234+00")!;
    const b = mod.asOfMicros("2026-09-22 12:00:00.1235+00")!;
    expect(b - a).toBe(100n);
  });

  it("reads a trimmed fraction as its value, not its text", async () => {
    const { mod } = await openTab();
    // As strings "…00.1+00" > "…00.09+00"; as times too — but "…00+00" vs
    // "…00.5+00" and offsets are where string order would lie.
    expect(mod.asOfMicros("2026-09-22 12:00:00.1+00")! >
      mod.asOfMicros("2026-09-22 12:00:00.09+00")!).toBe(true);
    expect(mod.asOfMicros("2026-09-22 13:00:00+01")).toBe(
      mod.asOfMicros("2026-09-22 12:00:00+00"),
    );
    expect(mod.asOfMicros("2026-09-22 12:00:00+05:30")).toBe(
      mod.asOfMicros("2026-09-22 06:30:00Z"),
    );
  });

  it("refuses what is not a timestamp", async () => {
    const { mod } = await openTab();
    expect(mod.asOfMicros("yesterday")).toBeNull();
    expect(mod.asOfMicros("2026-09-22")).toBeNull();
  });
});

// ---- no badge ---------------------------------------------------------------

describe("no badge before the first window", () => {
  it("answers null, never zero, for a feed with no window", async () => {
    const { mod } = await openTab();
    mod.useFeedSeen.getState().hydrate("u");
    const s = mod.useFeedSeen.getState();
    expect(mod.feedSeenCounts(s.windows.f, s.passed.f)).toBeNull();
    // …even when this device HAS passed posts in it: passes are not a window.
    s.markPassed("f", "p1", WS_S + 10);
    const t = mod.useFeedSeen.getState();
    expect(mod.feedSeenCounts(t.windows.f, t.passed.f)).toBeNull();
  });

  it("answers zero once a window says there is nothing", async () => {
    const { mod } = await openTab();
    mod.useFeedSeen.getState().hydrate("u");
    mod.useFeedSeen.getState().adoptWindow("f", win([]));
    const s = mod.useFeedSeen.getState();
    expect(mod.feedSeenCounts(s.windows.f, s.passed.f)).toEqual({
      unread: 0,
      new: 0,
      truncated: false,
      newTruncated: false,
    });
  });
});

// ---- first contact ----------------------------------------------------------

describe("first contact (§IV.5)", () => {
  it("shows the whole window unread and nothing new, and re-bases once at that window's asOf", async () => {
    const { mod } = await openTab();
    const store = mod.useFeedSeen;
    store.getState().hydrate("u");
    const first = win(
      [
        ["a", false],
        ["b", false],
        ["c", false],
      ],
      { seenBaselineAt: null, asOf: "2026-09-22 12:00:00.42+00" },
    );
    let resolve!: (w: FeedSeenWindow) => void;
    api.markSeen.mockReturnValue(new Promise((r) => (resolve = r)));

    store.getState().adoptWindow("f", first);
    // A poll landing while the re-base is in flight must not send a second.
    store.getState().adoptWindow("f", first);

    expect(api.markSeen).toHaveBeenCalledTimes(1);
    expect(api.markSeen).toHaveBeenCalledWith("f", "2026-09-22 12:00:00.42+00");
    let s = store.getState();
    expect(mod.feedSeenCounts(s.windows.f, s.passed.f)).toMatchObject({
      unread: 3,
      new: 0,
    });
    expect(s.passed.f ?? {}).toEqual({});

    resolve({ ...first, seenBaselineAt: first.asOf });
    await settle();
    s = store.getState();
    expect(s.windows.f.seenBaselineAt).toBe(first.asOf);
    expect(mod.feedSeenCounts(s.windows.f, s.passed.f)).toMatchObject({
      unread: 3,
      new: 0,
    });
    expect(api.markSeen).toHaveBeenCalledTimes(1);
  });

  it("does not re-base a feed that already has a baseline", async () => {
    const { mod } = await openTab();
    mod.useFeedSeen.getState().hydrate("u");
    mod.useFeedSeen.getState().adoptWindow("f", win([["a", true]]));
    expect(api.markSeen).not.toHaveBeenCalled();
  });
});

// ---- adoption, no flicker ---------------------------------------------------

describe("a seen response is adopted as the window (§IV.4)", () => {
  it("clears nothing locally, adopts the server's answer, and the next poll does not flicker", async () => {
    const { mod } = await openTab();
    const store = mod.useFeedSeen;
    store.getState().hydrate("u");
    const before = win([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    store.getState().adoptWindow("f", before);
    const counts = () => {
      const s = store.getState();
      return mod.feedSeenCounts(s.windows.f, s.passed.f);
    };
    expect(counts()).toMatchObject({ unread: 3, new: 2 });

    const after = win(
      [
        ["a", false],
        ["b", false],
        ["c", false],
      ],
      { asOf: "2026-09-22 12:02:00+00" },
    );
    let resolve!: (w: FeedSeenWindow) => void;
    api.markSeen.mockReturnValue(new Promise((r) => (resolve = r)));
    const done = store.getState().markSeen("f");
    // In flight: the client has NOT cleared its own flags.
    expect(counts()).toMatchObject({ new: 2 });
    resolve(after);
    expect(await done).toBe(true);
    expect(counts()).toMatchObject({ unread: 3, new: 0 });

    // The next poll carries the same server state: nothing moves.
    api.seen.mockResolvedValue(after);
    await store.getState().fetchWindow("f");
    expect(counts()).toMatchObject({ unread: 3, new: 0 });
  });

  it("sends the NEWEST asOf held, whether it came from a window or an items page", async () => {
    const { mod } = await openTab();
    const store = mod.useFeedSeen;
    store.getState().hydrate("u");
    api.markSeen.mockResolvedValue(win([]));

    store
      .getState()
      .adoptWindow("f", win([], { asOf: "2026-09-22 12:00:00.000002+00" }));
    // An older items page does not displace it — sub-millisecond apart.
    store.getState().noteAsOf("f", "2026-09-22 12:00:00.000001+00");
    await store.getState().markSeen("f");
    expect(api.markSeen).toHaveBeenLastCalledWith(
      "f",
      "2026-09-22 12:00:00.000002+00",
    );

    // A newer items page does.
    store.getState().noteAsOf("f", "2026-09-22 12:05:00+00");
    await store.getState().markSeen("f");
    expect(api.markSeen).toHaveBeenLastCalledWith("f", "2026-09-22 12:05:00+00");
  });

  it("keeps the old window when the look fails, and sends nothing with no asOf", async () => {
    const { mod } = await openTab();
    const store = mod.useFeedSeen;
    store.getState().hydrate("u");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await store.getState().markSeen("f")).toBe(false);
    expect(api.markSeen).not.toHaveBeenCalled();

    const w = win([["a", true]]);
    store.getState().adoptWindow("f", w);
    api.markSeen.mockRejectedValue(new Error("down"));
    expect(await store.getState().markSeen("f")).toBe(false);
    expect(store.getState().windows.f).toBe(w);
    warn.mockRestore();
  });
});

// ---- two tabs ---------------------------------------------------------------

describe("two tabs (§IV.5)", () => {
  it("lose no pass when both write the same feed from stale memory", async () => {
    const A = await openTab();
    A.mod.useFeedSeen.getState().hydrate("u");
    A.mod.useFeedSeen.getState().adoptWindow("f", win([["a", false], ["b", false], ["c", false]]));
    const B = await openTab();
    B.mod.useFeedSeen.getState().hydrate("u");
    B.mod.useFeedSeen.getState().adoptWindow("f", win([["a", false], ["b", false], ["c", false]]));

    A.mod.useFeedSeen.getState().markPassed("f", "a");
    B.mod.useFeedSeen.getState().markPassed("f", "b");
    // Both debounces fire; neither tab has heard from the other.
    flushWrites();

    expect(Object.keys(stored("u", "f")!.passed).sort()).toEqual(["a", "b"]);
    // The later writer adopted the union it wrote.
    const sB = B.mod.useFeedSeen.getState();
    expect(B.mod.feedSeenCounts(sB.windows.f, sB.passed.f)).toMatchObject({ unread: 1 });
  });

  it("stops counting in one tab what was passed in the other", async () => {
    const A = await openTab();
    A.mod.useFeedSeen.getState().hydrate("u");
    const w = win([["a", true], ["b", false]]);
    A.mod.useFeedSeen.getState().adoptWindow("f", w);
    const B = await openTab();
    B.mod.useFeedSeen.getState().hydrate("u");
    B.mod.useFeedSeen.getState().adoptWindow("f", w);

    B.mod.useFeedSeen.getState().markPassed("f", "a");
    flushWrites();
    deliverStorage(A, KEY("u", "f"));

    const sA = A.mod.useFeedSeen.getState();
    expect(A.mod.feedSeenCounts(sA.windows.f, sA.passed.f)).toMatchObject({
      unread: 1,
      new: 0,
    });
  });

  it("ignores another member's keys and a removal", async () => {
    const A = await openTab();
    A.mod.useFeedSeen.getState().hydrate("u");
    A.mod.useFeedSeen.getState().markPassed("f", "a", WS_S + 5);
    disk.set(KEY("other", "f"), JSON.stringify({ floor: null, passed: { z: WS_S + 5 } }));
    deliverStorage(A, KEY("other", "f"));
    fire(A, "storage", { key: KEY("u", "f"), newValue: null });
    expect(A.mod.useFeedSeen.getState().passed.f).toEqual({ a: WS_S + 5 });
  });
});

// ---- persistence ------------------------------------------------------------

describe("persistence", () => {
  it("writes debounced, per feed, and flushes on pagehide", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().markPassed("f", "a", WS_S + 5);
    store.getState().markPassed("g", "b", WS_S + 5);
    expect(disk.size).toBe(0);
    fire(T, "pagehide");
    expect(stored("u", "f")!.passed).toEqual({ a: WS_S + 5 });
    expect(stored("u", "g")!.passed).toEqual({ b: WS_S + 5 });
  });

  it("flushes on visibilitychange → hidden", async () => {
    const T = await openTab();
    T.mod.useFeedSeen.getState().hydrate("u");
    T.mod.useFeedSeen.getState().markPassed("f", "a", WS_S + 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document.visibilityState = "hidden";
    fire(T, "visibilitychange");
    expect(stored("u", "f")).not.toBeNull();
  });

  it("survives a reload", async () => {
    const A = await openTab();
    A.mod.useFeedSeen.getState().hydrate("u");
    A.mod.useFeedSeen.getState().markPassed("f", "a", WS_S + 5);
    flushWrites();
    const B = await openTab();
    B.mod.useFeedSeen.getState().hydrate("u");
    expect(B.mod.useFeedSeen.getState().passed.f).toEqual({ a: WS_S + 5 });
  });

  it("drops a pending write when a different member hydrates", async () => {
    const T = await openTab();
    T.mod.useFeedSeen.getState().hydrate("u");
    T.mod.useFeedSeen.getState().markPassed("f", "a", WS_S + 5);
    T.mod.useFeedSeen.getState().hydrate("v");
    flushWrites();
    fire(T, "pagehide");
    expect(disk.size).toBe(0);
    expect(T.mod.useFeedSeen.getState().passed).toEqual({});
  });

  it("degrades a malformed key to an empty set", async () => {
    disk.set(KEY("u", "f"), "{not json");
    disk.set(KEY("u", "g"), JSON.stringify({ passed: { a: "x", b: WS_S + 1 } }));
    const T = await openTab();
    T.mod.useFeedSeen.getState().hydrate("u");
    expect(T.mod.useFeedSeen.getState().passed.f).toEqual({});
    expect(T.mod.useFeedSeen.getState().passed.g).toEqual({ b: WS_S + 1 });
  });

  it("marks a post not in the window only when its date is known", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().adoptWindow("f", win([["a", false]]));
    store.getState().markPassed("f", "a");
    store.getState().markPassed("f", "ghost");
    expect(Object.keys(store.getState().passed.f)).toEqual(["a"]);
  });
});

// ---- pruning ----------------------------------------------------------------

describe("pruning at the floor", () => {
  it("drops, on hydrate, what is below the floor the key was written at", async () => {
    disk.set(
      KEY("u", "f"),
      JSON.stringify({ floor: WS_S, passed: { old: WS_S - 1, edge: WS_S, fresh: WS_S + 9 } }),
    );
    const T = await openTab();
    T.mod.useFeedSeen.getState().hydrate("u");
    expect(T.mod.useFeedSeen.getState().passed.f).toEqual({ edge: WS_S, fresh: WS_S + 9 });
  });

  it("drops, on every window, what is below that window's start — and persists it", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().markPassed("f", "old", WS_S + 100);
    store.getState().markPassed("f", "kept", WS_S + 5000);
    flushWrites();

    // A day later the floor has moved past "old".
    const later = "2026-09-15 12:10:00+00"; // WS_S + 600
    store.getState().adoptWindow("f", win([["kept", false]], { windowStart: later }));
    expect(store.getState().passed.f).toEqual({ kept: WS_S + 5000 });
    flushWrites();
    expect(stored("u", "f")).toEqual({ floor: WS_S + 600, passed: { kept: WS_S + 5000 } });
  });

  it("never lets an older window lower the floor", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().markPassed("f", "a", WS_S + 5000);
    store.getState().adoptWindow("f", win([], { windowStart: "2026-09-15 12:10:00+00" }));
    store.getState().adoptWindow("f", win([]));
    expect(store.getState().floors.f).toBe(WS_S + 600);
  });

  it("evicts the oldest past the cap", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    for (let i = 0; i < T.mod.PASSED_CAP + 5; i++)
      store.getState().markPassed("f", `p${i}`, WS_S + i);
    flushWrites();
    const kept = stored("u", "f")!.passed;
    expect(Object.keys(kept)).toHaveLength(T.mod.PASSED_CAP);
    expect(kept.p0).toBeUndefined();
    expect(kept.p4).toBeUndefined();
    expect(kept.p5).toBe(WS_S + 5);
  });

  it("forgets feeds that are no longer live, memory and storage alike — and only this member's", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().markPassed("f", "a", WS_S + 5);
    store.getState().markPassed("gone", "b", WS_S + 5);
    store.getState().adoptWindow("gone", win([]));
    flushWrites();
    disk.set(KEY("other", "gone"), "{}");

    store.getState().reconcileFeeds(["f"]);
    expect(disk.has(KEY("u", "gone"))).toBe(false);
    expect(disk.has(KEY("u", "f"))).toBe(true);
    expect(disk.has(KEY("other", "gone"))).toBe(true);
    const s = store.getState();
    expect(s.passed.gone).toBeUndefined();
    expect(s.windows.gone).toBeUndefined();
  });

  it("does not resurrect a reconciled feed from a pending write", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().markPassed("gone", "b", WS_S + 5);
    store.getState().reconcileFeeds([]);
    flushWrites();
    fire(T, "pagehide");
    expect(disk.has(KEY("u", "gone"))).toBe(false);
  });
});

// ---- quota ------------------------------------------------------------------

describe("quota (§IV.5)", () => {
  const quota = () => Object.assign(new Error("full"), { name: "QuotaExceededError" });

  it("cuts the feed's set to 1,000 and retries once", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    for (let i = 0; i < 1500; i++) store.getState().markPassed("f", `p${i}`, WS_S + i);
    setItemImpl = (k, v) => {
      if (Object.keys(JSON.parse(v).passed).length > T.mod.PASSED_QUOTA_CAP) throw quota();
      disk.set(k, v);
    };
    flushWrites();
    const kept = stored("u", "f")!.passed;
    expect(Object.keys(kept)).toHaveLength(T.mod.PASSED_QUOTA_CAP);
    expect(kept.p1499).toBe(WS_S + 1499);
    expect(kept.p0).toBeUndefined();
    // Memory follows what was written.
    expect(Object.keys(store.getState().passed.f)).toHaveLength(T.mod.PASSED_QUOTA_CAP);
  });

  it("drops the write silently when the retry fails too, and keeps counting", async () => {
    const T = await openTab();
    const store = T.mod.useFeedSeen;
    store.getState().hydrate("u");
    store.getState().adoptWindow("f", win([["a", false], ["b", false]]));
    setItemImpl = () => {
      throw quota();
    };
    store.getState().markPassed("f", "a");
    expect(() => flushWrites()).not.toThrow();
    expect(disk.size).toBe(0);
    const s = store.getState();
    expect(T.mod.feedSeenCounts(s.windows.f, s.passed.f)).toMatchObject({ unread: 1 });
  });

  it("does not retry on an error that is not quota", async () => {
    const T = await openTab();
    T.mod.useFeedSeen.getState().hydrate("u");
    const calls = vi.fn(() => {
      throw new Error("SecurityError");
    });
    setItemImpl = calls;
    T.mod.useFeedSeen.getState().markPassed("f", "a", WS_S + 5);
    flushWrites();
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

// ---- derivations ------------------------------------------------------------

describe("derivations", () => {
  it("counts the window minus the passed set, and new within that", async () => {
    const { mod } = await openTab();
    const w = win([["a", true], ["b", true], ["c", false], ["d", false]]);
    expect(mod.feedSeenCounts(w, { a: 1, c: 1, elsewhere: 1 })).toEqual({
      unread: 2,
      new: 1,
      truncated: false,
      newTruncated: false,
    });
  });

  it("says when a figure is a floor rather than a total", async () => {
    const { mod } = await openTab();
    expect(mod.feedSeenCounts(win([["a", true]], { truncated: true }), {})).toMatchObject({
      truncated: true,
      newTruncated: true,
    });
    expect(
      mod.feedSeenCounts(win([["a", true], ["b", false]], { truncated: true }), {}),
    ).toMatchObject({ truncated: true, newTruncated: false });
  });

  it("marks a card from the window, never from the list it was loaded in", async () => {
    const { mod } = await openTab();
    const w = win([["a", true], ["b", false]]);
    expect(mod.feedSeenMark(w, {}, "a")).toBe("new");
    expect(mod.feedSeenMark(w, {}, "b")).toBe("unread");
    expect(mod.feedSeenMark(w, { a: 1 }, "a")).toBe("read");
    expect(mod.feedSeenMark(w, { b: 1 }, "b")).toBe("read");
    expect(mod.feedSeenMark(w, {}, "older-than-the-window")).toBeNull();
    // Passed but outside the window (the window moved on): unknown, not read.
    expect(mod.feedSeenMark(w, { gone: 1 }, "gone")).toBeNull();
    expect(mod.feedSeenMark(undefined, {}, "a")).toBeNull();
  });
});
