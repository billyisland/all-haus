import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A RELAY OUTAGE IS RECORDED, NEVER SPENT ON THE SOURCE (CA-C3, 2026-09-29).
//
// The poll swallowed each relay's rejection and always ran the success UPDATE
// — error_count 0, last_error NULL, interval reset — so a source whose relays
// were all down read as healthy and quiet. Two fixes were refused (the cursor
// hold; the error path), see `lib/relay-budget.ts`. What ships: a failing
// relay is named in last_error while error_count stays 0; no relay answering
// backs the interval off on itself; a relay that fails repeatedly is dropped
// for every source and skipped, and the skip is named too.
//
// The last case is the CONTROL — a failure that is not a relay's still takes
// the source's error path, because the per-relay catch must not have
// swallowed the outer one.
//
// MUTATION CHECKS (each fails the named case):
//   `last_error = NULL` back in the success UPDATE  → "one relay down…"
//   `fetch_interval_seconds = 300` unconditionally  → "no relay answers…"
//   drop the `relayOnCooldown` skip                  → "a relay that keeps failing…"
//   route allRelaysFailed to the error path          → "no relay answers…" (is_active clause)
// =============================================================================

interface Call {
  sql: string;
  params: unknown[];
}
const calls: Call[] = [];
const PUBKEY = "a".repeat(64);
const RELAYS = ["wss://alive.example", "wss://flaky.example"];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM external_sources WHERE id = $1")) {
        return {
          rows: [
            {
              id: "src-1",
              source_uri: PUBKEY,
              relay_urls: RELAYS,
              cursor: "1000",
              error_count: 0,
              display_name: null,
              avatar_url: null,
              metadata_updated_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@platform-pub/shared/lib/platform-blocks.js", () => ({
  isSourceBlocked: vi.fn(async () => false),
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  pinnedWebSocketOptions: vi.fn(async () => ({})),
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../lib/repost-edge.js", () => ({
  recordRepostEdge: vi.fn(async () => true),
}));

const mockFetch = vi.fn();
const mockApplyDeletions = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../lib/nostr-ingest.js", () => ({
  fetchNostrRelayEvents: (...a: unknown[]) => mockFetch(...a),
  validateNostrEvents: vi.fn(async () => []),
  insertNostrItem: vi.fn(async () => "inserted"),
  applyNostrDeletions: (...a: unknown[]) => mockApplyDeletions(...a),
  detectNostrRepost: vi.fn(() => null),
  nostrNip05: vi.fn(() => null),
  nostrProfileUpdate: vi.fn(() => ({
    profileName: null,
    profileAvatar: null,
    profileCreatedAt: null,
    profileDeleted: null,
  })),
}));

const { feedIngestNostr } = await import("./feed-ingest-nostr.js");
const { resetRelayBudgets, RELAY_FAILURES_TO_DROP } = await import(
  "../lib/relay-budget.js"
);

const helpers = {} as never;
const run = () => feedIngestNostr({ sourceId: "src-1" }, helpers);

const successUpdate = () =>
  calls.find((c) => c.sql.includes("cursor = $2,") && c.sql.includes("error_count = 0"));
const errorUpdate = () => calls.find((c) => c.sql.includes("error_count = $2"));
const relaysAsked = () => mockFetch.mock.calls.map((c) => c[0] as string);

/** Script each relay: an Error rejects, anything else resolves with no events. */
function scriptRelays(outcome: Record<string, Error | null>) {
  mockFetch.mockImplementation(async (url: string) => {
    const o = outcome[url];
    if (o instanceof Error) throw o;
    return [];
  });
}

beforeEach(() => {
  calls.length = 0;
  mockFetch.mockReset();
  mockApplyDeletions.mockReset();
  mockApplyDeletions.mockResolvedValue(undefined);
  resetRelayBudgets();
});

describe("feed_ingest_nostr relay health", () => {
  it("every relay answers: the success UPDATE clears last_error and resets the interval", async () => {
    scriptRelays({ [RELAYS[0]]: null, [RELAYS[1]]: null });
    await run();
    const upd = successUpdate();
    expect(upd).toBeDefined();
    // [id, cursor, name, avatar, profileCreatedAt, relayError, allRelaysFailed]
    expect(upd!.params[5]).toBeNull();
    expect(upd!.params[6]).toBe(false);
    expect(errorUpdate()).toBeUndefined();
  });

  it("one relay down: the source is healthy, and the relay is NAMED in last_error", async () => {
    scriptRelays({ [RELAYS[0]]: null, [RELAYS[1]]: new Error("ECONNREFUSED") });
    await run();
    const upd = successUpdate();
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain("last_error = $6");
    expect(upd!.params[5]).toContain("wss://flaky.example");
    expect(upd!.params[5]).toContain("ECONNREFUSED");
    expect(upd!.params[5]).toContain("1/2 relays failed");
    expect(upd!.params[6]).toBe(false);
    // Healthy: not the error path, no deactivation clause anywhere.
    expect(errorUpdate()).toBeUndefined();
    expect(calls.some((c) => c.sql.includes("is_active"))).toBe(false);
  });

  it("no relay answers: recorded, interval backed off on itself, and the source's error budget UNTOUCHED", async () => {
    scriptRelays({ [RELAYS[0]]: new Error("timeout"), [RELAYS[1]]: new Error("ECONNRESET") });
    await run();
    const upd = successUpdate();
    expect(upd).toBeDefined();
    expect(upd!.params[5]).toMatch(/^no relay answered/);
    expect(upd!.params[6]).toBe(true);
    // The backoff is a CASE on the column itself — Postgres's to evaluate, so
    // this is a structural pin: the statement still asks to double, capped.
    expect(upd!.sql).toMatch(/WHEN \$7 THEN LEAST\(fetch_interval_seconds \* 2, 19200\)/);
    expect(upd!.sql).toContain("error_count = 0");
    expect(errorUpdate()).toBeUndefined();
    expect(calls.some((c) => c.sql.includes("is_active"))).toBe(false);
  });

  it("a relay that keeps failing is dropped for every source: skipped on the next poll, and the skip is named", async () => {
    scriptRelays({ [RELAYS[0]]: null, [RELAYS[1]]: new Error("ECONNREFUSED") });
    for (let i = 0; i < RELAY_FAILURES_TO_DROP; i++) await run();
    expect(relaysAsked().filter((u) => u === RELAYS[1])).toHaveLength(RELAY_FAILURES_TO_DROP);

    calls.length = 0;
    mockFetch.mockClear();
    await run();
    expect(relaysAsked()).toEqual([RELAYS[0]]);
    const upd = successUpdate();
    expect(upd!.params[5]).toContain("wss://flaky.example (dropped after repeated failures)");
    expect(upd!.params[6]).toBe(false);
  });

  it("CONTROL: a failure that is not a relay's still takes the source's error path", async () => {
    scriptRelays({ [RELAYS[0]]: null, [RELAYS[1]]: null });
    mockApplyDeletions.mockRejectedValueOnce(new Error("deadlock detected"));
    await run();
    const upd = errorUpdate();
    expect(upd).toBeDefined();
    expect(upd!.params[1]).toBe(1);
    expect(upd!.params[2]).toContain("deadlock detected");
    expect(successUpdate()).toBeUndefined();
  });
});
