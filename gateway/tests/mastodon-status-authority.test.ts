import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A Mastodon context write refuses a status that claims another host's ids
// (CA-A10, 2026-09-29; §2.9 on the client-API door).
//
// `fetchMastodonParent` reads `/api/v1/statuses/:id` on the host the child's
// reply uri named and used to store `status.uri || status.url` as the dedup
// key and `status.account.uri ?? url` as the author, on the instance's word.
// This drives the REAL function against a routed `safeFetch` mock — the real
// `readMastodonStatus` and the real `mastodonStatusIdentity` run — and the
// load-bearing assertion is whether the INSERT was ISSUED and with which
// identity: a guard that refuses after the row is written is the same squat
// wearing a null return. The text pin the audit first proposed (grep for
// `uri || url`) could not have seen either.
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
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/INSERT INTO external_items/.test(sql)) {
        inserts.push({ sql, params });
        return { rows: [{ id: "row-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _reply: unknown, done: () => void) => done(),
}));
vi.mock("../src/lib/external-items-shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureContextFeedItem: vi.fn(async () => {}),
}));

const { fetchMastodonParent } = await import("../src/routes/external-items/parent.js");

const HOST = "good.social";
const STATUS_URL = `https://${HOST}/api/v1/statuses/1`;
const honest = () => ({
  id: "1",
  uri: `https://${HOST}/users/alice/statuses/1`,
  url: `https://${HOST}/@alice/1`,
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
  in_reply_to_account_id: null,
});
const PARENT_URI = `https://${HOST}/users/alice/statuses/1`;

beforeEach(() => {
  responses.clear();
  inserts.length = 0;
});

describe("fetchMastodonParent — status authority", () => {
  it("stores an honest answer under its own ids (the control)", async () => {
    responses.set(STATUS_URL, honest());
    const out = await fetchMastodonParent(PARENT_URI, "source-1");
    expect(out?.parent.sourceItemUri).toBe(PARENT_URI);
    expect(inserts).toHaveLength(1);
    const p = inserts[0].params;
    expect(p[2]).toBe(PARENT_URI); // source_item_uri
    expect(p[6]).toBe(`https://${HOST}/users/alice`); // author_uri
  });

  it("refuses a status claiming a victim's id on another host — nothing is written", async () => {
    responses.set(STATUS_URL, { ...honest(), uri: "https://mastodon.social/users/victim/statuses/9" });
    expect(await fetchMastodonParent(PARENT_URI, "source-1")).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("refuses an honest status whose AUTHOR names a victim on another host", async () => {
    const body = honest();
    body.account.uri = "https://mastodon.social/users/victim";
    responses.set(STATUS_URL, body);
    expect(await fetchMastodonParent(PARENT_URI, "source-1")).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("refuses a status with no federated id rather than keying on the web url", async () => {
    const { uri: _drop, ...noUri } = honest();
    responses.set(STATUS_URL, noUri);
    expect(await fetchMastodonParent(PARENT_URI, "source-1")).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("refuses an author with no actor id rather than falling back to their web url", async () => {
    const body = honest();
    delete (body.account as { uri?: string }).uri;
    responses.set(STATUS_URL, body);
    expect(await fetchMastodonParent(PARENT_URI, "source-1")).toBeNull();
    expect(inserts).toHaveLength(0);
  });
});
