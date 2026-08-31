import { describe, it, expect, vi } from "vitest";

// The task module imports the shared pool / logger at top level; the pure helpers
// under test don't touch the DB, so stub the modules so importing is offline.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {},
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  registrableDomain,
  ownedDomains,
  domainMatchPairs,
  MAX_SOURCES_PER_DOMAIN,
  npubToHex,
  decodeApBridgeHandle,
  bridgeIdentityKeys,
  bridgeMatchPairs,
} = await import("./identity-link-detect.js");

type Row = Parameters<typeof ownedDomains>[0];
const row = (p: Partial<Row> & Pick<Row, "source_id" | "protocol">): Row => ({
  source_uri: "",
  website: null,
  handle: null,
  ...p,
});

describe("registrableDomain", () => {
  it("takes the last two labels and strips www", () => {
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("blog.example.com")).toBe("example.com");
    expect(registrableDomain("EXAMPLE.COM")).toBe("example.com");
  });
  it("handles multi-label public suffixes via the PSL", () => {
    expect(registrableDomain("alice.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.com.au")).toBe("example.com.au");
  });
  it("does NOT collapse distinct owners under an uncurated ccTLD (the over-merge bug)", () => {
    // co.id / co.kr / com.mx etc. were absent from the old hand-curated set, so
    // the last-two-labels rule mis-derived `alice.co.id` → `co.id` — the public
    // suffix itself — and any two `*.co.id` sources falsely shared a domain. The
    // PSL gives each owner a distinct eTLD+1.
    expect(registrableDomain("alice.co.id")).toBe("alice.co.id");
    expect(registrableDomain("bob.co.id")).toBe("bob.co.id");
    expect(registrableDomain("alice.co.id")).not.toBe(registrableDomain("bob.co.id"));
    expect(registrableDomain("shop.com.mx")).toBe("shop.com.mx");
    expect(registrableDomain("news.co.kr")).toBe("news.co.kr");
  });
  it("keeps private-section suffixes at the two-label platform domain (denylist intact)", () => {
    // ICANN-only: pages.dev / github.io resolve to the platform string the
    // PLATFORM_DOMAINS denylist matches, so there is no denylist regression.
    expect(registrableDomain("alice.pages.dev")).toBe("pages.dev");
    expect(registrableDomain("alice.github.io")).toBe("github.io");
    expect(registrableDomain("foo.substack.com")).toBe("substack.com");
  });
  it("rejects IPs, single labels, and empty", () => {
    expect(registrableDomain("127.0.0.1")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });
});

describe("ownedDomains", () => {
  it("derives an RSS feed's host", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "rss", source_uri: "https://blog.alice.com/feed.xml" })),
    ).toEqual(["alice.com"]);
  });
  it("derives a custom atproto handle host but not a bsky.social handle", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "atproto", handle: "alice.com" })),
    ).toEqual(["alice.com"]);
    expect(
      ownedDomains(row({ source_id: "s", protocol: "atproto", handle: "alice.bsky.social" })),
    ).toEqual([]); // platform handle → denylisted
  });
  it("derives the author website for any protocol", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "activitypub", website: "https://alice.com" })),
    ).toEqual(["alice.com"]);
  });
  it("drops platform domains entirely", () => {
    expect(
      ownedDomains(row({ source_id: "s", protocol: "rss", source_uri: "https://alice.substack.com/feed" })),
    ).toEqual([]);
  });
  it("dedupes when feed host and website share a domain", () => {
    expect(
      ownedDomains(
        row({
          source_id: "s",
          protocol: "rss",
          source_uri: "https://www.alice.com/feed",
          website: "https://blog.alice.com",
        }),
      ),
    ).toEqual(["alice.com"]);
  });
});

describe("domainMatchPairs", () => {
  it("links two sources that share a custom domain", () => {
    const pairs = domainMatchPairs([
      row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" }),
      row({ source_id: "b", protocol: "atproto", handle: "alice.com" }),
    ]);
    expect(pairs).toHaveLength(1);
    const [pa, pb] = pairs[0];
    expect(pa < pb).toBe(true); // ordered to satisfy the table CHECK
    expect(new Set(pairs[0])).toEqual(new Set(["a", "b"]));
  });

  it("does NOT link sources on a shared platform domain", () => {
    expect(
      domainMatchPairs([
        row({ source_id: "a", protocol: "rss", source_uri: "https://a.substack.com/feed" }),
        row({ source_id: "b", protocol: "rss", source_uri: "https://b.substack.com/feed" }),
      ]),
    ).toEqual([]);
  });

  it("does NOT link unrelated owners under an uncurated ccTLD (over-merge regression)", () => {
    // The old curated-suffix derivation collapsed alice.co.id and bob.co.id to
    // `co.id`, falsely linking them. The PSL keeps them distinct → no pair.
    expect(
      domainMatchPairs([
        row({ source_id: "a", protocol: "rss", source_uri: "https://alice.co.id/feed" }),
        row({ source_id: "b", protocol: "rss", source_uri: "https://bob.co.id/feed" }),
      ]),
    ).toEqual([]);
    // …but two surfaces of the SAME ccTLD owner still link.
    expect(
      domainMatchPairs([
        row({ source_id: "a", protocol: "rss", source_uri: "https://alice.co.id/feed" }),
        row({ source_id: "b", protocol: "atproto", handle: "alice.co.id" }),
      ]),
    ).toHaveLength(1);
  });

  it("count guard: a domain shared by more than MAX sources is treated as a platform", () => {
    const rows = Array.from({ length: MAX_SOURCES_PER_DOMAIN + 1 }, (_, i) =>
      row({ source_id: `s${i}`, protocol: "rss", source_uri: `https://blog${i}.shared.com/feed` }),
    );
    expect(domainMatchPairs(rows)).toEqual([]); // shared.com over the cap → dropped
  });

  it("links all pairs within a small same-domain cluster, deduped", () => {
    const pairs = domainMatchPairs([
      row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" }),
      row({ source_id: "b", protocol: "atproto", handle: "alice.com" }),
      row({ source_id: "c", protocol: "activitypub", website: "https://alice.com" }),
    ]);
    expect(pairs).toHaveLength(3); // a-b, a-c, b-c
    const keys = new Set(pairs.map((p) => p.join("|")));
    expect(keys.size).toBe(3); // no dupes
  });

  it("ignores a domain owned by a single source", () => {
    expect(
      domainMatchPairs([row({ source_id: "a", protocol: "rss", source_uri: "https://alice.com/feed" })]),
    ).toEqual([]);
  });
});

// Known-good npub ↔ hex pair (generated via nip19.npubEncode).
const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
const HEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";

describe("npubToHex", () => {
  it("decodes a valid npub to hex", () => {
    expect(npubToHex(NPUB)).toBe(HEX);
  });
  it("returns null for non-npub / garbage", () => {
    expect(npubToHex("not-an-npub")).toBeNull();
    expect(npubToHex(HEX)).toBeNull(); // bare hex is not an npub
    expect(npubToHex("")).toBeNull();
  });
});

describe("decodeApBridgeHandle", () => {
  it("reconstructs the fediverse acct from a Bridgy Fed bsky handle", () => {
    expect(decodeApBridgeHandle("alice.mastodon.social.ap.brid.gy")).toBe("alice@mastodon.social");
    expect(decodeApBridgeHandle("bob.example.co.uk.ap.brid.gy")).toBe("bob@example.co.uk");
  });
  it("is case-insensitive", () => {
    expect(decodeApBridgeHandle("Alice.Mastodon.Social.ap.brid.gy")).toBe("alice@mastodon.social");
  });
  it("returns null for non-Bridgy handles or unsplittable inner", () => {
    expect(decodeApBridgeHandle("alice.bsky.social")).toBeNull();
    expect(decodeApBridgeHandle("alice.example.com")).toBeNull();
    expect(decodeApBridgeHandle("nodots.ap.brid.gy")).toBeNull(); // no user/host split
    expect(decodeApBridgeHandle(null)).toBeNull();
    expect(decodeApBridgeHandle("")).toBeNull();
  });
});

describe("bridgeIdentityKeys", () => {
  it("extracts the original DID from a Bridgy bsky→fedi actor URL", () => {
    expect(
      bridgeIdentityKeys(
        row({
          source_id: "m",
          protocol: "activitypub",
          source_uri: "https://bsky.brid.gy/ap/did:plc:z72i7hdynmk6r22z27h6tvur",
        }),
      ),
    ).toEqual(["atproto:did:plc:z72i7hdynmk6r22z27h6tvur"]);
  });
  it("extracts the original hex from a mostr.pub nostr→fedi actor URL", () => {
    expect(
      bridgeIdentityKeys(
        row({ source_id: "m", protocol: "activitypub", source_uri: `https://mostr.pub/users/${NPUB}` }),
      ),
    ).toEqual([`nostr:${HEX}`]);
  });
  it("reconstructs the fedi acct from a Bridgy fedi→bsky atproto handle", () => {
    expect(
      bridgeIdentityKeys(
        row({ source_id: "m", protocol: "atproto", handle: "alice.mastodon.social.ap.brid.gy" }),
      ),
    ).toEqual(["ap:alice@mastodon.social"]);
  });
  it("returns nothing for a plain (non-bridge) source", () => {
    expect(
      bridgeIdentityKeys(row({ source_id: "n", protocol: "atproto", source_uri: "did:plc:abc", handle: "alice.bsky.social" })),
    ).toEqual([]);
    expect(
      bridgeIdentityKeys(row({ source_id: "n", protocol: "activitypub", source_uri: "https://mastodon.social/users/alice" })),
    ).toEqual([]);
  });
});

describe("bridgeMatchPairs", () => {
  it("links a bsky→fedi mirror to the native Bluesky source (DID match)", () => {
    const pairs = bridgeMatchPairs([
      row({ source_id: "native", protocol: "atproto", source_uri: "did:plc:z72i7hdynmk6r22z27h6tvur" }),
      row({
        source_id: "mirror",
        protocol: "activitypub",
        source_uri: "https://bsky.brid.gy/ap/did:plc:z72i7hdynmk6r22z27h6tvur",
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0] < pairs[0][1]).toBe(true); // ordered for the table CHECK
    expect(new Set(pairs[0])).toEqual(new Set(["native", "mirror"]));
  });

  it("links a mostr.pub mirror to the native Nostr source (npub→hex match)", () => {
    const pairs = bridgeMatchPairs([
      row({ source_id: "native", protocol: "nostr_external", source_uri: HEX }),
      row({ source_id: "mirror", protocol: "activitypub", source_uri: `https://mostr.pub/users/${NPUB}` }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(new Set(pairs[0])).toEqual(new Set(["native", "mirror"]));
  });

  it("links a fedi→bsky mirror to the native fediverse source (acct match)", () => {
    const pairs = bridgeMatchPairs([
      row({ source_id: "native", protocol: "activitypub", source_uri: "https://mastodon.social/users/alice", handle: "alice@mastodon.social" }),
      row({ source_id: "mirror", protocol: "atproto", source_uri: "did:plc:opaque", handle: "alice.mastodon.social.ap.brid.gy" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(new Set(pairs[0])).toEqual(new Set(["native", "mirror"]));
  });

  it("does NOT link two natives that share a key but neither is a bridge", () => {
    // Two AP sources with the same handle but different actors — not a bridge,
    // must not link (the ≥1-bridge-endpoint guard).
    expect(
      bridgeMatchPairs([
        row({ source_id: "a", protocol: "activitypub", source_uri: "https://a.example/users/x", handle: "x@example.com" }),
        row({ source_id: "b", protocol: "activitypub", source_uri: "https://b.example/users/x", handle: "x@example.com" }),
      ]),
    ).toEqual([]);
  });

  it("does NOT link a mirror with no matching native source", () => {
    expect(
      bridgeMatchPairs([
        row({ source_id: "mirror", protocol: "activitypub", source_uri: "https://bsky.brid.gy/ap/did:plc:lonely" }),
        row({ source_id: "other", protocol: "atproto", source_uri: "did:plc:someoneelse" }),
      ]),
    ).toEqual([]);
  });

  it("a mirror whose identity fails to decode contributes nothing", () => {
    // mostr mirror with an unparseable npub → no decoded key, and never falls
    // back to its own ap:…@mostr.pub native key.
    expect(
      bridgeMatchPairs([
        row({ source_id: "mirror", protocol: "activitypub", source_uri: "https://mostr.pub/users/garbage", handle: "garbage@mostr.pub" }),
        row({ source_id: "x", protocol: "activitypub", source_uri: "https://m/u/x", handle: "garbage@mostr.pub" }),
      ]),
    ).toEqual([]);
  });

  it("links one mirror bridged to two networks (two pairs, deduped)", () => {
    // A bsky→fedi mirror AND the native bsky source AND a separate native fedi
    // source the same person also has — only the DID match fires here.
    const pairs = bridgeMatchPairs([
      row({ source_id: "bsky", protocol: "atproto", source_uri: "did:plc:abc" }),
      row({ source_id: "mirror1", protocol: "activitypub", source_uri: "https://bsky.brid.gy/ap/did:plc:abc" }),
      row({ source_id: "mirror2", protocol: "atproto", source_uri: "did:plc:xyz", handle: "carol.mastodon.social.ap.brid.gy" }),
      row({ source_id: "fedi", protocol: "activitypub", source_uri: "https://mastodon.social/users/carol", handle: "carol@mastodon.social" }),
    ]);
    expect(pairs).toHaveLength(2);
    const keys = new Set(pairs.map((p) => p.join("|")));
    expect(keys.size).toBe(2);
    // bsky↔mirror1 (DID) and mirror2↔fedi (acct)
    expect(pairs.some((p) => new Set(p).has("bsky") && new Set(p).has("mirror1"))).toBe(true);
    expect(pairs.some((p) => new Set(p).has("mirror2") && new Set(p).has("fedi"))).toBe(true);
  });
});
