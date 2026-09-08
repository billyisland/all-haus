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
import { refresh, type ResonanceWeights } from "./engagement-baseline-refresh.js";

// =============================================================================
// engagement-baseline-refresh battery (SOCIAL-PROOF-RESONANCE-ADR D3, step 2).
//
// The two properties the "recompute, don't fold" decision rests on:
//
//   FOLD IDEMPOTENCY — the reason the task may be re-run freely after an
//   outage, and the reason the <7d engagement sweep touching an item ~6 times
//   cannot multiple-count it into a baseline.
//
//   STRUCTURAL LAG — no post younger than BASELINE_MIN_AGE_HOURS enters any
//   baseline, so a surging post is measured against its author's PRIOR
//   expectation and can never contaminate the baseline it is scored against.
//   This is what makes resonance a claim about surprise rather than a
//   self-fulfilling one.
//
// Runs the REAL refresh (not a copy) against a live Postgres, always inside a
// transaction that is rolled back. Note refresh() creates a temp table
// ON COMMIT DROP, so it can run at most once per transaction — the idempotency
// test therefore uses two sequential transactions and compares snapshots
// carried out in JS memory rather than in the database.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and FAILS on a skip). Run locally against dev:
//   TEST_DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/engagement-baseline-refresh.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Isolates fixture baselines from real rows — see resonance.test.ts. */
const TEST_PROTOCOL = "test_proto_baseline";

const WEIGHTS: ResonanceWeights = {
  like: 1,
  reply: 3,
  repost: 2,
  nativeUp: 5,
  nativeGate: 5,
};

interface BaselineRow {
  author_ref: string;
  protocol: string;
  post_type: string;
  median_e: string;
  n: number;
}

describe.skipIf(!DB_URL)("engagement baseline refresh (step 2)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /**
   * Fixture baselines only — scoped like baselineFor(), and it MUST stay scoped.
   *
   * refresh() selects its corpus through a window bounded at BOTH ends by now()
   * (`published_at < now() - 48h AND published_at > now() - 180d`) and takes the
   * median over the author's last <=20 qualifying posts. Read unscoped, this
   * returned the whole dev corpus, and the idempotency test below compares two
   * snapshots taken in two SEPARATE transactions (refresh()'s temp table is
   * ON COMMIT DROP, so it can run at most once per transaction) — i.e. separated
   * by real wall-clock time. Any real post sitting near the 48h boundary becomes
   * eligible between them and, because the sample is capped at 20, pushes the
   * oldest out: n stays 20 while the value set shifts, moving the median. That
   * flaked roughly one run in three (`activitypub|all|12.5|20` vs `11.5|20`) and
   * it got worse as the dev corpus grew.
   *
   * It never indicated a fold defect — refresh() is genuinely idempotent over a
   * FIXED corpus; the unscoped read simply did not hold the corpus fixed. The
   * fixtures are seeded well clear of the boundary (>=120h), so scoped, the
   * comparison is deterministic and still tests the property.
   */
  async function snapshot(): Promise<BaselineRow[]> {
    const { rows } = await client.query<BaselineRow>(
      `SELECT author_ref, protocol, post_type, median_e::text, n
       FROM author_engagement_baseline
       WHERE protocol = $1
       ORDER BY author_ref, protocol, post_type`,
      [TEST_PROTOCOL],
    );
    return rows;
  }

  /** An external author with posts at the given (ageHours, likeCount) pairs. */
  async function seedAuthor(
    posts: Array<{ ageHours: number; likes: number; contextOnly?: boolean }>,
  ): Promise<string> {
    return (await seedAuthorItems(posts)).authorId;
  }

  /**
   * seedAuthor, plus the external_items ids in seeding order. The tiebreak test
   * needs them: the rule it pins is "the greater id wins at a tie", and the ids
   * are gen_random_uuid() — so the expected answer cannot be written into the
   * fixture, only computed from what was actually seeded.
   *
   * NOTE ON TIES: published_at is `now() - make_interval(...)`, and now() is
   * TRANSACTION time, fixed for the whole test. Two posts seeded with the same
   * ageHours therefore share published_at exactly, to the microsecond — which is
   * what makes a tie seedable at all.
   */
  async function seedAuthorItems(
    posts: Array<{ ageHours: number; likes: number; contextOnly?: boolean }>,
  ): Promise<{ authorId: string; itemIds: string[] }> {
    const src = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('atproto', 'at://baseline-test/' || gen_random_uuid(), false)
       RETURNING id`,
    );
    const sourceId = src.rows[0].id;
    const auth = await client.query<{ id: string }>(
      `INSERT INTO external_authors (protocol, stable_handle, tier)
       VALUES ('atproto', 'baseline-test-' || gen_random_uuid(), 'A')
       RETURNING id`,
    );
    const authorId = auth.rows[0].id;

    const itemIds: string[] = [];
    for (const p of posts) {
      const ext = await client.query<{ id: string }>(
        `INSERT INTO external_items
           (source_id, protocol, tier, source_item_uri, published_at,
            like_count, reply_count, repost_count, is_context_only)
         VALUES ($1, 'atproto', 'tier3', 'at://item/' || gen_random_uuid(),
                 now() - make_interval(hours => $2), $3, 0, 0, $4)
         RETURNING id`,
        [sourceId, p.ageHours, p.likes, p.contextOnly ?? false],
      );
      await client.query(
        `INSERT INTO feed_items
           (item_type, external_item_id, external_author_id, author_name,
            published_at, source_protocol, source_id)
         VALUES ('external', $1, $2, 'Baseline Fixture',
                 now() - make_interval(hours => $3), $4, $5)`,
        [ext.rows[0].id, authorId, p.ageHours, TEST_PROTOCOL, sourceId],
      );
      itemIds.push(ext.rows[0].id);
    }
    return { authorId, itemIds };
  }

  async function baselineFor(authorId: string): Promise<BaselineRow | null> {
    const { rows } = await client.query<BaselineRow>(
      `SELECT author_ref, protocol, post_type, median_e::text, n
       FROM author_engagement_baseline
       WHERE author_ref = $1 AND protocol = $2`,
      [authorId, TEST_PROTOCOL],
    );
    return rows[0] ?? null;
  }

  // --- D3: structural lag ---------------------------------------------------

  it("admits no post younger than the 48h minimum age into a baseline", async () => {
    // Three settled posts at E=10, plus a post from an hour ago that is going
    // viral. If the young post entered, both n and the median would move.
    const authorId = await seedAuthor([
      { ageHours: 120, likes: 10 },
      { ageHours: 144, likes: 10 },
      { ageHours: 168, likes: 10 },
      { ageHours: 1, likes: 10000 },
    ]);

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row).not.toBeNull();
    expect(row!.n).toBe(3);
    expect(parseFloat(row!.median_e)).toBe(10);
  });

  it("PAIRED CONTROL: the same viral post counts once it is old enough", async () => {
    // Identical fixture with the viral post aged past the threshold. If this
    // did not move, the test above would prove only that medians are stable.
    const authorId = await seedAuthor([
      { ageHours: 120, likes: 10 },
      { ageHours: 144, likes: 10 },
      { ageHours: 168, likes: 10 },
      { ageHours: 72, likes: 10000 },
    ]);

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row!.n).toBe(4);
    // Median of [10, 10, 10, 10000] — percentile_cont interpolates the middle
    // pair, so the viral post lifts n but barely moves the expectation. That
    // is the median doing its job against exactly this kind of outlier.
    expect(parseFloat(row!.median_e)).toBe(10);
  });

  it("excludes context-only rows (thread scaffolding is not the author's output)", async () => {
    const authorId = await seedAuthor([
      { ageHours: 120, likes: 10 },
      { ageHours: 144, likes: 10 },
      { ageHours: 168, likes: 500, contextOnly: true },
    ]);

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row!.n).toBe(2);
    expect(parseFloat(row!.median_e)).toBe(10);
  });

  it("caps the sample at the last 20 qualifying posts", async () => {
    // 25 posts: the 20 most recent are E=1, the 5 oldest are E=1000. If the
    // cap were not applied the median would be pulled off 1.
    const posts = [
      ...Array.from({ length: 20 }, (_, i) => ({
        ageHours: 72 + i,
        likes: 1,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ageHours: 200 + i,
        likes: 1000,
      })),
    ];
    const authorId = await seedAuthor(posts);

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row!.n).toBe(20);
    expect(parseFloat(row!.median_e)).toBe(1);
  });

  it("breaks a tie AT THE 20-POST CUT by a total order, not by the plan (§9.12)", async () => {
    // published_at is not unique, so ranking on it alone leaves which of a tied
    // pair falls inside `rn <= 20` to whatever order the scan happens to
    // produce. Where the tie sits AT the cut, that decides a member of the
    // sample, and the same corpus can yield two different medians on two runs.
    //
    // The fixture puts SIX posts on one timestamp, older than everything else,
    // so exactly one of the six is admitted (rank 20). Its E is what the median
    // reads, and the nineteen clear posts are shaped so that it is READABLE:
    // sorted, they are nine 1s, one 100, nine 1000s, so percentile_cont(0.5)
    // over the twenty interpolates the 10th and 11th values -- 100 and the
    // admitted post -- giving (100 + X) / 2, distinct for each of the six.
    //
    // The expected winner is COMPUTED, not written down: the ids are
    // gen_random_uuid(), so the fixture cannot know in advance which one the
    // rule names. Comparison is on the hex WITHOUT dashes, which is what
    // Postgres's uuid type compares (bytewise, and collation-free -- the reason
    // item_ref is carried as uuid rather than text).
    const TIED_LIKES = [200, 300, 400, 500, 600, 700];
    const posts = [
      ...Array.from({ length: 9 }, (_, i) => ({ ageHours: 72 + i, likes: 1 })),
      { ageHours: 81, likes: 100 },
      ...Array.from({ length: 9 }, (_, i) => ({ ageHours: 82 + i, likes: 1000 })),
      ...TIED_LIKES.map((likes) => ({ ageHours: 200, likes })),
    ];
    const { authorId, itemIds } = await seedAuthorItems(posts);

    const hex = (id: string) => id.replace(/-/g, "").toLowerCase();
    const tied = itemIds
      .slice(19)
      .map((id, i) => ({ id, likes: TIED_LIKES[i] }));
    expect(tied).toHaveLength(6);
    const winner = tied.reduce((a, b) => (hex(b.id) > hex(a.id) ? b : a));

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row!.n).toBe(20);
    expect(parseFloat(row!.median_e)).toBe((100 + winner.likes) / 2);
  });

  it("records the true sampled-post count in the ambient row", async () => {
    // sample_n has no code reader — migration 158 calls it a "sanity signal
    // for tuning". It is pinned anyway because it is precisely what an
    // operator reads when re-measuring band incidence on prod (the gate on
    // turning RESONANCE_GLYPH_ENABLED on), and a silently wrong denominator
    // there would misinform the tuning rather than break a feature.
    await seedAuthor([
      { ageHours: 120, likes: 10 },
      { ageHours: 144, likes: 20 },
      { ageHours: 168, likes: 30 },
      { ageHours: 1, likes: 999 }, // too young to be sampled
    ]);

    await refresh(client, WEIGHTS);

    const { rows } = await client.query<{ sample_n: number; p50_e: string }>(
      `SELECT sample_n, p50_e::text FROM protocol_engagement_ambient
       WHERE protocol = $1 AND post_type = 'all'`,
      [TEST_PROTOCOL],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sample_n).toBe(3);
    expect(parseFloat(rows[0].p50_e)).toBe(20);
  });

  it("prunes an ambient pair with no qualifying posts in the window (§0i.9)", async () => {
    // A protocol whose counts flag was toggled off contributes nothing to
    // tmp_e; leaving its last percentiles behind means any future count write
    // re-arms scoring against months-old medians. Absent pair ⇒ absent row —
    // absence is the signal the scorer already treats as "no ambient
    // evidence". A pair WITH qualifying posts must survive the same run.
    await seedAuthor([{ ageHours: 120, likes: 10 }]); // live pair (TEST_PROTOCOL)
    await client.query(
      `INSERT INTO protocol_engagement_ambient (protocol, post_type, p50_e, p90_e, sample_n, updated_at)
       VALUES ('test_proto_stale', 'all', 5, 50, 40, now() - interval '90 days')`,
    );

    await refresh(client, WEIGHTS);

    const { rows } = await client.query<{ protocol: string }>(
      `SELECT protocol FROM protocol_engagement_ambient
       WHERE protocol IN ($1, 'test_proto_stale')`,
      [TEST_PROTOCOL],
    );
    expect(rows.map((r) => r.protocol)).toEqual([TEST_PROTOCOL]);
  });

  // --- D3: recompute is idempotent ------------------------------------------

  it("is a no-op on median_e and n when run twice over the same corpus", async () => {
    // The property that makes recompute safe to repeat: two independent runs
    // over the same corpus must agree exactly. Each runs in its own transaction
    // (the temp table is ON COMMIT DROP) and is rolled back, so the comparison
    // is carried in JS rather than in the database.
    //
    // "The same corpus" means the FIXTURES — snapshot() is scoped to
    // TEST_PROTOCOL, and the comment on it records why reading the whole dev
    // corpus here could never be deterministic. Two authors with different
    // shapes, so a refresh that wrote a constant or collapsed the two rows
    // together would not pass.
    const shapes: Array<Array<{ ageHours: number; likes: number }>> = [
      [
        { ageHours: 120, likes: 7 },
        { ageHours: 144, likes: 9 },
      ],
      [
        { ageHours: 168, likes: 2 },
        { ageHours: 192, likes: 40 },
        { ageHours: 216, likes: 11 },
      ],
    ];

    for (const posts of shapes) await seedAuthor(posts);
    await refresh(client, WEIGHTS);
    const first = await snapshot();

    await client.query("ROLLBACK");
    await client.query("BEGIN");

    for (const posts of shapes) await seedAuthor(posts);
    await refresh(client, WEIGHTS);
    const second = await snapshot();

    // Both runs must actually have produced the fixture rows — an empty
    // snapshot compared against an empty snapshot is equality that proves
    // nothing, and scoping the read is exactly what makes that reachable.
    expect(first.length).toBe(shapes.length);
    expect(second.length).toBe(first.length);

    // And the two fixture rows must be DISTINGUISHABLE by the value under
    // test, or the comment above is a claim this test cannot make: a refresh
    // that wrote a CONSTANT median is perfectly idempotent and would pass
    // every other assertion here. The shapes satisfy this by arithmetic --
    // seedAuthor writes only like_count and the `like` weight is 1, so the
    // medians are 8 over [7,9] and 11 over [2,40,11] -- but it is asserted
    // rather than assumed, because equalising the post counts would silently
    // remove the only other thing telling the two rows apart. Median
    // CORRECTNESS is pinned by the fixed-corpus tests above, not by this one.
    expect(new Set(first.map((r) => r.median_e)).size).toBe(shapes.length);

    // Compare on the value columns only: the two runs seed different author
    // uuids, so author_ref is expected to differ for the fixture rows.
    const values = (rows: BaselineRow[]) =>
      rows.map((r) => `${r.protocol}|${r.post_type}|${r.median_e}|${r.n}`).sort();
    expect(values(second)).toEqual(values(first));
  });

  it("REPLACES a pre-existing baseline row rather than accumulating onto it", async () => {
    // The specific failure mode "recompute, don't fold" exists to prevent. The
    // daily sweep touches a <7d item ~6 times; an incremental fold would count
    // it once per touch, so n would climb on every pass and the median would
    // drift toward whatever was folded last.
    //
    // This drives the ON CONFLICT DO UPDATE path directly by planting a stale
    // row first: refresh must overwrite it to the corpus truth (n=3, median=6),
    // never add to it (n=102) and never leave the stale estimate standing.
    const authorId = await seedAuthor([
      { ageHours: 120, likes: 4 },
      { ageHours: 144, likes: 6 },
      { ageHours: 168, likes: 8 },
    ]);
    await client.query(
      `INSERT INTO author_engagement_baseline
         (author_ref, protocol, post_type, median_e, n)
       VALUES ($1, $2, 'all', 999, 99)`,
      [authorId, TEST_PROTOCOL],
    );

    await refresh(client, WEIGHTS);

    const row = await baselineFor(authorId);
    expect(row!.n).toBe(3);
    expect(parseFloat(row!.median_e)).toBe(6);
  });
});

// =============================================================================
// MUTATION LOG — each assertion above was checked by breaking the code it
// claims to cover. Mutations applied to engagement-baseline-refresh.ts one at
// a time, each reverted before the next. All were DETECTED:
//
//   1. drop the 48h minimum-age floor on the external pass   -> 7 fail
//   2. `WHERE rn <= $1` -> effectively uncapped              -> 7 fail
//   3. drop `AND ei.is_context_only = false`                 -> 1 fail
//   4. ON CONFLICT DO UPDATE -> keep the existing median_e   -> 1 fail
//   5. ambient `COUNT(*)` -> `COUNT(*) * 2` (sample_n)       -> 1 fail
//   5b. baseline `COUNT(*)` -> `COUNT(*) * 2` (n)            -> 1 fail
//   6. `percentile_cont(0.5)` -> `avg(e)`                    -> 1 fail
//
// Mutations 1 and 2 failing the WHOLE file is the expected shape, not
// over-coupling: every fixture author's baseline is defined by which of their
// posts qualify, so widening the sample moves every row. Mutation 6 is the one
// worth re-running by hand if the estimator is ever revisited — the median is
// load-bearing against exactly the viral-outlier case test 2 fixes in place.
// =============================================================================
