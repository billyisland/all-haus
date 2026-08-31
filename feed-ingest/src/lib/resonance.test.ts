import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";
import {
  EXTERNAL_RESONANCE_SQL,
  NATIVE_RESONANCE_SQL,
  type ResonanceParams,
} from "./resonance.js";

// =============================================================================
// Resonance scoring battery (SOCIAL-PROOF-RESONANCE-ADR D2a/D3/D4/D5, step 3).
//
// The ADR specifies a test battery; steps 4 and 5 got tests and step 3 did not,
// so the mathematical core of the feature — shrinkage, the ambient veto, the
// band gates, absence semantics — shipped uncovered. This is that battery.
//
// Runs the crons' OWN SQL (the exported strings, not a copy) against a live
// Postgres, with every fixture seeded inside a transaction that is ALWAYS
// rolled back. Skipped unless a DB URL is supplied so the no-Postgres CI `test`
// job stays green. Run locally against dev:
//   TEST_DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/lib/resonance.test.ts
//
// ISOLATION. The external pass keys its ambient join on feed_items.source_
// protocol, which is free TEXT — so every external fixture below files itself
// under the synthetic protocol `test_proto`. No real row can join a test
// ambient value and no test touches the shared atproto/activitypub ambients.
// The native pass hardcodes protocol 'native', so those tests must upsert the
// real ('native', …) ambient rows; that write is real but rolled back, and the
// native pass has no id filter (it recomputes the whole 7-day window), so it
// also rewrites dev's few real native rows to values the rollback discards.
//
// A note on what these assertions are worth: each one is derived by hand from
// the ADR's formulae and then pinned, and the veto/gate cases carry PAIRED
// CONTROLS — a second row differing in exactly the one input under test — so a
// pass means the named mechanism fired, not that some other clause happened to
// produce the same band. Every test here was mutation-checked (see the file's
// closing comment) before being believed.
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Synthetic protocol — isolates external fixtures from all real ambient rows. */
const TEST_PROTOCOL = "test_proto";

/** Weights as shipped; individual tests override where the point is the weight. */
const PARAMS: ResonanceParams = {
  like: 1,
  reply: 3,
  repost: 2,
  nativeUp: 5,
  nativeGate: 5,
  k: 3,
  band1: 2.5,
  band2: 4,
  band3: 6,
};

interface Scored {
  resonance: number | null;
  resonance_band: number | null;
  ambient_pctl: number | null;
}

describe.skipIf(!DB_URL)("resonance scoring (step 3)", () => {
  let client: pg.Client;
  let sourceId: string;
  let authorId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const src = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('atproto', 'at://resonance-test/' || gen_random_uuid(), false)
       RETURNING id`,
    );
    sourceId = src.rows[0].id;
    const auth = await client.query<{ id: string }>(
      `INSERT INTO external_authors (protocol, stable_handle, tier)
       VALUES ('atproto', 'resonance-test-' || gen_random_uuid(), 'A')
       RETURNING id`,
    );
    authorId = auth.rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // --- fixture helpers ------------------------------------------------------

  /** Sets the ambient distribution the fixtures are scored against. */
  async function ambient(
    p50: number,
    p90: number,
    protocol = TEST_PROTOCOL,
    postType = "all",
  ): Promise<void> {
    await client.query(
      `INSERT INTO protocol_engagement_ambient (protocol, post_type, p50_e, p90_e, sample_n)
       VALUES ($1, $2, $3, $4, 100)
       ON CONFLICT (protocol, post_type) DO UPDATE
         SET p50_e = EXCLUDED.p50_e, p90_e = EXCLUDED.p90_e`,
      [protocol, postType, p50, p90],
    );
  }

  /** The author's prior expectation. Omit entirely to exercise the n=0 path. */
  async function baseline(
    medianE: number,
    n: number,
    protocol = TEST_PROTOCOL,
  ): Promise<void> {
    await client.query(
      `INSERT INTO author_engagement_baseline (author_ref, protocol, post_type, median_e, n)
       VALUES ($1, $2, 'all', $3, $4)`,
      [authorId, protocol, medianE, n],
    );
  }

  /**
   * An external item + its feed_items row. Counts are raw; E is derived by the
   * SQL under test, never precomputed here.
   */
  async function externalItem(counts: {
    likes?: number;
    replies?: number;
    reposts?: number;
    protocol?: string;
  }): Promise<{ externalItemId: string; feedItemId: string }> {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, published_at,
          like_count, reply_count, repost_count)
       VALUES ($1, 'atproto', 'tier3', 'at://item/' || gen_random_uuid(),
               now() - interval '5 days', $2, $3, $4)
       RETURNING id`,
      [sourceId, counts.likes ?? 0, counts.replies ?? 0, counts.reposts ?? 0],
    );
    const fi = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, external_item_id, external_author_id, author_name,
          published_at, source_protocol, source_id)
       VALUES ('external', $1, $2, 'Resonance Fixture',
               now() - interval '5 days', $3, $4)
       RETURNING id`,
      [ext.rows[0].id, authorId, counts.protocol ?? TEST_PROTOCOL, sourceId],
    );
    return { externalItemId: ext.rows[0].id, feedItemId: fi.rows[0].id };
  }

  /** Runs the real external cron SQL over the given external_item ids. */
  async function scoreExternal(
    ids: string[],
    overrides: Partial<ResonanceParams> = {},
  ): Promise<number> {
    const p = { ...PARAMS, ...overrides };
    const res = await client.query(EXTERNAL_RESONANCE_SQL, [
      ids,
      p.like,
      p.reply,
      p.repost,
      p.k,
      p.band1,
      p.band2,
      p.band3,
    ]);
    return res.rowCount ?? 0;
  }

  async function read(feedItemId: string): Promise<Scored> {
    const { rows } = await client.query<{
      resonance: string | null;
      resonance_band: number | null;
      ambient_pctl: string | null;
    }>(
      `SELECT resonance, resonance_band, ambient_pctl FROM feed_items WHERE id = $1`,
      [feedItemId],
    );
    const r = rows[0];
    return {
      resonance: r.resonance === null ? null : parseFloat(r.resonance),
      resonance_band: r.resonance_band,
      ambient_pctl: r.ambient_pctl === null ? null : parseFloat(r.ambient_pctl),
    };
  }

  /** Inverts resonance = log2((1+E)/(1+baseline)) to recover the E the SQL computed. */
  function recoverE(resonance: number, baselineValue: number): number {
    return Math.pow(2, resonance) * (1 + baselineValue) - 1;
  }

  // --- D3: shrinkage --------------------------------------------------------

  describe("D3 shrinkage toward ambient", () => {
    it("scores an author with no baseline row purely against network ambient (n=0)", async () => {
      // baseline = (0·0 + k·p50)/(0 + k) = p50, for any k. The LEFT JOIN's
      // cold-start answer: a new author is measured against their network.
      await ambient(10, 40);
      const { externalItemId, feedItemId } = await externalItem({ likes: 31 });
      await scoreExternal([externalItemId]);

      const got = await read(feedItemId);
      // E = 31·1 = 31, baseline = 10 → log2(32/11)
      expect(got.resonance).toBeCloseTo(Math.log2(32 / 11), 6);
      expect(recoverE(got.resonance!, 10)).toBeCloseTo(31, 6);
    });

    it("weights a well-established author's own median at n/(n+k)", async () => {
      // baseline = (n·M + k·p50)/(n + k). With p50 = 0 this is exactly
      // M·n/(n+k) = M·20/23 = 86.96% of the author's own median.
      await ambient(0, 0);
      await baseline(100, 20);
      const { externalItemId, feedItemId } = await externalItem({ likes: 100 });
      await scoreExternal([externalItemId]);

      const got = await read(feedItemId);
      const expectedBaseline = (20 * 100 + 3 * 0) / 23;
      expect(expectedBaseline / 100).toBeCloseTo(20 / 23, 6);
      expect(got.resonance).toBeCloseTo(Math.log2(101 / (1 + expectedBaseline)), 6);

      // NOTE for the ADR: the battery's "n=20 author is >=87% own-median" holds
      // only when ambient p50 > 0. The fraction is (20M + 3p)/(23M) =
      // 0.8696 + 0.1304·(p/M), i.e. exactly 86.96% at p50 = 0 and above 87%
      // once p/M > 0.0031. The mechanism is right; the round number isn't a
      // floor. Asserted here as the algebra, not the prose.
      expect(20 / 23).toBeLessThan(0.87);
    });

    it("moves the baseline toward the author as n grows (k held at 3)", async () => {
      // Same author median, same ambient, different confidence: the low-n item
      // is pulled toward ambient and so scores as the bigger surprise.
      await ambient(50, 100);
      await baseline(2, 1);
      const lowN = await externalItem({ likes: 20 });
      await scoreExternal([lowN.externalItemId]);
      const lowNScore = (await read(lowN.feedItemId)).resonance!;

      await client.query(
        `UPDATE author_engagement_baseline SET n = 50 WHERE author_ref = $1`,
        [authorId],
      );
      const highN = await externalItem({ likes: 20 });
      await scoreExternal([highN.externalItemId]);
      const highNScore = (await read(highN.feedItemId)).resonance!;

      // n=1:  baseline = (1·2 + 3·50)/4  = 38.0   → log2(21/39) < 0
      // n=50: baseline = (50·2 + 3·50)/53 = 4.717 → log2(21/5.717) > 0
      expect(lowNScore).toBeCloseTo(Math.log2(21 / 39), 6);
      expect(highNScore).toBeCloseTo(Math.log2(21 / (250 / 53 + 1)), 6);
      expect(highNScore).toBeGreaterThan(lowNScore);
    });
  });

  // --- D4: the ambient veto -------------------------------------------------

  describe("D4 ambient percentile as a veto, never a boost", () => {
    // The fixtures below use n = 20, which is the LARGEST n that can ever be
    // stored: engagement-baseline-refresh writes n = COUNT(*) over the last
    // BASELINE_LAST_N = 20 qualifying posts. That cap matters — it is what
    // makes the band-1 veto reachable only above a fairly loud ambient, and
    // the band-2 veto unreachable altogether (see the redundancy note below).

    it("holds a high-resonance item at band 0 while its E is below ambient p50", async () => {
      // The case the veto exists for: a shrunk-to-nothing baseline makes a
      // modest absolute response look enormous in ratio terms.
      // n=20, M=0, p50=25, k=3 → baseline = 75/23 = 3.2609
      // E = 24 → resonance = log2(25/4.2609) = 2.553, clears band1 (2.5)...
      // ...but E=24 < p50=25, so every band above 0 is vetoed.
      await ambient(25, 400);
      await baseline(0, 20);
      const { externalItemId, feedItemId } = await externalItem({ likes: 24 });
      await scoreExternal([externalItemId]);

      const got = await read(feedItemId);
      expect(got.resonance).toBeGreaterThan(PARAMS.band1);
      expect(got.resonance_band).toBe(0);
    });

    it("PAIRED CONTROL: the same item bands up once ambient p50 drops to its E", async () => {
      // Identical in every input except the ambient median, moved by one so
      // that E now meets it. If this did not move, the test above would be
      // proving the band gate, not the veto.
      await ambient(24, 400);
      await baseline(0, 20);
      const { externalItemId, feedItemId } = await externalItem({ likes: 24 });
      await scoreExternal([externalItemId]);

      const got = await read(feedItemId);
      expect(got.resonance).toBeGreaterThan(PARAMS.band1);
      expect(got.resonance_band).toBe(1);
    });

    it("requires p90 for band 3, not merely p50", async () => {
      // Resonance clears the band-3 gate outright, and E clears p50 — but not
      // p90, which is the one thing band 3 additionally demands. n=0 and
      // p50=0 give baseline 0, so resonance = log2(1 + 63) = 6.0 exactly.
      await ambient(0, 200);
      const { externalItemId, feedItemId } = await externalItem({ likes: 63 });
      await scoreExternal([externalItemId]);

      const got = await read(feedItemId);
      expect(got.resonance).toBeCloseTo(6, 9);
      expect(got.resonance).toBeGreaterThanOrEqual(PARAMS.band3);
      expect(got.resonance_band).toBe(2);
    });
  });

  // --- D4: band gates -------------------------------------------------------

  describe("D4 band gates", () => {
    /**
     * A row with baseline 0 and a fully-cleared veto (p50 = p90 = 0), so
     * resonance = log2(1 + E) exactly and the band is a pure function of the
     * gates. E = 7 → resonance = 3.0 on the nose, which lets the gates be
     * moved across a known value rather than the value across fixed gates.
     */
    async function itemAtResonanceThree(): Promise<{
      externalItemId: string;
      feedItemId: string;
    }> {
      await ambient(0, 0);
      return externalItem({ likes: 7 });
    }

    it("lands the exact boundary in the band it gates (>= is inclusive)", async () => {
      const { externalItemId, feedItemId } = await itemAtResonanceThree();
      await scoreExternal([externalItemId], { band1: 3, band2: 4, band3: 6 });

      const got = await read(feedItemId);
      expect(got.resonance).toBeCloseTo(3, 9);
      expect(got.resonance_band).toBe(1);
    });

    it("drops a hair below the boundary to the band beneath", async () => {
      const { externalItemId, feedItemId } = await itemAtResonanceThree();
      await scoreExternal([externalItemId], {
        band1: 3.000001,
        band2: 4,
        band3: 6,
      });

      expect((await read(feedItemId)).resonance_band).toBe(0);
    });

    it("selects the highest band the score qualifies for", async () => {
      const two = await itemAtResonanceThree();
      await scoreExternal([two.externalItemId], { band1: 2, band2: 3, band3: 6 });
      expect((await read(two.feedItemId)).resonance_band).toBe(2);

      const three = await externalItem({ likes: 7 });
      await scoreExternal([three.externalItemId], {
        band1: 1,
        band2: 2,
        band3: 3,
      });
      expect((await read(three.feedItemId)).resonance_band).toBe(3);
    });

    it("derives E from the configured weights, not hardcoded ones", async () => {
      await ambient(0, 0);
      const { externalItemId, feedItemId } = await externalItem({
        likes: 2,
        replies: 3,
        reposts: 4,
      });
      await scoreExternal([externalItemId], { like: 10, reply: 100, repost: 1000 });

      // 2·10 + 3·100 + 4·1000 = 4320
      const got = await read(feedItemId);
      expect(recoverE(got.resonance!, 0)).toBeCloseTo(4320, 3);
    });
  });

  // --- Absence, not zero ----------------------------------------------------

  describe("absence semantics (INNER JOIN on ambient)", () => {
    it("leaves a protocol with no ambient row entirely NULL, never band 0", async () => {
      // No ambient() call at all: `unmeasured_proto` has no row, so the INNER
      // JOIN drops the item. This is the rss/email and dark-nostr case — the
      // card must render no glyph, which it can only do if the column is NULL.
      const { externalItemId, feedItemId } = await externalItem({
        likes: 500,
        protocol: "unmeasured_proto",
      });
      const updated = await scoreExternal([externalItemId]);

      expect(updated).toBe(0);
      const got = await read(feedItemId);
      expect(got.resonance).toBeNull();
      expect(got.resonance_band).toBeNull();
      expect(got.ambient_pctl).toBeNull();
    });

    it("scores a measured sibling in the same batch (the join is the only filter)", async () => {
      await ambient(1, 2);
      const measured = await externalItem({ likes: 5 });
      const unmeasured = await externalItem({
        likes: 5,
        protocol: "unmeasured_proto",
      });
      const updated = await scoreExternal([
        measured.externalItemId,
        unmeasured.externalItemId,
      ]);

      expect(updated).toBe(1);
      expect((await read(measured.feedItemId)).resonance).not.toBeNull();
      expect((await read(unmeasured.feedItemId)).resonance).toBeNull();
    });

    it("skips soft-deleted rows", async () => {
      await ambient(1, 2);
      const { externalItemId, feedItemId } = await externalItem({ likes: 5 });
      await client.query(
        `UPDATE feed_items SET deleted_at = now() WHERE id = $1`,
        [feedItemId],
      );

      expect(await scoreExternal([externalItemId])).toBe(0);
      expect((await read(feedItemId)).resonance).toBeNull();
    });
  });

  // --- D5: ambient percentile -----------------------------------------------

  describe("D5 ambient_pctl piecewise interpolation", () => {
    async function pctlFor(
      e: number,
      p50: number,
      p90: number,
    ): Promise<number | null> {
      await ambient(p50, p90);
      const { externalItemId, feedItemId } = await externalItem({ likes: e });
      await scoreExternal([externalItemId]);
      return (await read(feedItemId)).ambient_pctl;
    }

    it("floors a silent item at 0", async () => {
      expect(await pctlFor(0, 10, 40)).toBe(0);
    });

    it("interpolates 0 -> p50 across 0.0-0.5", async () => {
      expect(await pctlFor(5, 10, 40)).toBeCloseTo(0.25, 6);
    });

    it("interpolates p50 -> p90 across 0.5-0.9", async () => {
      expect(await pctlFor(20, 10, 30)).toBeCloseTo(0.7, 6);
    });

    it("compresses the tail above p90 into 0.9-1.0 and clamps at 1", async () => {
      expect(await pctlFor(40, 10, 30)).toBeCloseTo(0.9 + 0.1 * (10 / 30), 6);
      expect(await pctlFor(100000, 10, 30)).toBe(1);
    });

    it("handles a quiet network where p50 = 0 without dividing by zero", async () => {
      // Any engagement at all is already above the median, so the item starts
      // at 0.5 and interpolates over 0 -> p90 instead.
      expect(await pctlFor(5, 0, 10)).toBeCloseTo(0.7, 6);
    });

    it("saturates when the network is silent end to end (p90 = 0)", async () => {
      expect(await pctlFor(3, 0, 0)).toBe(1);
    });
  });

  // --- D2a: native engagement parity ----------------------------------------

  describe("D2a native E composition", () => {
    it("counts up-votes, non-charged-back gate passes and replies, and nothing else", async () => {
      // The single assertion that pins all three weights AND both exclusions:
      // E is recovered from the score and compared to the hand-computed value.
      await ambient(0, 0, "native", "article");

      const writer = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES (encode(gen_random_bytes(32), 'hex')) RETURNING id`,
      );
      const writerId = writer.rows[0].id;
      const reader = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES (encode(gen_random_bytes(32), 'hex')) RETURNING id`,
      );
      const readerId = reader.rows[0].id;

      const eventId = "e".repeat(64);
      const article = await client.query<{ id: string }>(
        `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
         VALUES ($1, $2, 'resonance-test-d-tag', 'Fixture', 'resonance-test-slug', now() - interval '2 days')
         RETURNING id`,
        [writerId, eventId],
      );
      const articleId = article.rows[0].id;

      const feedItem = await client.query<{ id: string }>(
        `INSERT INTO feed_items
           (item_type, article_id, author_id, author_name, published_at, nostr_event_id)
         VALUES ('article', $1, $2, 'Fixture Writer', now() - interval '2 days', $3)
         RETURNING id`,
        [articleId, writerId, eventId],
      );
      const feedItemId = feedItem.rows[0].id;

      // 2 up-votes (count) + 1 down-vote (must NOT subtract, D2 valence axis)
      for (const [i, direction] of [
        [1, "up"],
        [2, "up"],
        [3, "down"],
      ] as const) {
        const voter = await client.query<{ id: string }>(
          `INSERT INTO accounts (nostr_pubkey) VALUES (encode(gen_random_bytes(32), 'hex')) RETURNING id`,
        );
        await client.query(
          `INSERT INTO votes (voter_id, target_nostr_event_id, target_author_id, direction, sequence_number)
           VALUES ($1, $2, $3, $4, $5)`,
          [voter.rows[0].id, eventId, writerId, direction, i],
        );
      }

      // 3 reads, one charged back (must NOT count)
      for (const state of ["accrued", "platform_settled", "charged_back"]) {
        await client.query(
          `INSERT INTO read_events (reader_id, article_id, writer_id, amount_pence, state)
           VALUES ($1, $2, $3, 10, $4::read_state)`,
          [readerId, articleId, writerId, state],
        );
      }

      // 2 replies; a 'like' row must not be picked up by the reply term
      await client.query(
        `INSERT INTO feed_engagement (target_nostr_event_id, engagement_type)
         VALUES ($1, 'reply'), ($1, 'reply'), ($1, 'like')`,
        [eventId],
      );

      await client.query(NATIVE_RESONANCE_SQL, [
        7,
        PARAMS.nativeUp,
        PARAMS.nativeGate,
        PARAMS.reply,
        PARAMS.k,
        PARAMS.band1,
        PARAMS.band2,
        PARAMS.band3,
      ]);

      // E = 5·(2 up) + 5·(2 non-charged-back reads) + 3·(2 replies) = 26
      const got = await read(feedItemId);
      expect(got.resonance).not.toBeNull();
      expect(recoverE(got.resonance!, 0)).toBeCloseTo(26, 6);
    });
  });
});

// =============================================================================
// MUTATION LOG — every assertion above was checked by breaking the code it
// claims to cover, per the M4(b) lesson (a test that passes the moment you
// write it has proved nothing yet). Mutations applied to resonance.ts one at a
// time, each reverted before the next:
//
//   DETECTED (the battery fails):
//    1. bandExpr: drop `AND r.e >= r.p50_e` from the band-1 arm  -> 2 fail
//    2. bandExpr: drop `AND r.e >= r.p90_e` from the band-3 arm  -> 1 fail
//    3. bandExpr: `>=` -> `>` on the band-1 gate                 -> 1 fail
//    4. scoreTail: JOIN ambient -> LEFT JOIN                     -> 2 fail
//    5. scoreTail: drop the `k * amb.p50_e` term                 -> 2 fail
//    6. scoreTail: `COALESCE(b.n,0) + k` -> `COALESCE(b.n,1) + k`
//       in the DENOMINATOR                                       -> 2 fail
//    7. PCTL_EXPR: drop the LEAST(1.0, …) tail clamp             -> 1 fail
//    8. native: `state <> 'charged_back'` -> `true`              -> 1 fail
//    9. native: count all votes, not just `direction = 'up'`     -> 1 fail
//
//   SURVIVED, AND CORRECTLY SO — two clauses are provably redundant. These are
//   findings about the CODE, not gaps in the battery; do not write a test to
//   "cover" them, because no input can distinguish their presence:
//
//   A. bandExpr's `AND r.e >= r.p50_e` on the BAND-2 arm is unreachable.
//      baseline >= k·p50/(n+k), and engagement-baseline-refresh writes
//      n = COUNT(*) over the last BASELINE_LAST_N = 20 posts, so n <= 20 and
//      baseline >= 3·p50/23. resonance >= 4 then forces
//      1+E >= 16(1 + 3·p50/23) = 16 + 2.087·p50, while the veto can only bind
//      when 1+E < 1+p50. Together: 1+p50 > 16 + 2.087·p50, i.e. p50 < -13.8 —
//      impossible for a non-negative ambient. Anything scoring band-2
//      resonance has already cleared p50 on arithmetic alone. (The band-1 arm
//      IS reachable, but only once ambient p50 >= 22 — which is why the veto
//      fixtures above are built at p50 = 25 rather than a smaller round
//      number that would have made the clause vacuous there too.)
//
//   B. PCTL_EXPR's `WHEN r.p50_e <= 0` branch computes exactly what the
//      general path already computes at p50 = 0. Its stated purpose is
//      avoiding a divide-by-zero in the `0.5 * e / p50` segment, but that
//      segment is guarded by `r.e < r.p50_e`, which is unreachable when
//      p50 = 0 and e > 0 (e <= 0 having returned 0 in the first branch). Both
//      remaining segments reduce to the same expressions: `0.5 + 0.4·e/p90`
//      and the clamped tail.
//
//   Both are retained rather than deleted: they cost nothing, they document
//   the intent, and B is a genuine guard if p50 could ever go negative. They
//   are recorded here so the next reader doesn't mistake a surviving mutation
//   for an untested branch. Reported to the ADR's open questions.
//
// If you change the scoring math, re-run this list (the harness lives in the
// FIX-PROGRAMME entry for this batch). A green suite after a behavioural
// change to the expressions above means the battery has drifted, not that the
// change was safe.
// =============================================================================
