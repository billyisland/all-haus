import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourcePageId } from "../src/lib/post/source-page";
import type { Post } from "../src/lib/post/types";

// =============================================================================
// A SOURCE IS LINKED ONLY WHERE ITS PAGE OPENS (MODERNHAUS-ADR §E7.3).
//
// A private email newsletter's cards linked to `/source/<id>` on both
// registers, and `GET /sources/:id` answers 404 for any protocol outside the
// public allow-list and for an inactive row. The gateway now states the
// route's two conditions as `origin.sourceBrowsable`
// (gateway/tests/post-mapper.test.ts pins the derivation); every link site
// asks `sourcePageId`, and the sites are pinned by reading them.
// =============================================================================

const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

function post(sourceBrowsable: boolean | undefined, externalSourceId: string | null) {
  return {
    externalSourceId,
    origin: { protocol: "rss", uri: "u", sourceName: "A Blog", publication: null, sourceBrowsable },
  } as Pick<Post, "origin" | "externalSourceId">;
}

describe("sourcePageId", () => {
  it("answers the id where the gateway says the page opens", () => {
    expect(sourcePageId(post(true, "src-1"))).toBe("src-1");
  });
  it("answers null where it does not, or where the gateway did not say", () => {
    expect(sourcePageId(post(false, "src-1"))).toBeNull();
    expect(sourcePageId(post(undefined, "src-1"))).toBeNull();
    expect(sourcePageId(post(true, null))).toBeNull();
  });
});

describe("every link to a post's source asks sourcePageId", () => {
  const SITES: [string, RegExp][] = [
    ["src/components/post/PostOriginTag.tsx", /const sourceId = sourcePageId\(post\);/],
    ["src/modernhaus/post.tsx", /const sourceId = sourcePageId\(post\)/],
    ["src/components/workspace/WorkspaceView.tsx", /sourceId: sourcePageId\(p\),/],
    ["src/stores/reader.ts", /sourceId: sourcePageId\(focal\),/],
  ];
  it.each(SITES)("%s", (file, re) => {
    const src = read(file);
    expect(src).toMatch(re);
    // …and never builds the address from the raw id beside it.
    expect(src).not.toMatch(/\/source\/\$\{encodeURIComponent\(post\.externalSourceId\)\}/);
    expect(src).not.toMatch(/sourceId: \w+\.externalSourceId/);
  });
});
