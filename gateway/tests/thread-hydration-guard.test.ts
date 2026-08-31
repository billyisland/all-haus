import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// THREAD-HYDRATION-LATENCY-ADR D1 — the server half of the deadlock fix. The
// `hydrating` flag must be derived from an in-flight registry, not from the
// re-trigger throttle guard (which flips false the instant it is set, so a
// client's mid-flight refetch reads `hydrating: false` and caches an empty
// thread — the observed 60 s stall). Network + DB are mocked; this exercises the
// registry mechanics (in-flight truth, concurrent-caller dedupe, settle cleanup,
// guard-clear-on-failure) in isolation.
//
// Sibling: author-timeline-guard.test.ts (the profile-view hydration twin).
// =============================================================================

// pool.query answers the single `SELECT relay_urls` in hydrateNostrThread.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [{ relay_urls: [] }], rowCount: 1 })),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  ),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The relay layer is the only thing that fails/succeeds; tests drive it.
const fetchNostrEvents = vi.fn(async () => [] as unknown[]);
vi.mock("../src/lib/nostr-relay.js", () => ({ fetchNostrEvents }));

const {
  hydrateExternalThreadContext,
  willHydrateThread,
  isThreadHydrating,
  getInFlightHydration,
  awaitHydrationWithinBudget,
  resetThreadHydrationGuards,
} = await import("../src/lib/external-hydration.js");

const VALID_ID = "f".repeat(64); // decodeNostrEventId accepts raw 64-hex

// A minimal harvested focal event: a run that finds at least one event is a
// SUCCESS. (An empty harvest is a failure since 2026-07-21 — the k-of-n soft
// deadline can fire with zero relays answered, and success-on-empty cached the
// bare focal for the full TTL; see the dedicated case below.)
const FOCAL_EVENT = {
  id: VALID_ID,
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [] as string[][],
  content: "hello",
  sig: "b".repeat(128),
};

function item(id: string, extra?: Record<string, unknown>) {
  return {
    id,
    source_id: "src-1",
    protocol: "nostr_external",
    source_item_uri: VALID_ID,
    interaction_data: { id: VALID_ID },
    ...extra,
  };
}

describe("thread hydration in-flight registry (D1)", () => {
  beforeEach(() => {
    resetThreadHydrationGuards();
    fetchNostrEvents.mockReset();
    fetchNostrEvents.mockResolvedValue([]);
  });

  it("isThreadHydrating is true while the job runs, false once it settles", async () => {
    const job = hydrateExternalThreadContext(item("A"));
    // Registered synchronously, before the async body yields.
    expect(isThreadHydrating("A")).toBe(true);
    await job;
    // finally() removed the entry — `hydrating` can never stick true.
    expect(isThreadHydrating("A")).toBe(false);
  });

  it("concurrent callers in the throttle window share one job (dedupe)", () => {
    const a = hydrateExternalThreadContext(item("B"));
    const b = hydrateExternalThreadContext(item("B"));
    expect(b).toBe(a); // same promise, not a second hydrate
  });

  it("a settled success still throttles re-triggers but reports not-hydrating", async () => {
    fetchNostrEvents.mockResolvedValue([FOCAL_EVENT]);
    await hydrateExternalThreadContext(item("C"));
    // Guard still set → no re-trigger …
    expect(willHydrateThread("C", "nostr_external")).toBe(false);
    // … but the job is done, so the flag is honest.
    expect(isThreadHydrating("C")).toBe(false);
    // A throttled caller gets a resolved no-op, never a second run. The guard
    // surviving means the prior run succeeded, so it resolves true (§0f-5).
    const noop = hydrateExternalThreadContext(item("C"));
    expect(getInFlightHydration("C")).toBeUndefined();
    await expect(noop).resolves.toBe(true);
  });

  it("guard-on-failure: a failed hydrate is immediately re-triggerable", async () => {
    fetchNostrEvents.mockRejectedValue(new Error("relay boom"));
    // The job resolves its success bit — false here (§0f-5), so D5's race
    // reports not-settled and the route keeps `hydrating: true`.
    await expect(hydrateExternalThreadContext(item("D"))).resolves.toBe(false);
    // The catch cleared the guard, so willHydrateThread is true again at once —
    // no 60 s freeze — and nothing is left in flight.
    expect(willHydrateThread("D", "nostr_external")).toBe(true);
    expect(isThreadHydrating("D")).toBe(false);
  });

  it("a zero-event harvest is a FAILURE, not an empty thread (guard cleared)", async () => {
    // Both relay fetches resolving empty is indistinguishable from "no relay
    // answered before the soft deadline" — reporting success here cached the
    // bare focal for the full client TTL with retries frozen behind the guard.
    fetchNostrEvents.mockResolvedValue([]);
    await expect(hydrateExternalThreadContext(item("Z"))).resolves.toBe(false);
    expect(willHydrateThread("Z", "nostr_external")).toBe(true);
    expect(isThreadHydrating("Z")).toBe(false);
  });

  it("non-hydratable protocols are a resolved no-op, never in flight", async () => {
    const job = hydrateExternalThreadContext(item("E", { protocol: "rss" }));
    expect(isThreadHydrating("E")).toBe(false);
    await expect(job).resolves.toBe(true); // nothing to hydrate ⇒ settled
  });
});

// =============================================================================
// D5 — short synchronous await on first expand. /thread races the in-flight
// hydration against a budget: settled-in-time ⇒ return the complete thread with
// hydrating:false (no client poll); budget-exceeded ⇒ hydrating:true + D2 poll.
// The helper is the pure race; the route derives `hydrating = !settled`.
// =============================================================================
describe("awaitHydrationWithinBudget (D5)", () => {
  it("resolves true when the job SUCCEEDS within budget", async () => {
    let done!: (ok: boolean) => void;
    const job = new Promise<boolean>((r) => {
      done = r;
    });
    const raced = awaitHydrationWithinBudget(job, 2_000);
    done(true);
    await expect(raced).resolves.toBe(true);
  });

  it("resolves false when the job FAILS within budget (§0f-5)", async () => {
    // A fast failure (all relays refused in <2s) must not read as settled —
    // that let the route report hydrating:false and cache the bare-focal
    // thread for 60s with no client poll to drive D1's guard-cleared retry.
    let done!: (ok: boolean) => void;
    const job = new Promise<boolean>((r) => {
      done = r;
    });
    const raced = awaitHydrationWithinBudget(job, 2_000);
    done(false);
    await expect(raced).resolves.toBe(false);
  });

  it("resolves false when the budget elapses before the job settles", async () => {
    vi.useFakeTimers();
    try {
      const job = new Promise<boolean>(() => {}); // never settles
      const raced = awaitHydrationWithinBudget(job, 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(raced).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves true immediately when there is no job to wait for", async () => {
    await expect(awaitHydrationWithinBudget(undefined, 2_000)).resolves.toBe(
      true,
    );
  });
});
