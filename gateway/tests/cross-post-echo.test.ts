import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// THE ECHO IS THE NOTE (CROSS-NETWORK-ROUNDTRIP-ADR F2 → rung B).
//
// A member replies to a Bluesky post from all.haus. The cross-post lands on
// Bluesky, and opening the parent's thread hydrates it back as a stranger's
// context-only row: the member's words twice, and the author's answer to them
// (report 2) hung off the stranger copy where the member's own note never
// showed it. The worker had always recorded the join
// (`outbound_posts.external_post_uri`); nothing read it.
//
// Driven through the REAL `GET /thread/:postId` and the real feed helpers,
// once per protocol, because the join key is per protocol: atproto and
// activitypub store the remote URI as the echo's identity, and nostr stores the
// HEX event id against an echo named by its relay-free nevent.
//
// The consent is the operator's call (B-Q1): the note replaces the echo for
// everybody only where the presence's `show_on_profile` is on, and for the
// member alone where it is off. Nostr needs none (the echo is signed by the
// member's own key).
//
// MUTATION LOG — each applied to src/, the suite re-run, reverted (2026-09-27):
//   A. `substitutes` returns `echo.disclosed` only (no member arm)  → "the
//      member still sees their note" fails, both networks.      2 FAIL
//   B. `substitutes` returns true                                  → "a
//      stranger sees the external post" fails, both networks.   2 FAIL
//   C. nostr key not decoded in `outboundUriFor`                    → every
//      substituting nostr case fails.                            5 FAIL
//   D. drop `op.status = 'sent'` from `loadEchoNotes`               → "a failed
//      cross-post is no echo" fails, all three.                  3 FAIL
//   E. skip `reparentOntoNotes` on the external assembly            → the
//      answer still points at the echo.                         11 FAIL
//   F. a note focal walks no echoes (roots = [])                    → "from the
//      note" and "opening the echo" fail, all three.             6 FAIL
//   G. an echo focal stays on the external branch                   → "opening
//      the echo opens the note" fails, all three.                3 FAIL
//   H. drop the window's `present` dedupe                           → the
//      window lists the note twice, all three.                   3 FAIL
//
// Fixtures COMMIT (the route reads through the shared pool) and are removed in
// afterEach. Skipped without a DB URL — CI supplies one and fails on a skip.
// Locally set BOTH DATABASE_URL and TEST_DATABASE_URL.
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

const hydrateSpy = vi.fn(async () => true);
vi.mock("../src/lib/external-hydration.js", () => ({
  hydrateExternalThreadContext: hydrateSpy,
  willHydrateThread: () => true,
  getInFlightHydration: () => undefined,
  awaitHydrationWithinBudget: async () => true,
  THREAD_HYDRATE_SYNC_BUDGET_MS: 0,
}));

const { postThreadRoutes } = await import("../src/routes/post-thread.js");
const { drawEchoesAsNotes, drawWindowEchoesAsNotes } = await import(
  "../src/lib/cross-post-echo.js"
);
const { nostrEventUri } = await import("../src/lib/nostr-thread.js");
const { pool } = await import("@platform-pub/shared/db/client.js");

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

type Protocol = "atproto" | "activitypub" | "nostr_external";

// A fresh remote identity, and what the worker stores for it on `sent`.
function remote(protocol: Protocol): { uri: string; outbound: string } {
  if (protocol === "atproto") {
    const uri = `at://did:plc:${randHex(6)}/app.bsky.feed.post/${randHex(6)}`;
    return { uri, outbound: uri };
  }
  if (protocol === "activitypub") {
    const uri = `https://social.example/users/m${randHex(3)}/statuses/${randHex(6)}`;
    return { uri, outbound: uri };
  }
  const hex = randHex();
  return { uri: nostrEventUri(hex), outbound: hex };
}

interface ThreadRes {
  focalId: string;
  posts: { id: string; inReplyTo: string | null; isMuted: boolean }[];
  totalDescendants: number;
}

describe.skipIf(!DB_URL)("a member's cross-post is drawn as their note", () => {
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
    await client.query(`DELETE FROM outbound_posts WHERE account_id = ANY($1::uuid[])`, [accounts]);
    await client.query(`DELETE FROM network_presences WHERE account_id = ANY($1::uuid[])`, [accounts]);
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

  async function externalPost(opts: {
    protocol: Protocol;
    sourceId: string;
    uri: string;
    replyTo?: string;
    minutesAgo: number;
  }): Promise<{ itemId: string; uri: string; postId: string }> {
    const { rows: ei } = await client.query<{ id: string }>(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, source_reply_uri,
         author_name, author_handle, author_uri, content_text, published_at,
         interaction_data
       ) VALUES ($1, $2::external_protocol,
                 (CASE WHEN $2 = 'nostr_external' THEN 'tier2' ELSE 'tier3' END)::content_tier,
                 $3, $4, 'Someone', 'someone',
                 'someone', 'body', now() - make_interval(mins => $5),
                 jsonb_build_object('uri', $3::text))
       RETURNING id`,
      [opts.sourceId, opts.protocol, opts.uri, opts.replyTo ?? null, opts.minutesAgo],
    );
    const { rows: fi } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, 'Someone', 'body', now() - make_interval(mins => $2),
                 $3::external_protocol, $4, $5, '[]'::jsonb, $6)
       RETURNING post_id`,
      [ei[0].id, opts.minutesAgo, opts.protocol, opts.uri, opts.sourceId, !!opts.replyTo],
    );
    return { itemId: ei[0].id, uri: opts.uri, postId: fi[0].post_id };
  }

  /**
   * The whole round trip, as it stands on disk after it happened:
   *   parent (someone's post) ← note (the member's reply, from all.haus)
   *                           ← echo (the same reply, come back from the network)
   *                                ← answer (the author's reply TO the echo)
   *                           ← stranger (an unrelated reply — the control)
   */
  async function scene(protocol: Protocol, opts: { consent: boolean; status?: string }) {
    const member = await account("member");
    const { rows: src } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
       VALUES ($1::external_protocol, $2, 'Someone', TRUE) RETURNING id`,
      [protocol, `src-${randHex(6)}`],
    );
    sources.push(src[0].id);
    const sourceId = src[0].id;

    const parent = await externalPost({ protocol, sourceId, uri: remote(protocol).uri, minutesAgo: 60 });
    const stranger = await externalPost({
      protocol, sourceId, uri: remote(protocol).uri, replyTo: parent.uri, minutesAgo: 50,
    });

    const eventId = randHex();
    const { rows: n } = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, char_count, published_at, external_parent_id)
       VALUES ($1, $2, 'my reply', 8, now() - make_interval(mins => 30), $3) RETURNING id`,
      [member, eventId, parent.itemId],
    );
    const { rows: nfi } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items
         (item_type, note_id, author_id, content_preview, nostr_event_id, published_at, is_reply)
       VALUES ('note', $1, $2, 'my reply', $3, now() - make_interval(mins => 30), TRUE)
       RETURNING post_id`,
      [n[0].id, member, eventId],
    );
    const note = { noteId: n[0].id, eventId, postId: nfi[0].post_id };

    // The presence the cross-post went out through (nostr goes out on the
    // member's own key, with none).
    let presenceId: string | null = null;
    if (protocol !== "nostr_external") {
      const { rows: np } = await client.query<{ id: string }>(
        `INSERT INTO network_presences (account_id, protocol, external_id, show_on_profile)
         VALUES ($1, $2::external_protocol, $3, $4) RETURNING id`,
        [member, protocol, `ext-${randHex(6)}`, opts.consent],
      );
      presenceId = np[0].id;
    }

    const echoRemote = remote(protocol);
    await client.query(
      `INSERT INTO outbound_posts
         (account_id, linked_account_id, protocol, nostr_event_id, action_type,
          status, external_post_uri, sent_at)
       VALUES ($1, $2, $3::external_protocol, $4, 'reply', $5, $6, now())`,
      [member, presenceId, protocol, eventId, opts.status ?? "sent", echoRemote.outbound],
    );
    const echo = await externalPost({
      protocol, sourceId, uri: echoRemote.uri, replyTo: parent.uri, minutesAgo: 29,
    });
    const answer = await externalPost({
      protocol, sourceId, uri: remote(protocol).uri, replyTo: echo.uri, minutesAgo: 10,
    });
    return { member, sourceId, parent, stranger, note, echo, answer };
  }

  async function thread(postId: string): Promise<ThreadRes> {
    const res = await app.inject({ url: `/thread/${postId}` });
    expect(res.statusCode).toBe(200);
    return res.json() as ThreadRes;
  }

  const ids = (t: ThreadRes) => t.posts.map((p) => p.id);
  const parentOf = (t: ThreadRes, id: string) => t.posts.find((p) => p.id === id)?.inReplyTo;

  describe.each<Protocol>(["atproto", "activitypub", "nostr_external"])("%s", (protocol) => {
    it("from the parent: the note stands in the echo's slot, and the answer hangs off it", async () => {
      const s = await scene(protocol, { consent: true });
      caller = await account("viewer");

      const t = await thread(s.parent.postId);

      expect(ids(t)).not.toContain(s.echo.postId);
      expect(ids(t)).toContain(s.note.postId);
      expect(ids(t)).toContain(s.stranger.postId); // control
      expect(parentOf(t, s.answer.postId)).toBe(s.note.postId);
      expect(t.totalDescendants).toBe(3); // stranger, note, answer — the echo is not one
    });

    it("from the note: the answer to the cross-post is its reply, and the echo is hydrated", async () => {
      const s = await scene(protocol, { consent: true });
      caller = await account("viewer");

      const t = await thread(s.note.postId);

      expect(t.focalId).toBe(s.note.postId);
      expect(ids(t)).toContain(s.parent.postId);
      expect(ids(t)).toContain(s.answer.postId);
      expect(parentOf(t, s.answer.postId)).toBe(s.note.postId);
      expect(ids(t)).not.toContain(s.echo.postId);
      expect(ids(t)).not.toContain(s.stranger.postId); // the parent's other replies are not the note's
      expect(hydrateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: s.echo.itemId }));
    });

    it("from the answer: its ancestors run through the note, not the echo", async () => {
      const s = await scene(protocol, { consent: true });

      const t = await thread(s.answer.postId);

      expect(ids(t).slice(0, 3)).toEqual([s.parent.postId, s.note.postId, s.answer.postId]);
      expect(parentOf(t, s.answer.postId)).toBe(s.note.postId);
    });

    it("opening the echo opens the note", async () => {
      const s = await scene(protocol, { consent: true });

      const t = await thread(s.echo.postId);

      expect(t.focalId).toBe(s.note.postId);
      expect(ids(t)).not.toContain(s.echo.postId);
      expect(ids(t)).toContain(s.answer.postId);
    });

    it("a failed cross-post is no echo", async () => {
      const s = await scene(protocol, { consent: true, status: "failed" });

      const t = await thread(s.parent.postId);

      expect(ids(t)).toContain(s.echo.postId);
      expect(parentOf(t, s.answer.postId)).toBe(s.echo.postId);
    });

    it("the feed and its window draw the echo as the note, once", async () => {
      const s = await scene(protocol, { consent: true });
      const viewer = await account("viewer");
      const echoCard = {
        id: s.echo.postId,
        externalItemId: s.echo.itemId,
        origin: { protocol, uri: s.echo.uri },
        publishedAt: 1,
      };
      const nativeCard = { id: s.note.postId, externalItemId: null, origin: { protocol: "nostr", uri: s.note.eventId }, publishedAt: 2 };

      const alone = await drawEchoesAsNotes(viewer, [echoCard] as never);
      expect(alone.map((p: { id: string }) => p.id)).toEqual([s.note.postId]);

      const both = await drawEchoesAsNotes(viewer, [echoCard, nativeCard] as never);
      expect(both.map((p: { id: string }) => p.id)).toEqual([s.note.postId]);

      const win = await drawWindowEchoesAsNotes(viewer, [
        { id: s.echo.postId, publishedAt: 1, isNew: true, protocol, sourceItemUri: s.echo.uri },
        { id: s.note.postId, publishedAt: 2, isNew: false, protocol: null, sourceItemUri: null },
      ]);
      expect(win.map((w) => w.id)).toEqual([s.note.postId]);
    });

    it("a viewer who hides the member does not get their note in the echo's slot", async () => {
      const s = await scene(protocol, { consent: true });
      const viewer = await account("viewer");
      await client.query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2)`, [viewer, s.member]);
      caller = viewer;

      const t = await thread(s.parent.postId);
      expect(ids(t)).not.toContain(s.note.postId);
      expect(ids(t)).not.toContain(s.echo.postId);

      // In a chain the note stays, flagged, or the thread below it breaks.
      const fromAnswer = await thread(s.answer.postId);
      expect(fromAnswer.posts.find((p) => p.id === s.note.postId)?.isMuted).toBe(true);

      const card = {
        id: s.echo.postId,
        externalItemId: s.echo.itemId,
        origin: { protocol, uri: s.echo.uri },
      };
      expect(await drawEchoesAsNotes(viewer, [card] as never)).toEqual([]);
    });
  });
  // Nostr has no consent to withhold (the echo is the member's own key), so
  // these two are the networks where a second identity exists to link.
  describe.each<Protocol>(["atproto", "activitypub"])("%s, consent off", (protocol) => {
    it("consent off: a stranger sees the external post, as before", async () => {
      const s = await scene(protocol, { consent: false });
      caller = await account("viewer");

      const fromParent = await thread(s.parent.postId);
      expect(ids(fromParent)).toContain(s.echo.postId);
      expect(parentOf(fromParent, s.answer.postId)).toBe(s.echo.postId);

      const fromEcho = await thread(s.echo.postId);
      expect(fromEcho.focalId).toBe(s.echo.postId);
    });

    it("consent off: the member still sees their note", async () => {
      const s = await scene(protocol, { consent: false });
      caller = s.member;

      const t = await thread(s.parent.postId);

      expect(ids(t)).not.toContain(s.echo.postId);
      expect(parentOf(t, s.answer.postId)).toBe(s.note.postId);
    });

  });
});
