import { JSDOM } from "jsdom";

// =============================================================================
// OPML parsing + import planning (FOLLOW-GRAPH-IMPORT-ADR §5.4, §11.4 — Phase
// 1d). OPML is the "follow graph" artifact for RSS: the export file every feed
// reader produces. Two deltas from the graph protocols:
//
//  - Folders map to one feed per folder — the user's own curation, already in
//    feed-shaped form (§5.4) — under a per-import feed cap: folders beyond it
//    fold into the base feed rather than minting an unbounded feed count.
//  - No sync semantics: OPML is a snapshot by nature, so the plan feeds the
//    import engine WITHOUT a feed_import_bindings row ("Sync now" doesn't
//    apply; re-import = new run).
//
// Parsing rides jsdom (already a gateway dependency) in strict XML mode — a
// malformed file throws at construction, which parseOpml surfaces as null.
// Both functions are pure (no I/O), so they carry the unit tests for the
// folder/cap behaviour.
// =============================================================================

export interface OpmlEntry {
  url: string;
  title?: string;
}

export interface OpmlGroup {
  /** null = entries sitting at the top level of <body>, outside any folder. */
  name: string | null;
  entries: OpmlEntry[];
}

export interface ParsedOpml {
  /** <head><title>, when present — the base-feed name fallback. */
  title: string | null;
  /** Loose entries (name null) + one group per top-level folder, document
   *  order. Nested folders flatten into their top-level ancestor. */
  groups: OpmlGroup[];
  /** Outlines carrying an xmlUrl that was not a valid http(s) URL — dropped
   *  from the groups but counted so the summary can say so (no-silent-caps). */
  invalidEntries: number;
}

// §6.5 — per-import feed cap: folders beyond it fold into the base feed.
export const OPML_MAX_FEEDS = 10;

// Matches the feeds.name / feedName schema bound (crud.ts).
const FEED_NAME_MAX = 80;

function outlineTitle(el: Element): string | undefined {
  const t = el.getAttribute("text") ?? el.getAttribute("title");
  const trimmed = t?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function outlineUrl(el: Element): string | null {
  // xmlUrl is the OPML 2.0 attribute; a few exporters lowercase it.
  return el.getAttribute("xmlUrl") ?? el.getAttribute("xmlurl");
}

function validFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

// Pre-parse shape guard — jsdom's XML parse is quadratic in element nesting
// DEPTH (measured: ~12k nested outlines in a 336KB file, well under the 2MB
// upload cap, costs ~30s of synchronous CPU on the request path), so a small
// crafted upload could freeze the single-threaded gateway. Real OPML nests
// folders 2–3 deep; reject pathological shapes with a linear, quote-aware
// scan before jsdom ever sees the text. Breadth is cheap (40k flat outlines
// parse in under a second), so the count bound is generous. Capping depth
// here also bounds collect()'s recursion below, so it can't overflow.
const MAX_OUTLINE_DEPTH = 100;
const MAX_OUTLINE_COUNT = 50_000;

export function opmlShapeOk(text: string): boolean {
  let depth = 0;
  let count = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    // Scan to the tag's real '>' respecting quoted attribute values, so an
    // attribute containing '>' or '/>' can't skew the depth count.
    let j = lt + 1;
    let quote: '"' | "'" | null = null;
    while (j < n) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    if (j >= n) break; // unterminated tag — jsdom rejects the file anyway
    const tag = text.slice(lt + 1, j);
    if (/^outline(?:[\s/]|$)/i.test(tag)) {
      if (++count > MAX_OUTLINE_COUNT) return false;
      if (!tag.endsWith("/") && ++depth > MAX_OUTLINE_DEPTH) return false;
    } else if (/^\/outline\s*$/i.test(tag)) {
      if (depth > 0) depth--;
    }
    i = j + 1;
  }
  return true;
}

export function parseOpml(text: string): ParsedOpml | null {
  if (!opmlShapeOk(text)) return null;
  let doc: Document;
  try {
    doc = new JSDOM(text, { contentType: "text/xml" }).window.document;
  } catch {
    return null;
  }
  if (doc.documentElement?.tagName.toLowerCase() !== "opml") return null;
  const body = doc.querySelector("body");
  if (!body) return null;

  const title =
    doc.querySelector("head > title")?.textContent?.trim() || null;

  let invalidEntries = 0;
  const loose: OpmlEntry[] = [];
  const groups: OpmlGroup[] = [];

  // Collect every entry (outline with xmlUrl) under a node, recursively —
  // nested folders flatten into whichever top-level group owns them.
  const collect = (root: Element, into: OpmlEntry[]) => {
    for (const child of Array.from(root.children)) {
      if (child.tagName.toLowerCase() !== "outline") continue;
      const rawUrl = outlineUrl(child);
      if (rawUrl !== null) {
        const url = validFeedUrl(rawUrl);
        if (url) into.push({ url, title: outlineTitle(child) });
        else invalidEntries++;
      }
      // An outline can be both an entry and a container; recurse regardless.
      collect(child, into);
    }
  };

  for (const top of Array.from(body.children)) {
    if (top.tagName.toLowerCase() !== "outline") continue;
    const rawUrl = outlineUrl(top);
    if (rawUrl !== null) {
      const url = validFeedUrl(rawUrl);
      if (url) loose.push({ url, title: outlineTitle(top) });
      else invalidEntries++;
      // Entry-shaped outlines rarely nest children, but tolerate it.
      collect(top, loose);
      continue;
    }
    const entries: OpmlEntry[] = [];
    collect(top, entries);
    if (entries.length > 0)
      groups.push({ name: outlineTitle(top) ?? null, entries });
  }

  const result: OpmlGroup[] = [];
  if (loose.length > 0) result.push({ name: null, entries: loose });
  result.push(...groups);
  return { title, groups: result, invalidEntries };
}

export interface OpmlPlannedFeed {
  name: string;
  entries: OpmlEntry[];
}

export interface OpmlImportPlan {
  feeds: OpmlPlannedFeed[];
  /** Entries across the planned feeds, after both caps. */
  totalEntries: number;
  /** Valid entries in the file, before the per-import cap. */
  remoteTotal: number;
  truncated: boolean;
  /** Folders folded into the base feed by the feed cap. */
  foldedFolders: number;
  invalidEntries: number;
}

// Turn a parsed file into the concrete feed plan: base feed (loose entries +
// any folded-overflow folders) first, then one feed per kept folder in
// document order; per-feed URL dedupe; the per-import identity cap applied
// across the whole plan in order (truncation surfaced, never silent).
export function planOpmlImport(
  parsed: ParsedOpml,
  opts: { baseName?: string; maxFeeds?: number; cap: number },
): OpmlImportPlan {
  const maxFeeds = Math.max(1, opts.maxFeeds ?? OPML_MAX_FEEDS);
  const baseName = (
    opts.baseName?.trim() ||
    parsed.title ||
    "Imported feeds"
  ).slice(0, FEED_NAME_MAX);

  const loose = parsed.groups.find((g) => g.name === null)?.entries ?? [];
  const folders = parsed.groups.filter(
    (g): g is OpmlGroup & { name: string } => g.name !== null,
  );

  // The base feed exists if there are loose entries, or if the feed cap
  // forces overflow folders to fold somewhere.
  const needsBase = loose.length > 0 || folders.length > maxFeeds;
  const allowedFolders = needsBase ? maxFeeds - 1 : maxFeeds;
  const kept = folders.slice(0, allowedFolders);
  const folded = folders.slice(allowedFolders);

  const dedupe = (entries: OpmlEntry[]): OpmlEntry[] => {
    const seen = new Set<string>();
    return entries.filter((e) =>
      seen.has(e.url) ? false : (seen.add(e.url), true),
    );
  };

  const feeds: OpmlPlannedFeed[] = [];
  if (needsBase) {
    feeds.push({
      name: baseName,
      entries: dedupe([...loose, ...folded.flatMap((f) => f.entries)]),
    });
  }
  for (const f of kept) {
    feeds.push({ name: f.name.slice(0, FEED_NAME_MAX), entries: dedupe(f.entries) });
  }

  const remoteTotal = feeds.reduce((n, f) => n + f.entries.length, 0);

  // Per-import cap across the whole plan, in plan order; feeds emptied by the
  // cap are dropped entirely (their run would be a no-op).
  let budget = opts.cap;
  const capped: OpmlPlannedFeed[] = [];
  for (const f of feeds) {
    if (budget <= 0) break;
    const entries = f.entries.slice(0, budget);
    budget -= entries.length;
    if (entries.length > 0) capped.push({ name: f.name, entries });
  }
  const totalEntries = capped.reduce((n, f) => n + f.entries.length, 0);

  return {
    feeds: capped,
    totalEntries,
    remoteTotal,
    truncated: totalEntries < remoteTotal,
    foldedFolders: folded.length,
    invalidEntries: parsed.invalidEntries,
  };
}
