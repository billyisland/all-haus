import { pool } from "@platform-pub/shared/db/client.js";

// Shared helpers for the workspace-feeds route modules (crud / items / sources /
// author-volume / saves). Anything consumed by ≥2 of those modules lives here so
// the split stays a pure move — no behaviour change. Module-private helpers stay
// with their module.

export { UUID_RE } from "../../lib/uuid.js";

export interface FeedRow {
  id: string;
  name: string;
  appearance: Record<string, unknown>;
  sort_rank: number;
  hidden: boolean;
  created_at: Date;
  updated_at: Date;
  source_count: number;
  // Computed provenance (EXPLAIN-ADR D7): true iff this feed is what the
  // platform set up for its owner rather than something they composed. Drives
  // the first-run / Explain copy fork. No column, no leaked seed id.
  from_starter: boolean;
  // Where a redeemed feed came from (FEED-FORMULAS-ADR D7). NULL unless the feed
  // was minted by redeeming SOMEBODY's share link — the default seed is
  // deliberately not that: it is from_starter's question, and answering both
  // would put "from <the operator>'s Starter" on every new member's first feed.
  // The two are disjoint by construction (see feedProvenanceSql). The NAME is
  // the stamped `feeds.origin_label` and the AUTHOR is a live join, so the
  // author's name may be null beside a present label. Attribution travels;
  // adoption counts do not — nothing here tells the author anything about
  // uptake.
  origin_formula_name: string | null;
  origin_author_name: string | null;
}

// The provenance projection, in ONE place.
//
// It used to be a hand-copied EXISTS at five sites (loadFeed, listFeedsForOwner,
// two inline SELECTs inside registerFeedCrudRoutes, and createFeedForOwner's
// literal `false`) — which is exactly why FEED-FORMULAS-ADR §11 has to warn a
// future reader to *grep* for from_starter rather than trust a list. Copies
// drift; a function cannot.
//
// KEYED ON `feed_formulas.kind`, NEVER ON `is_default_seed`
// (FEED-SHARE-LIVE-LINKS-ADR L9). Both questions used to read the designation
// flag's CURRENT value, so retiring a seed retroactively unmade `fromStarter`
// for its whole cohort and, in the same instant, handed them "from <the
// operator>'s Starter" as though they had chosen it — §14 of the parent fixed
// exactly that for `feeds.is_starter_template` and the formula rebuilt it one
// object up. `kind` is written once at insert and never moves, which is what
// makes it the right key: provenance is a fact about the MEMBER's feed, and a
// designation is a fact about what the operator currently keeps. It is also
// what makes revoke-on-retire (L5) safe.
//
// THREE arms, and all three are permanent:
//
//   • `kind = 'seed'` — the designated formula seedStarterFeeds redeems for
//     every new account, and every seed retired since;
//   • `cloned_from_feed_id IS NOT NULL` — the legacy arm, and a read-only one:
//     its sole writer was cloneFeedForOwner, deleted with
//     `feeds.is_starter_template` in migration 179. Nothing sets the column any
//     more, but it is the only provenance members seeded BEFORE that cutover
//     have (§11), so the arm stays. It must not be spelled as an EXISTS over
//     the flag, which is why step 1 re-derived it here a migration ahead of the
//     drop: under the old spelling, merely UNFLAGGING the template retroactively
//     unmade the provenance of every member ever seeded from it, and dropping
//     the column would have done the same to all of them at once. (DELETING the
//     template is beyond any spelling here — the FK is ON DELETE SET NULL, so
//     the delete clears the column itself. That is the limit of the legacy arm,
//     and the sharpest argument for D6: a formula has no `feeds` row for anyone
//     to delete.)
//   • `origin_*` is the OTHER question — "you added someone's link" — so it
//     reads `kind = 'link'`. The two are disjoint by construction.
//
// ATTRIBUTION IS STAMPED, NOT JOINED (L6). `origin_formula_name` is the plain
// column `feeds.origin_label`, written at redeem with the source feed's name at
// that moment. Joined to the live feed instead, a recipient's "from …" line
// would rewrite itself when the author renamed their feed; and if the link row
// were ever deleted, `from_formula_id`'s ON DELETE SET NULL would erase the
// provenance of every feed redeemed from it — the author's later act reaching
// into somebody else's workspace, which is the one thing D1's surviving half
// forbids. The author's NAME stays a live join, because a person's display name
// changing should follow — and it may now be null beside a present label (the
// author deleted their account and the CASCADE took the link row).
//
// `alias` is interpolated into SQL and is a compile-time literal at every call
// site (the table alias in that query — `f`, or the table name itself inside a
// RETURNING). It never carries user input.
export function feedProvenanceSql(alias: string): string {
  return `(${alias}.cloned_from_feed_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM feed_formulas seed
                  WHERE seed.id = ${alias}.from_formula_id AND seed.kind = 'seed')) AS from_starter,
     ${alias}.origin_label AS origin_formula_name,
     (SELECT COALESCE(a.display_name, a.username)
        FROM feed_formulas ff JOIN accounts a ON a.id = ff.author_id
       WHERE ff.id = ${alias}.from_formula_id AND ff.kind = 'link') AS origin_author_name`;
}

// Create a feed for an owner, ranked last (max+1 within the owner's set). A
// concurrent create can tie; ties are fine (read order falls back to
// created_at). Extracted from POST /feeds (FOLLOW-GRAPH-IMPORT-ADR §11.1) so
// the follow-import engine can mint the import's target feed through the same
// path. Returns the full FeedRow (source_count 0 by construction).
//
// It lives HERE rather than in crud.ts (where it was born) because Phase 2 made
// crud.ts a caller of the formula redeem core, and formulas.ts was already a
// caller of this: leaving it in crud.ts would have made the two modules import
// each other. Function-declaration hoisting would have survived that cycle
// today and broken on the first module-init read of the other's binding, which
// is not a trap worth leaving. shared.ts is the module both may depend on.
//
// `opts` serves link redemption (FEED-FORMULAS-ADR §5): a redeemed feed
// arrives in the author's colour scheme, and carries the link it came from for
// the D7 attribution line. All three default to today's behaviour — an omitted
// option cannot change what POST /feeds or the import engine mint.
// `origin_author_name` comes back NULL on this path by construction: the JOIN
// would be against a row this INSERT has only just referenced, and the caller
// (redeem) already holds the author.
export interface CreateFeedOptions {
  appearance?: Record<string, unknown>;
  fromFormulaId?: string;
  /**
   * The source feed's name at the moment of redeem, stamped for the D7
   * attribution line (FEED-SHARE-LIVE-LINKS-ADR L6).
   *
   * SEEDING DELIBERATELY DOES NOT PASS IT. A seeded feed answers `fromStarter`
   * and nothing else; stamping the seed's name here would put "from <the
   * operator>'s Starter" on every new member's first feed as though they had
   * chosen it (§14's point, preserved).
   */
  originLabel?: string;
}
export async function createFeedForOwner(
  ownerId: string,
  name: string,
  db: { query: typeof pool.query } = pool,
  opts: CreateFeedOptions = {},
): Promise<FeedRow> {
  const { rows } = await db.query<FeedRow>(
    `INSERT INTO feeds (owner_id, name, sort_rank, appearance, from_formula_id, origin_label)
     VALUES ($1, $2,
       (SELECT COALESCE(MAX(sort_rank), 0) + 1 FROM feeds WHERE owner_id = $1),
       COALESCE($3::jsonb, '{}'::jsonb), $4, $5)
     RETURNING id, name, appearance, sort_rank, hidden, created_at, updated_at, 0::int AS source_count,
       false AS from_starter, origin_label AS origin_formula_name, NULL::text AS origin_author_name`,
    [
      ownerId,
      name,
      opts.appearance ? JSON.stringify(opts.appearance) : null,
      opts.fromFormulaId ?? null,
      opts.originLabel ?? null,
    ],
  );
  return rows[0];
}

export function feedRowToResponse(row: FeedRow) {
  return {
    id: row.id,
    name: row.name,
    appearance: row.appearance ?? {},
    sortRank: row.sort_rank,
    hidden: row.hidden,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sourceCount: Number(row.source_count),
    fromStarter: row.from_starter,
    // Absent rather than null when there is nothing to say, so the client's
    // "where did this come from" line is a presence check.
    origin: row.origin_formula_name
      ? {
          formulaName: row.origin_formula_name,
          authorName: row.origin_author_name,
        }
      : null,
  };
}

export async function loadFeed(
  feedId: string,
  ownerId: string,
): Promise<FeedRow | null> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
       ${feedProvenanceSql("f")}
     FROM feeds f
     WHERE f.id = $1 AND f.owner_id = $2`,
    [feedId, ownerId],
  );
  return rows[0] ?? null;
}

// §6.4b — spacing between consecutive sources' subscribe-time ingest jobs, for
// any caller that adds sources in bulk. A 500-source import trickles its jobs
// over ~4 minutes instead of dumping 500 immediate fetches on a 10-concurrency
// worker; formula redemption rides the same brake. One home, because two bulk
// paths tuning the worker to different numbers is how a soak result gets lost.
export const ENQUEUE_SPACING_MS = 500;

export function tagged(
  code: string,
  message?: string,
): Error & { code: string } {
  const e = new Error(message ?? code) as Error & { code: string };
  e.code = code;
  return e;
}

// The five-step volume bar, as a THROUGHPUT FRACTION (migration 202): the share
// of that source's posts that reach the feed. Step 5 = 1.0 = everything, which
// is the schema default, and every add path inherits it (addSource's INSERT
// omits the column) — a source you just chose arrives at full volume,
// deliberately.
//
// It is NOT a ranking multiplier any more. The old scale (0.25 .. 4.0) was
// multiplied into the feed's sort key, which in a chronological feed meant
// multiplying a Unix epoch: one step down sorted a post published today as if
// published in 1998. Selection is now per source and the feed is a timeline
// throughout (lib/source-selection.ts).
//
// Index 0 is the mute placeholder, and it is INERT — but that had to be made
// true rather than asserted. It must satisfy the `throughput > 0` CHECK, so it
// is 1.0, which is also "everything"; both write paths used to store it on a
// mute, so muting a source set to 20% reset it to full volume and the reader
// met that on unmute. Neither path writes throughput at step 0 now (sources.ts
// PATCH skips the SET, author-volume PUT keeps the stored value on conflict) —
// mute rides `muted_at`, the read-back returns step 0 from that column alone,
// and the level is what the source comes back to. Do not reintroduce a write
// of this index on the argument that the UI always names a level on unmute:
// it does today, and the PATCH API has always accepted a bare `muted: false`.
//
// Changing these five numbers changes what every existing source means, since
// the stored value IS the fraction. The web carries its own copy (there is no
// gateway→web import path); `web/tests/volume-scale-parity.test.ts` is what
// stops the two drifting.
export const VOLUME_THROUGHPUT = [1.0, 0.2, 0.4, 0.6, 0.8, 1.0];
export function stepToThroughput(step: number): number {
  return VOLUME_THROUGHPUT[Math.max(0, Math.min(5, step))] ?? 1.0;
}
export function throughputToStep(throughput: number): number {
  // Inverse — picks the closest committed step. Used only for read-back so a
  // hand-edited value in the DB still reads back as a sensible bar position.
  let bestStep = 5;
  let bestDelta = Infinity;
  for (let s = 1; s <= 5; s++) {
    const d = Math.abs(VOLUME_THROUGHPUT[s] - throughput);
    if (d < bestDelta) {
      bestDelta = d;
      bestStep = s;
    }
  }
  return bestStep;
}
