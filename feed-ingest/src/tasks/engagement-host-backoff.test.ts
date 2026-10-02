import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// =============================================================================
// THE ENGAGEMENT REFRESH STOPS A HOST ON 429/5xx (CA-C13, 2026-09-29).
//
// `refreshMastodonHost` ran one GET per status, sequentially, and on any
// non-ok answer `continue`d to the next — through a 429, which is the
// instance saying stop, and the 429 budget is per IP, so the storm starved
// that instance's ingest poll too. `readMastodonStatus` returns the wire
// status for exactly this split; the host's loop now breaks on 429 and 5xx
// and goes on past a 404 (a fact about one status).
//
// MUTATION CHECK: `if (!res.ok) continue;` back → "a 429 stops the host…".
// =============================================================================

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown[] }[],
  rows: [] as Array<Record<string, unknown>>,
  reads: [] as string[],
  answers: [] as Array<{ ok: boolean; status: number; body: unknown }>,
}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => {
      state.calls.push({ sql, params });
      if (/FROM external_items/.test(sql)) {
        const rows = state.rows;
        state.rows = [];
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
  },
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: async () =>
    new Map([["feed_ingest_engagement_max_items", "50"]]),
}));
vi.mock("../lib/nostr-relay.js", () => ({
  fetchNostrEngagementCounts: vi.fn(),
}));
vi.mock("../lib/resonance.js", () => ({
  loadResonanceParams: vi.fn(),
  updateExternalResonance: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/mastodon-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@platform-pub/shared/lib/mastodon-api.js")>();
  return {
    ...actual,
    readMastodonStatus: async (origin: string, id: string) => {
      state.reads.push(`${origin}/${id}`);
      return state.answers.shift() ?? { ok: true, status: 200, body: {} };
    },
  };
});

import { externalEngagementRefresh } from "./external-engagement-refresh.js";

const HOST = "mastodon.example";
const status = (n: number) => ({
  id: `item-${n}`,
  protocol: "activitypub",
  source_item_uri: `https://${HOST}/users/alice/statuses/${n}`,
  interaction_data: {},
  media: [],
  like_count: 0,
  reply_count: 0,
  repost_count: 0,
  published_at: "2026-07-21T12:00:00Z",
});

const runTask = () =>
  (externalEngagementRefresh as (p: unknown, h: unknown) => Promise<void>)({}, {});

beforeEach(() => {
  state.calls.length = 0;
  state.reads.length = 0;
  state.answers.length = 0;
  state.rows = [status(1), status(2), status(3)];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-21T12:40:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Mastodon engagement refresh — per-host backoff", () => {
  it("a 429 stops the host for the run: nothing after it is asked", async () => {
    state.answers.push({ ok: false, status: 429, body: null });
    await runTask();
    expect(state.reads).toEqual([`https://${HOST}/1`]);
  });

  it("a 5xx stops the host too", async () => {
    state.answers.push(
      { ok: true, status: 200, body: { favourites_count: 1 } },
      { ok: false, status: 503, body: null },
    );
    await runTask();
    expect(state.reads).toEqual([`https://${HOST}/1`, `https://${HOST}/2`]);
  });

  it("a 404 is a fact about one status: the host goes on", async () => {
    state.answers.push({ ok: false, status: 404, body: null });
    await runTask();
    expect(state.reads).toHaveLength(3);
  });
});
