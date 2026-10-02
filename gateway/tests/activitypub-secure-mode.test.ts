import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// AUTHORIZED_FETCH on the gateway side — the resolver and the graph reader
//
// An instance in secure mode answers `401 {"error":"Request not signed"}` to
// every unsigned ActivityPub GET, which is what made a pasted mastodon.social
// handle resolve to NOTHING (so "Import follows" never appeared) and made
// `addSource`'s liveness probe answer 422 (so following anyone there was
// impossible). These drive the real `fetchActorProfile` /
// `verifySourceLiveness` / `readFollowGraph` against a URL-routed safeFetch.
// =============================================================================

const mockPoolQuery = vi.fn();
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a), connect: vi.fn() },
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/routes/feeds/sources.js", () => ({
  addSource: vi.fn(),
  removeSource: vi.fn(),
}));
vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: vi.fn(),
  getFollows: vi.fn(),
  isDid: vi.fn(() => false),
}));
vi.mock("../src/lib/nostr-relay.js", () => ({ fetchNostrContacts: vi.fn() }));
vi.mock("../src/lib/nostr-search.js", () => ({
  getDefaultProfileRelays: vi.fn(() => []),
  fetchNostrProfile: vi.fn(),
}));
const mockDecryptJson = vi.fn();
vi.mock("@platform-pub/shared/lib/crypto.js", () => ({
  decryptJson: (...a: unknown[]) => mockDecryptJson(...a),
  encryptJson: vi.fn(),
}));

const mockSafeFetch = vi.fn();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
}));

const { fetchActorProfile, fetchActorProfileWithVerdict } = await import(
  "../src/lib/activitypub-resolve.js"
);
const { verifySourceLiveness } = await import("../src/lib/source-liveness.js");
const { readFollowGraph } = await import("../src/lib/follow-import.js");

const HOST = "https://secure.test";
const ACTOR = `${HOST}/users/alice`;

function json(body: unknown, opts: { status?: number; link?: string } = {}) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: JSON.stringify(body),
    url: "",
    headers: { get: (n: string) => (n === "link" ? (opts.link ?? null) : null) },
  };
}

const ACCOUNT = {
  id: "42",
  acct: "alice",
  uri: ACTOR,
  url: `${HOST}/@alice`,
  display_name: "Alice",
  note: "<p>writes things</p>",
  avatar: `${HOST}/a.png`,
  following_count: 2,
  followers_count: 7,
  statuses_count: 33,
};

/** Every route a secure-mode instance offers: AP refused, client API fine. */
function routeSecureMode(extra: Record<string, unknown> = {}) {
  mockSafeFetch.mockImplementation((url: string) => {
    for (const [prefix, reply] of Object.entries(extra))
      if (url.startsWith(prefix)) return Promise.resolve(reply);
    if (url.startsWith(`${HOST}/.well-known/webfinger`))
      return Promise.resolve(
        json({
          links: [
            { rel: "self", type: "application/activity+json", href: ACTOR },
          ],
        }),
      );
    // The ActivityPub door, bolted.
    if (url === ACTOR)
      return Promise.resolve(json({ error: "Request not signed" }, { status: 401 }));
    if (url.startsWith(`${HOST}/api/v1/accounts/lookup`))
      return Promise.resolve(json(ACCOUNT));
    if (url.startsWith(`${HOST}/api/v1/accounts/42/following`))
      return Promise.resolve(
        json([
          {
            id: "1",
            acct: "bob@remote.test",
            uri: "https://remote.test/users/bob",
            display_name: "Bob",
          },
        ]),
      );
    return Promise.resolve(json({}, { status: 404 }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.FOLLOW_IMPORT_ENABLED = "1";
  process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED = "1";
});
afterEach(() => {
  delete process.env.FOLLOW_IMPORT_ENABLED;
  delete process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED;
  delete process.env.SOURCE_LIVENESS_ENFORCED;
});

describe("fetchActorProfile — the 401 fallback", () => {
  it("resolves through the client API when the actor document is refused", async () => {
    routeSecureMode();
    const profile = await fetchActorProfile(ACTOR);
    expect(profile).not.toBeNull();
    expect(profile!.actorUri).toBe(ACTOR);
    expect(profile!.handle).toBe("alice@secure.test");
    expect(profile!.displayName).toBe("Alice");
    // The bio arrives stripped, as it does off an AP `summary`.
    expect(profile!.description).toBe("writes things");
    // Counts an AP actor document never carries, and which `fetchAPProfile`
    // used to need a second REST call for.
    expect(profile!.followersCount).toBe(7);
  });

  it("does not open the second door for a non-authoritative id", async () => {
    // The AP document PARSED and claimed another host's id. That is a refusal,
    // not a transport failure — retrying elsewhere would give the claim a
    // second chance at the same lie.
    //
    // THE ASSERTION IS THE CALL LIST, NOT THE RETURN VALUE. A `null` here is
    // what a fallback that ran and failed returns too (the client-API helpers
    // swallow their own errors), so asserting only the outcome passes just as
    // happily against a version that DOES retry — verified by mutation.
    routeSecureMode({
      [ACTOR]: {
        ...json({ id: "https://victim.test/users/bob", preferredUsername: "bob" }),
        url: ACTOR,
      },
    });

    expect(await fetchActorProfile(ACTOR)).toBeNull();

    const urls = mockSafeFetch.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([ACTOR]);
    expect(urls.some((u) => u.includes("/api/v1/accounts"))).toBe(false);
  });

  it("refuses a client-API account claiming another host", async () => {
    routeSecureMode({
      [`${HOST}/api/v1/accounts/lookup`]: json({
        ...ACCOUNT,
        uri: "https://victim.test/users/bob",
      }),
    });
    expect(await fetchActorProfile(ACTOR)).toBeNull();
  });
});

describe("verifySourceLiveness — following an account on a secure-mode instance", () => {
  it("accepts the handle and stores the canonical actor URI", async () => {
    routeSecureMode();
    const verdict = await verifySourceLiveness(
      "activitypub",
      "alice@secure.test",
    );
    // Before the fallback this was `unreachable`, so addSource answered 422 and
    // following anybody on mastodon.social was simply impossible.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.sourceUri).toBe(ACTOR);
    expect(verdict.ok && verdict.displayName).toBe("Alice");
  });

  it("still refuses an address that resolves to nothing at all", async () => {
    mockSafeFetch.mockResolvedValue(json({}, { status: 404 }));
    const verdict = await verifySourceLiveness(
      "activitypub",
      "ghost@secure.test",
    );
    expect(verdict.ok).toBe(false);
  });

  it("A SOURCE WE CAN READ IS NOT ONE WE ARE LOCKED OUT OF, whatever the front door said", async () => {
    // The refusal verdict has to survive the WHOLE chain, not just the first
    // arm. mastodon.social 401s every unsigned actor GET and its client API
    // answers perfectly — so if the verdict were taken from the AP attempt
    // alone, every member following anyone on the largest instance on the
    // fediverse would be told we cannot read it, while we read it fine.
    routeSecureMode();
    const verdict = await verifySourceLiveness(
      "activitypub",
      "alice@secure.test",
    );
    expect(verdict.ok).toBe(true);
    // And the same fact stated at the seam the message keys off.
    const attempt = await fetchActorProfileWithVerdict(ACTOR);
    expect(attempt.profile).not.toBeNull();
    expect(attempt.signedFetchRefused).toBe(false);
  });

  it("reports the refusal when NOTHING can read it", async () => {
    // The control for the case above: 401 on the actor AND nothing from the
    // client API. Without this pair, a verdict hard-coded either way passes.
    mockSafeFetch.mockResolvedValue(json({}, { status: 401 }));
    const attempt = await fetchActorProfileWithVerdict(ACTOR);
    expect(attempt.profile).toBeNull();
    expect(attempt.signedFetchRefused).toBe(true);
  });
});

describe("readFollowGraph — the actor-URI form the UI actually sends", () => {
  it("reads the graph from an actor URI without fetching the actor document", async () => {
    routeSecureMode();

    // `FollowImportSection` and `FeedComposer` hand this the resolver's
    // canonical sourceUri, i.e. an actor URI. It used to recover the acct by
    // FETCHING THE ACTOR — the one document a secure-mode instance withholds —
    // so the paste path worked and the button built on it did not.
    const graph = await readFollowGraph("activitypub", ACTOR);

    expect(graph.ok).toBe(true);
    expect(graph.ok && graph.originIdentity).toBe("alice@secure.test");
    expect(graph.ok && graph.identities.map((i) => i.uri)).toEqual([
      "https://remote.test/users/bob",
    ]);
    // The point of the fix: the acct came off the URI's own path and host.
    expect(mockSafeFetch.mock.calls.map((c) => c[0])).not.toContain(ACTOR);
  });

  it("reads the same graph from the handle form", async () => {
    routeSecureMode();
    const graph = await readFollowGraph("activitypub", "@alice@secure.test");
    expect(graph.ok && graph.identities).toHaveLength(1);
  });
});

describe("readFollowGraph — an unknown follow count is not a count of zero", () => {
  it("reports hidden rather than empty when the lookup did not answer", async () => {
    // The reachable shape: a linked presence supplies the account id and a
    // token, the token turns out to be expired (the authed read 401s), the
    // public retry comes back EMPTY, and the lookup that would have carried
    // `following_count` failed too. The count is therefore UNKNOWN, and an
    // empty public list means either "follows nobody" or "follows hidden".
    //
    // `(count ?? 0) > 0` picked the one reading we know to be unsafe — it fell
    // through to ok-with-no-identities, which the route reports as
    // `empty_graph`, i.e. "this account doesn't follow anyone we can import":
    // a confident claim about the remote account built on our own failure to
    // read it.
    mockDecryptJson.mockReturnValue({ accessToken: "expired-token" });
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          external_id: "42",
          handle: "alice@secure.test",
          service_url: HOST,
          credentials_enc: "blob",
        },
      ],
      rowCount: 1,
    });

    mockSafeFetch.mockImplementation((url: string, opts: any) => {
      const authed = Boolean(opts?.headers?.Authorization);
      if (url.startsWith(`${HOST}/.well-known/webfinger`))
        return Promise.resolve(
          json({
            links: [
              { rel: "self", type: "application/activity+json", href: ACTOR },
            ],
          }),
        );
      if (url.startsWith(`${HOST}/api/v1/accounts/lookup`))
        return Promise.resolve(json({}, { status: 503 }));
      if (url.startsWith(`${HOST}/api/v1/accounts/42/following`))
        return Promise.resolve(
          authed ? json({}, { status: 401 }) : json([]),
        );
      return Promise.resolve(json({}, { status: 404 }));
    });

    const graph = await readFollowGraph("activitypub", "alice@secure.test", {
      accountId: "acct-1",
    });

    expect(graph.ok).toBe(false);
    expect(!graph.ok && graph.reason).toBe("hidden");
    expect(!graph.ok && graph.message).toMatch(/couldn't read/i);
  });

  it("still reports a genuinely empty public list as an empty graph", async () => {
    routeSecureMode({
      [`${HOST}/api/v1/accounts/lookup`]: json({ ...ACCOUNT, following_count: 0 }),
      [`${HOST}/api/v1/accounts/42/following`]: json([]),
    });
    const graph = await readFollowGraph("activitypub", "alice@secure.test");
    // A KNOWN zero is a fact, and must not be dressed up as hidden.
    expect(graph.ok).toBe(true);
    expect(graph.ok && graph.identities).toHaveLength(0);
  });

  it("still reports a hidden list with a known non-zero count as hidden", async () => {
    routeSecureMode({
      [`${HOST}/api/v1/accounts/42/following`]: json([]),
    });
    const graph = await readFollowGraph("activitypub", "alice@secure.test");
    expect(!graph.ok && graph.reason).toBe("hidden");
    expect(!graph.ok && graph.message).toMatch(/hidden/i);
  });
});
