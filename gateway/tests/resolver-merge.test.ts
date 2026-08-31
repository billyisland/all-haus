import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";
import {
  mergeMatches,
  type ResolverMatch,
} from "../src/lib/resolver-merge.js";

// =============================================================================
// mergeMatches (RESOLVER-DISCOVERY-ADR §6) — pure-function suite: alias
// dedupe, bridge-collision drop, and the §6.2 ordering (audit F5.4).
// =============================================================================

const HEX = "ab".repeat(32);
const NPUB = nip19.npubEncode(HEX);

function native(id: string, confidence: ResolverMatch["confidence"] = "exact"): ResolverMatch {
  return {
    type: "native_account",
    confidence,
    account: { id, username: id, displayName: id },
  };
}

function atproto(
  did: string,
  confidence: ResolverMatch["confidence"] = "speculative",
  handle?: string,
): ResolverMatch {
  return {
    type: "external_source",
    confidence,
    handle,
    externalSource: { protocol: "atproto", sourceUri: did },
  };
}

function nostr(
  pubkey: string,
  confidence: ResolverMatch["confidence"] = "speculative",
  proxy?: { origin: string; protocol: string },
): ResolverMatch {
  return {
    type: "external_source",
    confidence,
    proxy,
    externalSource: { protocol: "nostr_external", sourceUri: pubkey },
  };
}

function ap(
  sourceUri: string,
  confidence: ResolverMatch["confidence"] = "speculative",
  opts?: { actorUrl?: string; handle?: string },
): ResolverMatch {
  return {
    type: "external_source",
    confidence,
    actorUrl: opts?.actorUrl,
    handle: opts?.handle,
    externalSource: { protocol: "activitypub", sourceUri },
  };
}

function rssFeed(feedUrl: string): ResolverMatch {
  return {
    type: "rss_feed",
    confidence: "speculative",
    rssFeed: { feedUrl },
  };
}

const uris = (ms: ResolverMatch[]) =>
  ms.map((m) => m.externalSource?.sourceUri ?? m.rssFeed?.feedUrl ?? m.account?.id);

describe("alias dedupe", () => {
  it("collapses the same identity from two branches; higher confidence wins", () => {
    const out = mergeMatches(
      [nostr(HEX, "exact")],
      [nostr(HEX, "speculative")],
      "general",
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("exact");
  });

  it("a later higher-confidence twin replaces the stored speculative one", () => {
    const out = mergeMatches(
      [nostr(HEX, "speculative")],
      [nostr(HEX, "probable")],
      "general",
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("probable");
  });

  it("equal confidence keeps the earlier (already-persisted) candidate", () => {
    const first = nostr(HEX, "speculative");
    first.externalSource!.displayName = "first";
    const second = nostr(HEX, "speculative");
    second.externalSource!.displayName = "second";
    const out = mergeMatches([first], [second], "general");
    expect(out).toHaveLength(1);
    expect(out[0].externalSource?.displayName).toBe("first");
  });

  it("an AP acct candidate collapses onto a known-world actor-URI hit via actorUrl", () => {
    const knownWorld = ap("https://mastodon.social/users/guardian", "probable", {
      handle: "guardian@mastodon.social",
    });
    const discovered = ap("guardian@mastodon.social", "speculative", {
      actorUrl: "https://mastodon.social/users/guardian",
    });
    const out = mergeMatches([knownWorld], [discovered], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("probable");
    expect(out[0].externalSource?.sourceUri).toBe(
      "https://mastodon.social/users/guardian",
    );
  });

  it("an AP acct candidate collapses onto a known-world hit via the acct handle alone", () => {
    const knownWorld = ap("https://mastodon.social/users/guardian", "probable", {
      handle: "guardian@mastodon.social",
    });
    const discovered = ap("guardian@mastodon.social", "speculative", {});
    const out = mergeMatches([knownWorld], [discovered], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("probable");
  });

  it("distinct identities all survive", () => {
    const out = mergeMatches(
      [atproto("did:plc:aaa")],
      [atproto("did:plc:bbb"), nostr(HEX)],
      "general",
    );
    expect(out).toHaveLength(3);
  });

  it("a catalog rss_feed nomination collapses onto a known-world rss source for the same URL", () => {
    // The same feed reached through two shapes: a followed external_sources
    // row (known-world, probable) and a catalog nomination (rss_feed,
    // speculative). One key-space — the probable known-world hit survives.
    const knownWorld: ResolverMatch = {
      type: "external_source",
      confidence: "probable",
      externalSource: {
        protocol: "rss",
        sourceUri: "https://www.theguardian.com/international/rss",
      },
    };
    const catalog = rssFeed("https://www.theguardian.com/international/RSS");
    const out = mergeMatches([knownWorld], [catalog], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("external_source");
    expect(out[0].confidence).toBe("probable");
  });
});

describe("bridge-collision drop (§6.1)", () => {
  it("drops a Bridgy Fed Bluesky→fediverse mirror when the native DID is present", () => {
    const nativeBsky = atproto("did:plc:guardian", "speculative", "guardian.bsky.social");
    const mirror = ap("guardian.bsky.social@bsky.brid.gy", "speculative", {
      actorUrl: "https://bsky.brid.gy/ap/did:plc:guardian",
    });
    const out = mergeMatches([nativeBsky], [mirror], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].externalSource?.protocol).toBe("atproto");
  });

  it("drops a Mostr Nostr→fediverse mirror on the acct alone (npub embeds the origin)", () => {
    const mirror = ap(`${NPUB}@mostr.pub`, "speculative", {});
    const out = mergeMatches([nostr(HEX)], [mirror], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].externalSource?.protocol).toBe("nostr_external");
  });

  it("drops a Bridgy Fed fediverse→Bluesky mirror when the native AP acct is present", () => {
    const nativeAp = ap("https://hachyderm.io/users/alice", "speculative", {
      handle: "alice@hachyderm.io",
    });
    const mirror = atproto(
      "did:plc:mirror",
      "speculative",
      "alice.hachyderm.io.ap.brid.gy",
    );
    const out = mergeMatches([nativeAp], [mirror], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].externalSource?.protocol).toBe("activitypub");
  });

  it("drops a NIP-48-proxied nostr mirror of a native AP actor", () => {
    const nativeAp = ap("https://mastodon.social/users/guardian", "probable", {
      handle: "guardian@mastodon.social",
    });
    const mirror = nostr(HEX, "speculative", {
      origin: "https://mastodon.social/users/guardian",
      protocol: "activitypub",
    });
    const out = mergeMatches([nativeAp], [mirror], "subscribe");
    expect(out).toHaveLength(1);
    expect(out[0].externalSource?.protocol).toBe("activitypub");
  });

  it("a mirror with no native twin present survives", () => {
    const mirror = ap(`${NPUB}@mostr.pub`, "speculative", {});
    const out = mergeMatches([], [mirror, atproto("did:plc:other")], "subscribe");
    expect(out).toHaveLength(2);
  });

  it("two unrelated natives never collide via the bridge path", () => {
    const out = mergeMatches(
      [nostr(HEX)],
      [ap("someone@mastodon.social", "speculative", {})],
      "subscribe",
    );
    expect(out).toHaveLength(2);
  });
});

describe("§6.2 ordering (audit F5.4)", () => {
  it("confidence rank orders exact > probable > speculative", () => {
    const out = mergeMatches(
      [],
      [
        atproto("did:plc:spec", "speculative"),
        ap("https://m.s/users/prob", "probable", {}),
        nostr(HEX, "exact"),
      ],
      "general",
    );
    expect(out.map((m) => m.confidence)).toEqual([
      "exact",
      "probable",
      "speculative",
    ]);
  });

  it("subscribe context puts external before native within a tier", () => {
    const out = mergeMatches(
      [],
      [native("alice", "speculative"), atproto("did:plc:a", "speculative")],
      "subscribe",
    );
    expect(out[0].type).toBe("external_source");
    expect(out[1].type).toBe("native_account");
  });

  it("import context puts external before native within a tier (FOLLOW-GRAPH-IMPORT-ADR §7.4)", () => {
    const out = mergeMatches(
      [],
      [native("alice", "speculative"), atproto("did:plc:a", "speculative")],
      "import",
    );
    expect(out[0].type).toBe("external_source");
    expect(out[1].type).toBe("native_account");
  });

  it("invite context puts native before external within a tier", () => {
    const out = mergeMatches(
      [],
      [atproto("did:plc:a", "speculative"), native("alice", "speculative")],
      "invite",
    );
    expect(out[0].type).toBe("native_account");
  });

  it("general context is neutral: confidence only, insertion order kept", () => {
    const a = native("alice", "speculative");
    const b = native("bob", "speculative");
    const out = mergeMatches([], [a, b], "general");
    expect(out.map((m) => m.account?.id)).toEqual(["alice", "bob"]);
  });

  it("speculative tier tie-breaks by branch precision: catalog > Bluesky > AP > Nostr", () => {
    const out = mergeMatches(
      [],
      [
        nostr(HEX),
        ap("guardian@mastodon.social", "speculative", {}),
        atproto("did:plc:g"),
        rssFeed("https://g.example/rss"),
      ],
      "subscribe",
    );
    expect(
      out.map((m) => m.externalSource?.protocol ?? m.type),
    ).toEqual(["rss_feed", "atproto", "activitypub", "nostr_external"]);
  });

  it("probable tier keeps score order across mixed protocols (known-world)", () => {
    // trgm score order: nostr first, then rss, then atproto — precision must
    // NOT re-group the probable tier by protocol.
    const out = mergeMatches(
      [],
      [
        nostr(HEX, "probable"),
        {
          type: "external_source",
          confidence: "probable",
          externalSource: { protocol: "rss", sourceUri: "https://f.example/rss" },
        },
        atproto("did:plc:g", "probable"),
      ],
      "subscribe",
    );
    expect(out.map((m) => m.externalSource?.protocol)).toEqual([
      "nostr_external",
      "rss",
      "atproto",
    ]);
  });
});
