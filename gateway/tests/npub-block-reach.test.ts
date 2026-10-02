import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// An npub block holds "however they reach us" (§0z item 15; migration 224)
//
// The predicate lived in the feed ARM alone: a blocked identity's reply still
// rendered in `GET /thread/:postId`, its profile and timeline still served on
// `/author/<id>`, its hover card still resolved, and thread hydration kept
// writing its rows. Four reaches, four places the question is now asked.
//
// TWO KINDS OF PIN, and the file says which is which. The hydration funnel is
// driven for real against a scripted client (the blocked node is not written;
// a mock that answered "blocked" to a SELECT that never named the key would
// pin the fixture, so it answers from the params). The three SQL reads are
// STRUCTURAL pins — the predicate is `EXISTS (…platform_blocks…)`, which only
// Postgres can evaluate — asserted against the source with the match FOUND,
// so a renamed helper cannot make this pass by testing nothing. The DB-backed
// evaluation of the predicate itself is
// `feed-ingest/src/tasks/platform-block-ingest-integration.test.ts`.
// =============================================================================

const BLOCKED = "b".repeat(64);
const CLEAN = "c".repeat(64);
let blockedKeys = new Set<string>([BLOCKED]);
let inserted: string[] = [];

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT target_key FROM platform_blocks WHERE kind = 'npub' AND target_key = ANY\(\$1::text\[\]\)/.test(sql)) {
      const asked = params[0] as string[];
      return { rows: asked.filter((k) => blockedKeys.has(k)).map((target_key) => ({ target_key })), rowCount: 0 };
    }
    if (/INSERT INTO external_items/.test(sql)) {
      // WHICH NODE was written, by its own identity ($4). This used to record
      // `author_uri` ($8), which for a nostr node is an njump permalink and
      // for the author with no key is NULL — so the assertion read as though
      // it were about identities when it was about a column the block does not
      // key on (§0ab item 2).
      inserted.push(params[3] as string); // source_item_uri is $4
      return { rows: [{ id: `ei-${inserted.length}` }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: async (cb: (c: typeof client) => Promise<unknown>) => cb(client),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { persistHydratedThreadNodes } = await import("../src/lib/external-hydration.js");

function node(
  authorUri: string | null,
  uri: string,
  interactionData: Record<string, unknown> = {},
) {
  return {
    sourceItemUri: uri,
    sourceReplyUri: null,
    sourceQuoteUri: null,
    authorName: "x",
    authorHandle: null,
    authorAvatarUrl: null,
    authorUri,
    contentText: "hi",
    contentHtml: null,
    media: [],
    interactionData,
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    publishedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

/**
 * A nostr node in the SHAPE THE MAPPER ACTUALLY PRODUCES (§0ab item 2).
 *
 * `nostr-thread.ts::toHydratedNode` sets `authorUri` to an njump PERMALINK and
 * puts the pubkey in `interactionData` — `{ id, pubkey, relays }` — because a
 * nostr identity has no per-author URL. The first version of this file fed
 * 64-hex straight into `authorUri`, a shape nothing in production produces, so
 * it agreed with a guard that compared a URL column against a hex block key and
 * matched nothing. A fixture that cannot arise cannot witness anything: the
 * njump uri is set here deliberately, so a guard that drifts back to
 * `author_uri` finds a non-null value there and still matches no block.
 */
function nostrNode(pubkey: string | null, uri: string) {
  const npub = pubkey ? `npub1${pubkey.slice(0, 16)}` : "npub1anon";
  return node(`https://njump.me/${npub}`, uri, {
    id: uri.replace(/^nostr:/, ""),
    ...(pubkey ? { pubkey } : {}),
    relays: [],
  });
}

beforeEach(() => {
  inserted = [];
  blockedKeys = new Set([BLOCKED]);
  client.query.mockClear();
});

describe("thread hydration refuses a blocked npub before the write", () => {
  it("writes the clean node and not the blocked one — asked ONCE, before any INSERT", async () => {
    await persistHydratedThreadNodes(
      "src-1",
      "nostr_external",
      [nostrNode(BLOCKED, "nostr:evt-1"), nostrNode(CLEAN, "nostr:evt-2"), nostrNode(null, "nostr:evt-3")],
      { client },
    );
    // Pre-fix: all three written, and the identity trigger minted the
    // blocked author's row as a side effect.
    expect(inserted).toEqual(["nostr:evt-2", "nostr:evt-3"]);
    // And the question was asked about the PUBKEY, not the permalink: the
    // block table holds 64 hex and nothing else ever matches it.
    const askedWith = client.query.mock.calls.find((c) =>
      /FROM platform_blocks/.test(c[0] as string),
    )![1] as [string[]];
    expect(askedWith[0]).toEqual([BLOCKED, CLEAN]);
    const askedAt = client.query.mock.calls.findIndex((c) => /FROM platform_blocks/.test(c[0] as string));
    const firstInsert = client.query.mock.calls.findIndex((c) => /INSERT INTO external_items/.test(c[0] as string));
    expect(askedAt).toBeGreaterThanOrEqual(0);
    expect(askedAt).toBeLessThan(firstInsert);
  });

  it("does not ask for a non-nostr batch — an npub block is a nostr identity", async () => {
    await persistHydratedThreadNodes("src-1", "atproto", [node("did:plc:abc", "at://x/1")], { client });
    expect(inserted).toEqual(["at://x/1"]);
    expect(client.query.mock.calls.some((c) => /FROM platform_blocks/.test(c[0] as string))).toBe(false);
  });
});

describe("the three reads carry the predicate (structural pins)", () => {
  const src = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

  it("every feed_items read in the thread projector", () => {
    const s = src("../src/routes/post-thread.ts");
    const reads = s.match(/FROM feed_items fi\n/g) ?? [];
    expect(reads.length, "the projector's feed_items reads").toBeGreaterThanOrEqual(4);
    const guarded = s.match(/AND NOT \$\{externalAuthorBlockedSql\("fi"\)\}/g) ?? [];
    expect(guarded.length).toBe(reads.length);
  });

  it("the one author loader every author route goes through", () => {
    const s = src("../src/routes/author.ts");
    const loader = s.match(/export async function loadExternalAuthor[\s\S]*?return rows\[0\] \?\? null;/);
    expect(loader, "loadExternalAuthor not found").toBeTruthy();
    expect(loader![0]).toContain('AND NOT (protocol = \'nostr_external\' AND ${npubBlockedSql("stable_handle")})');
  });

  it("the hover card's item read — on the pubkey, never on author_uri", () => {
    // COMMENTS STRIPPED BEFORE THE NEGATIVE ASSERTIONS, because a detector that
    // reads PROSE is not reading the code: the very comment explaining why
    // `author_uri` was wrong contains the string a naive `not.toContain` is
    // looking for, and it would fail this test for describing the bug. (The
    // same shape as `nginx-reachability.test.ts` deriving `/actor` out of a
    // header — §0ab guard (a).) A one-line `--`/`//` strip is enough here: the
    // predicate is a single expression inside one template literal.
    const code = src("../src/routes/author-card.ts")
      .split("\n")
      .filter((l) => !/^\s*(--|\/\/)/.test(l))
      .join("\n");
    expect(code).toContain("AND ${npubBlockedSql(\"interaction_data->>'pubkey'\")}");
    // The predicate this replaced (§0ab item 2). `author_uri` is NULL on every
    // nostr row, so keying on it made the guard unreachable while reading as
    // though it were enforced — and an `author_uri IS NOT NULL` arm alongside
    // it made the dead branch look deliberate.
    expect(code).not.toContain('npubBlockedSql("author_uri")');
    expect(code).not.toContain("author_uri IS NOT NULL");
  });

  it("and the shared predicate joins on the author the item was attributed to", async () => {
    const { externalAuthorBlockedSql } = await import("@platform-pub/shared/lib/platform-blocks.js");
    const sql = externalAuthorBlockedSql("fi");
    expect(sql).toContain("bxa.id = fi.external_author_id");
    expect(sql).toContain("pb.kind = 'npub'");
    expect(sql).toContain("pb.target_key = bxa.stable_handle");
  });
});
