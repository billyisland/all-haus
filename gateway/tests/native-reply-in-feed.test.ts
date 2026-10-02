import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// A NATIVE REPLY IS A POST — migration 232.
//
// Replying to a note and replying to an article both produce a kind-1111
// `comments` row, and until migration 232 a comment had no `feed_items` row at
// all: it could not appear in a feed however its author's followers had
// composed one, while EXTERNAL replies had been arriving throughout, gated per
// source by `feed_sources.exclude_replies`. This suite is the claim that the
// two now behave alike.
//
// DB-BACKED, AND IT HAS TO BE. Three of the four things under test are
// Postgres's own and a mocked `pool.query` would answer them from its fixture:
// the `feed_items_post_identity` trigger's new `comment_id` branch (which must
// mint the SAME post_id the thread projector derives), the `exactly_one_source`
// CHECK, and `nostrTargetPostId` -> `article_post_id`, whose whole point is
// that an article's post_id comes off its naddr COORD and not off its event id.
//
// IT DRIVES THE ROUTE AND THE FEED, NOT A COPY OF EITHER. `POST /replies` is
// injected (so the dual-write under test is the one that ships) and the page is
// read through `loadFeedItemsPage` (so the query under test is the one the
// workspace runs). Neither can be exercised against uncommitted fixtures — the
// code under test uses the shared pool — so fixtures COMMIT and are cleaned up
// in a `finally`, keyed on the fixture accounts.
//
// MUTATION LOG. A passing new test proves nothing until it has been made to
// fail; each of these was applied to src/, the suite re-run, and reverted.
//
//   A. drop the feed_items dual-write from `POST /replies`
//      ⇒ all five fail: with no card there is no reply anywhere in
//        any of these feeds.                                        DETECTED
//   B. write the card with `is_reply` FALSE
//      ⇒ "the no-replies setting hides it" fails — the reply arrives
//        in a feed that asked for none.                             DETECTED
//   C. mint the card's post_id from the comment ROW id rather than its
//      event id (the trigger, in the database — applied with a
//      CREATE OR REPLACE and restored from schema.sql afterwards)
//      ⇒ "the thread projector still answers for the reply" fails:
//        two addresses for one reply, and the card's id names
//        neither a THING nor a comment the projector can find.      DETECTED
//   D. drop `AND fi.item_type <> 'comment'` from `loadFeedItemPost`
//      ⇒ "the thread projector still answers for the reply" fails —
//        the reply resolves as its own conversation's root and the
//        thread comes back with no ancestors.                       DETECTED
//   E. resolve the comment's root with a bare
//      `feed_items_derive_post_id('nostr', target_event_id)`
//      ⇒ "an article-rooted reply names the ARTICLE" fails, with a
//        plausible 64-hex id naming no row.                         DETECTED
//   F. skip the feed_items tombstone in `DELETE /replies/:replyId`
//      ⇒ "a deleted reply leaves the feed" fails.                   DETECTED
//
// THE CONTROLS ARE THE POINT OF HALF THE CASES. A blanket exclusion of comment
// rows passes every reply-shaped assertion in a suite made only of replies, so
// the no-replies case asserts the replier's own TOP-LEVEL note is still there,
// and the delete case asserts the sibling reply survives.
//
// Skipped without a DB URL — CI supplies one and FAILS on a skip. Locally, BOTH
// vars (the fixtures use their own client; the code under test uses the shared
// pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/native-reply-in-feed.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// `POST /replies` imports the article-access service for its paywall guard, and
// that module reads its service URLs at load time. Nothing here reaches them —
// every fixture root is free — but the import has to succeed.
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.READER_HASH_KEY ??= "a".repeat(64);
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.INTERNAL_SECRET ??= "b".repeat(64);

// Who the routes think is calling. Mutable, so one injected sequence can carry
// a replier and, later, the reply's own author asking to delete it.
let caller = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: caller };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: caller };
  },
}));

// A reply's delete signs a kind-5 as the reply's author and enqueues it
// (CA-B1); neither the signer nor the outbox is what this suite is about.
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: async (signerId: string, template: Record<string, unknown>) => ({
    ...template,
    id: randHex(32),
    pubkey: signerId,
    sig: "s".repeat(128),
  }),
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueRelayPublish: async () => ({ id: "outbox-stub" }),
}));

const { replyRoutes } = await import("../src/routes/replies.js");
const { postThreadRoutes } = await import("../src/routes/post-thread.js");
const { loadFeedItemsPage } = await import("../src/routes/feeds/items.js");
const { pool } = await import("@platform-pub/shared/db/client.js");

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

describe.skipIf(!DB_URL)("a native reply in a feed", () => {
  let client: pg.Client;
  let app: ReturnType<typeof Fastify>;
  // Every account minted by a test, dropped in afterEach. `comments.author_id`
  // is ON DELETE RESTRICT, so the comments go first; everything else cascades.
  let accounts: string[];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(replyRoutes);
    await app.register(postThreadRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await client.end();
    await pool.end();
  });
  beforeEach(() => {
    accounts = [];
  });
  afterEach(async () => {
    if (accounts.length === 0) return;
    // Innermost first: `comments`, `notes` and `articles` all RESTRICT on the
    // account, and every feed_items row goes with its backing row by cascade
    // (comment_id, note_id, article_id) rather than by author.
    await client.query(
      `DELETE FROM comments WHERE author_id = ANY($1::uuid[])
          OR target_event_id IN (
               SELECT nostr_event_id FROM notes WHERE author_id = ANY($1::uuid[])
             UNION ALL
               SELECT nostr_event_id FROM articles WHERE writer_id = ANY($1::uuid[]))`,
      [accounts],
    );
    await client.query(`DELETE FROM notes WHERE author_id = ANY($1::uuid[])`, [
      accounts,
    ]);
    await client.query(
      `DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`,
      [accounts],
    );
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
      accounts,
    ]);
  });

  // --- fixtures -------------------------------------------------------------

  async function account(prefix: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, display_name, nostr_pubkey)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${prefix}-${randHex(6)}`, prefix, randHex()],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }

  /** A top-level note + its feed card. Returns its event id and post_id. */
  async function note(
    authorId: string,
  ): Promise<{ eventId: string; postId: string }> {
    const eventId = randHex();
    const { rows: n } = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, char_count)
       VALUES ($1, $2, 'root note', 9) RETURNING id`,
      [authorId, eventId],
    );
    const { rows } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items
         (item_type, note_id, author_id, content_preview, nostr_event_id,
          published_at, is_reply)
       VALUES ('note', $1, $2, 'root note', $3, now() - interval '10 minutes', FALSE)
       RETURNING post_id`,
      [n[0].id, authorId, eventId],
    );
    return { eventId, postId: rows[0].post_id };
  }

  /** A published article + its feed card. */
  async function article(
    writerId: string,
  ): Promise<{ eventId: string; postId: string }> {
    const eventId = randHex();
    const dTag = `piece-${randHex(6)}`;
    const { rows: a } = await client.query<{ id: string }>(
      `INSERT INTO articles
         (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free,
          published_at)
       VALUES ($1, $2, $3, 'A piece', $3, 'free body', now() - interval '20 minutes')
       RETURNING id`,
      [writerId, eventId, dTag],
    );
    const { rows } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items
         (item_type, article_id, author_id, title, content_preview,
          nostr_event_id, published_at, is_reply)
       VALUES ('article', $1, $2, 'A piece', 'free body', $3,
               now() - interval '20 minutes', FALSE)
       RETURNING post_id`,
      [a[0].id, writerId, eventId],
    );
    return { eventId, postId: rows[0].post_id };
  }

  /** A feed owned by `owner` following `followed`, with its reply setting. */
  async function feedFollowing(
    owner: string,
    followed: string,
    excludeReplies = false,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'replies', 1)
       RETURNING id`,
      [owner],
    );
    await client.query(
      `INSERT INTO feed_sources
         (feed_id, source_type, account_id, throughput, sampling_mode,
          exclude_replies)
       VALUES ($1, 'account', $2, 1.0, 'scored', $3)`,
      [rows[0].id, followed, excludeReplies],
    );
    return rows[0].id;
  }

  /** Publish a reply through the real route. Returns its comment id. */
  async function reply(
    authorId: string,
    target: { eventId: string; kind: number },
    parentCommentId?: string,
  ): Promise<{ commentId: string; eventId: string }> {
    caller = authorId;
    const eventId = randHex();
    const res = await app.inject({
      method: "POST",
      url: "/replies",
      payload: {
        nostrEventId: eventId,
        targetEventId: target.eventId,
        targetKind: target.kind,
        parentCommentId: parentCommentId ?? null,
        content: "a remark",
      },
    });
    expect(res.statusCode).toBe(201);
    return { commentId: res.json().commentId as string, eventId };
  }

  /** One page of the feed, as the workspace reads it. */
  async function page(reader: string, feedId: string) {
    const { items } = await loadFeedItemsPage(reader, feedId, 1, undefined, 50);
    return items;
  }

  // --- the claim ------------------------------------------------------------

  it("a reply to a note reaches a follower's feed, addressed to the conversation", async () => {
    const rootWriter = await account("root");
    const replier = await account("replier");
    const reader = await account("reader");
    const root = await note(rootWriter);
    const { commentId, eventId } = await reply(replier, {
      eventId: root.eventId,
      kind: 1,
    });
    const feedId = await feedFollowing(reader, replier);

    const items = await page(reader, feedId);
    const card = items.find((p) => p.origin.uri === eventId);
    expect(card).toBeDefined();
    // A remark, not a THING: `conversation` is the discriminator, and it is
    // what `replyTargetFromPost` needs to address a reply to this reply.
    expect(card!.conversation).toEqual({
      rootEventId: root.eventId,
      rootKind: 1,
      commentId,
    });
    // Top-level in its conversation, so its parent is the root THING.
    expect(card!.inReplyTo).toBe(root.postId);
    expect(card!.body.text).toBe("a remark");
    expect(card!.author.accountId).toBe(replier);
  });

  it("a reply to an ARTICLE names the article, not a derived stand-in", async () => {
    const writer = await account("writer");
    const replier = await account("replier");
    const reader = await account("reader");
    const piece = await article(writer);
    await reply(replier, { eventId: piece.eventId, kind: 30023 });
    const feedId = await feedFollowing(reader, replier);

    const [card] = await page(reader, feedId);
    expect(card.conversation?.rootKind).toBe(30023);
    // An article's post_id is minted from its naddr COORD, so a root resolved
    // by hashing the event id is a plausible 64-hex string naming no row.
    expect(card.inReplyTo).toBe(piece.postId);
  });

  it("the 'no replies' setting hides it — and nothing else", async () => {
    const rootWriter = await account("root");
    const replier = await account("replier");
    const reader = await account("reader");
    const root = await note(rootWriter);
    const { eventId: replyEvent } = await reply(replier, {
      eventId: root.eventId,
      kind: 1,
    });
    // THE CONTROL. A blanket exclusion of comment rows passes this case too
    // unless something the source DOES want is asserted present.
    const own = await note(replier);

    const off = await feedFollowing(reader, replier, true);
    const shown = (await page(reader, off)).map((p) => p.origin.uri);
    expect(shown).not.toContain(replyEvent);
    expect(shown).toContain(own.eventId);

    const on = await feedFollowing(reader, replier, false);
    expect((await page(reader, on)).map((p) => p.origin.uri)).toContain(
      replyEvent,
    );
  });

  it("the thread projector still answers for the reply's own post_id", async () => {
    const rootWriter = await account("root");
    const replier = await account("replier");
    const reader = await account("reader");
    const root = await note(rootWriter);
    const { eventId } = await reply(replier, {
      eventId: root.eventId,
      kind: 1,
    });
    const feedId = await feedFollowing(reader, replier);
    const card = (await page(reader, feedId)).find(
      (p) => p.origin.uri === eventId,
    )!;

    // The card's id is the address the projector has always derived for a
    // comment, and the projector must still treat it as a REMARK: the root
    // comes back as its ancestor, not as the reply itself.
    caller = reader;
    const res = await app.inject({ method: "GET", url: `/thread/${card.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { focalId: string; posts: { id: string }[] };
    expect(body.focalId).toBe(card.id);
    expect(body.posts.map((p) => p.id)).toContain(root.postId);
  });

  it("a deleted reply leaves the feed, and its sibling does not", async () => {
    const rootWriter = await account("root");
    const replier = await account("replier");
    const reader = await account("reader");
    const root = await note(rootWriter);
    const doomed = await reply(replier, { eventId: root.eventId, kind: 1 });
    const kept = await reply(replier, { eventId: root.eventId, kind: 1 });
    const feedId = await feedFollowing(reader, replier);

    caller = replier;
    const res = await app.inject({
      method: "DELETE",
      url: `/replies/${doomed.commentId}`,
    });
    expect(res.statusCode).toBe(200);

    const shown = (await page(reader, feedId)).map((p) => p.origin.uri);
    expect(shown).not.toContain(doomed.eventId);
    expect(shown).toContain(kept.eventId);
  });
});
