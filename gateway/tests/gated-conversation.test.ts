import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// THE CONVERSATION IS PUBLIC; THE ARTICLE IS NOT
// (ARTICLE-HEADED-CONVERSATIONS-ADR D3/D4/D5, ship 2. Items 14 and 15.)
//
// WHAT THIS PINS, and why each half is here.
//
// 14. A locked viewer gets the COMMENTS — the policy itself. Before this the
//     projector returned the root alone, so the assertion that would have
//     caught a regression is simply "there is more than one post in here".
//     And the piece stays behind its wall: the head card's body is
//     `content_free` by construction (post-mapper's native-article branch), so
//     D4 adds no redaction step and this test is what says the construction is
//     still load-bearing. Widen that mapper line to the full body and this
//     reddens.
//
// 15. A reader WITH access gets NO `rootLocked` on any node. This is the
//     assertion that would have caught the ADR's first draft, which keyed the
//     affordance rule on `accessMode`: `accessMode` is derived from
//     `articles.access_mode` alone with no viewer term, so a PAYING reader's
//     article card says `gated` exactly as a stranger's does, and a rule keyed
//     on it strips reply/quote/vote from readers who have paid. Against
//     `accessMode` this test fails; against `rootLocked` it passes. That is the
//     whole reason the field exists.
//
//     It also pins the tri-state: an unlocked reader's nodes carry the field
//     ABSENT, not `false`. Absent means nobody asked this question about this
//     post, which is what every feed and log will keep emitting, and D6 reads
//     `=== true` so the two never have to be told apart at the call site.
//
// Mutation-proved:
//   - restore the early `return reply.send({ posts: [rootPost], … })` → the
//     comment-visibility test reddens and the free-portion one still passes,
//     which is the pair being distinguished.
//   - stamp `rootLocked` unconditionally (drop `rootLocked = !hasAccess`) → only
//     the with-access test reddens; that is the accessMode-keyed bug exactly.
//   - point `body.text` at a full-body column → only the free-portion test
//     reddens.
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const ARTICLE = "00000000-0000-4000-8000-0000000000c3";
const COMMENTER = "00000000-0000-4000-8000-0000000000d4";

const COMMENT_POST_ID = "1".repeat(64);
const ROOT_POST_ID = "2".repeat(64);
const ROOT_EVENT_ID = "3".repeat(64);
const COMMENT_EVENT_ID = "4".repeat(64);
const REPLY_POST_ID = "5".repeat(64);
const REPLY_EVENT_ID = "6".repeat(64);

const FREE_PORTION = "The opening, which is all that sits above the gate.";
const UNDER_THE_GATE = "THE PAYWALLED BODY, WHICH MUST NEVER LEAVE THE GATEWAY.";

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
    content_free: FREE_PORTION,
    // Deliberately present and deliberately never selected: the mapper reads
    // `content_free`, and if it ever stops doing so this row is what leaks.
    content: UNDER_THE_GATE,
    published_at_epoch: 1700000000,
    media: [],
  };
}

function comment(
  derived: string,
  eventId: string,
  parentPostId: string | null,
  content: string,
  ts: number,
) {
  return {
    id: `00000000-0000-4000-8000-00000000${eventId.slice(0, 4)}`,
    derived_post_id: derived,
    nostr_event_id: eventId,
    parent_comment_id: parentPostId ? "parent" : null,
    parent_post_id: parentPostId,
    content,
    published_at_epoch: ts,
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

function scriptedQuery(sql: string, params: unknown[] = []) {
  if (sql.includes("WHERE fi.post_id = $1")) {
    if (params[0] === ROOT_POST_ID) {
      return Promise.resolve({ rows: [articleRow()], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("SELECT target_event_id") && sql.includes("FROM comments")) {
    return Promise.resolve({
      rows: [{ target_event_id: ROOT_EVENT_ID }],
      rowCount: 1,
    });
  }
  if (sql.includes("SELECT post_id FROM feed_items")) {
    return Promise.resolve({ rows: [{ post_id: ROOT_POST_ID }], rowCount: 1 });
  }
  if (
    sql.includes("FROM comments c") &&
    sql.includes("ORDER BY c.published_at ASC")
  ) {
    return Promise.resolve({
      rows: [
        comment(COMMENT_POST_ID, COMMENT_EVENT_ID, null, "Worth the money.", 1700000100),
        comment(REPLY_POST_ID, REPLY_EVENT_ID, COMMENT_POST_ID, "Agreed, and the close especially.", 1700000200),
      ],
      rowCount: 2,
    });
  }
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

describe("GET /thread/:postId — a locked conversation (D3)", () => {
  it("returns the comments, not the root alone", async () => {
    const app = await build();
    const body = (await app.inject({ url: `/thread/${COMMENT_POST_ID}` })).json();

    const ids = body.posts.map((p: { id: string }) => p.id);
    expect(ids).toContain(ROOT_POST_ID);
    expect(ids).toContain(COMMENT_POST_ID);
    expect(ids).toContain(REPLY_POST_ID);

    // And the text is really there — a conversation with the bodies stripped
    // would satisfy the id assertion above and defeat the whole policy.
    const texts = body.posts.map((p: { body: { text: string } }) => p.body.text);
    expect(texts).toContain("Worth the money.");
    await app.close();
  });

  it("no node carries article content beyond the free portion (D4)", async () => {
    const app = await build();
    const body = (await app.inject({ url: `/thread/${COMMENT_POST_ID}` })).json();

    const root = body.posts.find((p: { id: string }) => p.id === ROOT_POST_ID);
    expect(root.body.text).toBe(FREE_PORTION);

    // Nothing anywhere in the response — any node, any field — carries it.
    expect(JSON.stringify(body)).not.toContain(UNDER_THE_GATE);
    await app.close();
  });

  it("every node is stamped rootLocked, the head article card included (D5/D6)", async () => {
    const app = await build();
    const body = (await app.inject({ url: `/thread/${COMMENT_POST_ID}` })).json();

    for (const p of body.posts) {
      expect(p.rootLocked).toBe(true);
    }
    // Named explicitly, because the head card is the one the first draft left
    // to be inferred: a reader who cannot read the piece does not vote on it.
    const root = body.posts.find((p: { id: string }) => p.id === ROOT_POST_ID);
    expect(root.rootLocked).toBe(true);
    await app.close();
  });

  it("a reader WITH access gets no rootLocked on any node — absent, not false", async () => {
    accessAnswer = { hasAccess: true };
    const app = await build();
    const body = (await app.inject({ url: `/thread/${COMMENT_POST_ID}` })).json();

    expect(body.posts.length).toBeGreaterThan(1);
    for (const p of body.posts) {
      expect(p.rootLocked).toBeUndefined();
    }
    // The root's accessMode is STILL "gated" for this paying reader — that is
    // the field's meaning and it has no viewer term. This line is the reason
    // `rootLocked` is a separate field: key D6 on `accessMode` and every one of
    // these nodes loses reply, quote and vote from a reader who has paid.
    const root = body.posts.find((p: { id: string }) => p.id === ROOT_POST_ID);
    expect(root.accessMode).toBe("gated");
    await app.close();
  });

  it("the retired thread-level paywallLocked flag is gone (D8)", async () => {
    const app = await build();
    const body = (await app.inject({ url: `/thread/${COMMENT_POST_ID}` })).json();
    expect(body.paywallLocked).toBeUndefined();
    await app.close();
  });
});
