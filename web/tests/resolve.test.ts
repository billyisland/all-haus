import { describe, it, expect } from "vitest";
import {
  matchToOptions,
  partitionMatchOptions,
  tagFallback,
  resolveMatches,
} from "../src/lib/workspace/resolve";
import type { ResolverMatch } from "../src/lib/api/resolver";

const nativeMatch: ResolverMatch = {
  type: "native_account",
  confidence: "exact",
  account: {
    id: "acc-1",
    username: "alice",
    displayName: "Alice A",
  },
};

const externalMatch: ResolverMatch = {
  type: "external_source",
  confidence: "probable",
  externalSource: {
    protocol: "rss",
    sourceUri: "https://example.com/feed.xml",
    displayName: "Example Blog",
    description: "A blog",
    avatar: "https://example.com/av.png",
    relayUrls: ["wss://relay.example.com"],
  },
};

const rssMatch: ResolverMatch = {
  type: "rss_feed",
  confidence: "speculative",
  rssFeed: {
    feedUrl: "https://example.com/rss",
    title: "RSS Feed",
    description: "The RSS feed",
  },
};

describe("matchToOptions", () => {
  it("maps native_account to an option", () => {
    const opts = matchToOptions(nativeMatch);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toEqual({
      key: "acc:acc-1",
      label: "Alice A",
      sublabel: "@alice",
      add: { sourceType: "account", accountId: "acc-1" },
      confidence: "exact",
      // Carried for the person-picking surfaces (DM / invite / fee override,
      // audit F4) — they act on the account, not a feed-source add.
      account: { id: "acc-1", username: "alice", displayName: "Alice A" },
    });
  });

  it("falls back to @username when displayName is empty", () => {
    const m: ResolverMatch = {
      type: "native_account",
      confidence: "exact",
      account: { id: "acc-2", username: "bob", displayName: "" },
    };
    const opts = matchToOptions(m);
    expect(opts[0].label).toBe("@bob");
  });

  it("maps external_source to an option", () => {
    const opts = matchToOptions(externalMatch);
    expect(opts).toHaveLength(1);
    expect(opts[0].key).toBe("xs:rss:https://example.com/feed.xml");
    expect(opts[0].label).toBe("Example Blog");
    expect(opts[0].add).toEqual({
      sourceType: "external_source",
      protocol: "rss",
      sourceUri: "https://example.com/feed.xml",
      displayName: "Example Blog",
      description: "A blog",
      avatarUrl: "https://example.com/av.png",
      relayUrls: ["wss://relay.example.com"],
    });
  });

  it("falls back to sourceUri when displayName missing", () => {
    const m: ResolverMatch = {
      type: "external_source",
      confidence: "probable",
      externalSource: { protocol: "atproto", sourceUri: "did:plc:abc" },
    };
    const opts = matchToOptions(m);
    expect(opts[0].label).toBe("did:plc:abc");
  });

  it("maps rss_feed to an option", () => {
    const opts = matchToOptions(rssMatch);
    expect(opts).toHaveLength(1);
    expect(opts[0].key).toBe("rss:https://example.com/rss");
    expect(opts[0].label).toBe("RSS Feed");
    expect(opts[0].sublabel).toBe("rss");
    expect(opts[0].add).toEqual({
      sourceType: "external_source",
      protocol: "rss",
      sourceUri: "https://example.com/rss",
      displayName: "RSS Feed",
      description: "The RSS feed",
    });
  });

  it("falls back to feedUrl when title missing", () => {
    const m: ResolverMatch = {
      type: "rss_feed",
      confidence: "speculative",
      rssFeed: { feedUrl: "https://example.com/rss" },
    };
    const opts = matchToOptions(m);
    expect(opts[0].label).toBe("https://example.com/rss");
  });

  it("returns empty array for mismatched type/payload", () => {
    const m: ResolverMatch = {
      type: "native_account",
      confidence: "exact",
    };
    expect(matchToOptions(m)).toEqual([]);
  });
});

describe("tagFallback", () => {
  it("returns a tag option for #hashtag input", () => {
    const opt = tagFallback("#music");
    expect(opt).toEqual({
      key: "tag:music",
      label: "#music",
      sublabel: "tag",
      add: { sourceType: "tag", tagName: "music" },
      confidence: "exact",
    });
  });

  it("normalises whitespace and case", () => {
    const opt = tagFallback("#My Tag");
    expect(opt!.add).toEqual({ sourceType: "tag", tagName: "my-tag" });
    expect(opt!.label).toBe("#my-tag");
  });

  it("trims surrounding whitespace", () => {
    const opt = tagFallback("  #jazz  ");
    expect(opt!.key).toBe("tag:jazz");
  });

  it("returns null for input without #", () => {
    expect(tagFallback("music")).toBeNull();
  });

  it("returns null for bare #", () => {
    expect(tagFallback("#")).toBeNull();
  });

  it("returns null for # followed by only spaces", () => {
    expect(tagFallback("#   ")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(tagFallback("")).toBeNull();
  });
});

describe("resolveMatches", () => {
  it("converts matches to options", () => {
    const items = resolveMatches("alice", [nativeMatch]);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("acc:acc-1");
  });

  it("appends tag fallback when query starts with #", () => {
    const items = resolveMatches("#music", [nativeMatch]);
    expect(items).toHaveLength(2);
    expect(items[1].key).toBe("tag:music");
  });

  it("does not duplicate tag if already in matches", () => {
    const tagMatch: ResolverMatch = {
      type: "rss_feed",
      confidence: "exact",
      rssFeed: { feedUrl: "https://example.com/rss" },
    };
    const items = resolveMatches("#not-a-real-tag", [tagMatch]);
    expect(items.filter((i) => i.key === "tag:not-a-real-tag")).toHaveLength(1);
  });

  it("flattens multiple matches", () => {
    const items = resolveMatches("query", [
      nativeMatch,
      externalMatch,
      rssMatch,
    ]);
    expect(items).toHaveLength(3);
  });

  it("returns only tag fallback when matches empty and query is a tag", () => {
    const items = resolveMatches("#solo", []);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("tag:solo");
  });

  it("returns empty array when no matches and query is not a tag", () => {
    expect(resolveMatches("hello", [])).toEqual([]);
  });
});

describe("partitionMatchOptions (RESOLVER-DISCOVERY-ADR §6.4)", () => {
  it("splits exact/probable into matches and speculative into suggestions", () => {
    const options = resolveMatches("query", [
      nativeMatch, // exact
      externalMatch, // probable
      rssMatch, // speculative
    ]);
    const sections = partitionMatchOptions(options);
    expect(sections.matches.map((o) => o.confidence)).toEqual([
      "exact",
      "probable",
    ]);
    expect(sections.suggestions.map((o) => o.confidence)).toEqual([
      "speculative",
    ]);
  });

  it("counts an option with no confidence as a match", () => {
    const sections = partitionMatchOptions([
      {
        key: "x",
        label: "X",
        sublabel: null,
        add: { sourceType: "tag", tagName: "x" },
      },
    ]);
    expect(sections.matches).toHaveLength(1);
    expect(sections.suggestions).toHaveLength(0);
  });

  it("puts the tag fallback (exact) under matches", () => {
    const options = resolveMatches("#music", [rssMatch]);
    const sections = partitionMatchOptions(options);
    expect(sections.matches.map((o) => o.key)).toEqual(["tag:music"]);
    expect(sections.suggestions.map((o) => o.key)).toEqual([
      "rss:https://example.com/rss",
    ]);
  });

  it("preserves relative order within each section", () => {
    const spec2 = {
      ...rssMatch,
      rssFeed: { feedUrl: "https://example.com/rss2" },
    };
    const options = resolveMatches("query", [rssMatch, spec2]);
    const sections = partitionMatchOptions(options);
    expect(sections.suggestions.map((o) => o.key)).toEqual([
      "rss:https://example.com/rss",
      "rss:https://example.com/rss2",
    ]);
  });
});
