import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  FOLLOWABLE_PROTOCOLS,
  isFeedFollowable,
  matchFeedSource,
  feedFollowAddInput,
  type FeedFollowTarget,
} from "../src/hooks/useFeedFollow";
import type { WorkspaceFeedSource } from "../src/lib/api";

// =============================================================================
// THE FOLLOW FRONTIER — every follow either takes its feed from the context or
// asks for one, and nothing writes a bare graph row.
//
// Following is feed-derived (CLAUDE.md), and since the reach retirement
// (migration 177, §9.16) that is true of native writers too: a `follows` row
// with no `account` source anywhere puts nothing in front of the reader. The
// profile bar's Follow was exactly that button for five weeks — pressed, it
// wrote a relationship whose effect could not be found, which is how it was
// reported from the outside ("I followed someone back and I don't know where
// they ended up").
//
// That class is invisible to `tsc`, to ESLint and to `next build`: a bare
// graph write typechecks perfectly. So the frontier is pinned by a scan, and
// the wire strings by reading the gateway's own source.
//
// AND THE CLIENT NO LONGER MAKES A FOLLOW AT ALL. The first fix put the graph
// write behind the picker, which left it split across four client call sites
// and said nothing about the two composer paths — where you TYPE a member's
// name instead of pressing Follow, and which wrote a source and no follow.
// The INSERT is now the feed-source ROUTE's, in the same transaction as the
// source (`gateway/tests/follow-is-a-chosen-source.test.ts`), so what this
// file guards is that no browser code puts it back: the client may DELETE a
// follow (the legacy exit, for a row with no source to remove) and may
// reflect what the route did, and may not create one.
//
// A comment cannot fail. This can.
// =============================================================================

const SRC = path.resolve(__dirname, "..", "src");
const GATEWAY_SOURCES = path.resolve(
  __dirname,
  "..",
  "..",
  "gateway",
  "src",
  "routes",
  "feeds",
  "sources.ts",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(full);
  }
  return out;
}

// -----------------------------------------------------------------------------
// 1. The frontier itself.
// -----------------------------------------------------------------------------

// The only file allowed to DELETE a follow from the browser, with the reason.
// A new surface that reaches for it fails here until somebody writes its line
// — and writing one means answering what this item is about: a follow with no
// source is the legacy shape, and everything else unfollows by letting go of
// the last feed.
const GRAPH_DELETERS = new Map<string, string>([
  [
    "hooks/useFeedFollow.ts",
    "the legacy exit: a stranded follow has no source for the route to drop",
  ],
]);

// The store DEFINES unfollow rather than calling it through `getState()`, so
// the scan never sees it — it is not an exemption.

const GRAPH_DELETE_RE = /useFollows\s*\.\s*getState\(\)\s*\.\s*unfollow\s*\(/;
const GRAPH_INSERT_RE = /\.\s*follow\s*\(/;

describe("the follow frontier", () => {
  it("NOTHING in the browser creates a follow", () => {
    // The INSERT belongs to `POST /workspace/feeds/:id/sources`, in the same
    // transaction as the source. There is no allow-list here on purpose:
    // every entry would be a client that can make a follow with no feed
    // behind it, which is the whole defect.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      const body = readFileSync(file, "utf8");
      for (const line of body.split("\n")) {
        // `followTarget(`, `unfollow(` and `unfollowEverywhere(` are not it.
        if (/\bunfollow/i.test(line)) continue;
        if (/(useFollows|followsApi|follows)\s*[.\w()]*\.follow\s*\(/.test(line))
          offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the store exposes no follow writer to be called", () => {
    // The pattern above can only catch a CALL. This catches the method
    // coming back, which is what would make such a call possible again.
    const store = readFileSync(path.join(SRC, "stores/follows.ts"), "utf8");
    expect(/^\s*follow:/m.test(store), "useFollows.follow is back").toBe(false);
    expect(/^\s*unfollow:/m.test(store), "useFollows.unfollow is gone").toBe(
      true,
    );
    const api = readFileSync(path.join(SRC, "lib/api/follows.ts"), "utf8");
    expect(/method:\s*['"]POST['"]/.test(api), "a POST /follows client is back").toBe(
      false,
    );
  });

  it("no surface deletes a native follow outside the legacy exit", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (GRAPH_DELETERS.has(rel)) continue;
      const body = readFileSync(file, "utf8");
      if (GRAPH_DELETE_RE.test(body)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  // The scan above is worthless if the pattern no longer matches anything —
  // a renamed store method would make every file "clean". Assert the allowed
  // home really does contain what the scan is looking for.
  it("the scan's pattern still matches the sanctioned home", () => {
    for (const rel of GRAPH_DELETERS.keys()) {
      const body = readFileSync(path.join(SRC, rel), "utf8");
      expect(
        GRAPH_DELETE_RE.test(body),
        `${rel} no longer contains a graph delete — has the store been renamed?`,
      ).toBe(true);
    }
  });

  // The raw-fetch escape the profile's Following view used to take. It
  // bypassed the shared store (stale labels everywhere else) AND left the feed
  // sources standing, so an "unfollowed" writer kept arriving.
  // ---------------------------------------------------------------------------
  // EVERY SURFACE THAT WRITES AN ACCOUNT SOURCE REPORTS WHAT THE ROUTE DID
  // (§0ab item 6).
  //
  // The route answers `following` for every account source — the state AFTER
  // the write, read off `follows`. A surface that DISCARDS it leaves the
  // shared graph store holding whatever it held before, so the writer the
  // member just added reads as not-followed everywhere else on the floor until
  // a reload: the two composer paths did exactly that, which is the client
  // half of the same defect the server half had.
  //
  // THE SCAN IS OVER `addSource`/`removeSource` CALL SITES, not a hand-listed
  // set of components: a new surface that writes a source is the next instance
  // of this, and a list would not know about it. `reportFollowState` is the one
  // home — it is a REPORT, not a writer, which is why it is not an exemption to
  // the rule above.
  // ---------------------------------------------------------------------------
  it("every surface that adds or removes a source reports the follow back", () => {
    const CALL_RE = /workspaceFeeds(?:Api)?\s*\.\s*(?:add|remove)Source\s*\(/;

    // Files that legitimately touch a source WITHOUT a follow to report, each
    // with the reason. A new entry means answering why this surface cannot be
    // adding an account.
    const NO_ACCOUNT_SOURCE = new Map<string, string>([
      [
        "components/workspace/FeedSyncSection.tsx",
        "follow-import's own sync, which reaches addSource server-side; " +
          "nothing here names an account",
      ],
    ]);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      const body = readFileSync(file, "utf8");
      if (!CALL_RE.test(body)) continue;
      if (NO_ACCOUNT_SOURCE.has(rel)) continue;
      if (!/reportFollowState\s*\(/.test(body)) offenders.push(rel);
    }
    expect(
      offenders,
      "these write a feed source and never tell the graph store what the " +
        "route did with the follow",
    ).toEqual([]);

    // The scan's own guard: a regex that matched nothing would make the
    // assertion above vacuous for ever. Four surfaces write sources today
    // (the hook, the hover card, the composer, the vessel bar).
    const writers = walk(SRC).filter((f) => CALL_RE.test(readFileSync(f, "utf8")));
    expect(writers.length).toBeGreaterThanOrEqual(4);
  });

  it("the report is not a write — it goes through setLocal, which issues no request", () => {
    // `reportFollowState` is exempt from "nothing creates a follow" only
    // because of this. If it ever reached the API it would be the fourth
    // client-side follow writer wearing a reporter's name.
    const hook = readFileSync(path.join(SRC, "hooks/useFeedFollow.ts"), "utf8");
    const fn = hook.slice(hook.indexOf("export function reportFollowState"));
    const bodyEnd = fn.indexOf("\n}");
    const impl = fn.slice(0, bodyEnd);
    expect(impl).toMatch(/setLocal\(/);
    expect(impl).not.toMatch(/fetch|followsApi|workspaceFeeds/);
  });

  it("nothing reaches /follows over a bare fetch", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      // lib/api/follows.ts is the API module the store itself calls.
      if (rel === "lib/api/follows.ts") continue;
      const body = readFileSync(file, "utf8");
      if (/fetch\([^)]*\/follows\//.test(body)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 2. The wire strings, read off the gateway rather than remembered.
// -----------------------------------------------------------------------------

describe("addSource vocabulary is pinned against the gateway", () => {
  const gateway = readFileSync(GATEWAY_SOURCES, "utf8");

  it("the followable protocols are exactly the route's enum", () => {
    const m = gateway.match(/protocol:\s*z\.enum\(\[([^\]]+)\]\)/);
    // A renamed constant must fail the suite, not make it pass by testing
    // nothing.
    expect(m, "protocol z.enum not found in feeds/sources.ts").toBeTruthy();
    const serverProtocols = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(serverProtocols.length).toBeGreaterThan(0);
    expect([...FOLLOWABLE_PROTOCOLS].sort()).toEqual(
      [...serverProtocols].sort(),
    );
  });

  it("the route accepts the `account` sourceType native follow depends on", () => {
    expect(
      /sourceType:\s*z\.literal\("account"\)/.test(gateway),
      "addSourceSchema no longer takes sourceType:'account' — native follow " +
        "has no way to write its feed source",
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 3. The target rules the two pickers and the feed-scoped button all share.
// -----------------------------------------------------------------------------

const native: FeedFollowTarget = {
  type: "user",
  id: "acct-1",
  isFollowing: false,
};

const external = (
  over: Partial<FeedFollowTarget> = {},
): FeedFollowTarget => ({
  type: "source",
  id: "author-1",
  isFollowing: false,
  protocol: "rss",
  sourceUri: "https://example.com/feed.xml",
  sourceId: "src-1",
  ...over,
});

function sources(rows: Partial<WorkspaceFeedSource>[]): WorkspaceFeedSource[] {
  return rows as WorkspaceFeedSource[];
}

describe("feed-follow target rules", () => {
  it("a native writer is always followable", () => {
    expect(isFeedFollowable(native)).toBe(true);
  });

  it("a protocol addSource cannot service has no follow gesture", () => {
    expect(isFeedFollowable(external({ protocol: "email" }))).toBe(false);
    for (const p of FOLLOWABLE_PROTOCOLS) {
      expect(isFeedFollowable(external({ protocol: p }))).toBe(true);
    }
  });

  it("matches a native writer on the account row, not the author id", () => {
    const rows = sources([
      { id: "fs-a", sourceType: "external_source", externalSourceId: "acct-1" },
      { id: "fs-b", sourceType: "account", accountId: "acct-1" },
    ]);
    expect(matchFeedSource(rows, native)).toBe("fs-b");
  });

  it("matches an external source on external_source_id, not the account", () => {
    const rows = sources([
      { id: "fs-a", sourceType: "account", accountId: "src-1" },
      { id: "fs-b", sourceType: "external_source", externalSourceId: "src-1" },
    ]);
    expect(matchFeedSource(rows, external())).toBe("fs-b");
  });

  // The dead-unfollow shape: a followed source whose add-only fields are
  // absent. Matching must still find its row, or the untick silently no-ops
  // and (now) the graph follow is never dropped either.
  it("finds the row for removal with no protocol or sourceUri", () => {
    const rows = sources([
      { id: "fs-b", sourceType: "external_source", externalSourceId: "src-1" },
    ]);
    const bare = external({ protocol: undefined, sourceUri: undefined });
    expect(feedFollowAddInput(bare)).toBeNull();
    expect(matchFeedSource(rows, bare)).toBe("fs-b");
  });

  it("an external source with no source row yet matches nothing", () => {
    const rows = sources([
      { id: "fs-b", sourceType: "external_source", externalSourceId: "src-1" },
    ]);
    expect(matchFeedSource(rows, external({ sourceId: null }))).toBeNull();
  });

  it("builds the account payload for a native writer", () => {
    expect(feedFollowAddInput(native)).toEqual({
      sourceType: "account",
      accountId: "acct-1",
    });
  });

  it("builds the external payload from protocol + uri", () => {
    expect(feedFollowAddInput(external())).toEqual({
      sourceType: "external_source",
      protocol: "rss",
      sourceUri: "https://example.com/feed.xml",
    });
  });
});
