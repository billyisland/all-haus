import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nip19 } from "nostr-tools";
import { verifySourceLiveness } from "../src/lib/source-liveness.js";

// =============================================================================
// addSource liveness verification (2026-07-09 resolver audit F1).
//
// The module is exercised through its one public entry, with the network
// leaves mocked at the same per-protocol seams the resolver tests use:
// safeFetch (rss probe), atproto getProfile, AP webfinger/actor fetch, nostr
// kind-0 fetch. rss-parser runs for real (pure string parsing).
//
// Coverage per protocol: canonical input verified live; non-canonical input
// normalised (handle → DID, npub/nprofile → hex, acct → actor URI); the
// malformed vs unreachable error split; and the SOURCE_LIVENESS_ENFORCED=0
// operator brake (probe skipped for canonical forms, normalisation kept).
// =============================================================================

const mockSafeFetch = vi.fn();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: unknown[]) => mockSafeFetch(...a),
  pinnedWebSocketOptions: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetProfile = vi.fn();
vi.mock("../src/lib/atproto-resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
}));

const mockResolveWebFinger = vi.fn();
const mockFetchActorProfile = vi.fn();
vi.mock("../src/lib/activitypub-resolve.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveWebFinger: (...a: unknown[]) => mockResolveWebFinger(...a),
  fetchActorProfile: (...a: unknown[]) => mockFetchActorProfile(...a),
}));

const mockFetchNostrProfile = vi.fn();
vi.mock("../src/lib/nostr-search.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchNostrProfile: (...a: unknown[]) => mockFetchNostrProfile(...a),
}));

function httpResponse(opts: {
  ok?: boolean;
  status?: number;
  text?: string;
  contentType?: string | null;
}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: opts.text ?? "",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (opts.contentType ?? null) : null,
    },
  };
}

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Feed</title>
  <description>An example</description>
  <item><title>Post</title><link>https://example.com/1</link></item>
</channel></rss>`;

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Example",
  description: "A JSON feed",
  items: [],
});

const HEX_PUBKEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.SOURCE_LIVENESS_ENFORCED;
});

// -----------------------------------------------------------------------------
// rss
// -----------------------------------------------------------------------------

describe("verifySourceLiveness — rss", () => {
  it("accepts a URL serving parseable RSS/Atom XML, with feed metadata", async () => {
    mockSafeFetch.mockResolvedValue(
      httpResponse({ text: RSS_XML, contentType: "application/rss+xml" }),
    );
    const v = await verifySourceLiveness("rss", "https://example.com/feed");
    expect(v).toMatchObject({
      ok: true,
      sourceUri: "https://example.com/feed",
      displayName: "Example Feed",
      description: "An example",
    });
  });

  it("accepts a JSON Feed (ingest supports it, so the probe must too)", async () => {
    mockSafeFetch.mockResolvedValue(
      httpResponse({ text: JSON_FEED, contentType: "application/feed+json" }),
    );
    const v = await verifySourceLiveness("rss", "https://example.com/feed.json");
    expect(v).toMatchObject({ ok: true, displayName: "JSON Example" });
  });

  it("accepts a shape-sniffed JSON Feed served without a JSON content-type", async () => {
    mockSafeFetch.mockResolvedValue(
      httpResponse({ text: JSON_FEED, contentType: "text/plain" }),
    );
    const v = await verifySourceLiveness("rss", "https://example.com/feed.json");
    expect(v).toMatchObject({ ok: true, displayName: "JSON Example" });
  });

  it("rejects an HTML page as unreachable (well-formed URL, not a feed)", async () => {
    mockSafeFetch.mockResolvedValue(
      httpResponse({ text: "<!doctype html><html></html>", contentType: "text/html" }),
    );
    const v = await verifySourceLiveness("rss", "https://example.com/");
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("rejects an HTTP error as unreachable, naming the status", async () => {
    mockSafeFetch.mockResolvedValue(httpResponse({ ok: false, status: 404 }));
    const v = await verifySourceLiveness("rss", "https://example.com/dead");
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
    expect((v as { message: string }).message).toContain("404");
  });

  it("rejects a fetch failure (DNS/SSRF/timeout) as unreachable", async () => {
    mockSafeFetch.mockRejectedValue(new Error("ENOTFOUND"));
    const v = await verifySourceLiveness("rss", "https://dead.example/feed");
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("rejects a non-URL and a non-http(s) scheme as malformed, without fetching", async () => {
    expect(await verifySourceLiveness("rss", "not a url")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(
      await verifySourceLiveness("rss", "ftp://example.com/feed"),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("skips the probe when SOURCE_LIVENESS_ENFORCED=0", async () => {
    process.env.SOURCE_LIVENESS_ENFORCED = "0";
    const v = await verifySourceLiveness("rss", "https://example.com/feed");
    expect(v).toMatchObject({ ok: true, sourceUri: "https://example.com/feed" });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// atproto
// -----------------------------------------------------------------------------

describe("verifySourceLiveness — atproto", () => {
  const DID = "did:plc:abc123xyz";
  const PROFILE = {
    did: DID,
    handle: "alice.bsky.social",
    displayName: "Alice",
    description: "bio",
    avatar: "https://cdn.example/a.jpg",
  };

  it("verifies a DID via getProfile", async () => {
    mockGetProfile.mockResolvedValue(PROFILE);
    const v = await verifySourceLiveness("atproto", DID);
    expect(v).toMatchObject({ ok: true, sourceUri: DID, displayName: "Alice" });
    expect(mockGetProfile).toHaveBeenCalledWith(DID);
  });

  it("normalises a handle to its canonical DID (omnivorous input)", async () => {
    mockGetProfile.mockResolvedValue(PROFILE);
    const v = await verifySourceLiveness("atproto", "alice.bsky.social");
    expect(v).toMatchObject({ ok: true, sourceUri: DID });
  });

  it("rejects a nonexistent DID as unreachable", async () => {
    mockGetProfile.mockResolvedValue(null);
    const v = await verifySourceLiveness("atproto", "did:plc:nonexistent");
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("rejects input that is neither DID nor handle as malformed", async () => {
    const v = await verifySourceLiveness("atproto", "not a did");
    expect(v).toMatchObject({ ok: false, reason: "malformed" });
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it("brake off: DID passes unprobed, but a handle still resolves (it cannot be stored raw)", async () => {
    process.env.SOURCE_LIVENESS_ENFORCED = "0";
    expect(await verifySourceLiveness("atproto", DID)).toMatchObject({
      ok: true,
      sourceUri: DID,
    });
    expect(mockGetProfile).not.toHaveBeenCalled();

    mockGetProfile.mockResolvedValue(PROFILE);
    expect(
      await verifySourceLiveness("atproto", "alice.bsky.social"),
    ).toMatchObject({ ok: true, sourceUri: DID });
    expect(mockGetProfile).toHaveBeenCalledOnce();
  });
});

// -----------------------------------------------------------------------------
// nostr_external
// -----------------------------------------------------------------------------

describe("verifySourceLiveness — nostr_external", () => {
  const KIND0 = { displayName: "Nym", about: "bio", picture: "https://p.example/x" };

  it("verifies a hex pubkey via kind-0 lookup, lowercased", async () => {
    mockFetchNostrProfile.mockResolvedValue(KIND0);
    const v = await verifySourceLiveness(
      "nostr_external",
      HEX_PUBKEY.toUpperCase(),
    );
    expect(v).toMatchObject({ ok: true, sourceUri: HEX_PUBKEY, displayName: "Nym" });
  });

  it("decodes an npub to hex (omnivorous input; relay-free identity)", async () => {
    mockFetchNostrProfile.mockResolvedValue(KIND0);
    const npub = nip19.npubEncode(HEX_PUBKEY);
    const v = await verifySourceLiveness("nostr_external", npub);
    expect(v).toMatchObject({ ok: true, sourceUri: HEX_PUBKEY });
  });

  it("decodes an nprofile and unions its relay hints into the probe set", async () => {
    mockFetchNostrProfile.mockResolvedValue(KIND0);
    const nprofile = nip19.nprofileEncode({
      pubkey: HEX_PUBKEY,
      relays: ["wss://relay.hint.example"],
    });
    const v = await verifySourceLiveness("nostr_external", nprofile);
    expect(v).toMatchObject({ ok: true, sourceUri: HEX_PUBKEY });
    const relays = mockFetchNostrProfile.mock.calls[0][1] as string[];
    expect(relays).toContain("wss://relay.hint.example");
    // defaults still probed alongside the hint
    expect(relays.length).toBeGreaterThan(1);
  });

  it("passes caller relayUrls as probe hints alongside the defaults", async () => {
    mockFetchNostrProfile.mockResolvedValue(KIND0);
    await verifySourceLiveness("nostr_external", HEX_PUBKEY, [
      "wss://my.relay.example",
    ]);
    const relays = mockFetchNostrProfile.mock.calls[0][1] as string[];
    expect(relays).toContain("wss://my.relay.example");
    expect(relays.length).toBeGreaterThan(1);
  });

  it("rejects a key with no kind-0 anywhere as unreachable", async () => {
    mockFetchNostrProfile.mockResolvedValue(null);
    const v = await verifySourceLiveness("nostr_external", HEX_PUBKEY);
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("rejects non-key input (incl. a malformed npub) as malformed", async () => {
    expect(
      await verifySourceLiveness("nostr_external", "deadbeef"),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(
      await verifySourceLiveness("nostr_external", "npub1notreal"),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(mockFetchNostrProfile).not.toHaveBeenCalled();
  });

  it("brake off: hex passes unprobed, npub still decodes to hex offline", async () => {
    process.env.SOURCE_LIVENESS_ENFORCED = "0";
    expect(
      await verifySourceLiveness("nostr_external", HEX_PUBKEY),
    ).toMatchObject({ ok: true, sourceUri: HEX_PUBKEY });
    expect(
      await verifySourceLiveness("nostr_external", nip19.npubEncode(HEX_PUBKEY)),
    ).toMatchObject({ ok: true, sourceUri: HEX_PUBKEY });
    expect(mockFetchNostrProfile).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// activitypub
// -----------------------------------------------------------------------------

describe("verifySourceLiveness — activitypub", () => {
  const ACTOR = "https://mastodon.social/users/alice";
  const ACTOR_PROFILE = {
    actorUri: ACTOR,
    displayName: "Alice",
    description: "bio",
    avatar: "https://cdn.example/a.png",
    handle: "alice@mastodon.social",
  };

  it("verifies an https actor URL and canonicalises to the document id", async () => {
    mockFetchActorProfile.mockResolvedValue(ACTOR_PROFILE);
    const v = await verifySourceLiveness(
      "activitypub",
      "https://mastodon.social/users/alice",
    );
    expect(v).toMatchObject({ ok: true, sourceUri: ACTOR, displayName: "Alice" });
    expect(mockResolveWebFinger).not.toHaveBeenCalled();
  });

  it("webfingers an acct (with or without leading @) to its actor and probes it", async () => {
    mockResolveWebFinger.mockResolvedValue(ACTOR);
    mockFetchActorProfile.mockResolvedValue(ACTOR_PROFILE);
    for (const input of ["alice@mastodon.social", "@alice@mastodon.social"]) {
      const v = await verifySourceLiveness("activitypub", input);
      expect(v).toMatchObject({ ok: true, sourceUri: ACTOR });
      expect(mockResolveWebFinger).toHaveBeenCalledWith("alice@mastodon.social");
    }
  });

  it("rejects a failed webfinger as unreachable", async () => {
    mockResolveWebFinger.mockResolvedValue(null);
    const v = await verifySourceLiveness("activitypub", "alice@dead.example");
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
    expect(mockFetchActorProfile).not.toHaveBeenCalled();
  });

  it("rejects a URL that is not an actor document as unreachable", async () => {
    mockFetchActorProfile.mockResolvedValue(null);
    const v = await verifySourceLiveness(
      "activitypub",
      "https://example.com/not-an-actor",
    );
    expect(v).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("rejects http:// URLs and free text as malformed", async () => {
    expect(
      await verifySourceLiveness("activitypub", "http://mastodon.social/users/alice"),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(
      await verifySourceLiveness("activitypub", "just a name"),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(mockResolveWebFinger).not.toHaveBeenCalled();
    expect(mockFetchActorProfile).not.toHaveBeenCalled();
  });

  it("brake off: actor URL passes unprobed; an acct still webfingers but skips the actor probe", async () => {
    process.env.SOURCE_LIVENESS_ENFORCED = "0";
    expect(await verifySourceLiveness("activitypub", ACTOR)).toMatchObject({
      ok: true,
      sourceUri: ACTOR,
    });
    mockResolveWebFinger.mockResolvedValue(ACTOR);
    expect(
      await verifySourceLiveness("activitypub", "alice@mastodon.social"),
    ).toMatchObject({ ok: true, sourceUri: ACTOR });
    expect(mockFetchActorProfile).not.toHaveBeenCalled();
  });
});
