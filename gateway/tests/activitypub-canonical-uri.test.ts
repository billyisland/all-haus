import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =============================================================================
// An activitypub row's identity is the `uri`, never the human `url`
// (MIRROR-AUDIT §3 *Data integrity and ingest*, S17).
//
// A Mastodon status carries two addresses: `uri` (the ActivityPub object id,
// which is what the ingester stores — `adapters/activitypub.ts` normalises
// `note.id`) and `url` (the web page a human opens). `(protocol,
// source_item_uri)` is the dedup key, so choosing `url` mints a SECOND
// external_items row for a status the source's own poll had already ingested —
// with its own feed_items twin, its own post_id, and no relation to the first.
// The thread then re-roots onto a twin the feed does not know about.
//
// Every writer spelled it `uri || url` except one: the Mastodon focus fetcher in
// external-items/thread.ts had `url || uri`, so the defect fired on any focus
// fetch of an already-ingested status. Since CA-A10 no writer spells either:
// the id is the one `mastodonStatusIdentity` admitted, or nothing.
//
// A text pin because there is no seam to drive: these are inner functions of
// route handlers, and the whole bug is which of two fields is read first. The
// count assertion is what stops a rename making it vacuous.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

// Every place a Mastodon/ActivityPub status is turned into a stored identity.
const WRITERS = [
  "gateway/src/routes/external-items/thread.ts",
  "gateway/src/routes/external-items/parent.ts",
  "gateway/src/lib/external-hydration.ts",
  "gateway/src/lib/author-timeline-hydration.ts",
  "feed-ingest/src/tasks/external-parent-prefetch.ts",
  // The quote fetcher mints an AP status identity too (S25 item 3): it was
  // correct and unlisted, which is guarded by nothing.
  "gateway/src/routes/external-items/quote.ts",
];

describe("activitypub canonical identity", () => {
  it("no writer prefers `url` over `uri`, and none takes either on the instance's word", () => {
    // Since CA-A10 (2026-09-29) the `uri || url` spelling is GONE from every
    // listed writer: each asks `mastodonStatusIdentity` (or, for the timeline
    // page whose author is already pinned, `authoritativeId`) and stores the
    // id that passed — a web-url fallback was the second half of the defect.
    // The reversed form stays banned; the count is of the one home instead,
    // so a rename cannot make the scan vacuous.
    let homes = 0;
    for (const rel of WRITERS) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      const reversed = [
        ...src.matchAll(/\b(\w+)\.url\s*\|\|\s*\1\.uri\b/g),
      ].map((m) => `${rel}: ${m[0]}`);
      expect(reversed).toEqual([]);
      const fallback = [
        ...src.matchAll(/\b(\w+)\.uri\s*\|\|\s*\1\.url\b/g),
      ].map((m) => `${rel}: ${m[0]}`);
      expect(fallback, `${rel} keys a status on the instance's word`).toEqual([]);
      // The WRITE spelling (`status.account.uri ?? …`). thread.ts's
      // ancestors/descendants arm is a read-only projection of what the
      // instance said, persisted nowhere, and keeps `s.account.uri ?? url`.
      const authorFallback = [
        ...src.matchAll(/\bstatus\.account\.uri\s*\?\?\s*status\.account\.url/g),
      ].map((m) => `${rel}: ${m[0]}`);
      expect(authorFallback, `${rel} takes an author on the instance's word`).toEqual([]);
      homes += (src.match(/mastodonStatusIdentity\(|authoritativeId\(/g) ?? []).length;
    }
    // At least one home per writer, and the prefetch file has two writers.
    expect(homes).toBeGreaterThanOrEqual(WRITERS.length + 1);
  });

  it("every listed writer exists", () => {
    // The list is hand-kept, so it must at least be real: a path that has moved
    // would otherwise silently drop a writer out of the scan.
    for (const rel of WRITERS) {
      expect(fs.existsSync(path.join(root, rel))).toBe(true);
    }
  });
});
