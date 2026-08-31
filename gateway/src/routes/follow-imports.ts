import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { UUID_RE } from "../lib/uuid.js";
import {
  createFeedForOwner,
  feedRowToResponse,
  loadFeed,
} from "./feeds/shared.js";
import {
  followImportEnabled,
  importFeedName,
  readFollowGraph,
  kickFollowImportSweep,
  computeSyncDiff,
  FOLLOW_IMPORT_CAP,
  type ImportIdentity,
  type ImportProtocol,
  type SyncMember,
} from "../lib/follow-import.js";
import { parseOpml, planOpmlImport, OPML_MAX_FEEDS } from "../lib/opml.js";

// =============================================================================
// Follow-graph import runs (FOLLOW-GRAPH-IMPORT-ADR §11.3).
//
// POST /follow-imports — validate the origin, read the remote graph ONCE, cap
// it, and persist the run row (identities + cursor make the sweep restartable)
// plus the origin binding and the new feed, all in one transaction. The sweep
// (gateway scheduler / the immediate kick) then feeds each identity through
// the addSource core. GET /follow-imports/:id is the client's progress poll.
//
// Dark behind FOLLOW_IMPORT_ENABLED (routes 404 when off, like an unshipped
// feature). Imports are opt-in per run — nothing here fires automatically on
// account link (D7).
// =============================================================================

const createImportSchema = z.object({
  protocol: z.enum(["atproto", "nostr_external", "activitypub", "rss"]),
  originIdentity: z.string().trim().min(1).max(2048),
  feedName: z.string().trim().min(1).max(80).optional(),
});

interface FollowImportStatusRow {
  id: string;
  protocol: string;
  origin_identity: string;
  feed_id: string;
  kind: string;
  status: string;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  removed: number;
  removals_total: number;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const STATUS_ROW_COLUMNS = `id, protocol, origin_identity, feed_id, kind,
       status, total, imported, skipped, failed, removed,
       jsonb_array_length(removals) AS removals_total,
       error, created_at, finished_at`;

function importRowToResponse(row: FollowImportStatusRow) {
  return {
    id: row.id,
    protocol: row.protocol,
    originIdentity: row.origin_identity,
    feedId: row.feed_id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    imported: row.imported,
    skipped: row.skipped,
    failed: row.failed,
    removed: row.removed,
    removalsTotal: Number(row.removals_total),
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export default async function followImportRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /follow-imports — start an import run
  // ---------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    "/follow-imports",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;

      const parsed = createImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { protocol, originIdentity, feedName } = parsed.data;

      const graph = await readFollowGraph(protocol, originIdentity, {
        accountId: ownerId,
      });
      if (!graph.ok) {
        if (graph.reason === "unsupported")
          return reply
            .status(400)
            .send({ error: "import_unsupported", message: graph.message });
        if (graph.reason === "malformed")
          return reply
            .status(400)
            .send({ error: "invalid_origin", message: graph.message });
        if (graph.reason === "hidden")
          // AP-only (§5.3): the follow list exists but the public endpoint
          // hides it — linking the account is the fix, so the client gets a
          // distinct code to say so.
          return reply
            .status(422)
            .send({ error: "follows_hidden", message: graph.message });
        return reply
          .status(422)
          .send({ error: "origin_unreachable", message: graph.message });
      }
      if (graph.identities.length === 0) {
        // Reachable but nothing to import (an empty follow list). Distinct
        // from unreachable so the client can say so plainly.
        return reply.status(422).send({
          error: "empty_graph",
          message: "This account doesn't follow anyone we can import",
        });
      }

      const { feed, importId } = await withTransaction(async (client) => {
        const feedRow = await createFeedForOwner(
          ownerId,
          feedName ?? importFeedName(protocol),
          client,
        );
        // Origin binding recorded from Phase 1 (§6.3) so the feed is
        // sync-capable retroactively when Phase 2 ships.
        await client.query(
          `INSERT INTO feed_import_bindings (feed_id, protocol, origin_identity)
           VALUES ($1, $2, $3)`,
          [feedRow.id, protocol, graph.originIdentity],
        );
        const {
          rows: [run],
        } = await client.query<{ id: string }>(
          `INSERT INTO follow_imports
             (account_id, protocol, origin_identity, feed_id, total, identities)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id`,
          [
            ownerId,
            protocol,
            graph.originIdentity,
            feedRow.id,
            graph.identities.length,
            JSON.stringify(graph.identities),
          ],
        );
        return { feed: feedRow, importId: run.id };
      });

      // Start processing now rather than on the next scheduler tick. Best
      // effort — the scheduler sweep picks the row up regardless.
      kickFollowImportSweep().catch((err) =>
        logger.warn({ err, importId }, "follow import kick failed"));

      return reply.status(201).send({
        import: {
          id: importId,
          protocol,
          originIdentity: graph.originIdentity,
          originLabel: graph.originLabel,
          feedId: feed.id,
          status: "pending",
          total: graph.identities.length,
          imported: 0,
          skipped: 0,
          failed: 0,
          // No-silent-caps rule: the offer/summary states truncation and
          // any entries the read couldn't canonicalise (AP, rare).
          remoteTotal: graph.total,
          truncated: graph.truncated,
          cap: FOLLOW_IMPORT_CAP,
          unresolved: graph.unresolved ?? 0,
        },
        feed: feedRowToResponse(feed),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /follow-imports/opml — OPML upload (Phase 1d, ADR §5.4)
  //
  // RSS's "follow graph" is the OPML export every feed reader produces. The
  // client reads the file and sends its text; folders map to one feed per
  // folder under the OPML_MAX_FEEDS cap (overflow folds into the base feed),
  // so one upload can mint SEVERAL runs — the response carries them all, plus
  // the aggregate no-silent-caps facts. Unlike the graph protocols there is
  // no feed_import_bindings row: OPML is a snapshot by nature ("Sync now"
  // doesn't apply; re-import = new run), and the engine keeps the liveness
  // probe ON for rss runs (D6 exception — dead entries land in `failed`).
  // ---------------------------------------------------------------------------
  const opmlImportSchema = z.object({
    opml: z.string().min(1).max(2_000_000),
    feedName: z.string().trim().min(1).max(80).optional(),
  });

  app.post<{ Body: unknown }>(
    "/follow-imports/opml",
    // Default 1MiB body limit is too tight for a large reader export wrapped
    // in JSON escaping; the zod max above still bounds the OPML text itself.
    { preHandler: requireAuth, bodyLimit: 3 * 1024 * 1024 },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;

      const parsedBody = opmlImportSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsedBody.error.flatten() });
      }
      const { opml, feedName } = parsedBody.data;

      const parsed = parseOpml(opml);
      if (!parsed) {
        return reply.status(400).send({
          error: "opml_invalid",
          message:
            "Could not read this file as OPML — export a fresh copy from your reader and try again",
        });
      }
      const plan = planOpmlImport(parsed, {
        baseName: feedName,
        maxFeeds: OPML_MAX_FEEDS,
        cap: FOLLOW_IMPORT_CAP,
      });
      if (plan.feeds.length === 0) {
        return reply.status(422).send({
          error: "empty_opml",
          message: "No feed URLs found in this file",
        });
      }

      // originIdentity has no remote-account meaning for a file upload; the
      // head title is the most useful provenance we have.
      const originIdentity = parsed.title ?? "OPML file";

      const created = await withTransaction(async (client) => {
        const out: Array<{
          importId: string;
          feed: Awaited<ReturnType<typeof createFeedForOwner>>;
          total: number;
        }> = [];
        for (const planned of plan.feeds) {
          const feedRow = await createFeedForOwner(
            ownerId,
            planned.name,
            client,
          );
          const identities: ImportIdentity[] = planned.entries.map((e) => ({
            uri: e.url,
            displayName: e.title,
          }));
          const {
            rows: [run],
          } = await client.query<{ id: string }>(
            `INSERT INTO follow_imports
               (account_id, protocol, origin_identity, feed_id, total, identities)
             VALUES ($1, 'rss', $2, $3, $4, $5::jsonb)
             RETURNING id`,
            [
              ownerId,
              originIdentity,
              feedRow.id,
              identities.length,
              JSON.stringify(identities),
            ],
          );
          out.push({ importId: run.id, feed: feedRow, total: identities.length });
        }
        return out;
      });

      kickFollowImportSweep().catch((err) =>
        logger.warn({ err }, "follow import kick failed (opml)"));

      return reply.status(201).send({
        runs: created.map((c) => ({
          import: {
            id: c.importId,
            protocol: "rss",
            originIdentity,
            originLabel: originIdentity,
            feedId: c.feed.id,
            status: "pending",
            total: c.total,
            imported: 0,
            skipped: 0,
            failed: 0,
            // Truncation is reported once, at the plan level below — a run
            // never sees more than its post-cap share.
            remoteTotal: c.total,
            truncated: false,
            cap: FOLLOW_IMPORT_CAP,
          },
          feed: feedRowToResponse(c.feed),
        })),
        // Aggregate no-silent-caps facts (§6.5): identity-cap truncation,
        // folders folded by the feed cap, and invalid entries dropped at
        // parse time — the upload summary states them all.
        plan: {
          totalEntries: plan.totalEntries,
          remoteTotal: plan.remoteTotal,
          truncated: plan.truncated,
          cap: FOLLOW_IMPORT_CAP,
          foldedFolders: plan.foldedFolders,
          invalidEntries: plan.invalidEntries,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /follow-imports/sync — "Sync now" preview (Phase 2, ADR §11.5)
  //
  // Re-reads the bound feed's remote graph, diffs (remote − exclusions)
  // against current same-protocol membership, and persists the plan as a
  // status='preview' run the user confirms (below) or cancels. Removals are
  // computed only when the graph read was NOT truncated (past the cap we
  // can't tell "unfollowed" from "outside the window") — skipped removals
  // are stated in the response, never silent. A diff of nothing stamps
  // last_synced_at and reports up-to-date without minting a row.
  // ---------------------------------------------------------------------------
  const syncSchema = z.object({ feedId: z.string().regex(UUID_RE) });

  app.post<{ Body: unknown }>(
    "/follow-imports/sync",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;

      const parsed = syncSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { feedId } = parsed.data;

      const feed = await loadFeed(feedId, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const {
        rows: [binding],
      } = await pool.query<{
        protocol: ImportProtocol;
        origin_identity: string;
      }>(
        `SELECT protocol, origin_identity
           FROM feed_import_bindings WHERE feed_id = $1`,
        [feedId],
      );
      if (!binding) {
        return reply.status(409).send({
          error: "not_syncable",
          message: "This feed wasn't imported from a network, so there's nothing to sync",
        });
      }

      const {
        rows: [inFlight],
      } = await pool.query(
        `SELECT 1 FROM follow_imports
          WHERE feed_id = $1 AND status IN ('pending', 'running')
          LIMIT 1`,
        [feedId],
      );
      if (inFlight) {
        return reply.status(409).send({
          error: "sync_in_progress",
          message: "An import or sync is already running for this feed",
        });
      }

      const graph = await readFollowGraph(
        binding.protocol,
        binding.origin_identity,
        { accountId: ownerId },
      );
      if (!graph.ok) {
        if (graph.reason === "unsupported")
          return reply
            .status(400)
            .send({ error: "import_unsupported", message: graph.message });
        if (graph.reason === "malformed")
          return reply
            .status(400)
            .send({ error: "invalid_origin", message: graph.message });
        if (graph.reason === "hidden")
          return reply
            .status(422)
            .send({ error: "follows_hidden", message: graph.message });
        return reply
          .status(422)
          .send({ error: "origin_unreachable", message: graph.message });
      }

      const exclusions = new Set(
        (
          await pool.query<{ identity: string }>(
            `SELECT identity FROM feed_import_exclusions
              WHERE feed_id = $1 AND protocol = $2`,
            [feedId, binding.protocol],
          )
        ).rows.map((r) => r.identity),
      );
      const members: SyncMember[] = (
        await pool.query<{ source_uri: string; display_name: string | null }>(
          `SELECT xs.source_uri, xs.display_name
             FROM feed_sources fs
             JOIN external_sources xs ON xs.id = fs.external_source_id
            WHERE fs.feed_id = $1 AND fs.source_type = 'external_source'
              AND xs.protocol = $2`,
          [feedId, binding.protocol],
        )
      ).rows.map((r) => ({
        uri: r.source_uri,
        displayName: r.display_name ?? undefined,
      }));

      // Removals need certainty about the FULL remote set: a truncated read
      // can't tell "unfollowed" from "outside the window", and an entry the
      // read couldn't canonicalise (AP unresolved) is still followed even
      // though it's missing from the desired set — either way, suppress.
      const removalsSuppressed =
        graph.truncated || (graph.unresolved ?? 0) > 0;
      const { toAdd, toRemove } = computeSyncDiff(
        graph.identities,
        exclusions,
        members,
        { removalsAllowed: !removalsSuppressed },
      );

      if (toAdd.length === 0 && toRemove.length === 0) {
        await pool.query(
          `UPDATE feed_import_bindings SET last_synced_at = now()
            WHERE feed_id = $1`,
          [feedId],
        );
        return reply.send({
          preview: {
            upToDate: true,
            feedId,
            protocol: binding.protocol,
            originLabel: graph.originLabel,
            removalsSkipped: removalsSuppressed,
          },
        });
      }

      const importId = await withTransaction(async (client) => {
        // Supersede any unconfirmed earlier preview for this feed — one live
        // plan at a time.
        await client.query(
          `DELETE FROM follow_imports
            WHERE feed_id = $1 AND status = 'preview'`,
          [feedId],
        );
        const {
          rows: [run],
        } = await client.query<{ id: string }>(
          `INSERT INTO follow_imports
             (account_id, protocol, origin_identity, feed_id, kind, status,
              total, identities, removals)
           VALUES ($1, $2, $3, $4, 'sync', 'preview', $5, $6::jsonb, $7::jsonb)
           RETURNING id`,
          [
            ownerId,
            binding.protocol,
            graph.originIdentity,
            feedId,
            toAdd.length,
            JSON.stringify(toAdd),
            JSON.stringify(toRemove),
          ],
        );
        return run.id;
      });

      const label = (i: ImportIdentity) => i.displayName ?? i.uri;
      return reply.status(201).send({
        preview: {
          upToDate: false,
          id: importId,
          feedId,
          protocol: binding.protocol,
          originIdentity: graph.originIdentity,
          originLabel: graph.originLabel,
          adds: toAdd.length,
          removes: toRemove.length,
          addSample: toAdd.slice(0, 12).map(label),
          removeSample: toRemove.slice(0, 12).map(label),
          // No-silent-caps facts: a truncated graph read caps the adds AND
          // suppresses removals entirely (see route comment).
          truncated: graph.truncated,
          remoteTotal: graph.total,
          cap: FOLLOW_IMPORT_CAP,
          removalsSkipped: removalsSuppressed,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /follow-imports/:id/confirm — apply a previewed sync plan
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/follow-imports/:id/confirm",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid import id" });

      const { rows } = await pool.query<FollowImportStatusRow>(
        `UPDATE follow_imports
            SET status = 'pending'
          WHERE id = $1 AND account_id = $2
            AND kind = 'sync' AND status = 'preview'
          RETURNING ${STATUS_ROW_COLUMNS}`,
        [id, ownerId],
      );
      if (rows.length === 0)
        return reply
          .status(404)
          .send({ error: "No confirmable sync preview with this id" });

      kickFollowImportSweep().catch((err) =>
        logger.warn({ err, importId: id }, "follow sync kick failed"));

      return reply.send({ import: importRowToResponse(rows[0]) });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /follow-imports/:id — cancel an unconfirmed sync preview
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/follow-imports/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid import id" });

      // Previews only — pending/running/terminal runs are progress history,
      // not cancellable plans.
      const { rowCount } = await pool.query(
        `DELETE FROM follow_imports
          WHERE id = $1 AND account_id = $2 AND status = 'preview'`,
        [id, ownerId],
      );
      if (rowCount === 0)
        return reply
          .status(404)
          .send({ error: "No cancellable sync preview with this id" });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // GET /follow-imports/:id — progress poll
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/follow-imports/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!followImportEnabled())
        return reply.status(404).send({ error: "Not found" });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid import id" });

      const { rows } = await pool.query<FollowImportStatusRow>(
        `SELECT ${STATUS_ROW_COLUMNS}
           FROM follow_imports
          WHERE id = $1 AND account_id = $2`,
        [id, ownerId],
      );
      if (rows.length === 0)
        return reply.status(404).send({ error: "Import not found" });
      return reply.send({ import: importRowToResponse(rows[0]) });
    },
  );
}
