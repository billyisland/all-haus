import { describe, it, expect } from "vitest";

// =============================================================================
// FOLLOW-GRAPH-IMPORT-ADR §5.4 / §11.4 (Phase 1d) — OPML parsing + the
// folder→feed import plan: folder mapping, nested-folder flattening, per-feed
// dedupe, the feed cap (overflow folds into the base feed), the per-import
// identity cap (truncation surfaced), and invalid-entry counting. Both
// functions are pure, so this is plain input/output coverage.
// =============================================================================

import { parseOpml, planOpmlImport, OPML_MAX_FEEDS } from "../src/lib/opml.js";

function opml(body: string, title?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>${title ? `<title>${title}</title>` : ""}</head>
  <body>${body}</body>
</opml>`;
}

describe("parseOpml", () => {
  it("reads loose entries, folders, and the head title", () => {
    const parsed = parseOpml(
      opml(
        `<outline text="Loose Feed" type="rss" xmlUrl="https://loose.example/rss"/>
         <outline text="Tech">
           <outline text="A" xmlUrl="https://a.example/feed"/>
           <outline text="B" xmlUrl="https://b.example/feed"/>
         </outline>`,
        "My Reader",
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("My Reader");
    expect(parsed!.groups).toEqual([
      {
        name: null,
        entries: [{ url: "https://loose.example/rss", title: "Loose Feed" }],
      },
      {
        name: "Tech",
        entries: [
          { url: "https://a.example/feed", title: "A" },
          { url: "https://b.example/feed", title: "B" },
        ],
      },
    ]);
    expect(parsed!.invalidEntries).toBe(0);
  });

  it("flattens nested folders into their top-level ancestor", () => {
    const parsed = parseOpml(
      opml(
        `<outline text="News">
           <outline text="World">
             <outline text="Deep" xmlUrl="https://deep.example/rss"/>
           </outline>
           <outline text="Top" xmlUrl="https://top.example/rss"/>
         </outline>`,
      ),
    );
    expect(parsed!.groups).toHaveLength(1);
    expect(parsed!.groups[0].name).toBe("News");
    expect(parsed!.groups[0].entries.map((e) => e.url)).toEqual([
      "https://deep.example/rss",
      "https://top.example/rss",
    ]);
  });

  it("counts non-http(s) and unparseable xmlUrls as invalid instead of keeping them", () => {
    const parsed = parseOpml(
      opml(
        `<outline text="Good" xmlUrl="https://ok.example/rss"/>
         <outline text="Ftp" xmlUrl="ftp://old.example/feed"/>
         <outline text="Junk" xmlUrl="not a url"/>`,
      ),
    );
    expect(parsed!.groups[0].entries).toHaveLength(1);
    expect(parsed!.invalidEntries).toBe(2);
  });

  it("accepts the lowercase xmlurl attribute variant", () => {
    const parsed = parseOpml(
      opml(`<outline text="LC" xmlurl="https://lc.example/rss"/>`),
    );
    expect(parsed!.groups[0].entries).toEqual([
      { url: "https://lc.example/rss", title: "LC" },
    ]);
  });

  it("drops folders that contain no valid entries", () => {
    const parsed = parseOpml(
      opml(
        `<outline text="Empty"></outline>
         <outline text="Full"><outline xmlUrl="https://f.example/rss"/></outline>`,
      ),
    );
    expect(parsed!.groups.map((g) => g.name)).toEqual(["Full"]);
  });

  it("returns null for malformed XML, non-OPML XML, and non-XML text", () => {
    expect(parseOpml("<opml><body><outline text=\"unclosed\"></body>")).toBeNull();
    expect(parseOpml("<rss version=\"2.0\"><channel/></rss>")).toBeNull();
    expect(parseOpml("just some text")).toBeNull();
    expect(parseOpml('{"not": "xml"}')).toBeNull();
  });

  // Shape guard — jsdom's XML parse is quadratic in nesting depth, so
  // pathological shapes are rejected by a linear pre-parse scan before jsdom
  // sees the text (the parseOpml DoS fix, 2026-07-12).
  it("rejects pathological nesting depth before jsdom parses it", () => {
    const depth = 5_000;
    const deep =
      "<outline text=\"d\">".repeat(depth) + "</outline>".repeat(depth);
    const started = Date.now();
    expect(parseOpml(opml(deep))).toBeNull();
    // The whole point is that rejection is cheap — jsdom at this depth
    // costs multiple seconds of synchronous CPU.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the depth scan is quote-aware: '/>' inside an attribute value can't fake a self-closing tag", () => {
    // Each opener smuggles '/>' in an attribute; a naive scanner reads it as
    // self-closing (depth 0) while the real parser nests all 5000 levels.
    const depth = 5_000;
    const deep =
      '<outline text="/>x">'.repeat(depth) + "</outline>".repeat(depth);
    expect(parseOpml(opml(deep))).toBeNull();
  });

  it("still accepts realistic breadth and folder nesting", () => {
    const flat = Array.from(
      { length: 2_000 },
      (_, i) => `<outline text="F${i}" xmlUrl="https://h.example/${i}"/>`,
    ).join("");
    const parsed = parseOpml(opml(flat));
    expect(parsed).not.toBeNull();
    expect(parsed!.groups[0].entries).toHaveLength(2_000);

    const nested =
      "<outline text=\"a\"><outline text=\"b\"><outline text=\"c\">" +
      "<outline text=\"leaf\" xmlUrl=\"https://h.example/leaf\"/>" +
      "</outline></outline></outline>";
    expect(parseOpml(opml(nested))).not.toBeNull();
  });
});

describe("planOpmlImport", () => {
  const entry = (n: number, host = "h") => ({
    url: `https://${host}.example/${n}`,
    title: `Feed ${n}`,
  });

  it("maps folders to feeds, with loose entries as the base feed named from the head title", () => {
    const plan = planOpmlImport(
      {
        title: "My Reader",
        invalidEntries: 0,
        groups: [
          { name: null, entries: [entry(1)] },
          { name: "Tech", entries: [entry(2), entry(3)] },
        ],
      },
      { cap: 1000 },
    );
    expect(plan.feeds.map((f) => f.name)).toEqual(["My Reader", "Tech"]);
    expect(plan.totalEntries).toBe(3);
    expect(plan.truncated).toBe(false);
    expect(plan.foldedFolders).toBe(0);
  });

  it("uses the explicit baseName over the head title, and the default over nothing", () => {
    const groups = [{ name: null, entries: [entry(1)] }];
    expect(
      planOpmlImport(
        { title: "Head", invalidEntries: 0, groups },
        { baseName: "Mine", cap: 10 },
      ).feeds[0].name,
    ).toBe("Mine");
    expect(
      planOpmlImport({ title: null, invalidEntries: 0, groups }, { cap: 10 })
        .feeds[0].name,
    ).toBe("Imported feeds");
  });

  it("folds folders beyond the feed cap into the base feed", () => {
    const folders = Array.from({ length: OPML_MAX_FEEDS + 3 }, (_, i) => ({
      name: `Folder ${i}`,
      entries: [entry(i, `f${i}`)],
    }));
    const plan = planOpmlImport(
      { title: null, invalidEntries: 0, groups: folders },
      { cap: 1000 },
    );
    expect(plan.feeds).toHaveLength(OPML_MAX_FEEDS);
    // Base feed first, holding the overflow folders' entries.
    expect(plan.feeds[0].name).toBe("Imported feeds");
    expect(plan.feeds[0].entries).toHaveLength(4); // 13 folders − 9 kept
    expect(plan.foldedFolders).toBe(4);
    expect(plan.feeds.slice(1).map((f) => f.name)).toEqual(
      folders.slice(0, OPML_MAX_FEEDS - 1).map((f) => f.name),
    );
  });

  it("keeps exactly maxFeeds folders with no base feed when nothing overflows", () => {
    const folders = Array.from({ length: OPML_MAX_FEEDS }, (_, i) => ({
      name: `Folder ${i}`,
      entries: [entry(i, `f${i}`)],
    }));
    const plan = planOpmlImport(
      { title: null, invalidEntries: 0, groups: folders },
      { cap: 1000 },
    );
    expect(plan.feeds).toHaveLength(OPML_MAX_FEEDS);
    expect(plan.feeds.map((f) => f.name)).toEqual(folders.map((f) => f.name));
  });

  it("dedupes URLs within a feed but not across feeds", () => {
    const dup = { url: "https://dup.example/rss", title: "Dup" };
    const plan = planOpmlImport(
      {
        title: null,
        invalidEntries: 0,
        groups: [
          { name: "A", entries: [dup, dup, entry(1)] },
          { name: "B", entries: [dup] },
        ],
      },
      { cap: 1000 },
    );
    expect(plan.feeds[0].entries).toHaveLength(2);
    expect(plan.feeds[1].entries).toHaveLength(1);
  });

  it("applies the per-import cap across the plan in order and surfaces truncation", () => {
    const plan = planOpmlImport(
      {
        title: null,
        invalidEntries: 0,
        groups: [
          { name: "A", entries: [entry(1), entry(2), entry(3)] },
          { name: "B", entries: [entry(4), entry(5)] },
          { name: "C", entries: [entry(6)] },
        ],
      },
      { cap: 4 },
    );
    // A keeps 3, B truncates to 1, C drops out entirely.
    expect(plan.feeds.map((f) => [f.name, f.entries.length])).toEqual([
      ["A", 3],
      ["B", 1],
    ]);
    expect(plan.totalEntries).toBe(4);
    expect(plan.remoteTotal).toBe(6);
    expect(plan.truncated).toBe(true);
  });

  it("clamps feed names to the 80-char schema bound", () => {
    const plan = planOpmlImport(
      {
        title: "T".repeat(120),
        invalidEntries: 0,
        groups: [
          { name: null, entries: [entry(1)] },
          { name: "F".repeat(120), entries: [entry(2)] },
        ],
      },
      { cap: 10 },
    );
    expect(plan.feeds[0].name).toHaveLength(80);
    expect(plan.feeds[1].name).toHaveLength(80);
  });

  it("returns an empty plan for a file with no valid entries", () => {
    const plan = planOpmlImport(
      { title: null, invalidEntries: 3, groups: [] },
      { cap: 10 },
    );
    expect(plan.feeds).toEqual([]);
    expect(plan.invalidEntries).toBe(3);
  });
});
