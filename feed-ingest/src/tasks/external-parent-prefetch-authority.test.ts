import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// The prefetch writers refuse a status claiming another host's ids, and the
// quote writer stores its permalink (CA-A10 + CA-C12, 2026-09-29).
//
// `prefetchMastodonParent` and `prefetchMastodonQuote` read the client API on
// the host the child's reply/quote uri named and INSERT a context row. Both
// used to key the row on `status.uri || status.url` and its author on
// `status.account.uri ?? url` — the instance's word; and the quote INSERT
// named no `canonical_url` at all, the ingest rule's 58,686-row class one
// writer over. Driven through a routed `safeFetch` mock so the REAL reader and
// the REAL identity check run; the assertion is whether an INSERT was issued
// and what it carried, column by column, read off the statement itself.
// =============================================================================

const responses = new Map<string, unknown>();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async (url: string) => {
    const body = responses.get(url);
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, headers: new Headers(), text: JSON.stringify(body), url };
  }),
}));

const inserts: Array<{ sql: string; params: unknown[] }> = [];
const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO external_items/.test(sql)) {
      inserts.push({ sql, params });
      return { rows: [{ id: "row-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prefetchMastodonParent, prefetchMastodonQuote } = await import("./external-parent-prefetch.js");

const HOST = "good.social";
const STATUS_URL = `https://${HOST}/api/v1/statuses/7`;
const URI = `https://${HOST}/users/alice/statuses/7`;
const honest = () => ({
  id: "7",
  uri: URI,
  url: `https://${HOST}/@alice/7`,
  content: "<p>hello</p>",
  created_at: "2026-09-01T00:00:00Z",
  account: {
    acct: "alice",
    display_name: "Alice",
    avatar: `https://${HOST}/a.png`,
    url: `https://${HOST}/@alice`,
    uri: `https://${HOST}/users/alice`,
  },
  in_reply_to_id: null,
});

/** The value an INSERT bound to a named column, resolved by zipping the
 *  statement's column list against its VALUES placeholders — the same
 *  reading the canonical-url suite does, so a column shuffled or dropped is
 *  seen rather than assumed. */
function boundTo(ins: { sql: string; params: unknown[] }, column: string): unknown {
  const cols = ins.sql.match(/INSERT INTO external_items \(([\s\S]*?)\) VALUES/)![1]
    .replace(/--[^\n]*/g, "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const vals = ins.sql.match(/VALUES \(([\s\S]*?)\)\s*(?:--[^\n]*\n\s*)*ON CONFLICT/)![1]
    .split(",")
    .map((v) => v.trim());
  const i = cols.indexOf(column);
  if (i < 0) return undefined;
  const m = vals[i].match(/^\$(\d+)$/);
  if (!m) return vals[i]; // a literal ('tier3', TRUE)
  return ins.params[Number(m[1]) - 1];
}

beforeEach(() => {
  responses.clear();
  inserts.length = 0;
});

describe("prefetchMastodonParent — status authority", () => {
  it("stores an honest answer under its own ids (the control)", async () => {
    responses.set(STATUS_URL, honest());
    await prefetchMastodonParent(URI, "source-1");
    expect(inserts).toHaveLength(1);
    expect(boundTo(inserts[0], "source_item_uri")).toBe(URI);
    expect(boundTo(inserts[0], "author_uri")).toBe(`https://${HOST}/users/alice`);
  });

  it("refuses a status claiming a victim's id on another host", async () => {
    responses.set(STATUS_URL, { ...honest(), uri: "https://mastodon.social/users/victim/statuses/9" });
    await prefetchMastodonParent(URI, "source-1");
    expect(inserts).toHaveLength(0);
  });

  it("refuses an author on another host beneath an honest status", async () => {
    const body = honest();
    body.account.uri = "https://mastodon.social/users/victim";
    responses.set(STATUS_URL, body);
    await prefetchMastodonParent(URI, "source-1");
    expect(inserts).toHaveLength(0);
  });
});

describe("prefetchMastodonQuote — authority and the permalink", () => {
  it("stores an honest quote with its canonical_url beside the id (CA-C12)", async () => {
    responses.set(STATUS_URL, honest());
    await prefetchMastodonQuote(URI, "source-1");
    expect(inserts).toHaveLength(1);
    expect(boundTo(inserts[0], "source_item_uri")).toBe(URI);
    expect(boundTo(inserts[0], "author_uri")).toBe(`https://${HOST}/users/alice`);
    // The permalink reaches its column, and it is not the identity.
    expect(boundTo(inserts[0], "canonical_url")).toBe(`https://${HOST}/@alice/7`);
    expect(boundTo(inserts[0], "canonical_url")).not.toBe(URI);
  });

  it("leaves canonical_url NULL when the status declares no url", async () => {
    responses.set(STATUS_URL, { ...honest(), url: null });
    await prefetchMastodonQuote(URI, "source-1");
    expect(inserts).toHaveLength(1);
    expect(boundTo(inserts[0], "canonical_url")).toBeNull();
  });

  it("refuses a quote claiming another host's ids — nothing is written", async () => {
    responses.set(STATUS_URL, { ...honest(), uri: "https://mastodon.social/users/victim/statuses/9" });
    await prefetchMastodonQuote(URI, "source-1");
    expect(inserts).toHaveLength(0);
  });
});
