import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// Resolver orchestration harness (RESOLVER-DISCOVERY-ADR Phase 0, audit F8).
//
// Exercises resolve()/resolveAsync() through their public surface — resolve()
// plus getAsyncResult() over a faked resolver_async_results table — with every
// network chain mocked at its module seam. No live I/O. Covers:
//   - Phase A → Phase B assembly (local matches survive into the async row,
//     Phase B enriches them)
//   - discover / skipExternal / context gating matrix (invite/dm never
//     register discovery chains)
//   - incremental partial persistence order (catalog lands before network
//     branches)
//   - initiator scoping + missing-initiator fallback (Phase B skipped)
//   - per-chain failure isolation (one chain throwing never fails the resolve
//     or strands the row in 'pending')
//
// This harness is the safety net for the resolver.ts decomposition
// (CONSOLIDATED-TODO §8.5) and for the discovery-expansion phases that follow.
// =============================================================================

// --- chain mocks (deferred-deref pattern, per auth-middleware.test.ts) -------

const mockGetProfile = vi.fn();
const mockResolveHandle = vi.fn();
const mockSearchActors = vi.fn();
const mockExtractFromBskyUrl = vi.fn();
const mockIsDid = vi.fn();

vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: (...a: any[]) => mockGetProfile(...a),
  resolveHandle: (...a: any[]) => mockResolveHandle(...a),
  searchActors: (...a: any[]) => mockSearchActors(...a),
  extractFromBskyUrl: (...a: any[]) => mockExtractFromBskyUrl(...a),
  isDid: (...a: any[]) => mockIsDid(...a),
}));

const mockResolveWebFinger = vi.fn();
const mockFetchActorProfile = vi.fn();
const mockExtractFromMastodonUrl = vi.fn();
const mockExtractFromThreadiverseUrl = vi.fn();

vi.mock("../src/lib/activitypub-resolve.js", () => ({
  resolveWebFinger: (...a: any[]) => mockResolveWebFinger(...a),
  fetchActorProfile: (...a: any[]) => mockFetchActorProfile(...a),
  extractFromMastodonUrl: (...a: any[]) => mockExtractFromMastodonUrl(...a),
  extractFromThreadiverseUrl: (...a: any[]) =>
    mockExtractFromThreadiverseUrl(...a),
}));

const mockSearchCatalog = vi.fn();

vi.mock("../src/lib/discovery-catalog.js", () => ({
  searchCatalog: (...a: any[]) => mockSearchCatalog(...a),
}));

const mockSearchApAccounts = vi.fn();

vi.mock("../src/lib/ap-account-search.js", () => ({
  searchApAccounts: (...a: any[]) => mockSearchApAccounts(...a),
}));

const mockFetchNostrProfile = vi.fn();
const mockSearchNostrProfiles = vi.fn();

vi.mock("../src/lib/nostr-search.js", () => ({
  fetchNostrProfile: (...a: any[]) => mockFetchNostrProfile(...a),
  searchNostrProfiles: (...a: any[]) => mockSearchNostrProfiles(...a),
  parseNostrProfileContent: vi.fn(),
}));

const mockSafeFetch = vi.fn();

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: any[]) => mockSafeFetch(...a),
  pinnedWebSocketOptions: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// --- fake resolver_async_results + accounts store ----------------------------

interface StoredRow {
  initiatorId: string;
  result: any;
}
const asyncRows = new Map<string, StoredRow>();
// Every upserted result snapshot, in write order — the persistence-order probe.
const storeLog: any[] = [];
const byUsername = new Map<string, any>();
const byPubkey = new Map<string, any>();
const byEmail = new Map<string, any>();
let fuzzyAccounts: any[] = [];
// Rows the known-world UNION query returns (RESOLVER-DISCOVERY-ADR §4),
// in the score order the real SQL would produce.
let knownWorldRows: any[] = [];

const mockQuery = vi.fn();

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...a: any[]) => mockQuery(...a) },
}));

function fakeQuery(sql: string, params?: any[]) {
  if (sql.includes("INSERT INTO resolver_async_results")) {
    const [requestId, initiatorId, resultJson] = params!;
    const result = JSON.parse(resultJson);
    asyncRows.set(requestId, { initiatorId, result });
    storeLog.push(result);
    return Promise.resolve({ rows: [] });
  }
  if (sql.includes("DELETE FROM resolver_async_results")) {
    return Promise.resolve({ rows: [] });
  }
  if (sql.includes("FROM resolver_async_results")) {
    const [requestId, initiatorId] = params!;
    const row = asyncRows.get(requestId);
    return Promise.resolve({
      rows:
        row && row.initiatorId === initiatorId ? [{ result: row.result }] : [],
    });
  }
  if (sql.includes("WHERE username = $1")) {
    const row = byUsername.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("WHERE nostr_pubkey = $1")) {
    const row = byPubkey.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("WHERE email = $1")) {
    const row = byEmail.get(params![0]);
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (sql.includes("ILIKE")) {
    return Promise.resolve({ rows: fuzzyAccounts });
  }
  if (sql.includes("FROM external_authors")) {
    return Promise.resolve({ rows: knownWorldRows });
  }
  return Promise.resolve({ rows: [] });
}

const { resolve, getAsyncResult } = await import("../src/lib/resolver.js");

const INITIATOR = "11111111-1111-4111-8111-111111111111";
const HEX_PUBKEY = "ab".repeat(32);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// resolveAsync is fire-and-forget from resolve(); wait for its final
// status:'complete' write to land in the fake table.
async function waitComplete(requestId: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = asyncRows.get(requestId);
    if (row?.result?.status === "complete") return row.result;
    await sleep(5);
  }
  throw new Error(`async result for ${requestId} never reached 'complete'`);
}

beforeEach(() => {
  vi.clearAllMocks();
  asyncRows.clear();
  storeLog.length = 0;
  byUsername.clear();
  byPubkey.clear();
  byEmail.clear();
  fuzzyAccounts = [];
  knownWorldRows = [];

  mockQuery.mockImplementation(fakeQuery);
  mockGetProfile.mockResolvedValue(null);
  mockResolveHandle.mockResolvedValue(null);
  mockSearchActors.mockResolvedValue([]);
  mockExtractFromBskyUrl.mockReturnValue(null);
  mockIsDid.mockImplementation((s: string) => s.startsWith("did:"));
  mockResolveWebFinger.mockResolvedValue(null);
  mockFetchActorProfile.mockResolvedValue(null);
  mockExtractFromMastodonUrl.mockReturnValue(null);
  mockExtractFromThreadiverseUrl.mockReturnValue(null);
  mockSearchCatalog.mockReturnValue([]);
  mockSearchApAccounts.mockResolvedValue([]);
  mockFetchNostrProfile.mockResolvedValue(null);
  mockSearchNostrProfiles.mockResolvedValue([]);
  mockSafeFetch.mockResolvedValue({
    ok: false,
    status: 404,
    text: "",
    headers: { get: () => null },
  });
});

// =============================================================================
// Phase A → Phase B assembly
// =============================================================================

describe("Phase A → Phase B assembly", () => {
  it("hex pubkey: Phase A returns native + external match, Phase B enriches in place", async () => {
    byPubkey.set(HEX_PUBKEY, {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });
    mockFetchNostrProfile.mockResolvedValue({
      displayName: "Guardian on Nostr",
      about: "News.",
      picture: "https://example.com/g.png",
    });

    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);

    expect(res.inputType).toBe("hex_pubkey");
    expect(res.status).toBe("pending");
    expect(res.requestId).toBeDefined();
    expect(res.pendingResolutions).toEqual(["nostr_profile"]);
    // Phase A: native account + exact external source, immediately.
    expect(res.matches).toHaveLength(2);
    expect(res.matches[0].type).toBe("native_account");
    expect(res.matches[0].account?.username).toBe("guardian");
    expect(res.matches[1].externalSource?.protocol).toBe("nostr_external");
    expect(res.matches[1].confidence).toBe("exact");

    // Seed row is stored before Phase B completes.
    expect(storeLog[0].status).toBe("pending");

    // Phase B enriches the external match with kind-0 metadata.
    const final = await waitComplete(res.requestId!);
    const ext = final.matches.find(
      (m: any) => m.externalSource?.protocol === "nostr_external",
    );
    expect(ext.externalSource.displayName).toBe("Guardian on Nostr");
    expect(ext.externalSource.description).toBe("News.");
    expect(ext.externalSource.avatar).toBe("https://example.com/g.png");
    // The Phase A native match survives into the final row.
    expect(
      final.matches.some((m: any) => m.account?.username === "guardian"),
    ).toBe(true);
  });

  it("missing initiator: Phase B is skipped entirely, Phase A returned complete", async () => {
    const res = await resolve("someone.bsky.social", "general", undefined);

    expect(res.inputType).toBe("bluesky_handle");
    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    await sleep(20);
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(storeLog).toHaveLength(0);
  });
});

// =============================================================================
// Gating matrix — discover / skipExternal / context
// =============================================================================

describe("discovery gating matrix", () => {
  const CATALOG_HIT = [
    {
      feedUrl: "https://www.theguardian.com/rss",
      title: "The Guardian",
      description: "News",
    },
  ];
  const BSKY_HIT = [
    {
      did: "did:plc:guardian",
      handle: "guardian.bsky.social",
      displayName: "The Guardian",
    },
  ];
  const NOSTR_HIT = [{ pubkey: HEX_PUBKEY, displayName: "guardian" }];
  const AP_HIT = [
    {
      acct: "guardian@mastodon.social",
      displayName: "The Guardian",
      url: "https://mastodon.social/users/guardian",
    },
  ];

  it("free_text + discover + subscribe: all four discovery branches run and land", async () => {
    mockSearchCatalog.mockReturnValue(CATALOG_HIT);
    mockSearchActors.mockResolvedValue(BSKY_HIT);
    mockSearchNostrProfiles.mockResolvedValue(NOSTR_HIT);
    mockSearchApAccounts.mockResolvedValue(AP_HIT);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);

    expect(res.inputType).toBe("free_text");
    expect(res.status).toBe("pending");
    expect(res.pendingResolutions).toEqual([
      "catalog_discovery",
      "bluesky_discovery",
      "nostr_discovery",
      "activitypub_discovery",
    ]);

    const final = await waitComplete(res.requestId!);
    const protocols = final.matches.map(
      (m: any) => m.externalSource?.protocol ?? m.type,
    );
    expect(protocols).toContain("rss_feed");
    expect(protocols).toContain("atproto");
    expect(protocols).toContain("nostr_external");
    expect(protocols).toContain("activitypub");
    // Discovery nominations are speculative, never exact.
    for (const m of final.matches) {
      expect(m.confidence).toBe("speculative");
    }
  });

  it("free_text without discover: no discovery chains, resolve completes in Phase A", async () => {
    const res = await resolve("the guardian news", "subscribe", INITIATOR);

    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    await sleep(20);
    expect(mockSearchCatalog).not.toHaveBeenCalled();
    expect(mockSearchActors).not.toHaveBeenCalled();
    expect(mockSearchNostrProfiles).not.toHaveBeenCalled();
    expect(mockSearchApAccounts).not.toHaveBeenCalled();
  });

  it.each(["invite", "dm"] as const)(
    "%s context never registers discovery chains even with discover=true",
    async (context) => {
      mockSearchCatalog.mockReturnValue(CATALOG_HIT);

      const res = await resolve("the guardian news", context, INITIATOR, true);

      expect(res.status).toBe("complete");
      expect(res.requestId).toBeUndefined();
      await sleep(20);
      expect(mockSearchCatalog).not.toHaveBeenCalled();
      expect(mockSearchActors).not.toHaveBeenCalled();
      expect(mockSearchNostrProfiles).not.toHaveBeenCalled();
      expect(mockSearchApAccounts).not.toHaveBeenCalled();
    },
  );

  it("platform_username with an exact hit short-circuits discovery", async () => {
    byUsername.set("guardian", {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });

    const res = await resolve("guardian", "general", INITIATOR, true);

    expect(res.status).toBe("complete");
    expect(res.requestId).toBeUndefined();
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].confidence).toBe("exact");
    await sleep(20);
    expect(mockSearchActors).not.toHaveBeenCalled();
  });

  it("platform_username with no exact hit falls back to discovery", async () => {
    const res = await resolve("guardian", "general", INITIATOR, true);

    expect(res.status).toBe("pending");
    expect(res.pendingResolutions).toEqual([
      "catalog_discovery",
      "bluesky_discovery",
      "nostr_discovery",
      "activitypub_discovery",
    ]);
    await waitComplete(res.requestId!);
  });

  it("ambiguous_at in invite context: NIP-05 runs (can find native accounts), WebFinger does not", async () => {
    const res = await resolve("someone@example.com", "invite", INITIATOR);

    expect(res.inputType).toBe("ambiguous_at");
    expect(res.pendingResolutions).toEqual(["nip05_resolution"]);

    const final = await waitComplete(res.requestId!);
    expect(final.status).toBe("complete");
    expect(mockResolveWebFinger).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Incremental partial persistence order
// =============================================================================

describe("incremental partial persistence", () => {
  it("catalog partial lands before the network discovery branches", async () => {
    mockSearchCatalog.mockReturnValue([
      { feedUrl: "https://g.example/rss", title: "Guardian" },
    ]);
    mockSearchActors.mockImplementation(async () => {
      await sleep(20);
      return [{ did: "did:plc:g", handle: "g.bsky.social" }];
    });

    const res = await resolve("the guardian news", "general", INITIATOR, true);
    await waitComplete(res.requestId!);

    const hasRss = (snap: any) =>
      snap.matches.some((m: any) => m.type === "rss_feed");
    const hasAtproto = (snap: any) =>
      snap.matches.some((m: any) => m.externalSource?.protocol === "atproto");

    const firstRss = storeLog.findIndex(hasRss);
    const firstAtproto = storeLog.findIndex(hasAtproto);
    expect(firstRss).toBeGreaterThanOrEqual(0);
    expect(firstAtproto).toBeGreaterThan(firstRss);
    // The catalog partial is still 'pending' — a poll mid-flight sees it.
    expect(storeLog[firstRss].status).toBe("pending");
    // The last write is the complete row carrying everything.
    const last = storeLog[storeLog.length - 1];
    expect(last.status).toBe("complete");
    expect(hasRss(last) && hasAtproto(last)).toBe(true);
  });
});

// =============================================================================
// Initiator scoping
// =============================================================================

describe("initiator scoping", () => {
  it("getAsyncResult returns the row only to its initiator", async () => {
    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);
    await waitComplete(res.requestId!);

    const other = await getAsyncResult(
      res.requestId!,
      "22222222-2222-4222-8222-222222222222",
    );
    expect(other).toBeNull();

    const mine = await getAsyncResult(res.requestId!, INITIATOR);
    expect(mine?.status).toBe("complete");
  });

  it("rejects non-UUID request ids without touching the DB", async () => {
    const result = await getAsyncResult("not-a-uuid", INITIATOR);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Known-world index (RESOLVER-DISCOVERY-ADR §4 — Phase 1)
// =============================================================================

describe("known-world index (Phase A)", () => {
  const AUTHOR_ROW = {
    protocol: "atproto",
    identity: "did:plc:guardian",
    display_name: "The Guardian",
    handle: "guardian.bsky.social",
    avatar: "https://cdn.example/a.png",
    kind: "author",
  };
  const SOURCE_ROW = {
    protocol: "rss",
    identity: "https://www.theguardian.com/rss",
    display_name: "The Guardian",
    handle: null,
    avatar: "https://cdn.example/s.png",
    kind: "source",
  };

  const knownWorldQueried = () =>
    mockQuery.mock.calls.some(([sql]: any[]) =>
      String(sql).includes("FROM external_authors"),
    );

  it("free_text surfaces known-world hits instantly in Phase A as 'probable'", async () => {
    knownWorldRows = [AUTHOR_ROW, SOURCE_ROW];

    // discover=false: no Phase B — known-world is synchronous Phase A.
    const res = await resolve("the guardian", "subscribe", INITIATOR);

    expect(res.status).toBe("complete");
    const ext = res.matches.filter((m) => m.type === "external_source");
    expect(ext).toHaveLength(2);
    expect(ext[0].confidence).toBe("probable");
    expect(ext[0].externalSource?.protocol).toBe("atproto");
    expect(ext[0].externalSource?.sourceUri).toBe("did:plc:guardian");
    expect(ext[0].externalSource?.displayName).toBe("The Guardian");
    expect(ext[1].externalSource?.protocol).toBe("rss");
    // No stray internal field leaks onto the wire shape.
    expect("kind" in ext[0]).toBe(false);
  });

  it("platform_username with no exact hit also searches the known world", async () => {
    knownWorldRows = [AUTHOR_ROW];

    const res = await resolve("guardian", "general", INITIATOR);

    expect(
      res.matches.some(
        (m) => m.externalSource?.sourceUri === "did:plc:guardian",
      ),
    ).toBe(true);
  });

  it("an exact platform_username hit short-circuits the known world", async () => {
    byUsername.set("guardian", {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });
    knownWorldRows = [AUTHOR_ROW];

    const res = await resolve("guardian", "general", INITIATOR);

    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].type).toBe("native_account");
    expect(knownWorldQueried()).toBe(false);
  });

  it("subscribe context runs the known world ALONGSIDE an exact native hit (squatter amendment)", async () => {
    // A native account squatting a publication name must not shadow the
    // external world in subscribe context; the exact hit still ranks first.
    byUsername.set("guardian", {
      id: "acc-1",
      username: "guardian",
      display_name: "The Guardian",
      avatar_blossom_url: null,
    });
    knownWorldRows = [AUTHOR_ROW];

    const res = await resolve("guardian", "subscribe", INITIATOR, true);

    expect(res.matches[0].type).toBe("native_account");
    expect(res.matches[0].confidence).toBe("exact");
    expect(
      res.matches.some(
        (m) => m.externalSource?.sourceUri === "did:plc:guardian",
      ),
    ).toBe(true);
    // Fuzzy native search stays suppressed by the exact hit…
    expect(
      res.matches.filter((m) => m.type === "native_account"),
    ).toHaveLength(1);
    // …and discovery chains still register.
    expect(res.pendingResolutions).toEqual(
      expect.arrayContaining(["catalog_discovery", "activitypub_discovery"]),
    );
  });

  it("queries shorter than 3 chars never touch the index", async () => {
    knownWorldRows = [AUTHOR_ROW];

    await resolve("ab", "general", INITIATOR);

    expect(knownWorldQueried()).toBe(false);
  });

  it.each(["invite", "dm"] as const)(
    "%s context is native-only: the known world is not searched",
    async (context) => {
      knownWorldRows = [AUTHOR_ROW];

      const res = await resolve("the guardian", context, INITIATOR);

      expect(knownWorldQueried()).toBe(false);
      expect(res.matches.every((m) => m.type === "native_account")).toBe(true);
    },
  );

  it("author/source twins dedupe to one match, preferring the source row", async () => {
    // Same (protocol, identity): the author scored higher (first), the source
    // row supersedes its data in place.
    const twinSource = {
      ...AUTHOR_ROW,
      kind: "source",
      display_name: "The Guardian (feed)",
      avatar: "https://cdn.example/s.png",
    };
    knownWorldRows = [AUTHOR_ROW, twinSource];

    const res = await resolve("the guardian", "subscribe", INITIATOR);

    const ext = res.matches.filter((m) => m.type === "external_source");
    expect(ext).toHaveLength(1);
    expect(ext[0].externalSource?.displayName).toBe("The Guardian (feed)");
    expect(ext[0].externalSource?.avatar).toBe("https://cdn.example/s.png");
  });

  it("caps known-world results at 5 even when the over-fetch returns more", async () => {
    knownWorldRows = Array.from({ length: 8 }, (_, i) => ({
      protocol: "rss",
      identity: `https://feed${i}.example/rss`,
      display_name: `Guardian ${i}`,
      handle: null,
      avatar: null,
      kind: "source",
    }));

    const res = await resolve("guardian weekly", "subscribe", INITIATOR);

    const ext = res.matches.filter((m) => m.type === "external_source");
    expect(ext).toHaveLength(5);
    // Score order (the stubbed row order) is preserved.
    expect(ext[0].externalSource?.displayName).toBe("Guardian 0");
  });
});

// =============================================================================
// ActivityPub discovery (RESOLVER-DISCOVERY-ADR §5 — Phase 2)
// =============================================================================

describe("activitypub discovery", () => {
  const GUARDIAN_ACTOR = "https://mastodon.social/users/guardian";
  const AP_CANDIDATE = {
    acct: "guardian@mastodon.social",
    displayName: "The Guardian",
    note: "News. Sport. Culture.",
    avatar: "https://cdn.example/g.png",
    url: GUARDIAN_ACTOR,
  };

  it("candidates land as speculative activitypub matches with the acct as sourceUri", async () => {
    mockSearchApAccounts.mockResolvedValue([AP_CANDIDATE]);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    const ap = final.matches.find(
      (m: any) => m.externalSource?.protocol === "activitypub",
    );
    expect(ap).toBeDefined();
    expect(ap.confidence).toBe("speculative");
    expect(ap.externalSource.sourceUri).toBe("guardian@mastodon.social");
    expect(ap.externalSource.displayName).toBe("The Guardian");
    expect(ap.externalSource.description).toBe("News. Sport. Culture.");
    expect(ap.externalSource.avatar).toBe("https://cdn.example/g.png");
  });

  it("a candidate whose actor URI collides with a known-world hit is dropped (known-world wins)", async () => {
    // Phase A known-world: the AP author's stable_handle IS the actor URI.
    knownWorldRows = [
      {
        protocol: "activitypub",
        identity: GUARDIAN_ACTOR,
        display_name: "The Guardian",
        handle: "guardian@mastodon.social",
        avatar: null,
        kind: "author",
      },
    ];
    mockSearchApAccounts.mockResolvedValue([
      AP_CANDIDATE,
      { acct: "guardian-fans@other.instance", displayName: "Guardian Fans" },
    ]);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    const ap = final.matches.filter(
      (m: any) => m.externalSource?.protocol === "activitypub",
    );
    // One probable known-world hit + the non-colliding candidate; the
    // colliding mirror is gone.
    expect(ap).toHaveLength(2);
    expect(
      ap.find((m: any) => m.externalSource.sourceUri === GUARDIAN_ACTOR)
        ?.confidence,
    ).toBe("probable");
    expect(
      ap.some(
        (m: any) => m.externalSource.sourceUri === "guardian@mastodon.social",
      ),
    ).toBe(false);
    expect(
      ap.find(
        (m: any) =>
          m.externalSource.sourceUri === "guardian-fans@other.instance",
      )?.confidence,
    ).toBe("speculative");
  });
});

// =============================================================================
// Merge step — bridge dedup + ordering (RESOLVER-DISCOVERY-ADR §6 — Phase 3)
// =============================================================================

describe("merge step (Phase 3)", () => {
  it("a Bridgy Fed AP mirror of a native Bluesky candidate yields one candidate", async () => {
    mockSearchActors.mockResolvedValue([
      { did: "did:plc:guardian", handle: "guardian.bsky.social" },
    ]);
    mockSearchApAccounts.mockResolvedValue([
      {
        acct: "guardian.bsky.social@bsky.brid.gy",
        displayName: "The Guardian (bridged)",
        url: "https://bsky.brid.gy/ap/did:plc:guardian",
      },
    ]);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    expect(
      final.matches.filter(
        (m: any) => m.externalSource?.protocol === "activitypub",
      ),
    ).toHaveLength(0);
    expect(
      final.matches.filter((m: any) => m.externalSource?.protocol === "atproto"),
    ).toHaveLength(1);
  });

  it("a NIP-48-proxied nostr mirror of a known-world AP author is dropped", async () => {
    knownWorldRows = [
      {
        protocol: "activitypub",
        identity: "https://mastodon.social/users/guardian",
        display_name: "The Guardian",
        handle: "guardian@mastodon.social",
        avatar: null,
        kind: "author",
      },
    ];
    mockSearchNostrProfiles.mockResolvedValue([
      {
        pubkey: HEX_PUBKEY,
        displayName: "guardian (mostr)",
        tags: [
          ["proxy", "https://mastodon.social/users/guardian", "activitypub"],
        ],
      },
    ]);

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    expect(
      final.matches.some(
        (m: any) => m.externalSource?.protocol === "nostr_external",
      ),
    ).toBe(false);
    expect(
      final.matches.some(
        (m: any) =>
          m.externalSource?.sourceUri ===
          "https://mastodon.social/users/guardian",
      ),
    ).toBe(true);
  });

  it("the final row is ordered by confidence: known-world probable before speculative discovery", async () => {
    knownWorldRows = [
      {
        protocol: "atproto",
        identity: "did:plc:knownworld",
        display_name: "Guardian (followed)",
        handle: "guardian.bsky.social",
        avatar: null,
        kind: "author",
      },
    ];
    // Nostr lands a speculative hit FIRST (catalog is empty, bluesky slow) so
    // ordering can't come from insertion order alone.
    mockSearchNostrProfiles.mockResolvedValue([
      { pubkey: HEX_PUBKEY, displayName: "guardian" },
    ]);
    mockSearchActors.mockImplementation(async () => {
      await sleep(20);
      return [{ did: "did:plc:speculative", handle: "g.bsky.social" }];
    });

    const res = await resolve("the guardian news", "subscribe", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    const confidences = final.matches.map((m: any) => m.confidence);
    expect(confidences[0]).toBe("probable");
    expect(final.matches[0].externalSource?.sourceUri).toBe("did:plc:knownworld");
    // No speculative row sorts above a probable one.
    const firstSpec = confidences.indexOf("speculative");
    expect(confidences.lastIndexOf("probable")).toBeLessThan(firstSpec);
    // Within the speculative tier, branch precision: Bluesky before Nostr.
    const spec = final.matches.filter((m: any) => m.confidence === "speculative");
    expect(spec.map((m: any) => m.externalSource?.protocol)).toEqual([
      "atproto",
      "nostr_external",
    ]);
  });
});

// =============================================================================
// Per-chain failure isolation
// =============================================================================

describe("per-chain failure isolation", () => {
  it("a throwing discovery branch never fails the resolve or drops its siblings", async () => {
    mockSearchActors.mockRejectedValue(new Error("bsky appview down"));
    mockSearchApAccounts.mockRejectedValue(new Error("instance down"));
    mockSearchNostrProfiles.mockResolvedValue([
      { pubkey: HEX_PUBKEY, displayName: "guardian" },
    ]);

    const res = await resolve("the guardian news", "general", INITIATOR, true);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    expect(
      final.matches.some(
        (m: any) => m.externalSource?.protocol === "nostr_external",
      ),
    ).toBe(true);
    expect(
      final.matches.some((m: any) => m.externalSource?.protocol === "atproto"),
    ).toBe(false);
    expect(
      final.matches.some(
        (m: any) => m.externalSource?.protocol === "activitypub",
      ),
    ).toBe(false);
  });

  it("a throwing profile chain still lands a complete (empty) result", async () => {
    mockGetProfile.mockRejectedValue(new Error("plc directory down"));

    const res = await resolve("did:plc:abcdef", "general", INITIATOR);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    expect(final.matches).toHaveLength(0);
  });

  it("a throwing enrichment chain keeps the Phase A matches intact", async () => {
    mockFetchNostrProfile.mockRejectedValue(new Error("relay refused"));

    const res = await resolve(HEX_PUBKEY, "general", INITIATOR);
    const final = await waitComplete(res.requestId!);

    expect(final.status).toBe("complete");
    const ext = final.matches.find(
      (m: any) => m.externalSource?.protocol === "nostr_external",
    );
    expect(ext).toBeDefined();
    expect(ext.confidence).toBe("exact");
  });
});
