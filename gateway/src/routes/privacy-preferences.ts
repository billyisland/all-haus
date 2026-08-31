import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import {
  markFollowListDirty,
  retractFollowList,
  republishProfile,
  republishRelayList,
  republishFollowList,
} from "../lib/discovery-publish.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Privacy preferences
//
//   GET /me/privacy-preferences   — fetch privacy/sharing prefs
//   PUT /me/privacy-preferences   — update privacy/sharing prefs (partial)
//
// discovery_enabled is the per-user Nostr public-presence opt-in (NETWORK-
// CONCIERGE-ADR §7). OFF by default: turning it ON publishes the user's profile
// (kind 0), relay list (kind 10002) and — unless separately opted out below —
// follow list (kind 3) to the public Nostr mesh, and arms the backfill sweep.
// Turning it OFF retracts the follow list and stops future republishing (the
// replaceable kind 0/10002 events can't be cleanly unpublished).
//
// publish_follow_graph is a finer-grained opt-OUT *within* an opted-in account:
// it controls only the kind-3 contact list. Default ON ("all means all").
// See docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md §5 and NETWORK-CONCIERGE-ADR §7.
// =============================================================================

const PrivacyPrefsSchema = z
  .object({
    publishFollowGraph: z.boolean().optional(),
    discoveryEnabled: z.boolean().optional(),
  })
  .refine(
    (d) => d.publishFollowGraph !== undefined || d.discoveryEnabled !== undefined,
    { message: "at least one preference required" },
  );

export async function privacyPreferencesRoutes(app: FastifyInstance) {
  app.get(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { rows } = await pool.query<{
        discovery_enabled: boolean;
        publish_follow_graph: boolean;
      }>(
        "SELECT discovery_enabled, publish_follow_graph FROM accounts WHERE id = $1",
        [userId],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: "Account not found" });
      }
      return reply.send({
        discoveryEnabled: rows[0].discovery_enabled,
        publishFollowGraph: rows[0].publish_follow_graph,
      });
    },
  );

  app.put(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = PrivacyPrefsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const userId = req.session!.sub;
      const { publishFollowGraph, discoveryEnabled } = parsed.data;

      // ----- Nostr public-presence opt-in -----
      if (discoveryEnabled !== undefined) {
        await pool.query(
          `UPDATE accounts
             SET discovery_enabled = $1,
                 -- re-arm the backfill sweep on opt-in
                 discovery_synced_at = CASE WHEN $1 THEN NULL ELSE discovery_synced_at END,
                 updated_at = now()
           WHERE id = $2`,
          [discoveryEnabled, userId],
        );

        if (discoveryEnabled) {
          // Opt-in: publish the three discovery events now (no-op when the
          // operator master switch is off; the sweep also backfills).
          republishProfile(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: profile republish failed"));
          republishRelayList(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: relay-list republish failed"));
          republishFollowList(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: follow-list republish failed"));
        } else {
          // Opt-out: retract the follow list (kind 0/10002 are left to age out).
          retractFollowList(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to retract follow list"));
        }
      }

      // ----- Follow-graph opt-out within an opted-in account -----
      if (publishFollowGraph !== undefined) {
        await pool.query(
          "UPDATE accounts SET publish_follow_graph = $1, updated_at = now() WHERE id = $2",
          [publishFollowGraph, userId],
        );

        if (publishFollowGraph) {
          // Opt-in: republish from current state on the next sweep cycle.
          markFollowListDirty(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to mark follow list dirty"));
        } else {
          // Opt-out: retract immediately by publishing an empty kind 3.
          retractFollowList(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to retract follow list"));
        }
      }

      // Return the resulting state so the client can reconcile.
      const { rows } = await pool.query<{
        discovery_enabled: boolean;
        publish_follow_graph: boolean;
      }>(
        "SELECT discovery_enabled, publish_follow_graph FROM accounts WHERE id = $1",
        [userId],
      );
      return reply.send({
        ok: true,
        discoveryEnabled: rows[0]?.discovery_enabled ?? false,
        publishFollowGraph: rows[0]?.publish_follow_graph ?? true,
      });
    },
  );
}
