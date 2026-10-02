// =============================================================================
// Per-source selection — the volume bar, as it was always specified.
//
// `feed_sources.throughput` (migration 202) is the fraction of a source's posts
// that reach the feed, and `sampling_mode` decides WHICH fraction. Selection
// happens per source, inside that source's own posts; the survivors merge
// chronologically. One source's setting therefore cannot move another's, which
// is the whole point and is what the previous design could not do:
//
//   - `weight` multiplied the feed's sort key. In a chronological feed that
//     meant multiplying a Unix epoch, so one step down sorted a post published
//     today as if published in 1998 — below a full-volume post from 2020.
//   - `sampling_mode` was decided by a MAJORITY VOTE across the feed's sources
//     (the old FEED_SAMPLING_MODE_SQL) and applied to every item in it, so
//     switching one source to TOP re-ranked every other source too.
//
// Both were recorded in items.ts as deferred rather than absent ("Per-source
// mode mixing inside one feed … is also deferred"; "true random pagination
// requires a stable seed per cursor and is deferred"). This is that work.
//
// Factored out of feeds/items.ts on the dedup-sql.ts / feed-rank.ts pattern so
// the integration test drives the *exact* SQL the live feed runs — there is no
// second copy to drift.
//
// HOST CONTRACT
//   - `$1` is the reader id and `$2` the feed id, as sourceFilteredItems
//     already threads them; every other param index is an argument, because the
//     host's layout varies with the optional cursor pair.
//   - The host must splice `feedAlphaCte` (feed-rank.ts) into the same WITH
//     list — `source_arms` reads `feed_alpha`.
//   - These CTEs END in `matched`, projecting `fi_id`, which is what the
//     ranking pass expects. Nothing downstream of `matched` changes.
//   - The dedup fragments are handed IN (`opts.dedupCtes`) rather than spliced
//     after, and the relation they read is `source_pool` — see below.
//
// WHY DEDUP SITS IN THE MIDDLE, AND WHAT GOES WRONG WHEN IT DOESN'T. Slice 8's
// whole design is a winner that does not depend on the page (dedup-sql.ts). The
// cut does depend on the page: `percent_rank` is taken over a window that slides
// down with the cursor, so a post cut on page 1 can be selected on page 3. Feed
// the dedup CTEs a post-cut relation and both halves of the guarantee break, in
// opposite directions on different pages:
//
//   - the winner is cut, so nothing suppresses the loser and the loser renders;
//     two pages later the winner's window has slid, the winner is selected, and
//     BOTH copies of one post are in the feed. (This is why the dedup input is
//     pre-cut.)
//   - conversely, a winner that can never render must not suppress a sibling
//     that can, or both copies disappear — the M11 failure `candidates` guards
//     against by mirroring the host's visibility predicates.
//
// So: `source_pool` (deliverable, pre-window, pre-cut) is the dedup input, and
// `suppressed` is applied BEFORE the window. A cross-posted pair therefore gets
// exactly ONE ticket in the cut — the winner's — rather than one each, which
// would also have made cross-posted content likelier to survive a low
// throughput than anything posted once.
//
// PARALLEL SAFETY — the reason RANDOM is a hash and not `random()`. `random()`
// is PARALLEL RESTRICTED (`pg_proc.proparallel = 'r'`), and a parallel-unsafe
// node anywhere in the expression tree costs the whole plan its parallelism —
// the finding behind items.ts's plan probe. `hashtext` is PARALLEL SAFE, so
// moving random sampling onto it RESTORES a parallel plan the old query lost
// for every feed that had a random source in it. It is also what makes random
// pagination possible at all: the value is a pure function of (item, source),
// so page 2 cannot reshuffle what page 1 decided.
//
// `hashtext` is an internal function and Postgres does not promise its output
// across major versions (the partitioning hashes are the ones with that
// guarantee). A server upgrade would therefore re-roll every RANDOM source
// once, which is harmless — a reshuffle, not a loss, and nothing is stored —
// but it is the reason not to persist a draw or key anything else on it.
// =============================================================================

import { dedupSuppressFilter } from "./dedup-sql.js";
import { npubBlockedSql } from "@platform-pub/shared/lib/platform-blocks.js";

// THE MEASUREMENT WINDOW IS ANCHORED ON FIXED CALENDAR BOUNDARIES, NOT ON THE
// CURSOR — and that is the whole of the rate promise.
//
// A percentile needs a denominator, and "everything this source has ever
// posted" is both unbounded work and the wrong answer: a source's older
// material would be judged against a distribution the reader is not looking at.
// The first version therefore measured each source's most recent 200 posts AT
// OR BELOW THE CURSOR, which slid down with the reader — and that is precisely
// what broke the promise it was written to keep.
//
// WHY, because it is not obvious and it was live for a week. rss, email and
// external nostr carry no engagement by construction, so every one of their
// posts lands on the proof floor and they all TIE; the ranking's tiebreak is
// `published_at DESC`. In a window that starts at the cursor, the newest post
// below the cursor is therefore ALWAYS `percent_rank` 0 and always admitted —
// the cursor can never get past a selected post to skip an unselected one. A
// source set to 60% delivered 36 of 60 on the first request and **60 of 60**
// once the client followed `nextCursor`, which is every source the code's own
// header counts as silent. Measured sources swung with their criterion's
// correlation to recency (older-is-stronger 14%, newer-is-stronger 100%);
// only an uncorrelated one held the rate.
//
// So a post's admission must be a function of the ROW, never of where the
// reader happens to be. The window is now a CALENDAR WEEK — `date_trunc('week',
// published_at)`, a pure function of the post — and the cut is taken inside it.
// Two consequences, both deliberate:
//
//   · the rate holds at every depth, because paging changes which buckets are
//     in range and never what a bucket contains;
//   · there are visible SEAMS at the boundaries. A week with three posts at 60%
//     keeps two (67%); a week with one keeps it (100%). The rate is exact over
//     a populated week and coarse over a sparse one, and that is the price of
//     a page-independent cut. The operator chose it (2026-09-16) over the
//     alternative — a stable per-row draw for the tie group — which is exact
//     everywhere but makes a silent source's TOP indistinguishable from its
//     RANDOM, retiring a distinction the volume bar sells for every protocol.
//
// THE CURSOR STILL BOUNDS THE SCAN, at bucket granularity: the arms take posts
// below the END of the cursor's week, so the cursor's own week arrives WHOLE.
// A partially-populated bucket would reintroduce the defect one bucket at a
// time. The exact keyset then runs AFTER the cut (`matched`), where it is a
// page bound and nothing else.
export const SOURCE_BUCKET_SQL = `date_trunc('week', fi.published_at)`;

// How many of a source's populated buckets one page considers.
//
// This is what bounds the sort — the job `SOURCE_WINDOW = 200` used to do, and
// the reason a deep page is not slower than page 1. It is a count of BUCKETS
// THAT EXIST rather than a calendar span, so a dormant source still contributes
// its most recent weeks whenever they fall below the cursor: there is no floor
// under the feed and no window that can come back empty while older posts
// remain (which would stop pagination with the feed reading as finished).
//
// Not a dial: a structural bound on how much of a source one page will
// consider, not a value to be tuned against live distributions.
export const SOURCE_WINDOW_BUCKETS = 4;

export interface SourceSelectionOpts {
  /** Param index carrying α (see feedAlphaCte). */
  alphaParam: number;
  /** Param index carrying the proof floor. */
  floorParam: number;
  /**
   * The cursor pair's PARAM INDICES — `[tsParam, idParam]`, or null on page 1.
   *
   * Indices rather than a ready-made clause, because the cursor is now spent
   * in TWO places with two different spellings and one of them cannot be
   * written by the host: the arms take a bucket-granular bound (posts below
   * the END of the cursor's week, so that week arrives whole — see
   * SOURCE_BUCKET_SQL), and `matched` takes the exact keyset AFTER the cut.
   * Handing in a clause meant the host wrote `AND (fi.published_at, fi.id) < …`
   * and the builder spliced it wherever it liked; that is how the measurement
   * window came to start at the cursor in the first place.
   */
  cursor: { tsParam: number; idParam: number } | null;
  /**
   * The Slice 8 dedup CTE list (`lib/dedup-sql.ts::dedupCtes`), or "" when this
   * reader has no applicable links. It is spliced INSIDE this list rather than
   * after it, because cross-source dedup has to resolve BEFORE the cut — see
   * WHY DEDUP SITS IN THE MIDDLE below.
   */
  dedupCtes?: string;
  /**
   * Param index carrying the unread window's floor (`windowStart`, a
   * `timestamptz` as text), or absent for an ordinary page.
   *
   * THE READING COUNTS' ONE PREDICATE, AND WHERE IT GOES IS THE WHOLE RULE
   * (WORKSPACE-QUEUE-ADR §IV.2). It is applied in `matched`, beside the
   * keyset — AFTER the cut — and never in the arms. The arms feed
   * `source_windowed` and `source_ranked`, so a date bound there would
   * half-empty the previous week's bucket and re-rank what is left: a source
   * at 40% would deliver a different 40% of last week to the count than to
   * the timeline, and the count would name posts the reader can never see.
   */
  windowStartParam?: number;
}

/**
 * The TOP criterion: a post's standing within its own source.
 *
 * This is the D6 proof term (SOCIAL-PROOF-RESONANCE-ADR) — α·resonance_norm +
 * (1−α)·ambient_pctl, clamped — WITHOUT the age decay that `proofBlendScoreSql`
 * wrapped it in. Decay earned its place when this expression ordered a whole
 * feed; inside a window that is already bounded by recency it would only
 * re-select recent posts, which is what the reader gets from the 100% setting.
 *
 * THE FLOOR IS THE SILENT-SOURCE FALLBACK, and it is the same floor for the
 * same reason D6 introduced it. Resonance is absent by construction for RSS and
 * email (structurally silent) and for external nostr while its counts flag is
 * dark — on the dev corpus, 0 of 28,019 nostr items and 0 of 2,787 rss items
 * carry one, against 72% for atproto and 79% for activitypub. Those posts
 * COALESCE to 0 and land on the floor, so they tie with each other and the
 * ordering's `published_at DESC` tiebreak decides between them: a fully silent
 * source at 60% returns its most recent 60%, in order, with no special case
 * anywhere in the query. A partially measured source keeps its measured posts
 * above its unmeasured ones, which is the honest ranking of what we know.
 *
 * Both inputs are clamped rather than trusted: `resonance` is unbounded above
 * (log2 of an arbitrary ratio) and negative below, and `ambient_pctl` is a
 * plain NUMERIC that should be in [0,1]. One bad row must not be able to
 * dominate a source's whole cut.
 */
export function proofTermSql(floorParam: number): string {
  return `GREATEST(
      (SELECT alpha FROM feed_alpha)
        * LEAST(GREATEST(COALESCE(fi.resonance, 0)::float8, 0), 4) / 4
    + (1 - (SELECT alpha FROM feed_alpha))
        * LEAST(GREATEST(COALESCE(fi.ambient_pctl, 0)::float8, 0), 1),
    $${floorParam}::float8
  )`;
}

/**
 * A stable pseudo-random value in [0,1) per (item, source).
 *
 * Keyed on both ids, so the same post sampled by two different sources — or by
 * the same source in two different feeds, `feed_sources.id` being per feed —
 * gets independent draws, while any one draw is identical on every page and
 * every request. `hashtext` returns a signed int4; the mask clears the sign bit
 * rather than `abs()`, which overflows on INT_MIN.
 */
export const STABLE_SAMPLE_SQL = `
  ((hashtext(fi.id::text || fs.id::text) & 2147483647)::float8 / 2147483648.0)`;

/**
 * The CTE list, ending in `matched`. Splice into the host's WITH:
 *
 *   WITH [RECURSIVE] ${feedAlphaCte(a)}, ${sourceSelectionCtes({…})}, …
 *
 * Four union arms, one per source_type, each an index-friendly equijoin — the
 * shape items.ts arrived at after an OR-of-arms join brute-forced
 * feed_items × feed_sources (24.9M pair evaluations for one page). They ride
 * idx_feed_items_author / the membership primary key / idx_feed_items_article.
 *
 * Unlike the `matched` CTE this replaces, the arms do NOT collapse to one row
 * per item up front: a post can be admitted by several sources at different
 * throughputs, and each source judges it inside its own population. They
 * collapse at the end, and the rule is that **an item admitted by ANY matching
 * source survives** — the successor to the old `MAX(weight)`, keeping the
 * property that adding a source can only ever add posts.
 */
export function sourceSelectionCtes(opts: SourceSelectionOpts): string {
  const { floorParam, cursor, dedupCtes = "", windowStartParam } = opts;
  const criterion = proofTermSql(floorParam);
  const dedupOn = dedupCtes !== "";

  // The arms' bound: everything below the END of the cursor's own week. The
  // cursor's week therefore arrives COMPLETE, which is what makes the cut
  // inside it page-independent; the rows above the cursor that this lets
  // through are dropped by the exact keyset in `matched`, after the cut.
  const windowClause = cursor
    ? `AND fi.published_at < date_trunc('week', to_timestamp($${cursor.tsParam}::float8))
                             + interval '1 week'`
    : "";
  // The page bound proper, and the only place the exact position is spent. A
  // DESCENDING keyset, so a ROW comparison over the pair the ORDER BY uses.
  const keysetClause = cursor
    ? `AND (published_at, fi_id) < (to_timestamp($${cursor.tsParam}::float8), $${cursor.idParam}::uuid)`
    : "";
  // The reading counts' floor (see `windowStartParam`): after the cut, never
  // in the arms.
  const windowStartClause = windowStartParam
    ? `AND published_at >= $${windowStartParam}::timestamptz`
    : "";

  const arm = (join: string, where: string, extra = "") => `
        SELECT fi.id AS fi_id, fs.id AS fs_id, fi.published_at,
               fs.created_at AS joined_at,
               ${SOURCE_BUCKET_SQL} AS bucket,
               fs.throughput::float8 AS throughput,
               fs.sampling_mode,
               NOT fs.exclude_replies AS allow,
               ${criterion} AS criterion,
               ${STABLE_SAMPLE_SQL} AS sample
          FROM feed_sources fs
          ${join}
         WHERE fs.feed_id = $2 AND fs.muted_at IS NULL AND ${where}
           AND fi.deleted_at IS NULL
           -- THE DENOMINATOR IS WHAT CAN ACTUALLY ARRIVE. A percentile over a
           -- population the query is about to discard is a percentile of the
           -- wrong thing: "60%" would mean 60% of a source's rows and a good
           -- deal less than 60% of its posts. On the dev corpus 61% of external
           -- feed_items are replies and 20% are context-only hydration rows, so
           -- an external source with exclude_replies on was delivering under
           -- half of what its bar claimed. Item-level deliverability therefore
           -- belongs HERE, in the arms, not downstream in the ranking pass:
           --   · the per-source reply gate (free — both columns are joined)
           --   · is_context_only, on the external arm that can carry one
           -- What stays downstream is per-READER, not per-item: blocks and
           -- mutes (two correlated NOT EXISTS whose dilution is a handful of
           -- rows, against a cost paid over the whole arm set), and the native
           -- note-reply filter (0 rows on dev — no dilution to recover).
           AND (NOT fs.exclude_replies OR fi.is_reply IS NOT TRUE)
           ${extra}
           ${windowClause}`;

  // THE DEDUP POOL IS CURSOR-FREE, AND THAT IS THE WHOLE OF IT.
  //
  // It used to be `GROUP BY fi_id FROM source_arms` — the arms, which carry the
  // page bound. Slice 8's winner is picked by `(tprio, published_at, …) ASC`,
  // so TIER BEATS DATE and the winner is very often the NEWER copy: a tier-A/B
  // mirror of a lower-tier original, which is the ordinary cross-protocol
  // `bridge` shape (a Mastodon post older, its Bluesky mirror newer). Drawn
  // from a relation bounded above by the reader's position, that winner is
  // simply absent once the reader has paged past it — nothing suppresses the
  // loser, and the copy one page decided against renders on the next. Driven:
  // one page → 4 rows, loser suppressed; paging by 1 → 5 rows, BOTH copies.
  //
  // So the pool is built from the feed's external sources directly, with no
  // cursor term at all. A winner is then a fact about the (component,
  // fingerprint) group rather than about the page — which is what the whole
  // design says it is.
  //
  // Narrow, deliberately, because this is the one unbounded scan here:
  //   · the external arm only — `candidates` inner-joins `external_items`, so
  //     no other arm could ever contribute a row;
  //   · fingerprinted rows only — the rest sit outside dedup entirely;
  //   · sources carrying an applicable link at all. That EXISTS duplicates a
  //     little of `applicable_links` (it omits the reader's tombstones) because
  //     a CTE cannot reference one declared after it; it is a SUPERSET, so it
  //     is a perf narrowing and never a correctness term — `candidates` still
  //     inner-joins `source_component`, which is the real guard.
  // The whole block only exists when the reader has links at all (the host's
  // plan probe), so a feed with none pays nothing.
  //
  // THE SAME MEMBERSHIP JOIN AS THE ARM (CA-C4): an item reaches this feed
  // through every source that SERVES it, not only the one that wrote it first,
  // so the pool must see exactly what the arms see or a shared item escapes
  // dedup. The link narrowing asks every serving source for the same reason —
  // `candidates` tags an item with the component of any of them.
  const pool = `
    source_pool AS (
      SELECT fi.id AS fi_id, bool_or(NOT fs.exclude_replies) AS allow_replies
        FROM feed_sources fs
        JOIN external_item_sources eis ON eis.source_id = fs.external_source_id
        JOIN feed_items fi ON fi.external_item_id = eis.external_item_id
        JOIN external_items ei ON ei.id = fi.external_item_id
       WHERE fs.feed_id = $2
         AND fs.source_type = 'external_source'
         AND fs.muted_at IS NULL
         AND fi.deleted_at IS NULL
         AND ei.dedup_fingerprint IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM external_item_sources m
             JOIN external_identity_links l
               ON l.source_a_id = m.source_id OR l.source_b_id = m.source_id
            WHERE m.external_item_id = fi.external_item_id
              AND (l.owner_id IS NULL OR l.owner_id = $1)
              AND l.link_type <> 'user_unlinked'
         )
       GROUP BY fi.id
    ),
    ${dedupCtes},`;

  return `
    source_arms AS (
      ${arm(
        `JOIN feed_items fi ON fi.author_id = fs.account_id`,
        `fs.source_type = 'account'`,
      )}
        UNION ALL
      ${arm(
        `JOIN articles a ON a.publication_id = fs.publication_id
           JOIN feed_items fi ON fi.article_id = a.id`,
        `fs.source_type = 'publication'`,
      )}
        UNION ALL
      ${arm(
        // THROUGH THE MEMBERSHIP, NEVER `fi.source_id` (CA-C4). An item is one
        // row whose `source_id` names the FIRST source that wrote it; a second
        // source serving the same item (a category feed, a Lemmy community and
        // its poster, one newsletter at two ingest addresses) wrote nothing and
        // so delivered nothing. `external_item_sources` records every source
        // that served it, and a context-only row has no membership at all —
        // nothing served it — so `is_context_only` below is belt-and-braces.
        // Measured on the dev corpus's busiest source: 36ms against 34ms for the
        // old `idx_feed_items_source` scan.
        `JOIN external_item_sources eis ON eis.source_id = fs.external_source_id
           JOIN feed_items fi ON fi.external_item_id = eis.external_item_id
           JOIN external_items ei ON ei.id = fi.external_item_id
           LEFT JOIN external_authors ea ON ea.id = fi.external_author_id`,
        `fs.source_type = 'external_source'`,
        // `IS NOT TRUE` rather than `= false`: the column is nullable.
        //
        // THE NPUB BLOCK IS ITEM-LEVEL DELIVERABILITY, so it belongs in the arm
        // and not in the ranking pass (L6.5; the denominator rule above). A
        // blocked identity's posts cannot arrive, so counting them in the
        // percentile would make the bar promise a share of a population that
        // includes them — the same fault `exclude_replies` had, one column
        // over. It is also not a fact about the READER, which is the test for
        // what stays downstream: blocks and mutes differ per viewer, an
        // operator block does not.
        //
        // TWO PLACES ONE IDENTITY CAN SIT, and both are asked. `ea.stable_handle`
        // is the post's OWN author, which is what catches a blocked npub whose
        // reply was hydrated into somebody else's thread; the source's own
        // `source_uri` catches the case where the blocked identity IS the
        // source and its items carry no author row. Asking only the first let
        // every post from a blocked source through while the ingest guard was
        // still catching up.
        `AND ei.is_context_only IS NOT TRUE
           AND NOT ${npubBlockedSql("ea.stable_handle")}
           AND NOT EXISTS (
             SELECT 1 FROM external_sources es_blk
              WHERE es_blk.id = fs.external_source_id
                AND es_blk.protocol = 'nostr_external'
                AND ${npubBlockedSql("es_blk.source_uri")}
           )`,
      )}
        UNION ALL
      ${arm(
        `JOIN tags t_join ON t_join.name = fs.tag_name
           JOIN article_tags at_join ON at_join.tag_id = t_join.id
           JOIN feed_items fi ON fi.article_id = at_join.article_id`,
        `fs.source_type = 'tag'`,
      )}
    ),
    ${dedupOn ? pool : ""}
    -- How far back this page looks, per source: its most recent
    -- SOURCE_WINDOW_BUCKETS POPULATED buckets. dense_rank over buckets that
    -- EXIST rather than a calendar span, so a dormant source still contributes
    -- its most recent weeks and the window can never come back empty while
    -- older posts remain — which would stop pagination with the feed reading
    -- as finished. Partitioned by feed_sources.id, so a tag or publication
    -- source is bounded ACROSS ITS WHOLE POPULATION rather than per
    -- contributing author.
    source_windowed AS (
      SELECT *,
             dense_rank() OVER (
               PARTITION BY fs_id ORDER BY bucket DESC
             ) AS bucket_rank
        FROM source_arms
       WHERE TRUE ${dedupOn ? dedupSuppressFilter("fi_id") : ""}
    ),
    -- percent_rank() is 0 for a bucket's best post and 1 for its worst, so
    -- comparing it against throughput keeps that fraction OF THE BUCKET. A
    -- window function cannot appear in a WHERE, hence the separate CTE.
    --
    -- PARTITIONED BY (source, BUCKET) — this is the fix. Partitioned by source
    -- alone over a cursor-started window, a tie group's newest surviving post
    -- was always rank 0 and the rate collapsed to 100% as the reader paged
    -- (see SOURCE_BUCKET_SQL). Inside a calendar week the population is fixed,
    -- so a post's rank is a fact about the post.
    source_ranked AS (
      SELECT fi_id, published_at, joined_at, throughput, sampling_mode, sample,
             percent_rank() OVER (
               PARTITION BY fs_id, bucket
               ORDER BY criterion DESC, published_at DESC, fi_id DESC
             ) AS pr
        FROM source_windowed
       WHERE bucket_rank <= ${SOURCE_WINDOW_BUCKETS}
    ),
    -- The cut, and THEN the page. The keyset runs here rather than in the arms
    -- because a cut taken below the cursor is a cut over a population that
    -- moves with the reader; here it only decides which of the selected posts
    -- this page returns.
    --
    -- \`joined_at\` is when the EARLIEST source that selected the post joined
    -- this feed. The timeline ignores it; the reading counts read it, because
    -- a post published before any of its sources was in the feed is that
    -- source's back-catalogue, never an arrival (WORKSPACE-QUEUE-ADR §IV.2).
    matched AS (
      SELECT fi_id, min(joined_at) AS joined_at
        FROM source_ranked
       WHERE CASE
               -- Full volume takes no predicate at all: at 100% there is
               -- nothing to select and the mode is moot.
               WHEN throughput >= 1 THEN TRUE
               WHEN sampling_mode = 'scored' THEN pr < throughput
               ELSE sample < throughput
             END
         ${keysetClause}
         ${windowStartClause}
       GROUP BY fi_id
    )`;
}
