import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS } from "../../lib/feed-sql.js";
import { parseCursorEpoch, encodeTsIdCursor } from "../../lib/cursor.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
  type Post,
} from "../../lib/post-mapper.js";
import { UUID_RE, feedRowToResponse, loadFeed } from "./shared.js";
import {
  DEDUP_CTES,
  DEDUP_SUPPRESS_FILTER,
  DEDUP_PROVENANCE_LATERAL,
} from "../../lib/dedup-sql.js";
import {
  resonanceRankingEnabled,
  loadProofBlendParams,
  feedAlphaCte,
  proofBlendScoreSql,
} from "../../lib/feed-rank.js";

export function registerFeedItemsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds/:id/items — feed contents
  //
  // Empty source set → falls back to the caller's explore feed. This keeps
  // the vessel meaningful while source-set wiring is still pending; once
  // sources arrive the SELECT branches on feed_sources rows.
  //
  // Cursor formats differ between the two paths (placeholder uses 3-part
  // score:ts:id, source-filtered uses 2-part score:id). If a feed transitions
  // mid-session (first source added while client holds a stale cursor), the
  // new path's parser returns undefined and the client restarts from page 1.
  // ---------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/feeds/:id/items", { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub;
    const { id } = req.params;
    if (!UUID_RE.test(id))
      return reply.status(400).send({ error: "Invalid feed id" });

    const feed = await loadFeed(id, ownerId);
    if (!feed) return reply.status(404).send({ error: "Feed not found" });

    try {
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 50);
      const page = await loadFeedItemsPage(
        ownerId,
        id,
        feed.source_count,
        req.query.cursor,
        limit,
      );
      return reply.send({ feed: feedRowToResponse(feed), ...page });
    } catch (err) {
      logger.error({ err, feedId: id }, "Feed items fetch failed");
      return reply.status(500).send({ error: "Feed items fetch failed" });
    }
  });
}

// First/next page of a feed's items, branching on source_count exactly as GET
// /feeds/:id/items does: an empty source set surfaces the platform's explore
// stream (placeholder) so the vessel is useful out of the box; once a source is
// added the source-filtered ranking takes over. Ownership is the caller's
// responsibility (both call sites assert it via loadFeed first). Shared by the
// route above and the /bootstrap aggregate (performance audit #3), which calls
// it per feed with the source_count it already has — no extra loadFeed.
export async function loadFeedItemsPage(
  ownerId: string,
  feedId: string,
  sourceCount: number,
  cursor: string | undefined,
  limit: number,
): Promise<{
  items: Post[];
  nextCursor: string | undefined;
  placeholder: boolean;
}> {
  if (sourceCount === 0) {
    const { items, nextCursor } = await placeholderExploreItems(
      ownerId,
      cursor,
      limit,
    );
    return { items, nextCursor, placeholder: true };
  }
  const { items, nextCursor } = await sourceFilteredItems(
    ownerId,
    feedId,
    cursor,
    limit,
  );
  return { items, nextCursor, placeholder: false };
}

// The candidate SELECT/JOINs (FEED_SELECT/FEED_JOINS) + the Post columns/joins
// (POST_SELECT/POST_JOINS) are imported from lib/feed-sql.ts + lib/post-mapper.ts —
// the same shared SQL every other feed_items read path projects, so the workspace
// items endpoint emits the unified Post[] with no bespoke row mapper. The old inline
// FEED_SELECT/FEED_JOINS copies + rowToItem/computeBiddabilityTier were retired here
// (FEED-RETIREMENT-PLAN Slice 6 item 4); only the per-vessel effective_score ranking
// and the format-tagged cursor below remain workspace-specific.

// Unified, format-tagged cursor codec for GET /feeds/:id/items. Two pagination
// shapes coexist on this one endpoint and used to share two bare, untyped
// formats whose 2-part interpretations disagreed (one read `ts:id`, the other
// `score:id`):
//   - "scored"  (score:id)     — the source-filtered path (sourceFilteredItems)
//   - "explore" (score:ts:id)  — the empty-vessel placeholder path
// A feed can gain or lose its first source mid-session, swapping which branch
// serves the next page. Tagging the wire format means a cursor minted by one
// branch can never be silently mis-read by the other: a foreign or stale tag
// decodes to `undefined` → a clean restart from page 1, never a mis-ordered
// page. (One-time effect on deploy: cursors held by in-flight paginators are
// untagged, so they decode to undefined and restart once — the same graceful
// degradation this endpoint already had for the source-transition case.)
const UNBOUNDED_SCORE = 1e18;

type FeedCursor =
  // asOf (fractional epoch seconds) pins the D6 blend's age term so later
  // pages score the corpus at page 1's instant (§0i.2 — a now()-decayed score
  // re-qualifies boundary items under the strict keyset). Optional: flag-off
  // cursors don't carry it (fi.score doesn't decay at query time), and a
  // 3-part cursor decodes fine so in-flight paginators survive the deploy.
  | { kind: "scored"; score: number; id: string; asOf?: number }
  | { kind: "explore"; score: number; ts: number; id: string };

// Exported for the cursor round-trip test (M13): the encode→decode pair must be
// lossless in the epoch, and a unit test is the only thing that pins that.
export function encodeFeedCursor(c: FeedCursor): string {
  return c.kind === "scored"
    ? c.asOf !== undefined
      ? `scored:${c.score}:${c.id}:${c.asOf}`
      : `scored:${c.score}:${c.id}`
    : `explore:${c.score}:${c.ts}:${c.id}`;
}

// The tag is the discriminant, so a decoded cursor is self-describing; each
// caller narrows to the `kind` its branch expects and treats the other kind as
// undefined (→ restart). A bare/untyped string matches no tag → undefined too.
export function decodeFeedCursor(raw: string | undefined): FeedCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts[0] === "scored") {
    if (parts.length !== 3 && parts.length !== 4) return undefined;
    const score = Number(parts[1]);
    const id = parts[2];
    if (Number.isNaN(score) || !UUID_RE.test(id)) return undefined;
    if (parts.length === 4) {
      // asOf is a FRACTIONAL epoch — parsed through the shared M13 primitive.
      const asOf = parseCursorEpoch(parts[3]);
      if (!Number.isFinite(asOf)) return undefined;
      return { kind: "scored", score, id, asOf };
    }
    return { kind: "scored", score, id };
  }
  if (parts[0] === "explore") {
    if (parts.length !== 4) return undefined;
    const score = Number(parts[1]);
    // FRACTIONAL epoch (published_at_secs) — parsed through the shared M13
    // primitive, which is also what feed-sql.ts's parseCursor uses.
    const ts = parseCursorEpoch(parts[2]);
    const id = parts[3];
    if (!Number.isFinite(score) || !Number.isFinite(ts) || !UUID_RE.test(id))
      return undefined;
    return { kind: "explore", score, ts, id };
  }
  return undefined; // foreign/stale shape → restart from page 1
}

// -----------------------------------------------------------------------------
// Source-filtered items query — slice 16.
//
// Slice 4 shipped the source-set fan-out but ranked everything chronologically
// regardless of feed_sources.weight or sampling_mode. Slice 14 then surfaced a
// volume bar that wrote real weight rows but had nothing to do at query time.
// Slice 16 closes the loop:
//
//   - Each item that matches at least one (non-muted) source carries
//     MAX(weight) across its matches — a writer subscribed via two sources
//     (e.g. account + publication) gets the louder of the two.
//
//   - effective_score is computed per item from the feed-level dominant
//     sampling_mode (most common across non-muted source rows, alphabetical
//     tiebreak for determinism):
//       chronological → epoch(published_at) * weight
//       scored        → feed_items.score * weight
//                       (or, with RESONANCE_RANKING_ENABLED, the D6 read-time
//                        proof blend — see lib/feed-rank.ts)
//       random        → random() * weight  (re-rolls per query)
//
//   - Cursor is (effective_score, id). Random mode's cursor is mathematically
//     valid but the next page reshuffles — true random pagination requires a
//     stable seed per cursor and is deferred.
//
// Per-source mode mixing inside one feed (one source chronological, another
// scored) is also deferred — it would need a per-row mode column flowing
// through a more complex score computation. The dominant-mode rule is the
// honest first cut.
// -----------------------------------------------------------------------------

async function sourceFilteredItems(
  readerId: string,
  feedId: string,
  rawCursor: string | undefined,
  limit: number,
): Promise<{ items: Post[]; nextCursor: string | undefined }> {
  const decoded = decodeFeedCursor(rawCursor);
  const cursor = decoded?.kind === "scored" ? decoded : undefined;
  const cursorClause = cursor
    ? `AND (effective_score, fi_id) < ($4::float8, $5::uuid)`
    : "";
  const params: any[] = cursor
    ? [readerId, feedId, limit, cursor.score, cursor.id]
    : [readerId, feedId, limit];

  // ── D6 read-time proof blend (step 5), behind RESONANCE_RANKING_ENABLED ────
  // When on, the 'scored' sampling mode ranks every item — native and external
  // alike — by one commensurable expression built from the stored resonance
  // columns, instead of the cron-baked native-only fi.score. Off, the branch
  // below is byte-for-byte what it always was. The extra params are appended
  // AFTER the optional cursor pair so their indices don't shift with it.
  const blend = resonanceRankingEnabled() ? await loadProofBlendParams() : null;
  let alphaCte = "";
  let scoredModeExpr = `COALESCE(fi.score, 0)::float8 * m.weight`;
  // The blend's age term is scored "as of" one pinned instant: page 1 mints it,
  // the cursor carries it forward (§0i.2 — see proofBlendScoreSql). A 3-part
  // pre-deploy cursor has no asOf; falling back to now() decays that one
  // paginator exactly as before, once.
  const asOfSecs = cursor?.asOf ?? Date.now() / 1000;
  if (blend) {
    // α is the constant following value since the reach source kind was
    // retired (migration 177) — a feed's carrying reach:explore was the only
    // explore-surface discriminator, so the §9.12 A/B needs a new one before
    // feed_alpha_explore can matter again (see feedAlphaCte).
    const alpha = params.push(blend.alphaFollowing);
    const gravity = params.push(blend.gravity);
    const floor = params.push(blend.floor);
    const asOf = params.push(asOfSecs);
    alphaCte = `${feedAlphaCte(alpha)},`;
    scoredModeExpr = proofBlendScoreSql(gravity, floor, asOf);
  }

  const result = await pool.query<any>(
    `
    WITH RECURSIVE ${alphaCte}
    feed_mode AS (
      SELECT sampling_mode
        FROM feed_sources
        WHERE feed_id = $2 AND muted_at IS NULL
        GROUP BY sampling_mode
        ORDER BY COUNT(*) DESC, sampling_mode
        LIMIT 1
    ),
    -- One UNION ALL branch per source_type, each an index-friendly equijoin,
    -- then GROUP BY to collapse multi-source matches (MAX weight / bool_or
    -- allow_replies — a writer subscribed via two sources gets the louder).
    -- (The reach:following / reach:explore arms were retired with the reach
    -- source kind, migration 177 — §9.16.)
    -- This used to be a single join whose ON was the OR of all arms; an
    -- OR-of-arms join has no hashable key, so the planner brute-forced
    -- feed_items × feed_sources — 24.9M pair evaluations (~4.5s) for one page
    -- of a 717-source follow-import feed (EXPLAIN'd 2026-07-25). The branches
    -- ride idx_feed_items_author / idx_feed_items_source /
    -- idx_feed_items_article and take the same page to milliseconds.
    matched AS (
      SELECT fi_id, MAX(weight)::float8 AS weight, bool_or(allow) AS allow_replies
      FROM (
        SELECT fi.id AS fi_id, fs.weight, NOT fs.exclude_replies AS allow
          FROM feed_sources fs
          JOIN feed_items fi ON fi.author_id = fs.account_id
         WHERE fs.feed_id = $2 AND fs.muted_at IS NULL AND fs.source_type = 'account'
           AND fi.deleted_at IS NULL
        UNION ALL
        SELECT fi.id, fs.weight, NOT fs.exclude_replies
          FROM feed_sources fs
          JOIN articles a ON a.publication_id = fs.publication_id
          JOIN feed_items fi ON fi.article_id = a.id
         WHERE fs.feed_id = $2 AND fs.muted_at IS NULL AND fs.source_type = 'publication'
           AND fi.deleted_at IS NULL
        UNION ALL
        SELECT fi.id, fs.weight, NOT fs.exclude_replies
          FROM feed_sources fs
          JOIN feed_items fi ON fi.source_id = fs.external_source_id
         WHERE fs.feed_id = $2 AND fs.muted_at IS NULL AND fs.source_type = 'external_source'
           AND fi.deleted_at IS NULL
        UNION ALL
        SELECT fi.id, fs.weight, NOT fs.exclude_replies
          FROM feed_sources fs
          JOIN tags t_join ON t_join.name = fs.tag_name
          JOIN article_tags at_join ON at_join.tag_id = t_join.id
          JOIN feed_items fi ON fi.article_id = at_join.article_id
         WHERE fs.feed_id = $2 AND fs.muted_at IS NULL AND fs.source_type = 'tag'
           AND fi.deleted_at IS NULL
      ) arms
      GROUP BY fi_id
    ),
    -- ── Slice 8 P1: cross-source dedup ──────────────────────────────────────
    -- linked_sources / candidates / suppressed CTEs (page-independent winner +
    -- whole-candidate-set suppression). Factored into lib/dedup-sql.ts so the
    -- integration test runs the exact same SQL — see that module for the design.
    ${DEDUP_CTES},
    -- Rank-then-project: score, filter, sort and LIMIT over a SLIM row (id +
    -- effective_score + the columns the visibility predicates need), then join
    -- the heavy FEED_SELECT/POST_SELECT projection — with its correlated
    -- subqueries (tag_names, reply/quote post-id derivation) and six LEFT
    -- JOINs — onto the ≤$3 winners only. Before this split the full projection
    -- ran per CANDIDATE (~12k rows on a large follow-import feed) to return 20
    -- (the same shape of win as the provenance lateral's post-LIMIT move,
    -- ~1.8s → ~80ms). The notes/external_items joins stay in the ranking pass
    -- because its WHERE reads them.
    ranked AS (
      SELECT * FROM (
        SELECT fi.id AS fi_id,
          (CASE
            WHEN (SELECT sampling_mode FROM feed_mode) = 'scored'
              THEN ${scoredModeExpr}
            WHEN (SELECT sampling_mode FROM feed_mode) = 'random'
              THEN random() * m.weight
            ELSE EXTRACT(EPOCH FROM fi.published_at)::float8 * m.weight
          END)::float8 AS effective_score
        FROM feed_items fi
        JOIN matched m ON m.fi_id = fi.id
        LEFT JOIN notes n ON n.id = fi.note_id
        LEFT JOIN external_items ei ON ei.id = fi.external_item_id
        WHERE fi.deleted_at IS NULL
          -- No self-exclusion here (unlike the explore queries): membership in a
          -- composable feed is explicit — nothing enters without a feed_sources
          -- match — so the reader's own items appear iff a source they added
          -- admits them (themselves as a source, their publication, a tag they
          -- post under). The old "not self" clause was inherited from explore
          -- semantics and silently overrode an explicit self-source.
          AND NOT EXISTS (
            SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
          )
          AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
          AND (fi.item_type != 'external' OR ei.is_context_only IS NOT TRUE)
          -- Per-source "no replies": drop reply items unless at least one
          -- matching source still admits replies (migration 107).
          AND (fi.is_reply IS NOT TRUE OR m.allow_replies)
          -- Slice 8 P1: drop the loser of a cross-source duplicate pair.
          ${DEDUP_SUPPRESS_FILTER}
      ) s
      WHERE TRUE ${cursorClause}
      ORDER BY effective_score DESC, fi_id DESC
      LIMIT $3
    )
    -- Provenance ("ALSO ON BLUESKY · MASTODON"): display-only on the returned
    -- page, so compute it AFTER the cursor/ORDER/LIMIT — over the ≤$3 survivors
    -- actually returned, not every survivor pre-LIMIT (the lateral references
    -- only scored.fi_id, which FEED_SELECT projects).
    -- effective_score/fi_id stay in scored.* for the JS cursor.
    SELECT scored.*, prov.also_on
    FROM (
      SELECT ${FEED_SELECT}${POST_SELECT}, r.effective_score
      FROM ranked r
      JOIN feed_items fi ON fi.id = r.fi_id
      ${FEED_JOINS}${POST_JOINS}
    ) scored
    ${DEDUP_PROVENANCE_LATERAL}
    -- Re-impose order: the lateral join doesn't preserve the subquery's ORDER,
    -- and the JS reads the last row for nextCursor (below). Cheap — ≤$3 rows.
    ORDER BY effective_score DESC, fi_id DESC
  `,
    params,
  );

  // One post per card is an absolute rule (consistent threading grammar), so we
  // no longer collapse a burst of replies into a single reply_group card — each
  // reply flows through as its own item and the client renders it as its own
  // card. Context is reached by expanding into the thread, never by fusing.
  //
  // Emits the unified Post[] (shared feedItemToPost) so the workspace consumes the
  // same shape every other surface does — no client-side legacy-item→Post adapter.
  // Ranking stays the composed-vessel effective_score (weight × sampling_mode); the
  // §5 hotness number is NOT applied here (FEED-RETIREMENT-PLAN Slice 6 item 4) —
  // in 'scored' mode the numerator is fi.score, or the D6 proof blend when
  // RESONANCE_RANKING_ENABLED is on.
  const items = result.rows.map(feedItemToPost);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor = lastRow
    ? encodeFeedCursor({
        kind: "scored",
        score: Number(lastRow.effective_score),
        id: lastRow.fi_id,
        // Only the blend decays with time, so only blend-on cursors pin asOf —
        // flag-off cursors keep the pre-existing 3-part wire shape.
        ...(blend ? { asOf: asOfSecs } : {}),
      })
    : undefined;

  return { items, nextCursor };
}

// The empty-vessel fallback. Deliberately NOT converted to the D6 proof blend
// (step 5): this path selects native items only (`item_type IN ('article',
// 'note')`), so the commensurability argument that drives D6 — native and
// external ranking in the same units — does not bite here, and its cursor
// filters on the fi.score COLUMN directly, which a computed expression would
// force into a different cursor shape for no behavioural gain. Since the reach
// source kind was retired (migration 177, §9.16) this fallback is the ONLY
// explore surface left — the deliberate default for a feed with zero sources
// (§2.7, explicitly deferred out of that retirement's scope).
async function placeholderExploreItems(
  readerId: string,
  rawCursor: string | undefined,
  limit: number,
): Promise<{ items: Post[]; nextCursor: string | undefined }> {
  const decoded = decodeFeedCursor(rawCursor);
  const cursor = decoded?.kind === "explore" ? decoded : undefined;
  const scoreCursor = cursor?.score ?? UNBOUNDED_SCORE;
  const cursorClause = cursor
    ? `AND (fi.score, fi.published_at, fi.id) < ($3::numeric, to_timestamp($4), $5::uuid)`
    : "";
  const params: any[] = cursor
    ? [readerId, limit, scoreCursor, cursor.ts, cursor.id]
    : [readerId, limit];

  const result = await pool.query<any>(
    `
    SELECT ${FEED_SELECT}${POST_SELECT},
      -- Full-precision epoch for the cursor (M13): published_at_epoch is
      -- ::bigint (whole seconds, for display), but the ORDER BY and the
      -- to_timestamp() cursor filter are full-precision, so a whole-second
      -- cursor skips/duplicates rows sharing a second. to_timestamp() accepts
      -- fractional seconds, so carry the fractional epoch in the cursor.
      EXTRACT(EPOCH FROM fi.published_at) AS published_at_secs
    FROM feed_items fi
    ${FEED_JOINS}${POST_JOINS}
    WHERE fi.deleted_at IS NULL
      AND fi.published_at > now() - INTERVAL '48 hours'
      AND fi.item_type IN ('article', 'note')
      AND fi.author_id != $1
      AND NOT EXISTS (
        SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = fi.author_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = fi.author_id
      )
      AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
      ${cursorClause}
    ORDER BY fi.score DESC, fi.published_at DESC, fi.id DESC
    LIMIT $2
  `,
    params,
  );

  const items = result.rows.map(feedItemToPost);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor = lastRow
    ? encodeFeedCursor({
        kind: "explore",
        score: lastRow.score ?? 0,
        ts: Number(lastRow.published_at_secs),
        id: lastRow.fi_id,
      })
    : undefined;

  return { items, nextCursor };
}
