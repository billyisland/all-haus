import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// =============================================================================
// Daily-sweep keyset cursor (§0i.1 — engagement cron budget starvation).
//
// Freshest-first + a fixed budget deterministically starves everything below
// the freshest page of the daily <7d window. These tests pin the rotation
// contract on the task's control flow (protocol-filtered fetch legs are inert
// — the seeded rows carry a protocol neither HTTP leg claims, so no network):
//
//   • daily + full page   → cursor persisted at the page's oldest published_at
//   • daily + prior cursor → the select resumes strictly below it
//   • daily + short page  → cursor cleared (next rotation starts at the top)
//   • daily + stale cursor → empty page clears + re-selects from the top NOW
//   • non-daily runs      → never read or write the cursor
// =============================================================================

interface Call {
  sql: string;
  params: unknown[];
}

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params: unknown[] }[],
  cursorValue: null as string | null,
  pages: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => {
      state.calls.push({ sql, params });
      if (/SELECT value FROM platform_config/.test(sql)) {
        return Promise.resolve({
          rows: state.cursorValue === null ? [] : [{ value: state.cursorValue }],
        });
      }
      if (/INSERT INTO platform_config/.test(sql)) {
        state.cursorValue = params[1] as string;
        return Promise.resolve({ rows: [] });
      }
      if (/DELETE FROM platform_config/.test(sql)) {
        state.cursorValue = null;
        return Promise.resolve({ rows: [] });
      }
      if (/FROM external_items/.test(sql)) {
        return Promise.resolve({ rows: state.pages.shift() ?? [] });
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
    new Map([["feed_ingest_engagement_max_items", "3"]]),
}));
vi.mock("../lib/nostr-relay.js", () => ({
  fetchNostrEngagementCounts: vi.fn(),
}));
vi.mock("../lib/resonance.js", () => ({
  loadResonanceParams: vi.fn(),
  updateExternalResonance: vi.fn(),
}));

import { externalEngagementRefresh } from "./external-engagement-refresh.js";

// Rows whose protocol no fetch leg claims — the cursor logic only counts them.
const row = (publishedAt: string) => ({
  id: `item-${publishedAt}`,
  protocol: "inert_test_protocol",
  source_item_uri: `https://example.com/${publishedAt}`,
  interaction_data: {},
  media: [],
  like_count: 0,
  reply_count: 0,
  repost_count: 0,
  published_at: publishedAt,
});

const itemSelects = () =>
  state.calls.filter((c: Call) => /FROM external_items/.test(c.sql));
const cursorWrites = () =>
  state.calls.filter((c: Call) => /INSERT INTO platform_config/.test(c.sql));
const cursorClears = () =>
  state.calls.filter((c: Call) => /DELETE FROM platform_config/.test(c.sql));
const cursorReads = () =>
  state.calls.filter((c: Call) => /SELECT value FROM platform_config/.test(c.sql));

const runTask = () =>
  (externalEngagementRefresh as (p: unknown, h: unknown) => Promise<void>)(
    {},
    {},
  );

beforeEach(() => {
  state.calls.length = 0;
  state.cursorValue = null;
  state.pages.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const DAILY = new Date("2026-07-21T04:05:00Z"); // hour 4, first quarter → <7d sweep
const HOURLY = new Date("2026-07-21T12:05:00Z"); // top of hour, not hour 4 → <24h
const HALF_HOUR = new Date("2026-07-21T12:40:00Z"); // :30 slot → <6h

describe("daily engagement sweep — keyset rotation", () => {
  it("full page persists the cursor at the page's oldest published_at", async () => {
    vi.setSystemTime(DAILY);
    state.pages.push([row("2026-07-21T00:00:00Z"), row("2026-07-20T00:00:00Z"), row("2026-07-19T00:00:00Z")]);
    await runTask();

    expect(itemSelects()).toHaveLength(1);
    expect(itemSelects()[0].params[2]).toBeNull(); // no prior cursor → from the top
    expect(cursorWrites()).toHaveLength(1);
    expect(cursorWrites()[0].params[1]).toBe("2026-07-19T00:00:00Z");
    expect(cursorClears()).toHaveLength(0);
  });

  it("a prior cursor is passed into the select; a short page clears it", async () => {
    vi.setSystemTime(DAILY);
    state.cursorValue = "2026-07-19T00:00:00Z";
    state.pages.push([row("2026-07-18T00:00:00Z"), row("2026-07-17T00:00:00Z")]); // 2 < budget 3
    await runTask();

    expect(itemSelects()).toHaveLength(1);
    expect(itemSelects()[0].params[2]).toBe("2026-07-19T00:00:00Z");
    expect(cursorWrites()).toHaveLength(0);
    expect(cursorClears()).toHaveLength(1); // rotation exhausted → restart next daily
  });

  it("a stale cursor (empty page) clears and re-selects from the top in the same run", async () => {
    vi.setSystemTime(DAILY);
    state.cursorValue = "2026-07-01T00:00:00Z"; // aged out below the 7d window
    state.pages.push([]); // page below the stale cursor: empty
    state.pages.push([row("2026-07-21T00:00:00Z")]); // retry from the top
    await runTask();

    expect(itemSelects()).toHaveLength(2);
    expect(itemSelects()[0].params[2]).toBe("2026-07-01T00:00:00Z");
    expect(itemSelects()[1].params[2]).toBeNull();
    expect(cursorClears().length).toBeGreaterThanOrEqual(1);
    // Short retry page → rotation restarts clean: no cursor persisted.
    expect(state.cursorValue).toBeNull();
  });
});

describe("non-daily tiers — cursor untouched", () => {
  it.each([
    ["hourly <24h", HOURLY],
    ["half-hourly <6h", HALF_HOUR],
  ])("%s: select from the top, no cursor read or write", async (_label, when) => {
    vi.setSystemTime(when);
    state.cursorValue = "2026-07-19T00:00:00Z"; // pre-existing daily cursor
    state.pages.push([row("2026-07-21T11:00:00Z"), row("2026-07-21T10:00:00Z"), row("2026-07-21T09:00:00Z")]); // full page
    await runTask();

    expect(itemSelects()).toHaveLength(1);
    expect(itemSelects()[0].params[2]).toBeNull(); // never keyset-filtered
    expect(cursorReads()).toHaveLength(0);
    expect(cursorWrites()).toHaveLength(0);
    expect(cursorClears()).toHaveLength(0);
    expect(state.cursorValue).toBe("2026-07-19T00:00:00Z"); // untouched
  });
});
