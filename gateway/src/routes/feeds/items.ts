import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS } from "../../lib/feed-sql.js";
import {
  parseCursorEpoch,
  encodeTsIdCursor,
  feedCursorEpoch,
} from "../../lib/cursor.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
  type Post,
} from "../../lib/post-mapper.js";
import { UUID_RE, feedRowToResponse, loadFeed } from "./shared.js";
import {
  dedupCtes,
  DEDUP_PROVENANCE_LATERAL,
  dedupApplicableExistsSql,
  dedupMinConfidence,
} from "../../lib/dedup-sql.js";
import { loadProofBlendParams, feedAlphaCte } from "../../lib/feed-rank.js";
import { sourceSelectionCtes } from "../../lib/source-selection.js";
import { parseLimit, isUuid } from "../../lib/request-inputs.js";
import { hiddenFromViewerSql } from "../../lib/blocks.js";
import { resolveLockedRoots } from "../../lib/root-locked.js";
import { drawEchoesAsNotes, drawWindowEchoesAsNotes } from "../../lib/cross-post-echo.js";

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
    if (!isUuid(id))
      return reply.status(404).send({ error: "We couldn't find that channel." });

    const feed = await loadFeed(id, ownerId);
    if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

    try {
      const limit = parseLimit(req.query.limit, 20, 50);
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
      return reply.status(500).send({ error: "Couldn't load this channel. Please try again." });
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
  db: Db = pool,
): Promise<{
  items: Post[];
  nextCursor: string | undefined;
  placeholder: boolean;
  asOf: string;
}> {
  // Taken BEFORE the page is read, so a row the page shows can only be above
  // it — and stays new after a look that sends this token (§IV.1).
  const { asOf } = await seenSnapshot(db);
  if (sourceCount === 0) {
    const { items, nextCursor } = await placeholderExploreItems(
      ownerId,
      cursor,
      limit,
    );
    return { items, nextCursor, placeholder: true, asOf };
  }
  const { items, nextCursor } = await sourceFilteredItems(
    ownerId,
    feedId,
    cursor,
    limit,
    db,
  );
  return { items, nextCursor, placeholder: false, asOf };
}

// =============================================================================
// Reading counts — the window and the `asOf` token (WORKSPACE-QUEUE-ADR §IV).
//
// The client counts a feed's "unread" and "new" against a WINDOW the server
// hands it: every post the timeline would show from the last UNREAD_WINDOW_DAYS,
// by id, each flagged `isNew` when its row entered the feed after the member
// last looked (`feeds.seen_baseline_at`). The client never assembles it from
// what it happens to have loaded, so paging never moves a count and a post that
// leaves the feed (a source removed, a volume lowered, a block, the cut
// drifting) stops being counted at the next fetch.
// =============================================================================

// The floor: nothing published before `now() - UNREAD_WINDOW_DAYS` is ever
// counted. Spelled once, here; the client applies the `windowStart` the server
// sends and never its own clock.
export const UNREAD_WINDOW_DAYS = 7;

// How many window posts one response lists — the newest by published_at, the
// ones a reader meets first. Past it the response says `truncated` and the pills
// read "500+". Not a dial: a bound on a payload, moved against the A1 payload
// measurement recorded in the ADR (§IV.3), not against a live distribution.
export const SEEN_WINDOW_CAP = 500;

// THE `asOf` TOKEN. A look is recorded as "I have seen everything up to asOf",
// and asOf is the server's clock at full Postgres precision — carried as text
// both ways, never through a JS Date (the timestamp-cursor rule; a truncated
// watermark errs backwards, which here would re-announce what was just seen).
//
// A MINUTE BEHIND `now()`, on purpose. `feed_items.created_at` defaults to the
// writing TRANSACTION's start time, so a row can commit after this fetch with a
// created_at before it; stamped at `now()`, the look would sweep it under the
// baseline unseen and it would never be new. The margin keeps such a row above
// the baseline. It is an assumption about ingest — no transaction writing
// feed_items runs longer than a minute — and A1 checked it (ADR §IV.1). A row
// that commits later still is never new, but it is still UNREAD, because the
// window lists it. The cost is the other way round and cheap: a post that
// arrived in the minute before a look can be new once more.
const AS_OF_MARGIN = "interval '1 minute'";

async function seenSnapshot(
  db: Db,
  feedId?: string,
): Promise<{ asOf: string; windowStart: string; baseline: string | null }> {
  const {
    rows: [snap],
  } = await db.query<{
    as_of: string;
    window_start: string;
    baseline: string | null;
  }>(
    `SELECT (now() - ${AS_OF_MARGIN})::text AS as_of,
            (now() - make_interval(days => $1::int))::text AS window_start,
            (SELECT seen_baseline_at::text FROM feeds WHERE id = $2::uuid) AS baseline`,
    [UNREAD_WINDOW_DAYS, feedId ?? null],
  );
  return {
    asOf: snap.as_of,
    windowStart: snap.window_start,
    baseline: snap.baseline,
  };
}

export interface FeedSeenWindow {
  asOf: string;
  seenBaselineAt: string | null;
  windowStart: string;
  // post_id; unix seconds (the same rounding as Post.publishedAt); newest
  // published first.
  items: { id: string; publishedAt: number; isNew: boolean }[];
  truncated: boolean;
}

// The window for one feed. Ownership is the caller's (both routes loadFeed
// first), exactly as for loadFeedItemsPage.
//
// A FEED WITH NO SOURCES HAS AN EMPTY WINDOW. Its vessel shows the platform's
// explore stream as a placeholder (loadFeedItemsPage), which is not the
// member's feed and not theirs to "catch up on"; counting it would badge every
// new, empty feed. Empty lists nothing the timeline hides, which is the rule.
export async function loadFeedSeenWindow(
  ownerId: string,
  feedId: string,
  sourceCount: number,
  db: Db = pool,
): Promise<FeedSeenWindow> {
  const { asOf, windowStart, baseline } = await seenSnapshot(db, feedId);
  const base = { asOf, seenBaselineAt: baseline, windowStart };
  if (sourceCount === 0) return { ...base, items: [], truncated: false };

  // One over the cap, so `truncated` is a fact and not a guess.
  const { sql, params } = await selectedSlimSql(
    db,
    ownerId,
    feedId,
    SEEN_WINDOW_CAP + 1,
    { windowStart },
  );
  const baselineParam = params.push(baseline);
  const { rows } = await db.query<{
    post_id: string;
    published_at_epoch: string;
    is_new: boolean;
    protocol: string | null;
    source_item_uri: string | null;
  }>(
    `${sql}
    -- isNew is PROJECTED, never filtered (§IV.2): filtering on created_at
    -- anywhere before the cut would take the percentile over the new rows
    -- alone. A NULL baseline (never looked) makes every flag false.
    --
    -- And a post published before its source JOINED the feed is never new.
    -- A source new to the platform brings its back-catalogue in as fresh
    -- inserts, written by the subscribe-time ingest job AFTER the add has
    -- answered — so no client re-base can land after them. The join time is
    -- the fact that says "this was already there when you chose it".
    SELECT fi.post_id,
           EXTRACT(EPOCH FROM r.published_at)::bigint AS published_at_epoch,
           COALESCE(fi.created_at > $${baselineParam}::timestamptz, false)
             AND r.published_at >= r.joined_at AS is_new,
           fi.source_protocol::text AS protocol, ei.source_item_uri
      FROM ranked r
      JOIN feed_items fi ON fi.id = r.fi_id
      LEFT JOIN external_items ei ON ei.id = fi.external_item_id
     WHERE fi.post_id IS NOT NULL
     ORDER BY r.published_at DESC, r.fi_id DESC`,
    params,
  );

  const truncated = rows.length > SEEN_WINDOW_CAP;
  return {
    ...base,
    // The window names what the page DRAWS, so an echo drawn as its note is
    // counted under the note's id (B3).
    items: await drawWindowEchoesAsNotes(
      ownerId,
      rows.slice(0, SEEN_WINDOW_CAP).map((r) => ({
        id: r.post_id,
        // bigint arrives as a string (node-postgres); coerce at the edge.
        publishedAt: Number(r.published_at_epoch),
        isNew: r.is_new,
        protocol: r.protocol,
        sourceItemUri: r.source_item_uri,
      })),
    ),
    truncated,
  };
}

// Move the baseline to `asOf` — forward only, and never past now() — then
// answer with the window computed against the NEW baseline, which the client
// adopts wholesale (§IV.4: it cannot tell which of its flags the move covers;
// the server can). Returns null when the feed is not this owner's.
//
// `GREATEST(COALESCE(…, '-infinity'), …)` is what makes a late or reordered
// request harmless: a beacon from a closing tab can land after a newer look and
// can never move the watermark back. `LEAST(…, now())` refuses a forged future.
export async function recordFeedSeen(
  ownerId: string,
  feedId: string,
  asOf: string,
  sourceCount: number,
  db: Db = pool,
): Promise<FeedSeenWindow | null> {
  const { rowCount } = await db.query(
    `UPDATE feeds
        SET seen_baseline_at = GREATEST(
              COALESCE(seen_baseline_at, '-infinity'::timestamptz),
              LEAST($3::timestamptz, now()))
      WHERE id = $1 AND owner_id = $2`,
    [feedId, ownerId, asOf],
  );
  if (!rowCount) return null;
  return loadFeedSeenWindow(ownerId, feedId, sourceCount, db);
}

// The candidate SELECT/JOINs (FEED_SELECT/FEED_JOINS) + the Post columns/joins
// (POST_SELECT/POST_JOINS) are imported from lib/feed-sql.ts + lib/post-mapper.ts —
// the same shared SQL every other feed_items read path projects, so the workspace
// items endpoint emits the unified Post[] with no bespoke row mapper. The old inline
// FEED_SELECT/FEED_JOINS copies + rowToItem/computeBiddabilityTier were retired here
// (FEED-RETIREMENT-PLAN Slice 6 item 4). Since migration 202 there is no
// per-vessel ranking left either — the vessel is a timeline — so what remains
// workspace-specific is the per-source selection and the format-tagged cursor.

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
  // A composed feed is a TIMELINE (migration 202): selection happens per source
  // and what survives is merged by time, so the cursor is a plain keyset on
  // (published_at, id) — the pair the ORDER BY uses, riding
  // idx_feed_items_cursor. It replaces the `scored` kind, whose `asOf` existed
  // only to stop a time-decaying score re-qualifying boundary items between
  // pages; with nothing decaying there is nothing to pin. An in-flight
  // `scored:` cursor decodes to undefined → one clean restart from page 1.
  | { kind: "ts"; ts: number; id: string }
  | { kind: "explore"; score: number; ts: number; id: string };

// Exported for the cursor round-trip test (M13): the encode→decode pair must be
// lossless in the epoch, and a unit test is the only thing that pins that.
export function encodeFeedCursor(c: FeedCursor): string {
  return c.kind === "ts"
    ? `ts:${encodeTsIdCursor(c.ts, c.id)}`
    : `explore:${c.score}:${c.ts}:${c.id}`;
}

// The tag is the discriminant, so a decoded cursor is self-describing; each
// caller narrows to the `kind` its branch expects and treats the other kind as
// undefined (→ restart). A bare/untyped string matches no tag → undefined too.
export function decodeFeedCursor(raw: string | undefined): FeedCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts[0] === "ts") {
    if (parts.length !== 3) return undefined;
    // FRACTIONAL epoch through the shared M13 primitive: this is a DESCENDING
    // keyset, the direction where truncation loses rows into a gap between
    // pages that nothing revisits.
    const ts = parseCursorEpoch(parts[1]);
    const id = parts[2];
    if (!Number.isFinite(ts) || !UUID_RE.test(id)) return undefined;
    return { kind: "ts", ts, id };
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
// Source-filtered items query.
//
// THE FEED IS A TIMELINE, AND VOLUME IS A FILTER (migration 202). Each source
// admits a fraction of its own posts — `feed_sources.throughput`, with
// `sampling_mode` deciding WHICH fraction — and what survives is merged by
// published_at. One source's setting cannot move another's, because the cut is
// taken inside that source's own population (lib/source-selection.ts).
//
// This replaced two things the header used to describe as deferred:
//
//   - `weight` multiplied this query's sort key, which for a chronological feed
//     meant multiplying a Unix epoch — one step down sorted a post published
//     today as if published in 1998, i.e. a mute rather than a sample.
//   - `sampling_mode` was read as the feed's DOMINANT value (a majority vote
//     across its sources) and applied to every item, so one source switched to
//     TOP re-ranked every other source in the feed.
//
// The ORDER BY is now `(published_at, id)` — the pair idx_feed_items_cursor
// already indexes — and the cursor is that keyset. Nothing decays between
// pages, so the `asOf` pinning the scored cursor carried is gone with it.
// -----------------------------------------------------------------------------

// Anything with a `query` — the shared pool, or a checked-out client inside a
// transaction (the DB-backed tests drive the real functions against fixtures
// they roll back).
type Db = Pick<typeof pool, "query">;

// THE SELECTION, ONCE — the WITH list through `ranked`, a slim relation of
// (fi_id, published_at) holding every post the timeline would show, ordered and
// bounded by `$3`. Two readers follow it with their own projection: the items
// page (the heavy Post columns) and the reading-count window (post ids and one
// flag, `loadFeedSeenWindow`). WORKSPACE-QUEUE-ADR §IV.2: a count must not name
// a post the timeline will not show, so the window is THIS selection with one
// extra predicate — never a second hand-kept SELECT that could drift from it.
//
// `windowStart` is that predicate's value (timestamptz text). It goes to the
// selection builder, which places it in `matched`, after the cut; see
// source-selection.ts › windowStartParam for why the arms are the wrong place.
//
// Param layout, which the builder depends on: $1 reader, $2 feed, $3 limit,
// then the optional cursor pair, then everything pushed below.
async function selectedSlimSql(
  db: Db,
  readerId: string,
  feedId: string,
  limit: number,
  opts: {
    cursor?: { ts: number; id: string };
    windowStart?: string;
  },
): Promise<{ sql: string; params: any[]; dedupOn: boolean }> {
  const { cursor } = opts;
  // The cursor's param INDICES, not a clause. It is spent in two places with
  // two different spellings and the selection builder owns both: a
  // bucket-granular bound on the measurement window, and the exact keyset
  // AFTER the cut (source-selection.ts › SOURCE_BUCKET_SQL). It is still a
  // DESCENDING keyset — a ROW comparison over the same pair the ORDER BY uses,
  // never a bare `<`, and never through a JS Date (to_timestamp takes the
  // fractional epoch the cursor carries), because two rows can share a
  // published_at exactly.
  const cursorParams = cursor ? { tsParam: 4, idParam: 5 } : null;
  const params: any[] = cursor
    ? [readerId, feedId, limit, cursor.ts, cursor.id]
    : [readerId, feedId, limit];

  // ── The plan probe (§6.6) ─────────────────────────────────────────────────
  // One fact, one cheap round trip, deciding the SHAPE of the feed query rather
  // than a value inside it — so it must be known before the query is built.
  // Postgres will not parallelise a plan whose expression tree contains a
  // parallel-unsafe or parallel-restricted node ANYWHERE, so a branch this feed
  // can never take still costs it the parallel plan; the fix for that class is
  // always to leave the branch out, never to make it cheaper.
  //
  //   has_links — the dedup block's `WITH RECURSIVE` is parallel-UNSAFE. Its
  //     cost is real but conditional: at zero links the CTEs genuinely
  //     short-circuit (`candidates` returns 0 rows in 0.081 ms) and the
  //     recursion adds ~110 ms to the core, all of it the lost parallelism.
  //
  // The probe used to read the feed's dominant sampling_mode too, because
  // `random()` is PARALLEL RESTRICTED and carrying it as one arm of a per-row
  // CASE de-parallelised the ranking pass for every feed including the ~all of
  // them that never took that arm. That whole problem is now gone rather than
  // avoided: sampling is per source, and its random arm is `hashtext`, which is
  // PARALLEL SAFE (see source-selection.ts). There is no mode to probe for.
  //
  // The probe binds ONLY what it reads. It used to carry the feed id as `$2`
  // for the sampling-mode half; leaving that bind in place once the half was
  // deleted made every feed page answer "could not determine data type of
  // parameter $2" — Postgres refuses a bind carrying more parameters than the
  // statement uses, the same rule this file already observes for the dedup
  // confidence push below. Nothing that tests the SQL BUILDERS can see it: the
  // fault is in what the route hands them.
  const minConfidence = await dedupMinConfidence();
  const {
    rows: [plan],
  } = await db.query<{ has_links: boolean }>(
    `SELECT ${dedupApplicableExistsSql(2)} AS has_links`,
    [readerId, minConfidence],
  );
  const dedupOn = plan?.has_links === true;

  // α and the proof floor are read on every page now, not behind a brake: they
  // are the TOP criterion, which is a per-source reader choice rather than a
  // claim the platform makes. α is the constant following value since the reach
  // source kind was retired (migration 177) — see feedAlphaCte.
  const blend = await loadProofBlendParams();
  const alphaParam = params.push(blend.alphaFollowing);
  const floorParam = params.push(blend.floor);

  // Pushed only on the branch that reads it: Postgres refuses a bind carrying
  // more parameters than the statement uses, so an unconditional push would
  // error on every feed page that has no dedup block.
  //
  // The fragment is handed to the selection builder rather than concatenated
  // after it, because dedup has to resolve BEFORE the per-source cut — a winner
  // picked out of the post-cut set changes from page to page, and then one post
  // appears twice. See lib/source-selection.ts › WHY DEDUP SITS IN THE MIDDLE.
  const dedupCtesFragment = dedupOn ? dedupCtes(params.push(minConfidence)) : "";

  const windowStartParam =
    opts.windowStart !== undefined ? params.push(opts.windowStart) : undefined;

  const selectionCtes = sourceSelectionCtes({
    alphaParam,
    floorParam,
    cursor: cursorParams,
    dedupCtes: dedupCtesFragment,
    windowStartParam,
  });

  const sql = `
    WITH${dedupOn ? " RECURSIVE" : ""} ${feedAlphaCte(alphaParam)},
    -- Per-source selection, ending in "matched" (fi_id) — the relation the
    -- ranking pass below expects. The Slice 8 dedup CTEs are inside this list,
    -- not after it: the winner has to be picked before the cut. One UNION ALL branch per source_type, each an index-friendly
    -- equijoin: this used to be a single join whose ON was the OR of all arms,
    -- and an OR-of-arms join has no hashable key, so the planner brute-forced
    -- feed_items × feed_sources — 24.9M pair evaluations (~4.5s) for one page
    -- of a 717-source follow-import feed (EXPLAIN'd 2026-07-25). The branches
    -- ride idx_feed_items_author / idx_feed_items_source /
    -- idx_feed_items_article. (The reach:following / reach:explore arms were
    -- retired with the reach source kind, migration 177 — §9.16.)
    ${selectionCtes},
    -- Rank-then-project: filter, sort and LIMIT over a SLIM row (id + the
    -- cursor pair + the columns the visibility predicates need), then join
    -- the heavy FEED_SELECT/POST_SELECT projection — with its correlated
    -- subqueries (tag_names, reply/quote post-id derivation) and six LEFT
    -- JOINs — onto the ≤$3 winners only. Before this split the full projection
    -- ran per CANDIDATE (~12k rows on a large follow-import feed) to return 20
    -- (the same shape of win as the provenance lateral's post-LIMIT move,
    -- ~1.8s → ~80ms). The notes/external_items joins stay in the ranking pass
    -- because its WHERE reads them.
    ranked AS (
      SELECT * FROM (
        SELECT fi.id AS fi_id, fi.published_at, m.joined_at
        FROM feed_items fi
        JOIN matched m ON m.fi_id = fi.id
        LEFT JOIN notes n ON n.id = fi.note_id
        WHERE fi.deleted_at IS NULL
          -- No self-exclusion here (unlike the explore queries): membership in a
          -- composable feed is explicit — nothing enters without a feed_sources
          -- match — so the reader's own items appear iff a source they added
          -- admits them (themselves as a source, their publication, a tag they
          -- post under). The old "not self" clause was inherited from explore
          -- semantics and silently overrode an explicit self-source.
          -- HIDING IS SYMMETRIC (CA-B9, 2026-09-29): a block runs between a
          -- PAIR, so a member who blocked the reader is hidden from them just
          -- as one they blocked is. This spelled blocker_id = $1 alone — one
          -- direction — beside its own mute clause; the one home carries both
          -- and the mute with them, so the arm cannot drift back on its own.
          AND NOT ${hiddenFromViewerSql("$1", "fi.author_id")}
          -- WHAT IS STILL FILTERED HERE, AND WHY IT IS THE REST. Anything that
          -- decides whether an ITEM can appear at all now runs inside the
          -- selection arms, so that the throughput percentile is taken over a
          -- population that can actually arrive (source-selection.ts). Three
          -- things stay:
          --   · blocks and mutes, which are facts about the READER rather than
          --     the item, and whose dilution is a handful of rows against a
          --     cost that would be paid over the whole arm set;
          --   · the native note-reply filter, which is 0 rows on the dev corpus
          --     — nothing to recover, and it would cost every arm a join to
          --     the notes table. It is about notes.reply_to_event_id, a
          --     column no live write path sets: a NATIVE REPLY is a
          --     kind-1111 comments row, which since migration 232 arrives
          --     as its own item_type = 'comment' card and is gated by
          --     exclude_replies in the arms like every other reply;
          --   · nothing else. The per-source reply gate, is_context_only and
          --     the Slice 8 suppression all moved up.
          AND (fi.item_type != 'note' OR n.reply_to_event_id IS NULL)
      ) s
      -- No cursor predicate here: the selection builder owns both halves of it
      -- — a bucket-granular bound on each source's measurement window (so the
      -- cursor's own week arrives WHOLE and the cut inside it is a fact about
      -- the post rather than about the page) and the exact keyset applied to
      -- the matched CTE, after the cut. Everything reaching this pass is already
      -- both selected and below the reader's position.
      ORDER BY published_at DESC, fi_id DESC
      LIMIT $3
    )`;
  return { sql, params, dedupOn };
}

async function sourceFilteredItems(
  readerId: string,
  feedId: string,
  rawCursor: string | undefined,
  limit: number,
  db: Db = pool,
): Promise<{ items: Post[]; nextCursor: string | undefined }> {
  const decoded = decodeFeedCursor(rawCursor);
  const cursor = decoded?.kind === "ts" ? decoded : undefined;
  const { sql: selectedSql, params, dedupOn } = await selectedSlimSql(
    db,
    readerId,
    feedId,
    limit,
    { cursor },
  );

  const result = await db.query<any>(
    `
    ${selectedSql}
    -- Provenance ("ALSO ON BLUESKY · MASTODON"): display-only on the returned
    -- page, so compute it AFTER the cursor/ORDER/LIMIT — over the ≤$3 survivors
    -- actually returned, not every survivor pre-LIMIT (the lateral references
    -- only scored.fi_id, which FEED_SELECT projects).
    -- The cursor pair stays in scored.* for the JS below.
    SELECT scored.*, ${dedupOn ? "prov.also_on" : "NULL::text[] AS also_on"}
    FROM (
      SELECT ${FEED_SELECT}${POST_SELECT},
        r.fi_id AS cursor_fi_id, ${feedCursorEpoch("r.published_at", "cursor_secs")}
      FROM ranked r
      JOIN feed_items fi ON fi.id = r.fi_id
      ${FEED_JOINS}${POST_JOINS}
    ) scored
    ${dedupOn ? DEDUP_PROVENANCE_LATERAL : ""}
    -- Re-impose order: the lateral join doesn't preserve the subquery's ORDER,
    -- and the JS reads the last row for nextCursor (below). Cheap — ≤$3 rows.
    ORDER BY cursor_secs DESC, cursor_fi_id DESC
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
  // The order is the composed vessel's timeline; the §5 hotness number is NOT
  // applied here (FEED-RETIREMENT-PLAN Slice 6 item 4), and since migration 202
  // neither is any other ranking — what the volume bar decides is WHICH posts
  // are here, never where they sit.
  const items = result.rows.map(feedItemToPost);
  await stampLockedConversations(readerId, result.rows, items);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor = lastRow
    ? encodeFeedCursor({
        kind: "ts",
        ts: Number(lastRow.cursor_secs),
        id: lastRow.cursor_fi_id,
      })
    : undefined;

  // A member's cross-post that came back is drawn as their note (rung B3);
  // the cursor above is the ROWS', so paging is untouched.
  return { items: await drawEchoesAsNotes(readerId, items), nextCursor };
}

// THE ONE VIEWER-DEPENDENT FACT ON A CARD, STAMPED WHERE THE VIEWER IS KNOWN.
//
// A native reply reaches a feed as a card of its own (migration 232), and its
// conversation may hang off a paywalled article this reader cannot open. The
// conversation is public and stays public (ARTICLE-HEADED-CONVERSATIONS-ADR
// D3) — what the card needs is `rootLocked`, so it draws no reply/quote/vote
// control it would only have refused (D6). `feedItemToPost` cannot answer it:
// it takes no viewer and must not learn to, which is why this runs after the
// mapping rather than inside it — the same division `GET /author/:id/replies`
// already makes.
//
// SET-BASED, and ABSENT IS NOT FALSE. `resolveLockedRoots` answers the whole
// page in two reads (one for an anonymous viewer, who can read none of them),
// where a call per card would be ~3 sequential round trips each. A card whose
// root is not a paywalled article is left untouched rather than stamped
// `false`: readers key on `=== true`, and "nobody asked" is the truth about
// every THING on the page.
async function stampLockedConversations(
  readerId: string,
  rows: any[],
  items: Post[],
): Promise<void> {
  const rootEventIds = [
    ...new Set(
      rows
        .filter((r) => r.item_type === "comment" && r.cm_target_event_id)
        .map((r) => r.cm_target_event_id as string),
    ),
  ];
  if (rootEventIds.length === 0) return;
  const locked = await resolveLockedRoots(readerId, rootEventIds);
  if (locked.size === 0) return;
  rows.forEach((r, i) => {
    if (r.item_type === "comment" && locked.has(r.cm_target_event_id)) {
      items[i].rootLocked = true;
    }
  });
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
      -- Symmetric, through the one home (CA-B9) — see the composed arm.
      AND NOT ${hiddenFromViewerSql("$1", "fi.author_id")}
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
