import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// FOLLOW-GRAPH-IMPORT-ADR §5.3 / §11.4 — Phase 1c ActivityPub graph reader.
//
// Covers the live-verified Mastodon-API contract end-to-end with a URL-routed
// safeFetch mock: Link-header pagination (same-origin only), the cap, the
// first-page-vs-later failure split, hidden-follows detection (empty list +
// following_count > 0 — public leg only; the authed self-call bypasses it),
// the linked-presence bearer token, actor-URI canonicalisation from the
// Account entity `uri` with the WebFinger fallback, and the §6.6 sub-brake.
// =============================================================================

const mockPoolQuery = vi.fn();
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/routes/feeds/sources.js", () => ({
  addSource: vi.fn(),
  removeSource: vi.fn(),
}));

vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: vi.fn(),
  getFollows: vi.fn(),
}));
vi.mock("../src/lib/nostr-relay.js", () => ({
  fetchNostrContacts: vi.fn(),
}));
vi.mock("../src/lib/nostr-search.js", () => ({
  getDefaultProfileRelays: vi.fn(() => []),
}));

const mockDecryptJson = vi.fn();
vi.mock("@platform-pub/shared/lib/crypto.js", () => ({
  decryptJson: (...args: unknown[]) => mockDecryptJson(...args),
  encryptJson: vi.fn(),
}));

const mockSafeFetch = vi.fn();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

import {
  parseNextLink,
  fetchMastodonFollowing,
} from "../src/lib/activitypub-resolve.js";
import { readFollowGraph } from "../src/lib/follow-import.js";

const ORIGIN = "https://inst.test";

function jsonResponse(
  body: unknown,
  opts: { link?: string; ok?: boolean; status?: number } = {},
) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: JSON.stringify(body),
    headers: { get: (name: string) => (name === "link" ? opts.link ?? null : null) },
  };
}

function apiAccount(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(n),
    acct: `user${n}@remote.test`,
    uri: `https://remote.test/users/user${n}`,
    display_name: `User ${n}`,
    avatar: `https://remote.test/a/${n}.png`,
    following_count: 5,
    ...overrides,
  };
}

// Standard route table for a full public read of alice@inst.test.
function routeStandard(handlers: Record<string, (url: string) => unknown> = {}) {
  mockSafeFetch.mockImplementation((url: string) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return Promise.resolve(handler(url));
    }
    if (url.startsWith(`${ORIGIN}/.well-known/webfinger`)) {
      return Promise.resolve(
        jsonResponse({
          links: [
            {
              rel: "self",
              type: "application/activity+json",
              href: `${ORIGIN}/users/alice`,
            },
          ],
        }),
      );
    }
    if (url.startsWith(`${ORIGIN}/api/v1/accounts/lookup`)) {
      return Promise.resolve(
        jsonResponse({
          id: "42",
          acct: "alice",
          uri: `${ORIGIN}/users/alice`,
          following_count: 2,
        }),
      );
    }
    if (url.startsWith(`${ORIGIN}/api/v1/accounts/42/following`)) {
      return Promise.resolve(jsonResponse([apiAccount(1), apiAccount(2)]));
    }
    return Promise.resolve({ ok: false, status: 404, text: "", headers: { get: () => null } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FOLLOW_IMPORT_ENABLED = "1";
  process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED = "1";
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  delete process.env.FOLLOW_IMPORT_ENABLED;
  delete process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED;
});

describe("parseNextLink", () => {
  it("extracts the same-origin rel=next URL", () => {
    const header = `<${ORIGIN}/api/v1/accounts/1/following?max_id=9>; rel="next", <${ORIGIN}/api/v1/accounts/1/following?since_id=5>; rel="prev"`;
    expect(parseNextLink(header, ORIGIN)).toBe(
      `${ORIGIN}/api/v1/accounts/1/following?max_id=9`,
    );
  });

  it("rejects a cross-origin next URL (remote-controlled header)", () => {
    const header = `<https://evil.test/steal>; rel="next"`;
    expect(parseNextLink(header, ORIGIN)).toBeNull();
  });

  it("returns null when there is no next link", () => {
    expect(parseNextLink(null, ORIGIN)).toBeNull();
    expect(
      parseNextLink(`<${ORIGIN}/x>; rel="prev"`, ORIGIN),
    ).toBeNull();
  });
});

describe("fetchMastodonFollowing", () => {
  it("pages through rel=next and stops at the cap (an incomplete read)", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => apiAccount(i));
    const page2 = Array.from({ length: 3 }, (_, i) => apiAccount(10 + i));
    mockSafeFetch
      .mockResolvedValueOnce(
        jsonResponse(page1, {
          link: `<${ORIGIN}/api/v1/accounts/42/following?max_id=3>; rel="next"`,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(page2));
    const out = await fetchMastodonFollowing(ORIGIN, "42", 5);
    expect(out?.accounts).toHaveLength(5); // capped mid-page-2
    expect(out?.complete).toBe(false);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it("a full read that ends at the last page is complete", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      jsonResponse([apiAccount(1), apiAccount(2)]),
    );
    const out = await fetchMastodonFollowing(ORIGIN, "42", 10);
    expect(out?.accounts).toHaveLength(2);
    expect(out?.complete).toBe(true);
  });

  it("returns null when the FIRST page fails, incomplete partial on a later failure", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: "",
      headers: { get: () => null },
    });
    expect(await fetchMastodonFollowing(ORIGIN, "42", 10)).toBeNull();

    mockSafeFetch
      .mockResolvedValueOnce(
        jsonResponse([apiAccount(1)], {
          link: `<${ORIGIN}/api/v1/accounts/42/following?max_id=1>; rel="next"`,
        }),
      )
      .mockRejectedValueOnce(new Error("boom"));
    const partial = await fetchMastodonFollowing(ORIGIN, "42", 10);
    expect(partial?.accounts).toHaveLength(1);
    expect(partial?.complete).toBe(false);
  });

  it("sends the bearer token when given one", async () => {
    mockSafeFetch.mockResolvedValueOnce(jsonResponse([]));
    await fetchMastodonFollowing(ORIGIN, "42", 10, "tok-123");
    const [, opts] = mockSafeFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer tok-123");
  });

  it("bounds a hostile endless pager: unparseable non-empty pages + a same-origin next chain terminate as an incomplete read", async () => {
    // Progress is measured in PARSED accounts, so without the page ceiling a
    // server feeding [{}] pages with rel=next forever would never terminate.
    mockSafeFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse([{}], {
          link: `<${ORIGIN}/api/v1/accounts/42/following?max_id=1>; rel="next"`,
        }),
      ),
    );
    const cap = 80;
    const out = await fetchMastodonFollowing(ORIGIN, "42", cap);
    expect(out?.accounts).toHaveLength(0);
    expect(out?.complete).toBe(false); // ceiling hit = truncated, suppresses sync removals
    expect(mockSafeFetch.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(cap / 80) + 7,
    );
  });
});

describe("readFollowGraph('activitypub', …)", () => {
  it("refuses while the §6.6 sub-brake is on", async () => {
    delete process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED;
    const res = await readFollowGraph("activitypub", "alice@inst.test");
    expect(res).toMatchObject({ ok: false, reason: "unsupported" });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-acct, non-URL input as malformed", async () => {
    const res = await readFollowGraph("activitypub", "not a handle");
    expect(res).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("reads a public graph: canonical actor URIs, label, total", async () => {
    routeStandard();
    const res = await readFollowGraph("activitypub", "@Alice@inst.test");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.originIdentity).toBe("alice@inst.test");
    expect(res.originLabel).toBe("@alice@inst.test");
    expect(res.identities.map((i) => i.uri)).toEqual([
      "https://remote.test/users/user1",
      "https://remote.test/users/user2",
    ]);
    expect(res.identities[0].displayName).toBe("User 1");
    expect(res.total).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.unresolved).toBe(0);
  });

  it("a drifting following_count does NOT mark a full read truncated", async () => {
    // following_count counts suspended/moved accounts the list omits; a full
    // pagination (no next link) is complete regardless — deriving truncation
    // from the count difference suppressed sync removals for nearly every
    // aged account (2026-07-12 run-through fix).
    routeStandard({
      [`${ORIGIN}/api/v1/accounts/lookup`]: () =>
        jsonResponse({
          id: "42",
          acct: "alice",
          uri: `${ORIGIN}/users/alice`,
          following_count: 5,
        }),
    });
    const res = await readFollowGraph("activitypub", "alice@inst.test");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identities).toHaveLength(2);
    expect(res.total).toBe(5); // display keeps the claimed count
    expect(res.truncated).toBe(false); // but the pager's verdict wins
  });

  it("detects hidden follows on the public leg (empty + count > 0)", async () => {
    routeStandard({
      [`${ORIGIN}/api/v1/accounts/42/following`]: () => jsonResponse([]),
    });
    const res = await readFollowGraph("activitypub", "alice@inst.test");
    expect(res).toMatchObject({ ok: false, reason: "hidden" });
  });

  it("uses the linked presence's token — and an empty authed list is NOT hidden", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          external_id: "42",
          handle: "alice@inst.test",
          service_url: ORIGIN,
          credentials_enc: "enc",
        },
      ],
      rowCount: 1,
    });
    mockDecryptJson.mockReturnValue({ accessToken: "tok-999" });
    routeStandard({
      [`${ORIGIN}/api/v1/accounts/42/following`]: () => jsonResponse([]),
    });
    const res = await readFollowGraph("activitypub", "alice@inst.test", {
      accountId: "acc-1",
    });
    // Authed self-call bypasses hide_results? — an empty list is genuinely empty.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identities).toHaveLength(0);
    const followingCall = mockSafeFetch.mock.calls.find(([u]) =>
      String(u).includes("/following"),
    );
    expect(followingCall?.[1]?.headers?.Authorization).toBe("Bearer tok-999");
  });

  it("falls back to WebFinger for entries without uri and counts the unresolvable", async () => {
    routeStandard({
      [`${ORIGIN}/api/v1/accounts/42/following`]: () =>
        jsonResponse([
          apiAccount(1),
          apiAccount(2, { uri: null, acct: "bob@old.test" }),
          apiAccount(3, { uri: null, acct: "gone@dead.test" }),
        ]),
      "https://old.test/.well-known/webfinger": () =>
        jsonResponse({
          links: [
            {
              rel: "self",
              type: "application/activity+json",
              href: "https://old.test/users/bob",
            },
          ],
        }),
      "https://dead.test/.well-known/webfinger": () => ({
        ok: false,
        status: 404,
        text: "",
        headers: { get: () => null },
      }),
    });
    const res = await readFollowGraph("activitypub", "alice@inst.test");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identities.map((i) => i.uri)).toEqual([
      "https://remote.test/users/user1",
      "https://old.test/users/bob",
    ]);
    expect(res.unresolved).toBe(1);
  });

  it("retries public when the authed read fails (expired token)", async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          external_id: "42",
          handle: "alice@inst.test",
          service_url: ORIGIN,
          credentials_enc: "enc",
        },
      ],
      rowCount: 1,
    });
    mockDecryptJson.mockReturnValue({ accessToken: "stale" });
    let followingCalls = 0;
    routeStandard({
      [`${ORIGIN}/api/v1/accounts/42/following`]: () => {
        // Authed attempt 401s; the public retry succeeds. The handler can't
        // see headers, so key off call order via a counter.
        followingCalls++;
        return followingCalls === 1
          ? { ok: false, status: 401, text: "", headers: { get: () => null } }
          : jsonResponse([apiAccount(1)]);
      },
    });
    const res = await readFollowGraph("activitypub", "alice@inst.test", {
      accountId: "acc-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identities).toHaveLength(1);
  });
});
