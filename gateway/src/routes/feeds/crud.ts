import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  UUID_RE,
  type FeedRow,
  createFeedForOwner,
  feedProvenanceSql,
  feedRowToResponse,
  loadFeed,
  tagged,
} from "./shared.js";
import { removeSource } from "./sources.js";
import { populateFeedFromFormula } from "./formulas.js";

const createFeedSchema = z.object({
  name: z.string().trim().max(80).default(""),
});

// Curated per-feed colour schemes (migration 112). Must mirror the scheme ids
// in web/src/components/workspace/tokens.ts — adding a scheme touches both.
// The web client normalises unknown ids to the light default, so a stale
// client against a newer server degrades gracefully; the enum here just stops
// junk reaching the row. The colourful schemes have been replaced by the
// four-seasons family (DESIGN-TUNING-FINDINGS §3, superseding the
// FEED-SCHEME-REFRESH-ADR renames blush/sage/sand/slate → mata/cobalto →
// anil/vela/caju); rows still holding a retired id are migrated on read by the
// client's normalizeBrightness alias map, so no DB backfill is needed — only
// new ids are ever written back here.
// A feed scheme is a COLOURWAY (seasonal character); light/dark is the global
// per-device toggle, not the per-feed scheme. Must mirror SCHEME_OPTIONS in
// web/src/components/workspace/tokens.ts. The retired mode-fixed ids
// "primary"/"dark" stay accepted (they alias to "basic" on the client) so a
// feed PATCH that round-trips an old persisted value is not rejected.
const FEED_SCHEME_IDS = [
  "basic",
  "spring",
  "summer",
  "autumn",
  "winter",
  "primary",
  "dark",
] as const;

// Per-feed density (MOBILE-LAYOUT-ADR §VI): feed character like the scheme,
// stored as a second key in the same appearance JSONB — no DDL. Must mirror
// the Density type in web/src/components/workspace/tokens.ts, a three-state
// cycle (standard/compact/headline). The retired "full" stays accepted (the
// client aliases it to "standard" on read via normalizeDensity) so a feed PATCH
// that round-trips an old persisted value from a stale client is not rejected;
// new clients never write it.
const FEED_DENSITIES = ["compact", "standard", "headline", "full"] as const;

// PATCH accepts any of name + appearance + hidden. Appearance is merged into
// the existing JSONB (not replaced) so future appearance keys written by
// another surface survive a scheme-only update. `hidden` is feed character
// (MOBILE-LAYOUT-ADR §V): it travels with the feed, excludes it from the
// mobile rotation, and skips it in the 1..N numbering on both surfaces.
const patchFeedSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    appearance: z
      .object({
        scheme: z.enum(FEED_SCHEME_IDS).optional(),
        density: z.enum(FEED_DENSITIES).optional(),
      })
      .strict()
      .refine((a) => a.scheme !== undefined || a.density !== undefined, {
        message: "Empty appearance",
      })
      .optional(),
    hidden: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.appearance !== undefined ||
      b.hidden !== undefined,
    {
      message: "Nothing to update",
    },
  );

// ---------------------------------------------------------------------------
// Starter-feed seeding (FEED-RETIREMENT Slice 3, workstream B).
//
// A brand-new account follows nobody, so a bare default vessel would be empty.
// Instead new accounts receive the platform's starter composition as a real,
// fully-editable owned feed — not a special-cased default object.
//
// WHAT IT IS SEEDED FROM is the operator-designated default-seed FORMULA
// (FEED-FORMULAS-ADR D6/D11), redeemed through the same core any shared formula
// goes through. Designation is an admin act — the *Default seed* panel on
// /admin/config, `POST /admin/dashboard/seed-formula`.
//
// It used to be a clone of a feed flagged `feeds.is_starter_template`, dropped
// in migration 179 along with the two 409 guards that grew around it. The flag
// marked an ordinary-looking feed as load-bearing and nothing said so, and it
// was tidied away twice by an operator who could not tell it from any other
// feed — each time silently ending seeding for every subsequent signup (§0l).
// A formula cannot die that way: it is frozen, and undeletable and unrevocable
// while designated, in the schema rather than in a route.
//
// PREREQ: with nothing designated, seeding is a no-op and a new account falls
// back to the client's empty-default-feed mint. That state is legal — it is
// where a fresh database sits until the operator designates one.
// ---------------------------------------------------------------------------

// Idempotent: give an owner who has none of their own feeds the platform's
// starter composition. Guarded by a per-owner advisory lock so two concurrent
// first loads (e.g. signup racing the first workspace fetch) can't double-seed.
// Returns the number of feeds seeded (0 if the owner already has feeds, or
// nothing is designated).
//
// NOT gated on FEED_FORMULAS_ENABLED, deliberately and permanently (§6): that
// brake gates publish and redeem-by-token. Gating the seed on it would mean
// turning the flag off silently ends new-account seeding — the §0l outage
// again, from the opposite direction. The seed path and the share path share a
// mechanism; they must not share a brake.
//
// Exported for the DB-backed test (feed-seed-formula.test.ts): what must hold
// spans feed_formulas → feeds → feed_sources → external_subscriptions, and a
// mocked pool.query would answer "did the redeemer get a subscription?" from
// the mock rather than from the path addSource actually takes.
export async function seedStarterFeeds(ownerId: string): Promise<number> {
  // Fast path: the overwhelming-common case is an owner who already has feeds.
  // A cheap unlocked COUNT keeps the per-request cost off the hot path — we
  // only open a transaction + take the advisory lock when there's nothing yet.
  const {
    rows: [{ count: pre }],
  } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
    [ownerId],
  );
  if (parseInt(pre, 10) > 0) return 0;

  // The claim is a SHORT transaction that COMMITS before any source is added
  // (§0s.4): take the per-owner seed lock, re-check, and mint the feed row —
  // which is then the recorded "seeded" fact a concurrent first-load sees. The
  // old shape held this pooled client open across the whole redemption while
  // every addSource inside took a further client, so N concurrent first-loads
  // ≥ pool size each held one and waited 5s for a second, and a signup burst
  // minted members with silently partial starter feeds. Now the lock guards
  // only the mint; population runs on the pool with nothing held.
  //
  // The failure mode this trades into: a crash between the claim committing
  // and population finishing leaves a visibly EMPTY starter feed (it serves
  // the explore placeholder) rather than a duplicate seed — the loud half of
  // the bargain, same per-source partial-failure reporting as before below.
  const claim = await withTransaction(async (client) => {
    // Serialise per owner. hashtextextended → bigint for the advisory key.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `feed-seed:${ownerId}`,
    ]);
    const {
      rows: [{ count }],
    } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
      [ownerId],
    );
    if (parseInt(count, 10) > 0) return null;

    // At most one row can be designated and it can never be revoked — both are
    // schema guarantees (D11, migration 178), so this needs no ORDER BY and no
    // revoked filter to be deterministic.
    const {
      rows: [seed],
    } = await client.query<{
      id: string;
      name: string;
      appearance: Record<string, unknown> | null;
    }>(`SELECT id, name, appearance FROM feed_formulas WHERE is_default_seed`);
    if (!seed) return null;

    // Minted on `client` so the feed commits WITH the claim — the same shape
    // redeemFormulaForOwner mints (appearance travels, from_formula_id set),
    // just inside the lock instead of after it.
    const feed = await createFeedForOwner(ownerId, seed.name, client, {
      appearance: seed.appearance ?? {},
      fromFormulaId: seed.id,
    });
    return { feedId: feed.id, formulaId: seed.id };
  });
  if (!claim) return 0;

  // On the pool, holding nothing — each addSource opens its own transaction
  // under its own `feed_sub:` advisory key, taken strictly after `feed-seed:`
  // has been released, so there is no cycle to deadlock on and no client held
  // while waiting for another.
  const result = await populateFeedFromFormula(
    claim.feedId,
    ownerId,
    claim.formulaId,
  );
  if (result.failed.length > 0) {
    // Never silent. A seed that quietly drops half its sources reads to a
    // new member as the composition we chose for them, and the only witness
    // is this line — the same class of failure as the starter template being
    // deleted, one level down.
    logger.error(
      {
        ownerId,
        formulaId: claim.formulaId,
        added: result.added,
        failed: result.failed,
      },
      "Default-seed formula redeemed with failures",
    );
  }
  return 1;
}

// List the caller's feeds in rank order, seeding starter templates first for an
// owner with none (MOBILE-LAYOUT-ADR §VII: sort_rank is the persisted order
// behind the numeral and the mobile swipe sequence; created_at/id are
// deterministic tie-breaks). Returns the raw FeedRow[] (carrying source_count)
// so callers can both map to the wire shape AND branch the items query on
// source_count without a second round trip. Shared by GET /feeds and the
// /bootstrap aggregate (performance audit #3).
export async function listFeedsForOwner(ownerId: string): Promise<FeedRow[]> {
  // Zero-feeds guard (Slice 3, workstream B): seed the starter composition on
  // first load for any owner with no feeds — covers fresh signups (both OAuth
  // and email paths) and pre-existing empty accounts uniformly, since every
  // workspace session reads this list. Idempotent + advisory-locked. No-op when
  // nothing is designated and no template is flagged (the client then mints an
  // empty feed).
  try {
    await seedStarterFeeds(ownerId);
  } catch (err) {
    // Never block the workspace on a seeding hiccup — log and serve whatever
    // feeds exist (possibly none, in which case the client mints a default).
    logger.error({ err, ownerId }, "Starter-feed seeding failed");
  }
  const { rows } = await pool.query<FeedRow>(
    `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
       (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
       ${feedProvenanceSql("f")}
     FROM feeds f
     WHERE f.owner_id = $1
     ORDER BY f.sort_rank ASC, f.created_at ASC, f.id ASC`,
    [ownerId],
  );
  return rows;
}

export function registerFeedCrudRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds — list mine, in rank order
  // ---------------------------------------------------------------------------
  app.get("/feeds", { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub;
    const rows = await listFeedsForOwner(ownerId);
    return reply.send({ feeds: rows.map(feedRowToResponse) });
  });

  // ---------------------------------------------------------------------------
  // POST /feeds — create
  // ---------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    "/feeds",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const parsed = createFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const feed = await createFeedForOwner(ownerId, parsed.data.name);
      return reply.status(201).send({ feed: feedRowToResponse(feed) });
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /feeds/:id — rename and/or set appearance (colour scheme)
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = patchFeedSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      let paramIdx = 3; // $1=id, $2=ownerId
      if (parsed.data.name !== undefined) {
        sets.push(`name = $${paramIdx}`);
        vals.push(parsed.data.name);
        paramIdx++;
      }
      if (parsed.data.appearance !== undefined) {
        // JSONB merge, not replace — future appearance keys survive a
        // scheme-only update.
        sets.push(`appearance = appearance || $${paramIdx}::jsonb`);
        vals.push(JSON.stringify(parsed.data.appearance));
        paramIdx++;
      }
      if (parsed.data.hidden !== undefined) {
        sets.push(`hidden = $${paramIdx}`);
        vals.push(parsed.data.hidden);
        paramIdx++;
      }

      const { rows } = await pool.query<FeedRow>(
        `UPDATE feeds SET ${sets.join(", ")}
         WHERE id = $1 AND owner_id = $2
         RETURNING id, name, appearance, sort_rank, hidden, created_at, updated_at,
           (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = feeds.id) AS source_count,
           ${feedProvenanceSql("feeds")}`,
        [id, ownerId, ...vals],
      );
      if (rows.length === 0)
        return reply.status(404).send({ error: "Feed not found" });
      return reply.send({ feed: feedRowToResponse(rows[0]) });
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /feeds/order — bulk re-rank (MOBILE-LAYOUT-ADR §VII.3)
  //
  // Body: { feedIds } — the caller's complete feed set in the desired order.
  // Ranks are plain integers rewritten in full on each reorder (feeds per
  // user are few; fractional keys are unjustified complexity). Requiring the
  // full set keeps a stale client from silently interleaving with a feed
  // created in another tab — on mismatch the client refetches and retries.
  // ---------------------------------------------------------------------------
  app.put<{ Body: unknown }>(
    "/feeds/order",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const parsed = z
        .object({ feedIds: z.array(z.string().uuid()).min(1).max(500) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const ids = parsed.data.feedIds;
      if (new Set(ids).size !== ids.length)
        return reply.status(400).send({ error: "Duplicate feed ids" });

      const { rows: ownedRows } = await pool.query<{ id: string }>(
        `SELECT id FROM feeds WHERE owner_id = $1`,
        [ownerId],
      );
      const owned = new Set(ownedRows.map((r) => r.id));
      if (ids.length !== owned.size || ids.some((id) => !owned.has(id))) {
        return reply.status(409).send({
          error: "Feed list out of date — refresh and retry",
        });
      }

      await pool.query(
        `UPDATE feeds f
         SET sort_rank = x.rank
         FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, rank)
         WHERE f.id = x.id AND f.owner_id = $1`,
        [ownerId, ids],
      );

      const { rows } = await pool.query<FeedRow>(
        `SELECT f.id, f.name, f.appearance, f.sort_rank, f.hidden, f.created_at, f.updated_at,
           (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count,
           ${feedProvenanceSql("f")}
         FROM feeds f
         WHERE f.owner_id = $1
         ORDER BY f.sort_rank ASC, f.created_at ASC, f.id ASC`,
        [ownerId],
      );
      return reply.send({ feeds: rows.map(feedRowToResponse) });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /feeds/:id
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/feeds/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const {
        rows: [{ count }],
      } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM feeds WHERE owner_id = $1`,
        [ownerId],
      );
      if (parseInt(count, 10) <= 1)
        return reply
          .status(409)
          .send({ error: "Cannot delete your only feed" });

      // No starter-template guard here any more, and its absence is the point:
      // migration 179 dropped `is_starter_template`, so no feed on this floor
      // is load-bearing for anyone but its owner. The guard, and the 2026-07-22
      // and 08-10 incidents that forced it, existed because deleting one
      // ordinary-looking feed silently ended new-account seeding platform-wide.
      // The designated seed FORMULA that replaced it has no `feeds` row to
      // delete (FEED-FORMULAS-ADR D6) — which is why this delete can go back to
      // being an ordinary delete rather than needing a better guard.

      // Tear down external sources through removeSource FIRST (H6). A bare
      // DELETE cascades feed_sources away without passing through the
      // feed-derived-subscription teardown: the derived external_subscriptions
      // row would survive, so the source polls forever (the GC keys "orphaned"
      // on external_subscriptions), the author card stays "Following" with no
      // surface left to undo it, and a nostr_external follow stays on the
      // published kind-3. Each call handles its own last-feed check + advisory
      // lock. recordExclusion:false — deleting a feed isn't a curation edit, and
      // its feed_import_exclusions cascade away with it anyway.
      const { rows: extSources } = await pool.query<{ id: string }>(
        `SELECT id FROM feed_sources
          WHERE feed_id = $1 AND source_type = 'external_source'`,
        [id],
      );
      for (const s of extSources) {
        await removeSource(id, ownerId, s.id, { recordExclusion: false });
      }

      const { rowCount } = await pool.query(
        `DELETE FROM feeds WHERE id = $1 AND owner_id = $2`,
        [id, ownerId],
      );
      if (rowCount === 0)
        return reply.status(404).send({ error: "Feed not found" });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /feeds/:id/merge — merge a source feed into this (target) feed
  //
  // Moves non-duplicate sources and saves from the source feed into the
  // target, then deletes the source feed. Both feeds must exist and be
  // owned by the caller.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id/merge",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id: targetId } = req.params;
      if (!UUID_RE.test(targetId))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = z
        .object({ sourceFeedId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { sourceFeedId } = parsed.data;

      if (sourceFeedId === targetId) {
        return reply
          .status(400)
          .send({ error: "Cannot merge a feed into itself" });
      }

      try {
        await withTransaction(async (client) => {
          // 1. Verify both feeds exist and are owned by the caller.
          const { rows: feedRows } = await client.query<{
            id: string;
            owner_id: string;
          }>(
            // FOR UPDATE holds both rows for the length of the transaction, so
            // the ownership check above still speaks for the feeds step 5
            // actually deletes. ORDER BY id keeps the two-row lock order
            // deterministic, so opposing concurrent merges (A→B and B→A) queue
            // instead of deadlocking.
            `SELECT id, owner_id FROM feeds WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [[targetId, sourceFeedId]],
          );
          const targetFeed = feedRows.find((r) => r.id === targetId);
          const sourceFeed = feedRows.find((r) => r.id === sourceFeedId);

          if (!targetFeed) {
            throw tagged("NOT_FOUND_TARGET");
          }
          if (!sourceFeed) {
            throw tagged("NOT_FOUND_SOURCE");
          }
          if (targetFeed.owner_id !== ownerId) {
            throw tagged("FORBIDDEN_TARGET");
          }
          if (sourceFeed.owner_id !== ownerId) {
            throw tagged("FORBIDDEN_SOURCE");
          }

          // (The starter-template refusal that stood here retired with
          // `feeds.is_starter_template` in migration 179 — merge deletes its
          // SOURCE feed, and the 2026-07-22 prod incident was a drag gesture
          // destroying the one flagged row every signup was cloned from. The
          // designated seed formula that replaced it has no `feeds` row for a
          // merge to consume, so a merge is now just a merge.)

          // 2. Move non-duplicate sources from source → target.
          //    Exclude rows that would conflict with existing target sources
          //    by matching on type + FK.
          await client.query(
            `UPDATE feed_sources SET feed_id = $1
             WHERE feed_id = $2
               AND NOT EXISTS (
                 SELECT 1 FROM feed_sources t
                 WHERE t.feed_id = $1
                   AND t.source_type = feed_sources.source_type
                   AND (
                     (t.source_type = 'account' AND t.account_id = feed_sources.account_id)
                     OR (t.source_type = 'publication' AND t.publication_id = feed_sources.publication_id)
                     OR (t.source_type = 'external_source' AND t.external_source_id = feed_sources.external_source_id)
                     OR (t.source_type = 'tag' AND t.tag_name = feed_sources.tag_name)
                   )
               )`,
            [targetId, sourceFeedId],
          );

          // 3. Delete remaining orphaned source rows (duplicates that couldn't move).
          await client.query(`DELETE FROM feed_sources WHERE feed_id = $1`, [
            sourceFeedId,
          ]);

          // 4. Move non-duplicate saves.
          await client.query(
            `INSERT INTO feed_saves (id, feed_id, feed_item_id, created_at)
             SELECT gen_random_uuid(), $1, feed_item_id, created_at
             FROM feed_saves WHERE feed_id = $2
             ON CONFLICT (feed_id, feed_item_id) DO NOTHING`,
            [targetId, sourceFeedId],
          );

          // 5. Delete the source feed (cascades remaining feed_saves).
          await client.query(`DELETE FROM feeds WHERE id = $1`, [sourceFeedId]);
        });

        // 6. Return the updated target feed.
        const updatedFeed = await loadFeed(targetId, ownerId);
        if (!updatedFeed)
          return reply.status(404).send({ error: "Feed not found" });
        return reply.send({ feed: feedRowToResponse(updatedFeed) });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "NOT_FOUND_TARGET" || code === "NOT_FOUND_SOURCE") {
          return reply.status(404).send({ error: "Feed not found" });
        }
        if (code === "FORBIDDEN_TARGET" || code === "FORBIDDEN_SOURCE") {
          return reply.status(403).send({ error: "Feed not owned by you" });
        }
        logger.error({ err, targetId, sourceFeedId }, "Feed merge failed");
        return reply.status(500).send({ error: "Feed merge failed" });
      }
    },
  );
}
