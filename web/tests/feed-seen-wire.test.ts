import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// The reading counts' wire — WORKSPACE-QUEUE-ADR §IV.2, slice A1.
//
// `FeedSeenWindow` and the items page's `asOf` are hand-written on both sides
// of a boundary no type crosses, and the client's whole account of "new" and
// "unread" is built on them: a field the gateway never sends reads
// `undefined`, and a route the client names but nobody mounts answers 404 on
// every poll — which the poll is specified to swallow (§IV.9), so it would
// never be seen. So the strings are pinned by READING the files that own them,
// and every match is asserted FOUND, or a rename passes this by testing nothing
// (`.claude/rules/testing.md` › a type is not a contract).
// =============================================================================

const GATEWAY = join(__dirname, "../../gateway/src");
const read = (p: string) => readFileSync(p, "utf8");
const SEEN_ROUTES = read(join(GATEWAY, "routes/feeds/seen.ts"));
const ITEMS = read(join(GATEWAY, "routes/feeds/items.ts"));
const BOOTSTRAP = read(join(GATEWAY, "routes/feeds/bootstrap.ts"));
const FEEDS_INDEX = read(join(GATEWAY, "routes/feeds/index.ts"));
const GATEWAY_INDEX = read(join(GATEWAY, "register-routes.ts"));
const WEB = read(join(__dirname, "../src/lib/api/feeds.ts"));

/** The field names of `export interface <name> { … }`, top level only. */
function fields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(m, `interface ${name} not found — was it renamed?`).toBeTruthy();
  return [...m![1].matchAll(/^ {2}(\w+)\??:/gm)].map((f) => f[1]).sort();
}

describe("the seen routes — parity with the gateway", () => {
  it("the gateway mounts GET and POST /feeds/:id/seen under /api/v1/workspace", () => {
    expect(SEEN_ROUTES).toMatch(/app\.get<[^>]*>\(\s*"\/feeds\/:id\/seen"/);
    expect(SEEN_ROUTES).toMatch(/app\.post<[^>]*>\(\s*"\/feeds\/:id\/seen"/);
    expect(FEEDS_INDEX).toContain("registerFeedSeenRoutes(app);");
    expect(GATEWAY_INDEX).toContain(
      'app.register(feedsRoutes, { prefix: "/api/v1/workspace" })',
    );
  });

  it("the web calls that path, both ways, and the beacon names it in full", () => {
    const calls = WEB.match(/`\/workspace\/feeds\/\$\{id\}\/seen`/g) ?? [];
    expect(calls.length).toBe(2); // seen + markSeen
    expect(WEB).toContain("`${API_BASE}/workspace/feeds/${id}/seen`");
    expect(WEB).toMatch(/markSeen:[\s\S]*?method: "POST",\s*body: JSON\.stringify\(\{ asOf \}\)/);
  });

  it("the POST body's field is the one the route reads", () => {
    expect(SEEN_ROUTES).toContain("(value as { asOf?: unknown }).asOf");
  });

  it("FeedSeenWindow has the same fields on both sides", () => {
    expect(fields(WEB, "FeedSeenWindow")).toEqual(fields(ITEMS, "FeedSeenWindow"));
    expect(fields(WEB, "FeedSeenWindow")).toEqual(
      ["asOf", "items", "seenBaselineAt", "truncated", "windowStart"],
    );
    // The item shape, which `fields` (top level only) does not reach.
    const item = "items: { id: string; publishedAt: number; isNew: boolean }[];";
    expect(ITEMS).toContain(item);
    expect(WEB).toContain(item);
  });

  it("the items page and the bootstrap both carry asOf, and the web reads it", () => {
    expect(ITEMS).toMatch(/placeholder: boolean;\n\s*asOf: string;\n\}> \{/);
    expect(ITEMS).toContain("return { items, nextCursor, placeholder: false, asOf };");
    expect(BOOTSTRAP).toContain("asOf: page.asOf,");
    expect(fields(WEB, "WorkspaceFeedItemsResponse")).toContain("asOf");
    expect(WEB).toMatch(/placeholder: boolean;\n\s*asOf: string;\n\s*\}\n\s*>;/);
  });
});
