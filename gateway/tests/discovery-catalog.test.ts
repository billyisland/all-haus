import { describe, it, expect } from "vitest";
import {
  searchCatalog,
  foldDiacritics,
  feedHost,
  mergeCatalogs,
  PUBLICATION_CATALOG,
  FULL_CATALOG,
  type CatalogEntry,
} from "../src/lib/discovery-catalog.js";
import { GENERATED_PUBLICATION_CATALOG } from "../src/lib/discovery-catalog.generated.js";

// Curated publication catalog — discovery fallback branch 3
// (UNIVERSAL-FEED-ADR §V.5.8). Pure, instant, no I/O.
describe("searchCatalog (discovery fallback branch 3)", () => {
  it("matches a bare name to its canonical feed (the head case)", () => {
    const out = searchCatalog("Guardian");
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("The Guardian");
    expect(out[0].feedUrl).toBe("https://www.theguardian.com/international/rss");
  });

  it("is case-insensitive and trims", () => {
    expect(searchCatalog("  bbc  ")[0]?.title).toBe("BBC News");
    expect(searchCatalog("BBC")[0]?.title).toBe("BBC News");
  });

  it("matches a partial of an alias (alias ⊇ query)", () => {
    // "guard" ⊆ "guardian"
    expect(searchCatalog("guard")[0]?.title).toBe("The Guardian");
  });

  it("matches a superset of an alias (query ⊇ alias)", () => {
    // "guardian" ⊆ "the guardian newspaper"
    expect(searchCatalog("the guardian newspaper")[0]?.title).toBe(
      "The Guardian",
    );
  });

  it("resolves common aliases to the same entry", () => {
    for (const q of ["nyt", "nytimes", "new york times"]) {
      expect(searchCatalog(q)[0]?.title).toBe("The New York Times");
    }
  });

  it("requires at least 2 characters (no single-keystroke fan-out)", () => {
    expect(searchCatalog("h")).toEqual([]);
    expect(searchCatalog("")).toEqual([]);
  });

  it("caps results at the requested limit", () => {
    // "news" appears in several descriptions/aliases; cap still holds.
    const out = searchCatalog("news", 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("returns [] for a name not in the catalog", () => {
    expect(searchCatalog("zzz-not-a-publication")).toEqual([]);
  });

  it("every catalog entry has an https/http feed URL and aliases", () => {
    for (const entry of PUBLICATION_CATALOG) {
      expect(entry.feedUrl).toMatch(/^https?:\/\//);
      expect(entry.aliases.length).toBeGreaterThan(0);
      // Aliases must be lowercase so case-insensitive matching is symmetric.
      for (const a of entry.aliases) expect(a).toBe(a.toLowerCase());
    }
  });

  it("the curated head keeps priority in the merged catalog", () => {
    // FULL_CATALOG scans in order and searchCatalog caps, so the head must be
    // the merged list's prefix — a generated near-duplicate can never outrank
    // the canonical curated entry.
    expect(FULL_CATALOG.slice(0, PUBLICATION_CATALOG.length)).toEqual(
      PUBLICATION_CATALOG,
    );
    expect(searchCatalog("guardian")[0]?.feedUrl).toBe(
      "https://www.theguardian.com/international/rss",
    );
  });

  it("matches diacritic queries against the folded aliases", () => {
    expect(foldDiacritics("Süddeutsche Zeitung")).toBe("Suddeutsche Zeitung");
    expect(foldDiacritics("plain ascii")).toBe("plain ascii"); // no-op on ASCII
    // searchCatalog folds the query, so an accented query hits an ASCII alias.
    expect(searchCatalog("güardian")[0]?.title).toBe("The Guardian");
  });

  it("alias-in-query requires word boundaries — no mid-word alias fire", () => {
    // "thorough" must not fire a hypothetical short alias "thor", and more
    // generally no generated alias may hit inside an unrelated word. "hn" is a
    // real head alias sitting inside "john" — it must not nominate Hacker News.
    const hits = searchCatalog("john thorough");
    expect(hits.map((h) => h.title)).not.toContain("Hacker News");
  });

  it("alias-in-query requires ≥5-char aliases — short acronyms only hit typed exactly", () => {
    // "hn" (2 chars) as a standalone word in a longer query: too generic to
    // nominate from inside a sentence…
    expect(searchCatalog("the hn thing").map((h) => h.title)).not.toContain(
      "Hacker News",
    );
    // …but typing the acronym itself still hits (query-in-alias direction —
    // alongside other aliases containing "hn", e.g. "technica").
    expect(searchCatalog("hn").map((h) => h.title)).toContain("Hacker News");
  });

  it("alias-in-query still matches a ≥5-char alias on word boundaries", () => {
    expect(searchCatalog("the guardian newspaper")[0]?.title).toBe(
      "The Guardian",
    );
  });
});

describe("mergeCatalogs (generated tail under the curated head)", () => {
  const head: CatalogEntry[] = [
    { title: "A", feedUrl: "https://www.a.example/rss", aliases: ["aaa"] },
  ];

  it("drops a generated entry whose feed host collides with the head", () => {
    const generated: CatalogEntry[] = [
      // Same host as the head entry, www-insensitively — dropped.
      { title: "A dup", feedUrl: "https://a.example/other.xml", aliases: ["dup"] },
      { title: "B", feedUrl: "https://b.example/rss", aliases: ["bbb"] },
    ];
    const merged = mergeCatalogs(head, generated);
    expect(merged.map((e) => e.title)).toEqual(["A", "B"]);
  });

  it("does not host-dedupe generated entries against each other", () => {
    // Multi-tenant hosts (podcast platforms) legitimately repeat within the
    // generated set — generation-time dedup owns that axis, not the merge.
    const generated: CatalogEntry[] = [
      { title: "P1", feedUrl: "https://feeds.example/p1", aliases: ["podcast one"] },
      { title: "P2", feedUrl: "https://feeds.example/p2", aliases: ["podcast two"] },
    ];
    expect(mergeCatalogs(head, generated)).toHaveLength(3);
  });

  it("feedHost strips www. and lowercases; null on garbage", () => {
    expect(feedHost("https://WWW.Example.COM/feed")).toBe("example.com");
    expect(feedHost("not a url")).toBeNull();
  });

  it("multi-tenant hosts collide by full URL, not host — one curated tenant does not delete the rest", () => {
    const multiHead: CatalogEntry[] = [
      {
        title: "Curated Pod",
        feedUrl: "https://feeds.feedburner.com/curated",
        aliases: ["curated pod"],
      },
    ];
    const generated: CatalogEntry[] = [
      // Exact-URL duplicate of the head — dropped.
      {
        title: "Curated Pod (gen)",
        feedUrl: "https://feeds.feedburner.com/curated",
        aliases: ["curated"],
      },
      // Different tenant on the same multi-tenant host — must survive.
      {
        title: "Other Pod",
        feedUrl: "https://feeds.feedburner.com/other",
        aliases: ["other pod"],
      },
    ];
    const merged = mergeCatalogs(multiHead, generated);
    expect(merged.map((e) => e.title)).toEqual(["Curated Pod", "Other Pod"]);
  });
});

describe("GENERATED_PUBLICATION_CATALOG hygiene (RESOLVER-DISCOVERY-ADR §7.1)", () => {
  it("meets the Phase 4 acceptance floor (≥300 probed-live entries)", () => {
    expect(GENERATED_PUBLICATION_CATALOG.length).toBeGreaterThanOrEqual(300);
  });

  it("every generated entry passes alias hygiene and URL shape", () => {
    for (const entry of GENERATED_PUBLICATION_CATALOG) {
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.feedUrl).toMatch(/^https?:\/\//);
      expect(entry.aliases.length).toBeGreaterThan(0);
      for (const a of entry.aliases) {
        expect(a.length).toBeGreaterThanOrEqual(3);
        expect(a).toBe(a.toLowerCase());
        expect(a).toBe(foldDiacritics(a)); // already folded at generation
      }
    }
  });
});
