import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// The reading counts' window — WORKSPACE-QUEUE-ADR §IV, slice A1.
//
// THE CLAIM UNDER TEST IS AN AGREEMENT CLAIM: a count must not name a post the
// timeline will not show (§IV.2). The window is the items query's page-one
// selection with ONE extra predicate, `published_at >= windowStart`, and
// the rule is WHERE that predicate sits — in `matched`, after the per-source
// cut, never in the arms. So every agreement case compares the window against
// the real items page (both driven through the exported functions, inside a
// transaction that is always rolled back) filtered to the same floor.
//
// The first case is the one that decides placement: a SCORED source below
// 100% whose previous calendar week straddles the floor. With the predicate in
// the arms, that week's bucket is half-emptied and re-ranked, and the window
// admits posts the timeline cut.
//
// MUTATION LOG (each applied to src/, the suite re-run, and reverted):
//   1. source-selection.ts: the windowStart predicate moved from `matched`
//      into the arms (appended to `windowClause`)
//      ⇒ "agrees with the timeline across the floor, for a scored source
//        below full volume" fails — the window lists the two low-proof posts
//        above the floor that the timeline cut.                     DETECTED
//   2. items.ts: `fi.created_at > baseline` → `fi.published_at > baseline`
//      ⇒ "flags a post new by when it ARRIVED" fails.               DETECTED
//   3. items.ts: GREATEST dropped from the baseline write (plain LEAST)
//      ⇒ "never moves the baseline backwards" fails.                DETECTED
//   4. items.ts: LEAST dropped (plain GREATEST over $3)
//      ⇒ "clamps a future asOf to now()" fails.                     DETECTED
//   5. seen.ts: parseTimestampCursor bypassed (raw body value passed on)
//      ⇒ "answers a malformed asOf with 400" fails with a 500.      DETECTED
//   6. items.ts: the `published_at >= joined_at` term dropped from is_new
//      ⇒ "never flags a source's back-catalogue new" fails.         DETECTED
//   7. source-selection.ts: `min(joined_at)` → `max(joined_at)` in `matched`
//      ⇒ "…a post two sources carry is new by the EARLIER join" fails. DETECTED
//
// Run locally (BOTH vars — fixtures use their own client, the blend loader and
// the route cases use the shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/feed-seen-window.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const randHex = () => Math.random().toString(16).slice(2, 10);

let sessionSub = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: sessionSub };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: sessionSub };
    done();
  },
}));

const {
  loadFeedItemsPage,
  loadFeedSeenWindow,
  recordFeedSeen,
  SEEN_WINDOW_CAP,
} = await import("../src/routes/feeds/items.js");
const { registerFeedSeenRoutes } = await import("../src/routes/feeds/seen.js");

describe.skipIf(!DB_URL)("the reading-count window", () => {
  let client: pg.Client;
  let reader: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    reader = await account("seen-reader");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // --- fixtures -------------------------------------------------------------

  async function account(prefix: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, display_name, nostr_pubkey)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${prefix}-${randHex()}`, prefix, randHex().padEnd(64, "0").slice(0, 64)],
    );
    return rows[0].id;
  }

  async function feed(owner = reader): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'seen', 1) RETURNING id`,
      [owner],
    );
    return rows[0].id;
  }

  async function externalSource(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ('atproto', $1) RETURNING id`,
      [`https://seen.test/${randHex()}`],
    );
    return rows[0].id;
  }

  async function attach(
    feedId: string,
    target: { externalSourceId?: string; accountId?: string },
    opts: {
      throughput?: number;
      mode?: "scored" | "random";
      /** When the source joined the feed, as SQL. Defaults to a month ago —
       *  a long-standing source, so a post's arrival alone decides `isNew`. */
      joinedAt?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_sources
         (feed_id, source_type, external_source_id, account_id, throughput, sampling_mode,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${opts.joinedAt ?? "now() - interval '30 days'"})
       RETURNING id`,
      [
        feedId,
        target.externalSourceId ? "external_source" : "account",
        target.externalSourceId ?? null,
        target.accountId ?? null,
        opts.throughput ?? 1.0,
        opts.mode ?? "scored",
      ],
    );
    return rows[0].id;
  }

  // Timestamps are SQL expressions evaluated by Postgres, so a fixture can sit
  // relative to the floor and to calendar-week boundaries whatever day the
  // suite runs on. `now()` is the transaction's start, which is also what the
  // route functions see inside it.
  const FLOOR = `(now() - interval '7 days')`;
  const PREV_WEEK = `date_trunc('week', now() - interval '7 days')`;
  const THIS_WEEK = `date_trunc('week', now())`;
  /** A point in the previous calendar week, strictly BELOW the floor. */
  const belowFloor = (k: number) => `${PREV_WEEK} + (${FLOOR} - ${PREV_WEEK}) * ${k}`;
  /** A point in the previous calendar week, strictly ABOVE the floor. */
  const aboveFloor = (k: number) => `${FLOOR} + (${THIS_WEEK} - ${FLOOR}) * ${k}`;
  const minutesAgo = (m: number) => `now() - interval '${m} minutes'`;

  /** One external post at a SQL-expressed time, with a proof level. */
  async function post(
    sourceId: string,
    at: string,
    opts: { resonance?: number | null; createdAt?: string } = {},
  ): Promise<string> {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, published_at)
       VALUES ($1, 'atproto', 'tier3', $2, ${at}) RETURNING id`,
      [sourceId, `uri:${randHex()}`],
    );
    const postId = `post:${randHex()}${randHex()}`;
    await client.query(
      `INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at, source_protocol,
          source_id, biddability_tier, post_id, resonance, created_at)
       VALUES ('external', $1, 'fixture', ${at}, 'atproto', $2, 'B', $3, $4,
               ${opts.createdAt ?? "now()"})`,
      [ext.rows[0].id, sourceId, postId, opts.resonance ?? null],
    );
    return postId;
  }

  /** A native article by `writer`, for the account arm. */
  async function article(writer: string, at: string): Promise<string> {
    const a = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
       VALUES ($1, $2, $3, 'fixture', $4, ${at}) RETURNING id`,
      [writer, `ev:${randHex()}`, `d:${randHex()}`, `slug-${randHex()}`],
    );
    const postId = `post:${randHex()}${randHex()}`;
    await client.query(
      `INSERT INTO feed_items
         (item_type, article_id, author_id, published_at, biddability_tier, post_id)
       VALUES ('article', $1, $2, ${at}, 'A', $3)`,
      [a.rows[0].id, writer, postId],
    );
    return postId;
  }

  async function sourceCount(feedId: string): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feed_sources WHERE feed_id = $1`,
      [feedId],
    );
    return rows[0].n;
  }

  /**
   * The window's ids, and the items page's ids filtered to the window's own
   * floor — the two sides of the agreement claim. The page is read whole (a
   * limit far past the fixture), so "the timeline" here is everything it
   * would ever show.
   */
  async function bothSides(feedId: string) {
    const n = await sourceCount(feedId);
    const w = await loadFeedSeenWindow(reader, feedId, n, client);
    const p = await loadFeedItemsPage(reader, feedId, n, undefined, 1000, client);
    const {
      rows: [{ floor_secs }],
    } = await client.query<{ floor_secs: number }>(
      `SELECT EXTRACT(EPOCH FROM $1::timestamptz)::float8 AS floor_secs`,
      [w.windowStart],
    );
    return {
      window: w,
      windowIds: w.items.map((i) => i.id).sort(),
      timelineIds: p.items
        .filter((i) => i.publishedAt >= floor_secs)
        .map((i) => i.id)
        .sort(),
      page: p,
    };
  }

  // --- agreement ------------------------------------------------------------

  it("agrees with the timeline across the floor, for a scored source below full volume", async () => {
    const f = await feed();
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.5, mode: "scored" });
    // The previous calendar week straddles the floor. Its four STRONG posts
    // are below the floor and its four WEAK ones above it, so the week's cut
    // at 50% keeps exactly the strong four — none of them in the window.
    const strongBelow: string[] = [];
    const weakAbove: string[] = [];
    for (let i = 1; i <= 4; i++) {
      strongBelow.push(await post(src, belowFloor(i / 5), { resonance: 3 }));
      weakAbove.push(await post(src, aboveFloor(i / 5), { resonance: 0.1 }));
    }
    // This week: two posts, one of which survives its own week's cut.
    await post(src, minutesAgo(30), { resonance: 2 });
    await post(src, minutesAgo(20), { resonance: 0.1 });

    const { windowIds, timelineIds } = await bothSides(f);
    expect(windowIds).toEqual(timelineIds);
    // …and the case is not vacuous: the week's cut really did leave its weak
    // posts out, which is the population a predicate in the arms would re-rank.
    for (const id of weakAbove) expect(windowIds).not.toContain(id);
    expect(windowIds.length).toBe(1);
  });

  it("does not list a post older than the floor", async () => {
    const f = await feed();
    const src = await externalSource();
    await attach(f, { externalSourceId: src });
    const old = await post(src, belowFloor(0.5));
    const fresh = await post(src, minutesAgo(10));
    const { window, page } = await bothSides(f);
    expect(window.items.map((i) => i.id)).toEqual([fresh]);
    // The timeline still shows it — the floor is the COUNT's, not the feed's.
    expect(page.items.map((i) => i.id)).toContain(old);
  });

  it("agrees when the reader blocks an author", async () => {
    const f = await feed();
    const writer = await account("seen-writer");
    await attach(f, { accountId: writer });
    const a = await article(writer, minutesAgo(15));
    expect((await bothSides(f)).windowIds).toEqual([a]);

    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      reader,
      writer,
    ]);
    const { windowIds, timelineIds } = await bothSides(f);
    expect(windowIds).toEqual([]);
    expect(windowIds).toEqual(timelineIds);
  });

  it("agrees when a source is muted", async () => {
    const f = await feed();
    const keep = await externalSource();
    const hush = await externalSource();
    await attach(f, { externalSourceId: keep });
    const hushFs = await attach(f, { externalSourceId: hush });
    const kept = await post(keep, minutesAgo(10));
    await post(hush, minutesAgo(11));
    await client.query(`UPDATE feed_sources SET muted_at = now() WHERE id = $1`, [hushFs]);
    const { windowIds, timelineIds } = await bothSides(f);
    expect(windowIds).toEqual([kept]);
    expect(windowIds).toEqual(timelineIds);
  });

  it("agrees when a cross-posted pair is deduplicated", async () => {
    const f = await feed();
    const [a, b] = [await externalSource(), await externalSource()].sort();
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_asserted', 1.0, NULL)`,
      [a, b],
    );
    await attach(f, { externalSourceId: a });
    await attach(f, { externalSourceId: b });
    // dedup_fingerprint is trigger-computed from content_text (≥32 chars).
    const text = `the same thing posted to two networks ${randHex()}`;
    const ids: string[] = [];
    for (const [src, m] of [
      [a, 30],
      [b, 29],
    ] as const) {
      const ext = await client.query<{ id: string }>(
        `INSERT INTO external_items
           (source_id, protocol, tier, source_item_uri, published_at, content_text)
         VALUES ($1, 'atproto', 'tier3', $2, ${minutesAgo(m)}, $3) RETURNING id`,
        [src, `uri:${randHex()}`, text],
      );
      const postId = `post:${randHex()}${randHex()}`;
      ids.push(postId);
      await client.query(
        `INSERT INTO feed_items
           (item_type, external_item_id, author_name, published_at, source_protocol,
            source_id, biddability_tier, post_id)
         VALUES ('external', $1, 'fixture', ${minutesAgo(m)}, 'atproto', $2, 'B', $3)`,
        [ext.rows[0].id, src, postId],
      );
    }
    const { windowIds, timelineIds } = await bothSides(f);
    expect(windowIds.length).toBe(1);
    expect(windowIds).toEqual(timelineIds);
  });

  it("an empty feed has an empty window, whatever its placeholder shows", async () => {
    const f = await feed();
    const w = await loadFeedSeenWindow(reader, f, 0, client);
    expect(w.items).toEqual([]);
    expect(w.truncated).toBe(false);
    expect(w.asOf).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("caps the window at SEEN_WINDOW_CAP, keeps the newest, and says so", async () => {
    const f = await feed();
    const src = await externalSource();
    await attach(f, { externalSourceId: src });
    // Bulk, in SQL: SEEN_WINDOW_CAP + 5 posts a minute apart.
    await client.query(
      `WITH ei AS (
         INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at)
         SELECT $1, 'atproto', 'tier3', 'uri:' || $2 || ':' || g, now() - make_interval(mins => g)
           FROM generate_series(1, $3::int) g
         RETURNING id, published_at, source_item_uri
       )
       INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at, source_protocol,
          source_id, biddability_tier, post_id)
       SELECT 'external', id, 'fixture', published_at, 'atproto', $1, 'B', 'post:' || source_item_uri
         FROM ei`,
      [src, randHex(), SEEN_WINDOW_CAP + 5],
    );
    const w = await loadFeedSeenWindow(reader, f, 1, client);
    expect(w.truncated).toBe(true);
    expect(w.items.length).toBe(SEEN_WINDOW_CAP);
    // Newest published first — the ones the reader meets first.
    const times = w.items.map((i) => i.publishedAt);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(typeof times[0]).toBe("number");
  });

  // --- new, and the baseline -------------------------------------------------

  it("flags a post new by when it ARRIVED, and a never-looked feed flags nothing", async () => {
    const f = await feed();
    const src = await externalSource();
    await attach(f, { externalSourceId: src });
    // Published long ago (inside the floor) but ingested just now: new.
    const backdated = await post(src, `now() - interval '3 days'`, {
      createdAt: minutesAgo(1),
    });
    // Published just now but ingested before the look: not new.
    const early = await post(src, minutesAgo(2), { createdAt: minutesAgo(20) });

    const never = await loadFeedSeenWindow(reader, f, 1, client);
    expect(never.seenBaselineAt).toBeNull();
    expect(never.items.every((i) => !i.isNew)).toBe(true);

    await client.query(
      `UPDATE feeds SET seen_baseline_at = now() - interval '10 minutes' WHERE id = $1`,
      [f],
    );
    const w = await loadFeedSeenWindow(reader, f, 1, client);
    const flag = Object.fromEntries(w.items.map((i) => [i.id, i.isNew]));
    expect(flag[backdated]).toBe(true);
    expect(flag[early]).toBe(false);
  });

  // A source new to the platform brings its back-catalogue in as fresh
  // inserts, and the subscribe-time ingest job writes them AFTER the add has
  // answered, so a client re-base can never land after them. What they share
  // is being published before the source joined — and that is never new.
  it("never flags a source's back-catalogue new, only what it publishes after joining", async () => {
    const f = await feed();
    const old = await externalSource();
    await attach(f, { externalSourceId: old });
    const fresh = await externalSource();
    await attach(f, { externalSourceId: fresh }, { joinedAt: minutesAgo(30) });
    await client.query(
      `UPDATE feeds SET seen_baseline_at = now() - interval '1 hour' WHERE id = $1`,
      [f],
    );
    // All three ingested a minute ago — after the baseline, after the join.
    const backCatalogue = await post(fresh, `now() - interval '3 days'`, {
      createdAt: minutesAgo(1),
    });
    const afterJoin = await post(fresh, minutesAgo(10), { createdAt: minutesAgo(1) });
    const lateArrival = await post(old, `now() - interval '3 days'`, {
      createdAt: minutesAgo(1),
    });

    const w = await loadFeedSeenWindow(reader, f, 2, client);
    const flag = Object.fromEntries(w.items.map((i) => [i.id, i.isNew]));
    // Listed, so still UNREAD — just never NEW.
    expect(flag[backCatalogue]).toBe(false);
    expect(flag[afterJoin]).toBe(true);
    // The same backdated arrival through a source that was already there IS
    // new: the rule is about the source's join, not about backdating.
    expect(flag[lateArrival]).toBe(true);
  });

  // A post two sources carry is new by the EARLIER join: the source that was
  // already there would have brought it as an arrival whatever the newcomer did.
  it("a post two sources carry is new by the EARLIER join", async () => {
    const f = await feed();
    const writer = await account("seen-writer");
    // The writer joined half an hour ago; a tag they post under has been in
    // the feed for a month.
    await attach(f, { accountId: writer }, { joinedAt: minutesAgo(30) });
    const tagName = `seen-${randHex()}`;
    const tag = await client.query<{ id: string }>(
      `INSERT INTO tags (name) VALUES ($1) RETURNING id`,
      [tagName],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, tag_name, created_at)
       VALUES ($1, 'tag', $2, now() - interval '30 days')`,
      [f, tagName],
    );
    await client.query(
      `UPDATE feeds SET seen_baseline_at = now() - interval '1 hour' WHERE id = $1`,
      [f],
    );
    const p = await article(writer, `now() - interval '3 days'`);
    await client.query(
      `INSERT INTO article_tags (article_id, tag_id)
       SELECT article_id, $2 FROM feed_items WHERE post_id = $1`,
      [p, tag.rows[0].id],
    );

    const w = await loadFeedSeenWindow(reader, f, 2, client);
    expect(w.items.find((i) => i.id === p)?.isNew).toBe(true);
  });

  it("records a look and answers the window against the NEW baseline", async () => {
    const f = await feed();
    const src = await externalSource();
    await attach(f, { externalSourceId: src });
    await client.query(
      `UPDATE feeds SET seen_baseline_at = now() - interval '1 hour' WHERE id = $1`,
      [f],
    );
    const p = await post(src, minutesAgo(5), { createdAt: minutesAgo(5) });
    expect((await loadFeedSeenWindow(reader, f, 1, client)).items[0].isNew).toBe(true);

    const {
      rows: [{ t }],
    } = await client.query<{ t: string }>(`SELECT (now() - interval '1 minute')::text AS t`);
    const after = await recordFeedSeen(reader, f, t, 1, client);
    expect(after!.items.find((i) => i.id === p)!.isNew).toBe(false);
    expect(after!.seenBaselineAt).toBe(t);
  });

  it("never moves the baseline backwards", async () => {
    const f = await feed();
    const {
      rows: [{ newer, older }],
    } = await client.query<{ newer: string; older: string }>(
      `SELECT (now() - interval '1 minute')::text AS newer,
              (now() - interval '1 hour')::text AS older`,
    );
    await recordFeedSeen(reader, f, newer, 0, client);
    const w = await recordFeedSeen(reader, f, older, 0, client);
    expect(w!.seenBaselineAt).toBe(newer);
  });

  it("clamps a future asOf to now()", async () => {
    const f = await feed();
    const w = await recordFeedSeen(reader, f, "2999-01-01 00:00:00+00", 0, client);
    const {
      rows: [{ now }],
    } = await client.query<{ now: string }>(`SELECT now()::text AS now`);
    expect(w!.seenBaselineAt).toBe(now);
  });

  it("will not record a look on somebody else's feed", async () => {
    const other = await account("seen-other");
    const f = await feed(other);
    const w = await recordFeedSeen(reader, f, "2026-01-01 00:00:00+00", 0, client);
    expect(w).toBeNull();
    const { rows } = await client.query(`SELECT seen_baseline_at FROM feeds WHERE id = $1`, [f]);
    expect(rows[0].seen_baseline_at).toBeNull();
  });

  it("the items page carries an asOf a minute behind the server clock", async () => {
    const f = await feed();
    const p = await loadFeedItemsPage(reader, f, 0, undefined, 5, client);
    const {
      rows: [{ lag }],
    } = await client.query<{ lag: number }>(
      `SELECT EXTRACT(EPOCH FROM now() - $1::timestamptz)::float8 AS lag`,
      [p.asOf],
    );
    expect(lag).toBe(60);
  });
});

// =============================================================================
// The routes: what is about the REQUEST. Committed fixtures (the route uses the
// shared pool, which cannot see another client's transaction), cleaned up by
// deleting the owner, which cascades the feed.
// =============================================================================
describe.skipIf(!DB_URL)("the seen routes", () => {
  let client: pg.Client;
  let app: ReturnType<typeof Fastify>;
  let owner = "unset";
  let feedId = "unset";

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const a = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, display_name, nostr_pubkey)
       VALUES ($1, 'seen-route', $2) RETURNING id`,
      [`seen-route-${randHex()}`, randHex().padEnd(64, "0").slice(0, 64)],
    );
    owner = a.rows[0].id;
    const f = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'seen', 1) RETURNING id`,
      [owner],
    );
    feedId = f.rows[0].id;
    sessionSub = owner;
    app = Fastify();
    await app.register(
      async (inst) => {
        registerFeedSeenRoutes(inst);
      },
      { prefix: "/workspace" },
    );
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await client.query(`DELETE FROM accounts WHERE id = $1`, [owner]);
    await client.end();
  });

  async function baseline(): Promise<string | null> {
    const { rows } = await client.query<{ b: string | null }>(
      `SELECT seen_baseline_at::text AS b FROM feeds WHERE id = $1`,
      [feedId],
    );
    return rows[0].b;
  }

  it("answers GET with the window shape", async () => {
    const res = await app.inject({ method: "GET", url: `/workspace/feeds/${feedId}/seen` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const k of ["asOf", "seenBaselineAt", "windowStart", "items", "truncated"]) {
      expect(body).toHaveProperty(k);
    }
  });

  it("answers a malformed asOf with 400, and moves nothing", async () => {
    for (const payload of [{ asOf: "yesterday" }, { asOf: 12 }, {}]) {
      const res = await app.inject({
        method: "POST",
        url: `/workspace/feeds/${feedId}/seen`,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const res = await app.inject({
      method: "POST",
      url: `/workspace/feeds/${feedId}/seen`,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: "not json",
    });
    expect(res.statusCode).toBe(400);
    expect(await baseline()).toBeNull();
  });

  it("accepts the beacon's text/plain body, read back from the DB", async () => {
    const g = await app.inject({ method: "GET", url: `/workspace/feeds/${feedId}/seen` });
    const { asOf } = g.json();
    const res = await app.inject({
      method: "POST",
      url: `/workspace/feeds/${feedId}/seen`,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: JSON.stringify({ asOf }),
    });
    expect(res.statusCode).toBe(200);
    expect(await baseline()).toBe(asOf);
  });

  it("answers 404 on somebody else's feed and on a malformed id", async () => {
    sessionSub = "00000000-0000-0000-0000-000000000000";
    try {
      const other = await app.inject({ method: "GET", url: `/workspace/feeds/${feedId}/seen` });
      expect(other.statusCode).toBe(404);
      const post = await app.inject({
        method: "POST",
        url: `/workspace/feeds/${feedId}/seen`,
        payload: { asOf: "2026-01-01 00:00:00+00" },
      });
      expect(post.statusCode).toBe(404);
    } finally {
      sessionSub = owner;
    }
    const bad = await app.inject({ method: "GET", url: `/workspace/feeds/nope/seen` });
    expect(bad.statusCode).toBe(404);
  });
});
