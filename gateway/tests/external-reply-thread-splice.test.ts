import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// A NATIVE REPLY TO AN EXTERNAL POST IS PART OF THAT POST'S THREAD
// (CROSS-NETWORK-ROUNDTRIP-ADR F1 → A1 + A2).
//
// The operator's report 1: a member replied to a Bluesky post from all.haus;
// the reply showed in their feeds, and opening it did not bring in the post it
// answered. `notes.external_parent_id` was written and no projection read it.
// Two halves of one edge, both driven through the REAL `GET /thread/:postId`:
//
//   · from the NOTE, the external parent is its ancestor and the note is the
//     focal (the walk anchors — and hydrates — on the parent);
//   · from the PARENT, the note is a descendant, with its own `comments`
//     conversation spliced in beside it, or those replies vanish the moment
//     the thread is opened from the external side.
//
// DB-backed because the parent edge is `externalParentPostId`, SQL only
// Postgres evaluates — and it must READ the parent's stored post_id, so the
// fixture gives the parent's card an explicit post_id that its derivation
// would NOT produce. A mapper that derived instead would name no row.
//
// Hydration is mocked to a settled no-op (nothing here may reach Bluesky); the
// spy is how the note-focal case proves it hydrates the PARENT.
//
// MUTATION LOG — each applied to src/, the suite re-run, reverted:
//   A. drop the `n.external_parent_id` arm from POST_SELECT      → the
//      note's `inReplyTo` is null; "from the note" and "from the parent"
//      fail.                                                      DETECTED
//   B. derive in `externalParentPostId` instead of reading the stored
//      post_id                                                   → the
//      edge names no row; both fail.                              DETECTED
//   C. drop the `loadSplicedNotes` call from the external walk    → "from
//      the parent" fails (the member's reply is missing).         DETECTED
//   D. skip the spliced notes' comments                           → "from
//      the parent" fails on the comment.                          DETECTED
//   E. route a note focal down the native branch (noteFocal = null)
//      → "from the note" fails: no ancestor.                      DETECTED
//   F. drop the hidden-author filter on spliced notes             → "a
//      muted author's reply" fails.                               DETECTED
//
// Fixtures COMMIT (the route reads through the shared pool) and are removed in
// afterEach, keyed on what they created. Skipped without a DB URL — CI supplies
// one and fails on a skip. Locally set BOTH DATABASE_URL and TEST_DATABASE_URL.
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.READER_HASH_KEY ??= "a".repeat(64);
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.INTERNAL_SECRET ??= "b".repeat(64);

let caller: string | null = null;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    if (caller) req.session = { sub: caller };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    if (caller) req.session = { sub: caller };
  },
}));

const hydrateSpy = vi.fn(async () => undefined);
vi.mock("../src/lib/external-hydration.js", () => ({
  hydrateExternalThreadContext: hydrateSpy,
  willHydrateThread: () => true,
  getInFlightHydration: () => undefined,
  awaitHydrationWithinBudget: async () => true,
  THREAD_HYDRATE_SYNC_BUDGET_MS: 0,
}));

const { postThreadRoutes } = await import("../src/routes/post-thread.js");
const { pool } = await import("@platform-pub/shared/db/client.js");

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

describe.skipIf(!DB_URL)("a native reply to an external post, in its thread", () => {
  let client: pg.Client;
  let app: ReturnType<typeof Fastify>;
  const accounts: string[] = [];
  const sources: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(postThreadRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await client.end();
    await pool.end();
  });
  afterEach(async () => {
    caller = null;
    hydrateSpy.mockClear();
    await client.query(
      `DELETE FROM comments WHERE author_id = ANY($1::uuid[])
          OR target_event_id IN (SELECT nostr_event_id FROM notes WHERE author_id = ANY($1::uuid[]))`,
      [accounts],
    );
    await client.query(`DELETE FROM notes WHERE author_id = ANY($1::uuid[])`, [accounts]);
    await client.query(`DELETE FROM mutes WHERE muter_id = ANY($1::uuid[])`, [accounts]);
    await client.query(
      `DELETE FROM feed_items WHERE external_item_id IN
         (SELECT id FROM external_items WHERE source_id = ANY($1::uuid[]))`,
      [sources],
    );
    await client.query(`DELETE FROM external_items WHERE source_id = ANY($1::uuid[])`, [sources]);
    await client.query(`DELETE FROM external_sources WHERE id = ANY($1::uuid[])`, [sources]);
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    accounts.length = 0;
    sources.length = 0;
  });

  async function account(prefix: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, display_name, nostr_pubkey)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${prefix}-${randHex(6)}`, prefix, randHex()],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }

  /** A Bluesky post + its card. `explicitPostId` stands in for a card whose
   *  stored post_id is not what a derivation would produce. */
  async function blueskyPost(opts: {
    sourceId: string;
    rkey: string;
    replyTo?: string;
    minutesAgo: number;
    explicitPostId?: string;
  }): Promise<{ itemId: string; uri: string; postId: string }> {
    const uri = `at://did:plc:bob/app.bsky.feed.post/${opts.rkey}`;
    const { rows: ei } = await client.query<{ id: string }>(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, source_reply_uri,
         author_name, author_handle, author_uri, content_text, published_at,
         interaction_data
       ) VALUES ($1, 'atproto', 'tier3', $2, $3, 'Bob', 'bob.bsky.social',
                 'did:plc:bob', 'body', now() - make_interval(mins => $4),
                 jsonb_build_object('uri', $2::text, 'cid', 'c'))
       RETURNING id`,
      [opts.sourceId, uri, opts.replyTo ?? null, opts.minutesAgo],
    );
    const cols = opts.explicitPostId ? ", post_id" : "";
    const vals = opts.explicitPostId ? ", $6" : "";
    const params: unknown[] = [ei[0].id, uri, opts.sourceId, opts.minutesAgo, !!opts.replyTo];
    if (opts.explicitPostId) params.push(opts.explicitPostId);
    const { rows: fi } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply${cols}
       ) VALUES ('external', $1, 'Bob', 'body', now() - make_interval(mins => $4),
                 'atproto', $2, $3, '[]'::jsonb, $5${vals})
       RETURNING post_id`,
      params,
    );
    return { itemId: ei[0].id, uri, postId: fi[0].post_id };
  }

  /** What POST /external-items/:id/reply writes: a note carrying its parent. */
  async function nativeReply(
    authorId: string,
    parentItemId: string,
    minutesAgo: number,
  ): Promise<{ eventId: string; postId: string }> {
    const eventId = randHex();
    const { rows: n } = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, char_count, published_at, external_parent_id)
       VALUES ($1, $2, 'my reply', 8, now() - make_interval(mins => $3), $4) RETURNING id`,
      [authorId, eventId, minutesAgo, parentItemId],
    );
    const { rows } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items
         (item_type, note_id, author_id, content_preview, nostr_event_id, published_at, is_reply)
       VALUES ('note', $1, $2, 'my reply', $3, now() - make_interval(mins => $4), TRUE)
       RETURNING post_id`,
      [n[0].id, authorId, eventId, minutesAgo],
    );
    return { eventId, postId: rows[0].post_id };
  }

  /** A remark under a note, as POST /replies writes it — BOTH halves: the
   *  comment and its `item_type = 'comment'` card, written in one transaction
   *  by the route (migration 232). The thread projector resolves a comment
   *  focal's root through that card (CA-G5), so a bare comments row is a state
   *  the app cannot produce. The card's post_id is minted by the trigger from
   *  the event id; the derivation beside it pins that they agree. */
  async function commentOn(
    authorId: string,
    noteEventId: string,
    minutesAgo: number,
  ): Promise<string> {
    const eventId = randHex();
    const c = await client.query<{ id: string }>(
      `INSERT INTO comments (author_id, nostr_event_id, target_event_id, target_kind, content, published_at)
       VALUES ($1, $2, $3, 1, 'a remark', now() - make_interval(mins => $4))
       RETURNING id`,
      [authorId, eventId, noteEventId, minutesAgo],
    );
    const card = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, comment_id, author_id, nostr_event_id, published_at, is_reply)
       VALUES ('comment', $1, $2, $3, now() - make_interval(mins => $4), TRUE)
       RETURNING post_id`,
      [c.rows[0].id, authorId, eventId, minutesAgo],
    );
    const { rows } = await client.query<{ p: string }>(
      `SELECT feed_items_derive_post_id('nostr', $1) AS p`,
      [eventId],
    );
    expect(card.rows[0].post_id).toBe(rows[0].p);
    return rows[0].p;
  }

  async function scene() {
    const member = await account("member");
    const other = await account("other");
    const { rows: src } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
       VALUES ('atproto', $1, 'Bob', TRUE) RETURNING id`,
      [`did:plc:bob-${randHex(4)}`],
    );
    sources.push(src[0].id);
    const parentPostId = randHex();
    const parent = await blueskyPost({
      sourceId: src[0].id,
      rkey: randHex(6),
      minutesAgo: 60,
      explicitPostId: parentPostId,
    });
    const extReply = await blueskyPost({
      sourceId: src[0].id,
      rkey: randHex(6),
      replyTo: parent.uri,
      minutesAgo: 40,
    });
    const note = await nativeReply(member, parent.itemId, 30);
    const remark = await commentOn(other, note.eventId, 20);
    return { member, other, parent, parentPostId, extReply, note, remark };
  }

  async function thread(postId: string) {
    const res = await app.inject({ url: `/thread/${postId}` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      focalId: string;
      posts: { id: string; inReplyTo: string | null }[];
      totalDescendants: number;
    };
  }

  it("from the note: the external parent is its ancestor, and it is hydrated", async () => {
    const s = await scene();
    expect(s.parent.postId).toBe(s.parentPostId); // the explicit id stuck

    const t = await thread(s.note.postId);

    expect(t.focalId).toBe(s.note.postId);
    const ids = t.posts.map((p) => p.id);
    expect(ids.indexOf(s.parentPostId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(s.parentPostId)).toBeLessThan(ids.indexOf(s.note.postId));
    // A1: the edge is the parent's STORED post_id.
    expect(t.posts.find((p) => p.id === s.note.postId)!.inReplyTo).toBe(s.parentPostId);
    // The note's own conversation comes with it.
    expect(ids).toContain(s.remark);
    // Its descendants are the NOTE's, not the parent's other replies.
    expect(ids).not.toContain(s.extReply.postId);
    // The walk hydrated the post the note answers.
    expect(hydrateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: s.parent.itemId }),
    );
  });

  it("from the parent: the member's reply and its conversation are descendants", async () => {
    const s = await scene();

    const t = await thread(s.parentPostId);

    expect(t.focalId).toBe(s.parentPostId);
    const ids = t.posts.map((p) => p.id);
    expect(ids).toContain(s.extReply.postId); // control: the external reply
    expect(ids).toContain(s.note.postId);
    expect(ids).toContain(s.remark);
    expect(t.totalDescendants).toBe(3);
    expect(t.posts.find((p) => p.id === s.note.postId)!.inReplyTo).toBe(s.parentPostId);
    expect(t.posts.find((p) => p.id === s.remark)!.inReplyTo).toBe(s.note.postId);
  });

  it("from a remark under the note: the ancestors continue up into the external thread", async () => {
    const s = await scene();

    const t = await thread(s.remark);

    const ids = t.posts.map((p) => p.id);
    expect(t.focalId).toBe(s.remark);
    expect(ids.slice(0, 2)).toEqual([s.parentPostId, s.note.postId]);
  });

  it("a muted author's reply is not in the viewer's thread, but still opens directly", async () => {
    const s = await scene();
    const viewer = await account("viewer");
    await client.query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2)`, [
      viewer,
      s.member,
    ]);
    caller = viewer;

    const fromParent = await thread(s.parentPostId);
    expect(fromParent.posts.map((p) => p.id)).not.toContain(s.note.postId);
    expect(fromParent.posts.map((p) => p.id)).toContain(s.extReply.postId); // control

    const fromNote = await thread(s.note.postId);
    expect(fromNote.focalId).toBe(s.note.postId); // the focal is never dropped
  });

  // CA-G4: the descendant walk asks ONE query per generation, not one per node.
  // Three generations under the root (2, then 3, then 1 replies) reach the
  // page whole, and the reply read runs four times — once per level plus the
  // empty one that ends the walk. The per-node walk it replaced ran seven
  // (one per node, the root included), so reverting to it fails the count;
  // dropping a level's children fails the membership.
  it("the external walk reads each generation in one query and reaches all of them", async () => {
    const { rows: src } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
       VALUES ('atproto', $1, 'Bob', TRUE) RETURNING id`,
      [`did:plc:bob-${randHex(4)}`],
    );
    sources.push(src[0].id);
    const post = (replyTo: string | undefined, minutesAgo: number) =>
      blueskyPost({ sourceId: src[0].id, rkey: randHex(6), replyTo, minutesAgo });
    const root = await post(undefined, 90);
    const a = await post(root.uri, 80);
    const b = await post(root.uri, 79);
    const a1 = await post(a.uri, 70);
    const b1 = await post(b.uri, 69);
    const b2 = await post(b.uri, 68);
    const a1x = await post(a1.uri, 60);

    const spy = vi.spyOn(pool, "query");
    const res = await app.inject({ url: `/thread/${root.postId}?replyLimit=50` });
    const walkReads = spy.mock.calls.filter(([sql]) =>
      String(sql).includes("source_reply_uri = ANY"),
    ).length;
    spy.mockRestore();

    expect(res.statusCode).toBe(200);
    const t = res.json() as { posts: { id: string }[]; totalDescendants: number };
    const ids = new Set(t.posts.map((p) => p.id));
    for (const n of [a, b, a1, b1, b2, a1x]) expect(ids.has(n.postId)).toBe(true);
    expect(t.totalDescendants).toBe(6);
    expect(walkReads).toBe(4);
  });
});
