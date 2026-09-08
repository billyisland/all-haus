import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// THE PROFILE'S REPLIES LOG STAMPS THE SAME ANSWER AS THE PROJECTOR
// (ARTICLE-HEADED-CONVERSATIONS-ADR D3/D5/D6, item 8. The route half of 16.)
//
// WHAT IT PINS, in the order the failures matter.
//
// 1. TWO SURFACES, ONE KEY. A comment card renders inside a conversation
//    envelope on the thread and outside any envelope on the Replies log, so the
//    fact has to travel PER POST — and both surfaces have to reach the same
//    answer for the same viewer and root, or a member's own log hands them
//    affordances the conversation has taken away. The two are computed by two
//    different implementations (`checkArticleAccess` one article at a time;
//    `checkArticleAccessSet` a page at a time), which is the standing hazard
//    here and the reason this test compares them rather than each alone.
//
// 2. AN ANONYMOUS READ ISSUES NO ACCESS QUERY AT ALL. Every paywalled root is
//    locked to a reader who is nobody, so the resolution short-circuits. This is
//    the only cheap guard against item 8 being rebuilt later as the obvious
//    loop: `checkArticleAccess` is 1-3 SEQUENTIAL round-trips and this route
//    pages at 50, so a call per row is ~150 sequential queries on a route a
//    stranger can reach. The discriminator is WHICH SQL RAN — a per-row loop
//    answers 200 with identical JSON.
//
// 3. A NOTE-ROOTED COMMENT SHIPS `rootLocked` ABSENT. A note has no paywall.
//    This is the shape that catches the resolution being folded into the main
//    comments read as an INNER join, which would silently delete every
//    note-rooted comment from a member's Replies log — half a log, quietly, with
//    no error. (The other half of that finding is DB-backed, in
//    root-locked-key.test.ts: only Postgres knows the two keys are different
//    strings.)
//
// 4. ABSENT IS NOT FALSE. A reader with access gets the field missing, not
//    `false`, on every node — the same tri-state the projector emits, so D6's
//    `=== true` never has to tell them apart.
//
// Mutation-proved: stamp every root regardless of access → the with-access case
// reddens; drop the `!viewerId` short-circuit in checkArticleAccessSet → the
// anonymous case reddens; resolve the roots on `root_post_id` instead of
// `target_event_id` → cases 1 and 3 flip to "nothing is locked", which is the
// silent, reassuring failure this whole item is about.
// =============================================================================

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const VIEWER = "00000000-0000-4000-8000-0000000000c3";
const ARTICLE = "00000000-0000-4000-8000-0000000000d4";

const PAYWALLED_EVENT = "3".repeat(64);
const NOTE_EVENT = "7".repeat(64);
const ARTICLE_COMMENT_POST_ID = "1".repeat(64);
const NOTE_COMMENT_POST_ID = "8".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
let sessionSub: string | null = null;
let unlocked = false;

function ran(fragment: string): boolean {
  return calls.some((c) => c.sql.includes(fragment));
}

function commentRow(derived: string, targetEventId: string, content: string) {
  return {
    id: `00000000-0000-4000-8000-0000000${derived.slice(0, 5)}`,
    derived_post_id: derived,
    nostr_event_id: `evt-${derived.slice(0, 8)}`,
    parent_comment_id: null,
    parent_post_id: null,
    // What the route computes as the grouping key. Deliberately NOT the
    // article's post_id — that is the whole point of the key finding.
    root_post_id: `derived-${targetEventId.slice(0, 8)}`,
    target_event_id: targetEventId,
    content,
    published_at_epoch: 1700000100,
    published_at_secs: 1700000100.123456,
    deleted_at: null,
    author_id: AUTHOR,
    acc_display_name: "Ash Mowbray",
    acc_username: "ashmowbray",
    nostr_pubkey: "f".repeat(64),
    pip_status: "known",
    vt_up: 0,
    vt_down: 0,
  };
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM accounts WHERE id = $1")) {
    return Promise.resolve({ rows: [{ exists: true }], rowCount: 1 });
  }
  // The Replies log itself — two comments, one on a paywalled article and one
  // on a note, which is the mix a real log carries.
  if (sql.includes("FROM comments c") && sql.includes("ORDER BY c.published_at DESC")) {
    return Promise.resolve({
      rows: [
        commentRow(ARTICLE_COMMENT_POST_ID, PAYWALLED_EVENT, "Worth the money."),
        commentRow(NOTE_COMMENT_POST_ID, NOTE_EVENT, "Replying to a note."),
      ],
      rowCount: 2,
    });
  }
  // The roots read. It is keyed on nostr_event_id — the note's target simply
  // is not an article and returns no row.
  if (sql.includes("FROM articles") && sql.includes("access_mode = 'paywalled'")) {
    const ids = (params[0] as string[]) ?? [];
    return Promise.resolve({
      rows: ids.includes(PAYWALLED_EVENT)
        ? [
            {
              nostr_event_id: PAYWALLED_EVENT,
              id: ARTICLE,
              writer_id: WRITER,
              publication_id: null,
            },
          ]
        : [],
      rowCount: 0,
    });
  }
  if (sql.includes("FROM article_unlocks")) {
    return Promise.resolve({
      rows: unlocked ? [{ article_id: ARTICLE }] : [],
      rowCount: 0,
    });
  }
  if (sql.includes("FROM subscriptions")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    if (sessionSub) req.session = { sub: sessionSub };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    if (sessionSub) req.session = { sub: sessionSub };
  },
}));

const { authorRoutes } = await import("../src/routes/author.js");

async function build() {
  const app = Fastify();
  await app.register(authorRoutes);
  return app;
}

async function replies() {
  const app = await build();
  const res = await app.inject({ url: `/author/${AUTHOR}/replies` });
  const body = res.json();
  await app.close();
  return body.items as Array<{ id: string; rootLocked?: boolean }>;
}

beforeEach(() => {
  calls = [];
  sessionSub = VIEWER;
  unlocked = false;
});

describe("GET /author/:authorId/replies — rootLocked (item 8)", () => {
  it("a comment on a paywalled article the viewer cannot read is stamped", async () => {
    const items = await replies();
    const onArticle = items.find((p) => p.id === ARTICLE_COMMENT_POST_ID);
    expect(onArticle?.rootLocked).toBe(true);
  });

  it("a NOTE-rooted comment is present and carries no stamp", async () => {
    const items = await replies();
    // Present at all: this is the assertion that fails if the resolution is
    // ever folded into the comments read as an inner join on articles.
    const onNote = items.find((p) => p.id === NOTE_COMMENT_POST_ID);
    expect(onNote).toBeTruthy();
    expect(onNote?.rootLocked).toBeUndefined();
  });

  it("a viewer WITH access gets the field absent, not false", async () => {
    unlocked = true;
    const items = await replies();
    for (const p of items) expect(p.rootLocked).toBeUndefined();
  });

  it("an ANONYMOUS read issues no access query at all", async () => {
    sessionSub = null;
    const items = await replies();

    // Locked, and measured rather than defaulted: a reader who is nobody
    // genuinely has no access to a paywalled piece.
    expect(items.find((p) => p.id === ARTICLE_COMMENT_POST_ID)?.rootLocked).toBe(
      true,
    );
    // And nothing was asked of the access tables. A per-row loop would answer
    // identically and issue up to ~150 sequential queries.
    expect(ran("FROM article_unlocks")).toBe(false);
    expect(ran("FROM subscriptions")).toBe(false);
    expect(ran("FROM publication_members")).toBe(false);
  });

  it("the roots are resolved once for the whole page, on target_event_id", async () => {
    await replies();
    const rootReads = calls.filter(
      (c) => c.sql.includes("FROM articles") && c.sql.includes("access_mode = 'paywalled'"),
    );
    // ONE read for the page, whatever its length — never one per comment.
    expect(rootReads).toHaveLength(1);
    // And keyed on the event ids, which is the key that joins. Resolved through
    // the log's own `root_post_id` this array would carry the derived strings
    // and match nothing, and every comment would ship unstamped.
    expect(rootReads[0].params[0]).toEqual([PAYWALLED_EVENT, NOTE_EVENT]);
  });
});
