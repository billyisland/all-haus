import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A PROJECTOR NEVER RETURNS A FOCAL IT DID NOT SEND
// (ARTICLE-HEADED-CONVERSATIONS-ADR D9, ship 1).
//
// WHY IT EXISTS. `GET /thread/:postId`'s gated branch answered with the
// REQUESTED postId — a comment's id — while `posts` held the article root
// alone. The client's `deriveThreadView` returns null the instant the focal is
// absent from the pool, and PostThread renders null as "Loading thread…", so
// every comment on a paywalled piece in the profile's Replies log opened onto a
// spinner with no end. Not an error and not a gate, which is why it was never
// reported.
//
// THE ASSERTION IS THE GENERAL RULE, NOT THE BRANCH. A thread response whose
// `focalId` is not among its `posts` is malformed whatever produced it, so the
// test reads the response shape. That is deliberate: it survives ship 2
// replacing this branch wholesale, and it fails for any future branch that
// invents the same shape somewhere else.
//
// Mutation-proved: restore `focalId: postId === rootPost.id ? rootPost.id :
// postId` and the deep-linked case goes red; drop the 404 guard itself and the
// absent-comment case goes red (added 2026-09-06 — until then every case in this
// file passed THROUGH that guard without ever taking its branch, so the three
// lines could have been deleted with the suite staying green).
//
// UPDATED FOR SHIP 2 (2026-09-05). D3 replaced the gated branch wholesale — the
// conversation now arrives and every node carries `rootLocked` — and the
// assertion above survived it untouched, which is the property it was written
// for. What changed here is the FIXTURE: the mock now scripts the conversation,
// because a locked viewer is no longer answered with the root alone; and the
// `paywallLocked` assertion is gone with the flag (D8).
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const ARTICLE = "00000000-0000-4000-8000-0000000000c3";

// The comment's derived post_id — what a Replies-log card links to.
const COMMENT_POST_ID = "1".repeat(64);
// The article's real feed_items.post_id, minted off its naddr coord.
const ROOT_POST_ID = "2".repeat(64);
const ROOT_EVENT_ID = "3".repeat(64);
const COMMENT_EVENT_ID = "4".repeat(64);
const COMMENTER = "00000000-0000-4000-8000-0000000000d4";
// A comment id that resolves to this conversation and is NOT in it — the state
// the guard exists for. NOT reachable by an ordinary soft delete: `comments` is
// read twice (once to find the root, once for the conversation) and NEITHER
// read filters `deleted_at` — a soft-deleted comment stays in the set and
// renders "[deleted]" (post-thread.ts, `loadConversationComments`). The state
// is reachable by a hard delete between the two reads, or by a crafted id whose
// derived post_id resolves to a root it does not belong to; the guard is what
// stands between either and a focal absent from its own posts. (An earlier
// version of this comment claimed the second read filtered `deleted_at`; it
// never did — CONSOLIDATED-TODO §0w item 6.)
const ORPHAN_POST_ID = "5".repeat(64);

function commentRow() {
  return {
    id: "00000000-0000-4000-8000-0000000000e5",
    derived_post_id: COMMENT_POST_ID,
    nostr_event_id: COMMENT_EVENT_ID,
    parent_comment_id: null,
    parent_post_id: null,
    content: "The middle section is the strongest thing they have written.",
    published_at_epoch: 1700000100,
    deleted_at: null,
    author_id: COMMENTER,
    acc_display_name: "Ash Mowbray",
    acc_username: "ashmowbray",
    nostr_pubkey: "f".repeat(64),
    pip_status: "known",
    vt_up: 2,
    vt_down: 0,
  };
}

let accessAnswer = { hasAccess: false };

function articleRow() {
  return {
    post_id: ROOT_POST_ID,
    item_type: "article",
    access_mode: "paywalled",
    source_protocol: "nostr",
    nostr_event_id: ROOT_EVENT_ID,
    article_id: ARTICLE,
    author_id: WRITER,
    acc_display_name: "Wren Fallow",
    acc_username: "wrenfallow",
    title: "A piece behind a wall",
    a_summary: "The standfirst.",
    content_free: "The free portion, and nothing under the gate.",
    published_at_epoch: 1700000000,
    media: [],
  };
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  // Focal resolution: the comment is NOT a feed_items THING, so this misses.
  // The comment's conversation root, read through its own feed_items card
  // (CA-G5). Matched first: its SQL also carries `WHERE fi.post_id = $1`.
  if (sql.includes("SELECT c.target_event_id") && sql.includes("fi.comment_id")) {
    return Promise.resolve({
      rows: [{ target_event_id: ROOT_EVENT_ID }],
      rowCount: 1,
    });
  }
  if (sql.includes("WHERE fi.post_id = $1")) {
    if (params[0] === ROOT_POST_ID) {
      return Promise.resolve({ rows: [articleRow()], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  // …so the route falls through to the comment's conversation root. Both
  // COMMENT_POST_ID and ORPHAN_POST_ID answer here, and that is the fixture's
  // point rather than the mock being lazy: both ARE comments on this root at the
  // moment of this read. They part company at the SECOND read below, which is
  // where the deletion has taken effect.
  if (sql.includes("SELECT post_id FROM feed_items")) {
    return Promise.resolve({ rows: [{ post_id: ROOT_POST_ID }], rowCount: 1 });
  }
  // The conversation itself. Under D3 a locked viewer gets this too.
  if (sql.includes("FROM comments c") && sql.includes("ORDER BY c.published_at ASC")) {
    return Promise.resolve({ rows: [commentRow()], rowCount: 1 });
  }
  // The gated branch's own re-fetch of the article ids for the access check.
  if (sql.includes("JOIN articles a ON a.id = fi.article_id")) {
    return Promise.resolve({
      rows: [{ id: ARTICLE, writer_id: WRITER, publication_id: null }],
      rowCount: 1,
    });
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
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
}));

vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async () => ({ ...accessAnswer }),
}));

const { postThreadRoutes } = await import("../src/routes/post-thread.js");

async function build() {
  const app = Fastify();
  await app.register(postThreadRoutes);
  return app;
}

beforeEach(() => {
  accessAnswer = { hasAccess: false };
});

describe("GET /thread/:postId — the focal is always in the pool (D9)", () => {
  it("a comment deep-link on a gated article returns a focal it actually sent", async () => {
    const app = await build();
    const res = await app.inject({ url: `/thread/${COMMENT_POST_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The general rule. This is the assertion; everything below is context.
    expect(body.posts.map((p: { id: string }) => p.id)).toContain(body.focalId);

    // And what it resolves TO is the comment that was asked for — which under
    // D3 is in the pool, because the conversation came with it. Before ship 1
    // this id was returned with `posts` holding the root alone; before ship 2 it
    // resolved to the root instead. Either way the rule above is the invariant.
    expect(body.focalId).toBe(COMMENT_POST_ID);
    await app.close();
  });

  it("the same invariant on the root's own url", async () => {
    const app = await build();
    const res = await app.inject({ url: `/thread/${ROOT_POST_ID}` });
    const body = res.json();
    expect(body.posts.map((p: { id: string }) => p.id)).toContain(body.focalId);
    await app.close();
  });

  it("404s a comment deep-link whose comment is NOT in the conversation", async () => {
    // THE CASE THE GUARD IS FOR, and the only one in this file where it fires.
    // Every other case here passes THROUGH the guard without exercising it: the
    // focal is in the pool, so the branch is never taken and the three lines
    // could be deleted with the suite staying green.
    //
    // What must not happen is a 200. `deriveThreadView` returns null the instant
    // the focal is absent from `posts`, and PostThread renders null as
    // "Loading thread…" — so serving a well-formed-looking body here is a
    // spinner with no end, which is precisely the failure D9 was written after.
    // 404 is the honest answer: a malformed thread is not a thread.
    const app = await build();
    const res = await app.inject({ url: `/thread/${ORPHAN_POST_ID}` });
    expect(res.statusCode).toBe(404);
    // And it is a refusal, not a thread that happens to be short.
    expect(res.json().posts).toBeUndefined();
    await app.close();
  });

  // The locked head card is safe to render by construction: a native article
  // Post's body is `content_free`, so the paywalled body was never in a thread
  // response and D4 adds no redaction step. Pinned here because that is the
  // fact the whole surface rests on.
  it("the head card carries the free portion only", async () => {
    const app = await build();
    const res = await app.inject({ url: `/thread/${COMMENT_POST_ID}` });
    const root = res.json().posts.find((p: { id: string }) => p.id === ROOT_POST_ID);
    expect(root.body.text).toBe(
      "The free portion, and nothing under the gate.",
    );
    await app.close();
  });
});
