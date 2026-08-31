import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { loadAuthorLinkSource } from "./author.js";
import {
  assertIdentityLink,
  unlinkIdentityPair,
} from "../lib/identity-link-ops.js";

// =============================================================================
// Cross-source identity links — Slice 8 P2 ("Link to…" / "Unlink")
//
// A user_asserted link records one reader's claim that two external sources are
// the same identity cross-posting the same content — the input the dedup CTEs in
// sourceFilteredItems consume (drop the loser twin, surface "ALSO ON …"). Per
// the SLICE-8 plan's owner model these are OWNER-SCOPED (owner_id = asserter,
// confidence 1.0): an unverifiable claim suppresses content only in the
// asserter's own feed, never globally. Global automated links + the negative
// override are P3.
//
//   POST   /author/:authorId/links            { protocol, sourceUri } → create
//   DELETE /author/:authorId/links/:linkId                            → unlink
//
// source_a is the viewed author's backing source (derived server-side from
// authorId — never trusted from the client). source_b is the pasted target,
// upserted into external_sources so the link's FK resolves. The pair is stored
// LEAST/GREATEST-ordered to satisfy the table's `source_a_id < source_b_id`
// CHECK (A/B and B/A collapse to one row). The mutations themselves live in
// lib/identity-link-ops.ts (assertIdentityLink / unlinkIdentityPair) so the
// integration test runs the exact SQL; both converge the viewer's owner-scoped
// slot last-write-wins (Link → asserted, Unlink → not merged).
// =============================================================================


// Protocols a link target can carry — mirrors addSource's per-protocol shape
// (sources.ts) and the client's FOLLOWABLE_PROTOCOLS. email is intentionally
// excluded (no stable subscribable identity to dedup against).
function validateTarget(protocol: string, sourceUri: string): boolean {
  switch (protocol) {
    case "rss":
      try {
        const u = new URL(sourceUri);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    case "activitypub":
      try {
        return new URL(sourceUri).protocol === "https:";
      } catch {
        return false;
      }
    case "atproto":
      return /^did:(plc|web):[a-zA-Z0-9.:_-]+$/.test(sourceUri);
    case "nostr_external":
      return /^[0-9a-f]{64}$/i.test(sourceUri);
    default:
      return false;
  }
}

export async function identityLinkRoutes(app: FastifyInstance) {
  // POST /author/:authorId/links — assert that this author is also `sourceUri`.
  app.post<{
    Params: { authorId: string };
    Body: { protocol?: string; sourceUri?: string };
  }>(
    "/author/:authorId/links",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      const viewerId = req.session!.sub;
      const protocol = req.body?.protocol;
      const sourceUri = req.body?.sourceUri;

      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }
      if (!protocol || !sourceUri || !validateTarget(protocol, sourceUri)) {
        return reply.status(400).send({ error: "Invalid link target" });
      }

      try {
        // source_a — the viewed author's own backing source, server-derived.
        const srcA = await loadAuthorLinkSource(authorId);
        if (!srcA) {
          return reply
            .status(400)
            .send({ error: "Author has no linkable source" });
        }

        const result = await withTransaction(async (client) => {
          // Upsert source_b so the link FK resolves. Minimal SET (touch
          // updated_at only) — a link must NOT revive/reactivate an orphaned or
          // unsubscribed source (no subscription is implied by linking); the GC
          // is link-aware so the bare row survives (external-sources-gc.ts).
          const {
            rows: [srcBRow],
          } = await client.query<{
            id: string;
            display_name: string | null;
          }>(
            `INSERT INTO external_sources (protocol, source_uri)
             VALUES ($1::external_protocol, $2)
             ON CONFLICT (protocol, source_uri)
               DO UPDATE SET updated_at = now()
             RETURNING id, display_name`,
            [protocol, sourceUri],
          );
          const sourceBId = srcBRow.id;

          if (sourceBId === srcA.sourceId) {
            return { selfLink: true as const };
          }

          // Insert the owner-scoped assertion (pair ordered + ON CONFLICT
          // authoritative inside the helper, so a re-assert — including one that
          // reverses a prior unlink tombstone — is idempotent and lands on
          // 'user_asserted').
          const linkId = await assertIdentityLink(
            client,
            srcA.sourceId,
            sourceBId,
            viewerId,
          );

          return {
            selfLink: false as const,
            linkId,
            sourceBId,
            displayName: srcBRow.display_name,
          };
        });

        if (result.selfLink) {
          return reply
            .status(400)
            .send({ error: "Cannot link an author to itself" });
        }

        // The new chip the surface appends without a refetch.
        return reply.status(201).send({
          linkedSource: {
            linkId: result.linkId,
            protocol,
            sourceUri,
            displayName: result.displayName ?? undefined,
            sourceId: result.sourceBId,
          },
        });
      } catch (err) {
        logger.error({ err, authorId }, "Identity link create failed");
        return reply.status(500).send({ error: "Link failed" });
      }
    },
  );

  // DELETE /author/:authorId/links/:linkId — unlink.
  //
  // Converges the pair to "not merged" for this viewer, whichever link the clicked
  // chip pointed at (its own assertion or the global detection) — and even when
  // BOTH touch the pair. A pair carrying the viewer's own assertion AND a global
  // detected link surfaces ONE "own-first" chip (author.ts dedupes the two), so a
  // naive "delete what the chip points at" left the other alive: deleting the
  // assertion left the global merging, tombstoning the global was skipped to spare
  // the assertion — either way the merge survived and "Stop merging" did nothing.
  // unlinkIdentityPair picks the right move (tombstone the global, else delete the
  // assertion); see lib/identity-link-ops.ts.
  app.delete<{ Params: { authorId: string; linkId: string } }>(
    "/author/:authorId/links/:linkId",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { linkId } = req.params;
      const viewerId = req.session!.sub;
      if (!UUID_RE.test(linkId)) {
        return reply.status(400).send({ error: "Invalid link id" });
      }

      try {
        // Look up the target link. Only the viewer's own assertion or a global
        // link is actionable (another reader's assertion is invisible/untouchable).
        const {
          rows: [link],
        } = await pool.query<{
          source_a_id: string;
          source_b_id: string;
          owner_id: string | null;
          link_type: string;
        }>(
          `SELECT source_a_id, source_b_id, owner_id, link_type
             FROM external_identity_links WHERE id = $1`,
          [linkId],
        );
        if (!link) {
          return reply.status(404).send({ error: "Link not found" });
        }

        // Actionable iff the row is the viewer's own or a global fact; another
        // reader's owned assertion is invisible/untouchable. Unlinking the
        // viewer's OWN tombstone is a no-op (already not merged).
        const isOwn = link.owner_id === viewerId;
        const isGlobal = link.owner_id === null;
        if (!isOwn && !isGlobal) {
          return reply.status(404).send({ error: "Link not found" });
        }
        if (isOwn && link.link_type === "user_unlinked") {
          return reply.status(404).send({ error: "Link not found" });
        }

        // The link row is stored ordered (source_a_id < source_b_id), so pass the
        // pair straight through. In a transaction: the global-check + tombstone-or-
        // delete is a read-modify-write on the viewer's single owner slot.
        await withTransaction((client) =>
          unlinkIdentityPair(
            client,
            link.source_a_id,
            link.source_b_id,
            viewerId,
          ),
        );
        return reply.status(204).send();
      } catch (err) {
        logger.error({ err, linkId }, "Identity link delete failed");
        return reply.status(500).send({ error: "Unlink failed" });
      }
    },
  );
}
