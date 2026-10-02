import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// THE MEMBER'S ACTIVITY ELSEWHERE IS THEIRS (CROSS-NETWORK-ROUNDTRIP-ADR rung D).
//
// Report 3: a member replied to a Bluesky author directly on Bluesky, and
// all.haus neither pulled the post in nor attributed it to them. The column
// that would have — external_authors.account_id, migration 099 — had a reader
// and no writer. Rung D writes it from the linked presence (migration 237's
// trigger) and reads it in four places, every one of which answers to the
// presence's DISPLAY consent (D-Q1, operator 2026-09-27):
//
//   · the byline (post-mapper: accountId / memberUsername, disclosed only);
//   · the member's profile log (their posts elsewhere, for everybody where
//     disclosed and for the member alone where not; echoes and replies out);
//   · a report (resolveReportTarget: a disclosed claim names the member);
//   · the export (every claimed post, disclosed or not — it is their record).
//
// All against a live Postgres, because every one of these is a predicate only
// Postgres evaluates: a trigger, a correlated subquery, a NULL-safe viewer
// comparison. Fixtures COMMIT (the route reads through the shared pool) and
// are removed in afterEach. Skipped without a DB URL — CI supplies one and
// fails on a skip. Locally set BOTH DATABASE_URL and TEST_DATABASE_URL.
//
// MUTATION LOG — each applied, the suite re-run, reverted (2026-09-27). The
// trigger mutations were applied to the dev DB's function and restored:
//   A. trigger claims with account_id NULL (both arms)             → 11 FAIL
//   B. trigger's release arm removed                                →  3 FAIL
//   C. trigger fires on is_valid AND requires it (release on a
//      refused token) — adding the term to the condition alone is
//      unreachable, the trigger does not fire on is_valid           →  1 FAIL
//   D. mapper reads raw xa.account_id (no disclosure gate)          →  1 FAIL
//   E. disclosedClaimantSql drops `np.show_on_profile`              →  2 FAIL
//   F. ownPostsElsewhereSql drops the member (viewer) arm           →  1 FAIL
//   G. ownPostsElsewhereSql's echo exclusion matches nothing        →  1 FAIL
//   H. resolveReportTarget ignores claimant_id                      →  1 FAIL
//   I. export SQL filters on disclosure                             →  1 FAIL
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

const { authorRoutes } = await import("../src/routes/author.js");
const { resolveReportTarget } = await import("../src/routes/moderation.js");
const { EXPORT_POSTS_ELSEWHERE_SQL } = await import("../src/routes/export.js");
const { FEED_SELECT, FEED_JOINS } = await import("../src/lib/feed-sql.js");
const { POST_SELECT, POST_JOINS, feedItemToPost } = await import("../src/lib/post-mapper.js");
const { pool } = await import("@platform-pub/shared/db/client.js");

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

describe.skipIf(!DB_URL)("a member's activity elsewhere is theirs", () => {
  let client: pg.Client;
  let app: ReturnType<typeof Fastify>;
  const accounts: string[] = [];
  const sources: string[] = [];
  const handles: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(authorRoutes);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await client.end();
    await pool.end();
  });
  afterEach(async () => {
    caller = null;
    await client.query(`DELETE FROM outbound_posts WHERE account_id = ANY($1::uuid[])`, [accounts]);
    await client.query(`DELETE FROM network_presences WHERE account_id = ANY($1::uuid[])`, [accounts]);
    await client.query(
      `DELETE FROM feed_items WHERE external_item_id IN
         (SELECT id FROM external_items WHERE source_id = ANY($1::uuid[]))`,
      [sources],
    );
    await client.query(`DELETE FROM external_items WHERE source_id = ANY($1::uuid[])`, [sources]);
    await client.query(`DELETE FROM external_sources WHERE id = ANY($1::uuid[])`, [sources]);
    await client.query(`DELETE FROM external_authors WHERE stable_handle = ANY($1::text[])`, [handles]);
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    accounts.length = 0;
    sources.length = 0;
    handles.length = 0;
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

  function did(): string {
    const d = `did:plc:${randHex(8)}`;
    handles.push(d);
    return d;
  }

  async function link(member: string, handle: string, showOnProfile: boolean): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO network_presences (account_id, protocol, external_id, stable_handle, show_on_profile)
       VALUES ($1, 'atproto', $2, $2, $3) RETURNING id`,
      [member, handle, showOnProfile],
    );
    return rows[0].id;
  }

  async function claimOf(handle: string): Promise<string | null | undefined> {
    const { rows } = await client.query<{ account_id: string | null }>(
      `SELECT account_id FROM external_authors WHERE protocol = 'atproto' AND stable_handle = $1`,
      [handle],
    );
    return rows.length === 0 ? undefined : rows[0].account_id;
  }

  async function source(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('atproto', $1, TRUE) RETURNING id`,
      [`src-${randHex(6)}`],
    );
    sources.push(rows[0].id);
    return rows[0].id;
  }

  /** A post by `authorDid`, ingested the way real ingest writes one: the
   *  feed_items INSERT fires feed_items_post_identity, which mints or finds
   *  the external_authors row from the item's author_uri. */
  async function post(opts: {
    sourceId: string;
    authorDid: string;
    replyTo?: string;
    minutesAgo?: number;
  }): Promise<{ uri: string; postId: string; externalAuthorId: string | null }> {
    const uri = `at://${opts.authorDid}/app.bsky.feed.post/${randHex(6)}`;
    const { rows: ei } = await client.query<{ id: string }>(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, source_reply_uri,
         author_name, author_handle, author_uri, content_text, published_at
       ) VALUES ($1, 'atproto', 'tier3', $2, $3, 'Member', 'member.bsky.social',
                 $4, 'said elsewhere', now() - make_interval(mins => $5))
       RETURNING id`,
      [opts.sourceId, uri, opts.replyTo ?? null, opts.authorDid, opts.minutesAgo ?? 10],
    );
    const { rows: fi } = await client.query<{ post_id: string; external_author_id: string | null }>(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, 'Member', 'said elsewhere',
                 now() - make_interval(mins => $2), 'atproto', $3, $4, '[]'::jsonb, $5)
       RETURNING post_id, external_author_id`,
      [ei[0].id, opts.minutesAgo ?? 10, uri, opts.sourceId, !!opts.replyTo],
    );
    return { uri, postId: fi[0].post_id, externalAuthorId: fi[0].external_author_id };
  }

  async function mapped(postId: string) {
    const { rows } = await pool.query(
      `SELECT ${FEED_SELECT}${POST_SELECT}
         FROM feed_items fi ${FEED_JOINS} ${POST_JOINS}
        WHERE fi.post_id = $1`,
      [postId],
    );
    return feedItemToPost(rows[0]);
  }

  async function log(memberId: string, kind?: string): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/author/${memberId}/posts${kind ? `?kind=${kind}` : ""}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((p) => p.id);
  }

  // ---------------------------------------------------------------------------
  // D1 — the claim follows the presence, whatever writes it
  // ---------------------------------------------------------------------------

  describe("the claim", () => {
    it("linking claims the identity, minting its author row", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, false);
      expect(await claimOf(d)).toBe(member);
    });

    it("a post ingested AFTER the link is filed under the claimed row", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, false);
      const p = await post({ sourceId: await source(), authorDid: d });
      const { rows } = await client.query(`SELECT account_id FROM external_authors WHERE id = $1`, [
        p.externalAuthorId,
      ]);
      expect(rows[0].account_id).toBe(member);
    });

    it("an author row that existed BEFORE the link is claimed by it", async () => {
      const member = await account("member");
      const d = did();
      await post({ sourceId: await source(), authorDid: d });
      expect(await claimOf(d)).toBeNull();
      await link(member, d, false);
      expect(await claimOf(d)).toBe(member);
    });

    it("unlinking releases it", async () => {
      const member = await account("member");
      const d = did();
      const presence = await link(member, d, true);
      await client.query(`DELETE FROM network_presences WHERE id = $1`, [presence]);
      expect(await claimOf(d)).toBeNull();
    });

    it("account deletion's deprovision releases it", async () => {
      const member = await account("member");
      const d = did();
      const presence = await link(member, d, true);
      await client.query(
        `UPDATE network_presences SET lifecycle_state = 'deprovisioned', is_valid = FALSE WHERE id = $1`,
        [presence],
      );
      expect(await claimOf(d)).toBeNull();
    });

    it("a token the network refused does NOT release it — the identity is still proven", async () => {
      const member = await account("member");
      const d = did();
      const presence = await link(member, d, true);
      await client.query(`UPDATE network_presences SET is_valid = FALSE WHERE id = $1`, [presence]);
      expect(await claimOf(d)).toBe(member);
    });

    it("relinking to another identity moves the claim", async () => {
      const member = await account("member");
      const d1 = did();
      const d2 = did();
      const presence = await link(member, d1, true);
      await client.query(
        `UPDATE network_presences SET external_id = $2, stable_handle = $2 WHERE id = $1`,
        [presence, d2],
      );
      expect(await claimOf(d1)).toBeNull();
      expect(await claimOf(d2)).toBe(member);
    });
  });

  // ---------------------------------------------------------------------------
  // D-Q1 — the byline answers to the display consent
  // ---------------------------------------------------------------------------

  describe("the byline", () => {
    it("names the member where they consented to showing the link", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, true);
      const p = await post({ sourceId: await source(), authorDid: d });
      const mappedPost = await mapped(p.postId);
      expect(mappedPost.author.accountId).toBe(member);
      expect(mappedPost.author.memberUsername).toMatch(/^member-/);
    });

    it("names nobody where they did not", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, false);
      const p = await post({ sourceId: await source(), authorDid: d });
      const mappedPost = await mapped(p.postId);
      expect(mappedPost.author.accountId).toBeNull();
      expect(mappedPost.author.memberUsername).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // D-Q2 — the member's own profile log
  // ---------------------------------------------------------------------------

  describe("the profile log", () => {
    async function scene(showOnProfile: boolean) {
      const member = await account("member");
      const d = did();
      await link(member, d, showOnProfile);
      const src = await source();
      const own = await post({ sourceId: src, authorDid: d, minutesAgo: 5 });
      const reply = await post({ sourceId: src, authorDid: d, replyTo: "at://x/p/1", minutesAgo: 6 });
      const echo = await post({ sourceId: src, authorDid: d, minutesAgo: 7 });
      const stranger = await post({ sourceId: src, authorDid: did(), minutesAgo: 8 });
      await client.query(
        `INSERT INTO outbound_posts (account_id, protocol, action_type, nostr_event_id, status, external_post_uri)
         VALUES ($1, 'atproto', 'original', $2, 'sent', $3)`,
        [member, randHex(), echo.uri],
      );
      return { member, own, reply, echo, stranger };
    }

    it("shows a DISCLOSED member's posts elsewhere to a stranger", async () => {
      const s = await scene(true);
      caller = await account("stranger");
      const ids = await log(s.member, "note");
      expect(ids).toContain(s.own.postId);
    });

    it("shows an UNDISCLOSED member's posts elsewhere to nobody else — anonymous or signed in", async () => {
      const s = await scene(false);
      expect(await log(s.member, "note")).not.toContain(s.own.postId);
      caller = await account("stranger");
      expect(await log(s.member, "note")).not.toContain(s.own.postId);
    });

    it("shows an UNDISCLOSED member their own", async () => {
      const s = await scene(false);
      caller = s.member;
      expect(await log(s.member, "note")).toContain(s.own.postId);
    });

    it("leaves out their replies, their echoes and anybody else's posts", async () => {
      const s = await scene(true);
      const ids = await log(s.member);
      expect(ids).toContain(s.own.postId);
      expect(ids).not.toContain(s.reply.postId);
      expect(ids).not.toContain(s.echo.postId);
      expect(ids).not.toContain(s.stranger.postId);
    });

    it("keeps them off the Work tab", async () => {
      const s = await scene(true);
      expect(await log(s.member, "article")).not.toContain(s.own.postId);
    });
  });

  // ---------------------------------------------------------------------------
  // D-Q3 — reports and the export
  // ---------------------------------------------------------------------------

  describe("a report", () => {
    const report = (postId: string) => ({
      id: "r",
      target_nostr_event_id: null,
      target_account_id: null,
      target_post_id: postId,
      target_conversation_id: null,
      target_profile_id: null,
      status: "open",
    });

    it("on a DISCLOSED member's post elsewhere reaches their account, and stays external", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, true);
      const p = await post({ sourceId: await source(), authorDid: d });
      expect(await resolveReportTarget(report(p.postId))).toEqual({
        eventId: null,
        accountId: member,
        external: true,
      });
    });

    it("on an UNDISCLOSED one reaches nobody", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, false);
      const p = await post({ sourceId: await source(), authorDid: d });
      expect((await resolveReportTarget(report(p.postId))).accountId).toBeNull();
    });
  });

  describe("the export", () => {
    it("carries every post elsewhere the member claims — disclosed or not — and nobody else's", async () => {
      const member = await account("member");
      const d = did();
      await link(member, d, false);
      const src = await source();
      const own = await post({ sourceId: src, authorDid: d });
      const theirs = await post({ sourceId: src, authorDid: did() });
      const { rows } = await client.query<{ source_item_uri: string }>(EXPORT_POSTS_ELSEWHERE_SQL, [
        member,
        100,
      ]);
      const uris = rows.map((r) => r.source_item_uri);
      expect(uris).toContain(own.uri);
      expect(uris).not.toContain(theirs.uri);
    });
  });
});
