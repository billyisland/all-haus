import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { feedAlphaCte } from "../src/lib/feed-rank.js";
import { sourceSelectionCtes, SOURCE_WINDOW_BUCKETS } from "../src/lib/source-selection.js";
import { dedupCtes } from "../src/lib/dedup-sql.js";

// =============================================================================
// Per-source selection — integration test (migration 202)
//
// Drives the REAL SQL builder, the same string feeds/items.ts splices in, so
// there is no second copy to drift. Every fixture is seeded inside a
// transaction that is ALWAYS rolled back.
//
// THE CLAIM UNDER TEST IS AN INDEPENDENCE CLAIM, and nothing before this file
// tested it — there was no test of the composed feed query at all. The old
// design could not have passed: `weight` multiplied the whole feed's sort key
// and `sampling_mode` was resolved by a MAJORITY VOTE across the feed's
// sources, so turning one source down moved every other source's items and
// switching one to TOP re-ranked the lot.
//
// MUTATION LOG. A passing new test proves nothing until it has been made to
// fail, so each of these was applied to src/, the suite re-run, and reverted.
//
//   A. the arms stop gating replies (drop the exclude_replies predicate)
//      ⇒ "does not count replies a source excludes" fails.          DETECTED
//   B. the external arm stops gating is_context_only
//      ⇒ "does not count context-only hydration rows" fails.        DETECTED
//   C. the pre-fix dedup wiring restored — the CTEs after `matched`, reading
//      it, with nothing suppressed before the window
//      ⇒ "gives a cross-posted pair ONE ticket" fails, with the loser in the
//        page: the exact defect, a winner cut out of the candidate set so
//        nothing suppresses its twin.                               DETECTED
//      This one cannot be made smaller. The fix IS the ordering: point
//      `candidates` at `matched` while leaving it downstream and the CTEs are
//      mutually recursive, so there is no one-word version of this mutation.
//   D. percent_rank() → cume_dist() (the off-by-one class)
//      ⇒ 8 of 18 fail, including the rate case.                     DETECTED
//   E. drop `rn <= SOURCE_WINDOW`, so the cut is taken over the source's whole
//      history rather than the window
//      ⇒ "takes the cut over the WINDOW" fails (200, expected 100). DETECTED
//      NOTE: this mutation SURVIVED the suite as first written. Every existing
//      case either ran at full volume, where the cut takes no predicate at
//      all, or had fewer than SOURCE_WINDOW posts in a source. The window was
//      the load-bearing constant nothing measured; case E is why it now is.
//
// Skipped unless a DB URL is supplied — CI supplies one and FAILS on a skip:
//   TEST_DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/source-selection.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The host's own layout, which the builder depends on: $1 reader, $2 feed,
// $3 limit, then α and the floor, then the optional cursor pair. `$2` in
// particular is not negotiable — sourceSelectionCtes reads the feed id from it
// by contract.
const P_ALPHA = 4;
const P_FLOOR = 5;
const P_CURSOR_TS = 6;
const P_CURSOR_ID = 7;
// Dedup's confidence floor takes whatever index is FREE in this shape, exactly
// as the live host's `params.push` does. It was a constant 6 — the cursor
// pair's first slot — on the reasoning that only the no-cursor shape binds it;
// that was true, and it was also the harness's biggest blind spot. No case
// could bind the dedup fragment and a cursor TOGETHER, so every dedup case was
// single-page BY CONSTRUCTION — and a single page is precisely where the
// cursor-bounded dedup pool looks correct. The suite could not reach the
// defect it was written to guard.
//
// A function rather than a constant, because Postgres refuses a bind carrying
// more parameters than the statement uses: each shape must bind exactly what
// it reads, which is the rule the live host observes for the same reason.
const pConfidence = (hasCursor: boolean) => (hasCursor ? 8 : 6);

function selectSql(hasCursor: boolean, dedup = false): string {
  return `
    WITH${dedup ? " RECURSIVE" : ""} ${feedAlphaCte(P_ALPHA).trim()},
    ${sourceSelectionCtes({
      alphaParam: P_ALPHA,
      floorParam: P_FLOOR,
      // Indices, not a clause: the builder spends the cursor in two places
      // (the arms' bucket bound and the keyset after the cut) and owns both.
      cursor: hasCursor ? { tsParam: P_CURSOR_TS, idParam: P_CURSOR_ID } : null,
      dedupCtes: dedup ? dedupCtes(pConfidence(hasCursor)) : "",
    })}
    SELECT fi.id AS fi_id, fi.published_at,
           EXTRACT(EPOCH FROM fi.published_at) AS secs
      FROM feed_items fi
      JOIN matched m ON m.fi_id = fi.id
     WHERE fi.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
       )
     ORDER BY fi.published_at DESC, fi.id DESC
     LIMIT $3`;
}

describe.skipIf(!DB_URL)("per-source selection", () => {
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
    reader = await account("selection-reader");
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

  async function feed(owner: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'sel', 1) RETURNING id`,
      [owner],
    );
    return rows[0].id;
  }

  async function externalSource(protocol = "atproto"): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ($1::external_protocol, $2) RETURNING id`,
      [protocol, `https://sel.test/${randHex()}`],
    );
    return rows[0].id;
  }

  /** Attach a source to a feed at a given throughput + mode. Returns fs.id. */
  async function attach(
    feedId: string,
    target: { externalSourceId?: string; accountId?: string; tagName?: string },
    opts: {
      throughput?: number;
      mode?: "scored" | "random";
      excludeReplies?: boolean;
    } = {},
  ): Promise<string> {
    const type = target.externalSourceId
      ? "external_source"
      : target.accountId
        ? "account"
        : "tag";
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_sources
         (feed_id, source_type, external_source_id, account_id, tag_name,
          throughput, sampling_mode, exclude_replies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        feedId,
        type,
        target.externalSourceId ?? null,
        target.accountId ?? null,
        target.tagName ?? null,
        opts.throughput ?? 1.0,
        opts.mode ?? "scored",
        opts.excludeReplies ?? false,
      ],
    );
    return rows[0].id;
  }

  /** One external post, `ageMinutes` old, with an explicit proof level. */
  async function post(
    sourceId: string,
    opts: {
      ageMinutes: number;
      resonance?: number | null;
      protocol?: string;
      isReply?: boolean;
      contextOnly?: boolean;
      /** Shared body text — the trigger derives dedup_fingerprint from it. */
      text?: string;
      /** Mints an `external_authors` row and points the item at it (L6.5). */
      authorPubkey?: string;
    },
  ): Promise<string> {
    const protocol = opts.protocol ?? "atproto";
    // protocol_tier_consistency pins the pair: atproto/activitypub ⇒ tier3,
    // nostr_external ⇒ tier2, rss/email ⇒ tier4.
    const tier =
      protocol === "rss" || protocol === "email"
        ? "tier4"
        : protocol === "nostr_external"
          ? "tier2"
          : "tier3";
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, published_at,
          is_context_only, content_text)
       VALUES ($1, $2::external_protocol, $5::content_tier, $3,
               now() - make_interval(mins => $4), $6, $7)
       RETURNING id`,
      [
        sourceId,
        protocol,
        `uri:${randHex()}`,
        opts.ageMinutes,
        tier,
        opts.contextOnly ?? false,
        opts.text ?? null,
      ],
    );
    // An `external_authors` row where the caller names one, so the npub-block
    // arm has a `stable_handle` to compare against. Null otherwise, which is
    // the ordinary tier-C/D shape and the case the LEFT JOIN has to keep.
    let authorId: string | null = null;
    if (opts.authorPubkey) {
      const a = await client.query<{ id: string }>(
        `INSERT INTO external_authors (protocol, stable_handle, tier)
         VALUES ($1::external_protocol, $2, 'B')
         ON CONFLICT (protocol, stable_handle) DO UPDATE SET tier = EXCLUDED.tier
         RETURNING id`,
        [protocol, opts.authorPubkey],
      );
      authorId = a.rows[0].id;
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at, source_protocol,
          source_id, biddability_tier, post_id, resonance, is_reply,
          external_author_id)
       VALUES ('external', $1, 'fixture', now() - make_interval(mins => $2), $3,
               $4, 'B', $5, $6, $7, $8)
       RETURNING id`,
      [
        ext.rows[0].id,
        opts.ageMinutes,
        protocol,
        sourceId,
        `post:${randHex()}`,
        opts.resonance ?? null,
        opts.isReply ?? false,
        authorId,
      ],
    );
    return rows[0].id;
  }

  /** A native article by `writer`, tagged `tag`, for the tag arm. */
  async function article(
    writer: string,
    tag: string,
    opts: { ageMinutes: number; resonance: number | null },
  ): Promise<string> {
    const a = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
       VALUES ($1, $2, $3, 'fixture', $4, now() - make_interval(mins => $5))
       RETURNING id`,
      [writer, `ev:${randHex()}`, `d:${randHex()}`, `slug-${randHex()}`, opts.ageMinutes],
    );
    const t = await client.query<{ id: string }>(
      `INSERT INTO tags (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tag],
    );
    await client.query(
      `INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2)`,
      [a.rows[0].id, t.rows[0].id],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, article_id, author_id, published_at, biddability_tier, post_id, resonance)
       VALUES ('article', $1, $2, now() - make_interval(mins => $3), 'A', $4, $5)
       RETURNING id`,
      [a.rows[0].id, writer, opts.ageMinutes, `post:${randHex()}`, opts.resonance],
    );
    return rows[0].id;
  }

  async function page(
    feedId: string,
    opts: {
      limit?: number;
      cursor?: [number, string];
      dedup?: boolean;
    } = {},
  ): Promise<{ ids: string[]; last?: [number, string] }> {
    // Bind exactly what the shape reads, in the order the indices above
    // declare: base, then the cursor pair if there is one, then the
    // confidence floor if dedup is on. A cursor AND dedup is now expressible,
    // which is the whole point of the change.
    const params: unknown[] = [reader, feedId, opts.limit ?? 100, 0.8, 0.05];
    if (opts.cursor) params.push(opts.cursor[0], opts.cursor[1]);
    if (opts.dedup) params.push(0.9);
    const { rows } = await client.query<{ fi_id: string; secs: string }>(
      selectSql(!!opts.cursor, opts.dedup),
      params,
    );
    const last = rows.at(-1);
    return {
      ids: rows.map((r) => r.fi_id),
      last: last ? [Number(last.secs), last.fi_id] : undefined,
    };
  }

  // --- the independence claim ----------------------------------------------

  it("turning ONE source down leaves every other source's items untouched", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const loud = await externalSource();
    const quiet = await externalSource();
    await attach(f, { externalSourceId: loud });
    const quietFs = await attach(f, { externalSourceId: quiet });

    const loudPosts: string[] = [];
    for (let i = 0; i < 10; i++) {
      loudPosts.push(await post(loud, { ageMinutes: i * 10, resonance: i }));
      await post(quiet, { ageMinutes: i * 10 + 5, resonance: i });
    }

    const before = (await page(f)).ids.filter((id) => loudPosts.includes(id));
    await client.query(`UPDATE feed_sources SET throughput = 0.4 WHERE id = $1`, [
      quietFs,
    ]);
    const after = (await page(f)).ids.filter((id) => loudPosts.includes(id));

    // Byte-identical, order included. Under the old design this could not hold:
    // weight multiplied the shared sort key, so quieting one source moved the
    // others relative to it.
    expect(after).toEqual(before);
    expect(after).toHaveLength(10);
  });

  it("the same source at different volumes in two feeds cuts independently", async () => {
    const owner = await account("owner");
    const [f1, f2] = [await feed(owner), await feed(owner)];
    const src = await externalSource();
    await attach(f1, { externalSourceId: src }, { throughput: 1.0 });
    await attach(f2, { externalSourceId: src }, { throughput: 0.4, mode: "scored" });
    for (let i = 0; i < 10; i++) {
      await post(src, { ageMinutes: i * 10, resonance: i });
    }

    expect((await page(f1)).ids).toHaveLength(10);
    expect((await page(f2)).ids).toHaveLength(4);
  });

  it("full volume takes everything, whatever the mode says", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 1.0, mode: "random" });
    for (let i = 0; i < 12; i++) await post(src, { ageMinutes: i, resonance: null });
    expect((await page(f)).ids).toHaveLength(12);
  });

  it("a post admitted by ANY matching source survives the other's cut", async () => {
    // The successor to the old MAX(weight): adding a source can only ever add
    // posts. Here one source is turned right down and another is wide open, and
    // the SAME items match both.
    const owner = await account("owner");
    const f = await feed(owner);
    const writer = await account("writer");
    await attach(f, { accountId: writer }, { throughput: 0.2, mode: "scored" });
    await attach(f, { tagName: "sel-any" }, { throughput: 1.0 });
    for (let i = 0; i < 10; i++) {
      await article(writer, "sel-any", { ageMinutes: i * 10, resonance: i });
    }
    expect((await page(f)).ids).toHaveLength(10);
  });

  // --- TOP ------------------------------------------------------------------

  it("TOP keeps the most resonant fraction, not the most recent", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.4, mode: "scored" });
    // Resonance runs OPPOSITE to recency, so a recency-ordered cut returns the
    // other half entirely — the two answers are disjoint, not merely different.
    //
    // The values stay INSIDE the [0,4] clamp on purpose. At resonance = i the
    // top six all clamp to 4, tie, and the published_at tiebreak then returns
    // the four FRESHEST of them — a fixture that tests the tiebreak while
    // claiming to test the ranking.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await post(src, { ageMinutes: i * 10, resonance: i * 0.4 }));
    }
    const got = (await page(f)).ids;
    expect(got).toHaveLength(4);
    // The four most resonant are the four OLDEST here.
    expect(new Set(got)).toEqual(new Set(ids.slice(6)));
  });

  it("a source with no engagement signal falls back to its most recent", async () => {
    // rss carries no counts, so every item's resonance is NULL, every criterion
    // ties at the floor, and the published_at tiebreak decides. The throughput
    // promise is kept exactly; it is the word "top" that degrades.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource("rss");
    await attach(f, { externalSourceId: src }, { throughput: 0.6, mode: "scored" });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await post(src, { ageMinutes: i * 10, resonance: null, protocol: "rss" }));
    }
    const got = (await page(f)).ids;
    expect(got).toHaveLength(6);
    expect(got).toEqual(ids.slice(0, 6)); // the six freshest, in order
  });

  it("cuts a tag ACROSS its whole population, not per contributing author", async () => {
    // The partition is feed_sources.id. Partitioned by the item's own origin
    // instead, each writer would keep their own top 50% and the quiet writer
    // would survive — which is the bug this asserts against.
    const owner = await account("owner");
    const f = await feed(owner);
    const loudWriter = await account("loud");
    const quietWriter = await account("quiet");
    await attach(f, { tagName: "sel-tag" }, { throughput: 0.4, mode: "scored" });

    for (let i = 0; i < 8; i++) {
      await article(loudWriter, "sel-tag", { ageMinutes: i * 10, resonance: 4 });
    }
    const quietIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      quietIds.push(
        await article(quietWriter, "sel-tag", { ageMinutes: i * 10 + 5, resonance: 0 }),
      );
    }

    const got = (await page(f)).ids;
    expect(got).toHaveLength(4);
    // Every survivor is the loud writer's; the quiet writer is cut entirely.
    for (const id of quietIds) expect(got).not.toContain(id);
  });

  // --- RANDOM ---------------------------------------------------------------

  it("RANDOM is stable: the same request twice returns the same sample", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.6, mode: "random" });
    for (let i = 0; i < 40; i++) await post(src, { ageMinutes: i * 10 });

    const a = (await page(f)).ids;
    const b = (await page(f)).ids;
    expect(b).toEqual(a);
    // A sample, not everything and not nothing — the predicate is doing work.
    expect(a.length).toBeGreaterThan(10);
    expect(a.length).toBeLessThan(40);
  });

  it("RANDOM gives the same post independent draws in two different feeds", async () => {
    // Keyed on (item, feed_sources.id), so one feed's sample is not the other's.
    // Keyed on the item alone, these two would be identical.
    const owner = await account("owner");
    const [f1, f2] = [await feed(owner), await feed(owner)];
    const src = await externalSource();
    await attach(f1, { externalSourceId: src }, { throughput: 0.5, mode: "random" });
    await attach(f2, { externalSourceId: src }, { throughput: 0.5, mode: "random" });
    for (let i = 0; i < 60; i++) await post(src, { ageMinutes: i * 10 });

    const a = new Set((await page(f1)).ids);
    const b = (await page(f2)).ids;
    const overlap = b.filter((id) => a.has(id)).length;
    // Independent draws at p=0.5 over ~60 items: identical sets are what a
    // shared key would give, and that is what this rules out.
    expect(overlap).toBeLessThan(b.length);
  });

  it("pages a RANDOM feed without duplicates or a reshuffle", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.6, mode: "random" });
    for (let i = 0; i < 60; i++) await post(src, { ageMinutes: i * 10 });

    const seen = new Set<string>();
    let cursor: [number, string] | undefined;
    let pages = 0;
    for (;;) {
      const r: { ids: string[]; last?: [number, string] } = await page(f, {
        limit: 5,
        cursor,
      });
      if (r.ids.length === 0) break;
      for (const id of r.ids) {
        expect(seen.has(id)).toBe(false); // the whole point
        seen.add(id);
      }
      cursor = r.last;
      if (++pages > 20) break;
    }
    expect(pages).toBeGreaterThan(3);
    expect(seen.size).toBeGreaterThan(10);
  });

  it("holds the TOP rate to the cursor's exhaustion, on a source whose criterion TIES", async () => {
    // THE DEFECT THIS PINS, AND THE PROMISE THE VOLUME BAR MAKES. rss, email
    // and external nostr carry no engagement by construction, so every one of
    // their posts lands on the proof FLOOR and they all tie — and the ranking
    // tiebreak is `published_at DESC`. With the measurement window taken at or
    // below the CURSOR, the newest post below the cursor is therefore ALWAYS
    // percent_rank 0 and always admitted: the cursor can never get past a
    // selected post to skip an unselected one, so a source set to 60% delivers
    // 100% the moment the client follows nextCursor. Driven on dev before the
    // fix: 60 rss posts at TOP 0.6 → 36 on the first request, 60/60 after
    // paging to exhaustion.
    //
    // The twin of `pages a RANDOM feed without duplicates`, which passes
    // against the defect because the stable hash is a function of the ROW and
    // so was page-independent already. TOP had to become one.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource("rss");
    await attach(f, { externalSourceId: src }, { throughput: 0.6, mode: "scored" });
    // Ten minutes apart, so they land in the same fixed bucket and the cut is
    // taken over one complete population rather than across a boundary.
    for (let i = 0; i < 60; i++)
      await post(src, { ageMinutes: i * 10, protocol: "rss" });

    const seen = new Set<string>();
    let cursor: [number, string] | undefined;
    for (let pages = 0; pages < 30; pages++) {
      const r: { ids: string[]; last?: [number, string] } = await page(f, {
        limit: 5,
        cursor,
      });
      if (r.ids.length === 0) break;
      for (const id of r.ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      cursor = r.last;
    }

    // The bar said 60%. Paging to exhaustion must not turn that into 100%.
    // A band rather than an exact count: the cut is taken per fixed bucket, so
    // where the boundaries fall costs a post or two either way — which is the
    // accepted seam, not a licence for the rate to drift.
    expect(seen.size).toBeGreaterThan(25);
    expect(seen.size).toBeLessThan(45);
  });

  // --- the window -----------------------------------------------------------

  it("keeps returning items past the window bound — there is no floor under the feed", async () => {
    // The window is the source's most recent SOURCE_WINDOW_BUCKETS POPULATED
    // buckets at or below the cursor's own bucket, so it slides down with the
    // reader a week at a time. Bounded by a fixed calendar span instead, a
    // single-source feed would simply END at the span's edge; bounded by
    // buckets that exist, a dormant source still hands over its most recent
    // weeks whenever they fall below the cursor.
    //
    // The fixture spans THREE TIMES the bound, so the window has to slide
    // several times to return everything.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 1.0 });
    const weeks = SOURCE_WINDOW_BUCKETS * 3;
    const total = weeks * 4;
    for (let i = 0; i < total; i++)
      // Four per week, walking back a week at a time.
      await post(src, { ageMinutes: Math.floor(i / 4) * 7 * 24 * 60 + (i % 4) * 30 });

    const seen = new Set<string>();
    let cursor: [number, string] | undefined;
    for (let i = 0; i < 20; i++) {
      const r: { ids: string[]; last?: [number, string] } = await page(f, {
        limit: 50,
        cursor,
      });
      if (r.ids.length === 0) break;
      r.ids.forEach((id) => seen.add(id));
      cursor = r.last;
    }
    expect(seen.size).toBe(total);
  });

  it("a descending keyset loses nothing into the sub-second gap between pages", async () => {
    // The timestamp-cursor rule's own failure mode, and the direction where it
    // is silent: a truncated cursor lands EARLIER, so rows inside the lost
    // microseconds fall outside both pages and nothing revisits them. Only
    // Postgres reproduces this, which is why the fixture shares a second.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 1.0 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await post(src, { ageMinutes: 0 });
      // All six inside one second, distinct by microseconds.
      await client.query(
        `UPDATE feed_items SET published_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [id, i * 0.000123],
      );
      ids.push(id);
    }

    const seen: string[] = [];
    let cursor: [number, string] | undefined;
    for (let i = 0; i < 10; i++) {
      const r: { ids: string[]; last?: [number, string] } = await page(f, {
        limit: 2,
        cursor,
      });
      if (r.ids.length === 0) break;
      seen.push(...r.ids);
      cursor = r.last;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });
  // --- the rate the bar actually promises ----------------------------------
  //
  // The tests above are all RELATIVE — independence, stability, ordering. None
  // of them would notice if "40%" delivered a quarter of a source, which is the
  // one thing the control says out loud.

  it("is a RATE: a source at 40% returns 40% of its posts", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.4 });
    for (let i = 0; i < 100; i++)
      await post(src, { ageMinutes: i, resonance: i / 100 });

    // percent_rank over 100 rows is (rank-1)/99, so `pr < 0.4` keeps ranks
    // 1..40 — exact, not approximate, which is why this asserts a number.
    const r = await page(f);
    expect(r.ids.length).toBe(40);
  });

  it("keeps the comparison STRICT at the boundary — `pr < t`, never `pr <= t`", async () => {
    // The off-by-one nobody could see. Every other fixture in this file has a
    // non-integer (N−1)·throughput, so no row ever lands exactly ON the
    // boundary and `pr < t` → `pr <= t` left all eighteen green. Eleven rows
    // at 0.4 puts one there precisely: percent_rank over 11 is (rank−1)/10, so
    // rank 5 is exactly 0.4 — kept by `<=`, dropped by `<`.
    //
    // `<` is the right side of it: at throughput 0 nothing may be admitted,
    // and `pr <= 0` would keep every source's best post at a setting that
    // means "none of this source". (Step 0 is mute and stores no throughput,
    // so that is not reachable through the UI — but the rule is the query's,
    // not the surface's.)
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.4 });
    for (let i = 0; i < 11; i++)
      await post(src, { ageMinutes: i, resonance: (11 - i) / 11 });

    const r = await page(f);
    expect(r.ids.length).toBe(4);
  });

  it("takes the cut INSIDE each bucket, so a quiet week is not judged against a busy one", async () => {
    // The denominator is the bucket, not the source's whole history and not a
    // window that starts wherever the reader is. Two weeks, one busy and one
    // quiet, with the quiet week's posts scoring BELOW every post in the busy
    // one: measured together, the quiet week would be cut away entirely at 50%
    // — "half of this source" delivering none of one week and all of another.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.5 });

    const WEEK = 7 * 24 * 60;
    const busy: string[] = [];
    for (let i = 0; i < 20; i++)
      // This week, resonance 2.0–3.9 — every one of them above the quiet week.
      busy.push(await post(src, { ageMinutes: 60 + i * 30, resonance: 2 + i / 10 }));
    const quiet: string[] = [];
    for (let i = 0; i < 6; i++)
      // Two weeks back, resonance 0.0–0.5.
      quiet.push(await post(src, { ageMinutes: 2 * WEEK + i * 60, resonance: i / 10 }));

    const r = await page(f, { limit: 500 });
    // Each week cut at its own 50%: 10 of 20, 3 of 6.
    expect(r.ids.filter((id) => busy.includes(id))).toHaveLength(10);
    expect(r.ids.filter((id) => quiet.includes(id))).toHaveLength(3);
  });

  it("does not count replies a source excludes against that source's cut", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(
      f,
      { externalSourceId: src },
      { throughput: 0.5, excludeReplies: true },
    );
    const real: string[] = [];
    for (let i = 0; i < 40; i++)
      real.push(await post(src, { ageMinutes: i, resonance: i / 100 }));
    for (let i = 0; i < 60; i++)
      await post(src, { ageMinutes: i, resonance: i / 100, isReply: true });

    // 40 deliverable posts, half of them = 20. Measured over all 100 rows the
    // cut would admit 50, and the reply filter downstream would leave ~20 of a
    // promised 50 — the bar lying by a factor of 2.5. On the dev corpus 61% of
    // external feed_items are replies, so this is the ordinary case, not a
    // corner.
    const r = await page(f);
    expect(r.ids.length).toBe(20);
    expect(r.ids.every((id) => real.includes(id))).toBe(true);
  });

  it("keeps a platform-blocked npub out of the arm, and out of the denominator", async () => {
    // L6.5 / D7 §5. The block is item-level DELIVERABILITY, so it belongs in
    // the arm rather than in the ranking pass: a blocked identity's posts
    // cannot arrive, so counting them in the percentile would make the bar
    // promise a share of a population that includes them — the same fault
    // `exclude_replies` had, one column over.
    //
    // 20 deliverable posts at 0.5 = 10. Filtered downstream instead, the cut
    // would be taken over 50 and admit 25, of which ~10 would render.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource("nostr_external");
    await attach(f, { externalSourceId: src }, { throughput: 0.5 });

    const clean = "1".repeat(64);
    const blocked = "2".repeat(64);
    const real: string[] = [];
    for (let i = 0; i < 20; i++)
      real.push(
        await post(src, {
          ageMinutes: i,
          resonance: i / 100,
          protocol: "nostr_external",
          authorPubkey: clean,
        }),
      );
    for (let i = 0; i < 30; i++)
      await post(src, {
        ageMinutes: i,
        resonance: 0.9,
        protocol: "nostr_external",
        authorPubkey: blocked,
      });

    await client.query(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
       VALUES ('npub', 'nostr_external', $1, 'fixture')`,
      [blocked],
    );

    const r = await page(f);
    expect(r.ids.length).toBe(10);
    // The negative control, and it is the one that matters: a predicate that
    // matched everything would also produce a short page.
    expect(r.ids.every((id) => real.includes(id))).toBe(true);
  });

  it("keeps posts with NO author row — the LEFT JOIN must not drop them", async () => {
    // Most tier-C/D external rows carry no `external_authors` record at all,
    // so the npub comparison is against NULL. An inner join, or a predicate
    // that treated NULL as a match, would empty the feed for every rss and
    // email source on the platform — silently, and in the reassuring
    // direction, since an empty source reads as a quiet one.
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource("rss");
    await attach(f, { externalSourceId: src });
    const real: string[] = [];
    for (let i = 0; i < 6; i++)
      real.push(await post(src, { ageMinutes: i, resonance: null, protocol: "rss" }));

    await client.query(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
       VALUES ('npub', 'nostr_external', $1, 'fixture')`,
      ["3".repeat(64)],
    );

    const r = await page(f);
    expect(r.ids.sort()).toEqual([...real].sort());
  });

  it("does not count context-only hydration rows against a source's cut", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const src = await externalSource();
    await attach(f, { externalSourceId: src }, { throughput: 0.5 });
    const real: string[] = [];
    for (let i = 0; i < 20; i++)
      real.push(await post(src, { ageMinutes: i, resonance: i / 100 }));
    // Thread participants pulled in for context inherit the focal's source_id,
    // so they land in this source's arm and can never render (20% of external
    // feed_items on dev).
    for (let i = 0; i < 30; i++)
      await post(src, { ageMinutes: i, resonance: 0.9, contextOnly: true });

    const r = await page(f);
    expect(r.ids.length).toBe(10);
    expect(r.ids.every((id) => real.includes(id))).toBe(true);
  });

  // --- CA-C4: an item reaches every source that SERVES it ------------------
  //
  // An item is one row whose `source_id` names the FIRST source that wrote it.
  // A second source serving the same item (a category feed of the same site,
  // a Lemmy community and its poster) wrote nothing, and a feed built on it
  // never carried the item. The arm joins through `external_item_sources`.

  async function servedBy(feedItemId: string, sourceId: string): Promise<void> {
    await client.query(
      `INSERT INTO external_item_sources (external_item_id, source_id)
       SELECT external_item_id, $2 FROM feed_items WHERE id = $1`,
      [feedItemId, sourceId],
    );
  }

  it("an item another source wrote first reaches a feed built on a source that also serves it", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const first = await externalSource("rss");
    const second = await externalSource("rss");
    await attach(f, { externalSourceId: second });
    const shared = await post(first, { ageMinutes: 5, protocol: "rss" });

    // The control: served by `first` alone, it is not this feed's.
    expect((await page(f)).ids).not.toContain(shared);

    await servedBy(shared, second);
    expect((await page(f)).ids).toEqual([shared]);
  });

  it("dedups a shared item through the component of the source that SERVES it, not its home", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    // `home` wrote the item and is linked to nothing; `serving` also serves
    // it and is linked to `twin`, which carries the same post, older.
    const home = await externalSource();
    const [serving, twin] = [await externalSource(), await externalSource()].sort();
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_asserted', 1.0, NULL)`,
      [serving, twin],
    );
    const text = `the same thing posted to two networks ${randHex()}`;
    await attach(f, { externalSourceId: serving });
    await attach(f, { externalSourceId: twin });
    const winner = await post(twin, { ageMinutes: 100, text });
    const loser = await post(home, { ageMinutes: 99, text });
    await servedBy(loser, serving);

    const r = await page(f, { dedup: true });
    expect(r.ids).toContain(winner);
    expect(r.ids).not.toContain(loser);
  });

  // --- dedup resolves BEFORE the cut ---------------------------------------

  it("gives a cross-posted pair ONE ticket in the cut, not one each", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    // Ordered pair: the link table CHECKs source_a_id < source_b_id.
    const [a, b] = [await externalSource(), await externalSource()].sort();
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_asserted', 1.0, NULL)`,
      [a, b],
    );
    // dedup_fingerprint is trigger-computed from content_text, and the
    // normaliser returns NULL under 32 surviving characters — so the shared
    // body has to be a real sentence, exactly as a cross-post is.
    const text = `the same thing posted to two networks ${randHex()}`;

    // The winner is the OLDER copy (dedup-sql orders published_at ASC). Put it
    // on a source turned down, and give it the worst proof in that source's
    // population so the cut rejects it.
    await attach(f, { externalSourceId: a }, { throughput: 0.5 });
    const winner = await post(a, {
      ageMinutes: 100,
      resonance: 0,
      text,
    });
    for (let i = 0; i < 9; i++)
      await post(a, { ageMinutes: 90 - i, resonance: 1 + i });

    // The loser sits on a source at full volume, so nothing but suppression can
    // keep it out.
    await attach(f, { externalSourceId: b }, { throughput: 1.0 });
    const loser = await post(b, {
      ageMinutes: 99,
      resonance: 4,
      text,
    });

    const r = await page(f, { dedup: true });
    // Fed a POST-cut candidate set, the winner is absent from `candidates`,
    // nothing suppresses the loser, and the loser renders — then the winner's
    // window slides on a later page and BOTH copies are in the feed. Resolved
    // before the cut, the pair competes once, on the winner's source, and loses.
    expect(r.ids).not.toContain(loser);
    expect(r.ids).not.toContain(winner);
  });

  it("keeps the winner and drops the loser when the winner survives its cut", async () => {
    const owner = await account("owner");
    const f = await feed(owner);
    const [a, b] = [await externalSource(), await externalSource()].sort();
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_asserted', 1.0, NULL)`,
      [a, b],
    );
    const text = `the same thing posted to two networks ${randHex()}`;
    await attach(f, { externalSourceId: a }, { throughput: 1.0 });
    await attach(f, { externalSourceId: b }, { throughput: 1.0 });
    const winner = await post(a, { ageMinutes: 100, text });
    const loser = await post(b, { ageMinutes: 99, text });

    const r = await page(f, { dedup: true });
    expect(r.ids).toContain(winner);
    expect(r.ids).not.toContain(loser);
  });

  it("suppresses the loser on EVERY page, even when the winner is newer than it", async () => {
    // THE DEFECT THIS PINS. `candidates` used to read the cursor-bounded pool,
    // so a page whose cursor sits BELOW the winner had a candidate set with no
    // winner in it — nothing suppressed the loser, and the loser rendered.
    // The winner order is (tprio, published_at, …) ASC, so tier beats date:
    // when the winner is the NEWER copy (a tier-A/B mirror of a lower-tier
    // original) it is exactly the copy a descending keyset leaves behind. That
    // is the common cross-protocol `bridge` shape — Mastodon original older,
    // Bluesky mirror newer and higher tier.
    //
    // It needs a CURSOR to reach, which is why it survived: until the
    // confidence param stopped squatting on slot 6, no case in this file could
    // bind dedup and a cursor at once.
    const owner = await account("owner");
    const f = await feed(owner);
    const [a, b] = [await externalSource(), await externalSource()].sort();
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_asserted', 1.0, NULL)`,
      [a, b],
    );
    const text = `the same thing posted to two networks ${randHex()}`;

    // Both at full volume: nothing but suppression can keep either out.
    await attach(f, { externalSourceId: a }, { throughput: 1.0 });
    await attach(f, { externalSourceId: b }, { throughput: 1.0 });

    // The winner is tier A and NEWER; the loser is tier D and older, and the
    // two straddle a bucket boundary — which is what is left of this hole once
    // the measurement window is bucket-granular rather than cursor-relative.
    // A pair inside one bucket now arrives together (the arms take the whole
    // of the cursor's week), so the case that survives is the one where the
    // winner sits in a bucket the reader has already paged past. `post()`
    // writes biddability_tier 'B' for every row, so set the pair explicitly —
    // tprio is what makes the newer copy win.
    const WEEK = 7 * 24 * 60;
    const winner = await post(a, { ageMinutes: 10, text });
    const loser = await post(b, { ageMinutes: 2 * WEEK, text, protocol: "rss" });
    await client.query(
      `UPDATE feed_items SET biddability_tier = 'A' WHERE id = $1`,
      [winner],
    );
    await client.query(
      `UPDATE feed_items SET biddability_tier = 'D' WHERE id = $1`,
      [loser],
    );
    // Fillers between and below, so the reader can page PAST the winner's
    // bucket and still have the loser ahead of them.
    for (let i = 0; i < 3; i++)
      await post(a, { ageMinutes: WEEK + i * 60 });

    // One page: the pool holds both, the winner suppresses the loser.
    const whole = await page(f, { limit: 100, dedup: true });
    expect(whole.ids).toHaveLength(4);

    // Now page through it one row at a time. The suppression must survive the
    // cursor descending past the winner.
    const seen: string[] = [];
    let cursor: [number, string] | undefined;
    for (let i = 0; i < 10; i++) {
      const r: { ids: string[]; last?: [number, string] } = await page(f, {
        limit: 1,
        cursor,
        dedup: true,
      });
      if (r.ids.length === 0) break;
      seen.push(...r.ids);
      cursor = r.last;
    }
    expect(seen).toContain(winner);
    // The whole claim: paging must not resurrect the copy one page already
    // decided against.
    expect(seen).not.toContain(loser);
    expect(seen).toHaveLength(4);
  });
});

function randHex(): string {
  return process.hrtime.bigint().toString(16);
}
