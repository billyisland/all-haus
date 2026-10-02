import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import {
  markFollowListDirty,
  retractFollowList,
  republishProfile,
  republishRelayList,
  republishFollowList,
} from "../lib/discovery-publish.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";

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
//
// discoverable_by_email is a THIRD, unrelated question (MIRROR-AUDIT §3, S16;
// migration 196): may `POST /resolve` confirm that this account owns a given
// email address, and name it? Default OFF. It is deliberately not folded into
// discovery_enabled — that one means "publish my profile to the public Nostr
// mesh", and a member enabling it is not thereby agreeing to be findable by the
// address they log in with. Every other identifier the resolver accepts is
// published; this one is not.
// See docs/adr/NOSTR-OUTBOUND-INTEROP-ADR.md §5 and NETWORK-CONCIERGE-ADR §7.
// =============================================================================

const PrivacyPrefsSchema = z
  .object({
    publishFollowGraph: z.boolean().optional(),
    discoveryEnabled: z.boolean().optional(),
    discoverableByEmail: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.publishFollowGraph !== undefined ||
      d.discoveryEnabled !== undefined ||
      d.discoverableByEmail !== undefined,
    { message: "at least one preference required" },
  );

// ---------------------------------------------------------------------------
// Flip a discovery flag and report what the pair WAS.
//
// WHY THE PRIOR STATE IS NEEDED. `retractFollowList` publishes a signed empty
// kind 3 to the public mesh, and there is nothing to retract for a member who
// was never publishing one — so the "retraction" would be the first thing about
// them ever put there. Every publish path gates on
// `discovery_enabled AND publish_follow_graph`, so that pair, read before the
// write, is what "was publishing" means. After the write the row cannot answer,
// which is why the caller states it rather than the callee reading it.
//
// WHY IT IS READ WITH `FOR UPDATE` IN A TRANSACTION, and not cleverly. Two
// one-statement forms were tried against Postgres first, and the obvious one is
// WRONG: a `WITH prev AS (SELECT … FOR UPDATE)` referenced from the UPDATE's
// RETURNING comes back **NULL**, so `wasPublishing` would have been false
// always and NO retraction would ever have fired — including the legitimate one,
// which is a worse bug than the one being fixed. It passed a mocked-pool test
// green, because a mock answers from its fixture and cannot evaluate SQL; that
// is why the test beside this is DB-backed and runs these statements. A
// self-join (`UPDATE accounts a … FROM accounts prev`) does return the old row,
// but its `prev` scan reads the statement snapshot while the UPDATE re-reads
// under READ COMMITTED, so a concurrent write makes the two disagree. Read
// first under the row lock and the question has one answer — the same shape as
// `article-event-rekey.ts` reading the old event id before its upsert, and for
// the same reason.
// ---------------------------------------------------------------------------
// All three statements are EXPORTED, and `wasPublishing` with them, so the
// DB-backed test runs what ships rather than a retyped copy — the near-miss
// above is precisely a case where a test holding its own copy of the SQL agrees
// with itself while production answers NULL.
export const PRIOR_DISCOVERY_FLAGS_SQL = `SELECT discovery_enabled, publish_follow_graph
       FROM accounts WHERE id = $1 FOR UPDATE`;

export const SET_DISCOVERY_ENABLED_SQL = `UPDATE accounts
       SET discovery_enabled = $1,
           -- re-arm the backfill sweep on opt-in
           discovery_synced_at = CASE WHEN $1 THEN NULL ELSE discovery_synced_at END,
           -- and clear the retry back-off, so an opt-in is healed at once
           discovery_attempted_at = CASE WHEN $1 THEN NULL ELSE discovery_attempted_at END,
           updated_at = now()
     WHERE id = $2`;

export const SET_PUBLISH_FOLLOW_GRAPH_SQL = `UPDATE accounts
       SET publish_follow_graph = $1, updated_at = now()
     WHERE id = $2`;

/** What "was publishing" means, in one place: BOTH flags, as every publish path
 *  gates on both — and FALSE for an absent row, which is a real case (an
 *  account deleted between the request and the flip) and the one where "we do
 *  not know" must not become "they were publishing". */
export function wasPublishingFollowList(
  row: { discovery_enabled: boolean; publish_follow_graph: boolean } | undefined,
): boolean {
  return row?.discovery_enabled === true && row?.publish_follow_graph === true;
}

async function setDiscoveryFlag(
  userId: string,
  updateSql: string,
  value: boolean,
): Promise<{ wasPublishing: boolean }> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      discovery_enabled: boolean;
      publish_follow_graph: boolean;
    }>(PRIOR_DISCOVERY_FLAGS_SQL, [userId]);
    await client.query(updateSql, [value, userId]);
    return { wasPublishing: wasPublishingFollowList(rows[0]) };
  });
}

export async function privacyPreferencesRoutes(app: FastifyInstance) {
  app.get(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { rows } = await pool.query<{
        discovery_enabled: boolean;
        publish_follow_graph: boolean;
        discoverable_by_email: boolean;
      }>(
        "SELECT discovery_enabled, publish_follow_graph, discoverable_by_email FROM accounts WHERE id = $1",
        [userId],
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." });
      }
      return reply.send({
        discoveryEnabled: rows[0].discovery_enabled,
        publishFollowGraph: rows[0].publish_follow_graph,
        discoverableByEmail: rows[0].discoverable_by_email,
      });
    },
  );

  app.put(
    "/me/privacy-preferences",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = PrivacyPrefsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }
      const userId = req.session!.sub;
      const { publishFollowGraph, discoveryEnabled, discoverableByEmail } =
        parsed.data;

      // ----- Nostr public-presence opt-in -----
      if (discoveryEnabled !== undefined) {
        const { wasPublishing } = await setDiscoveryFlag(
          userId,
          SET_DISCOVERY_ENABLED_SQL,
          discoveryEnabled,
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
          // A no-op for an account that was not publishing one.
          retractFollowList(userId, { wasPublishing }).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to retract follow list"));
        }
      }

      // ----- Follow-graph opt-out within an opted-in account -----
      if (publishFollowGraph !== undefined) {
        // Needed here too, and this is the arm that catches the ordinary member:
        // `publish_follow_graph` defaults TRUE, so someone who never opted into
        // discovery at all and turns this switch off has published nothing —
        // and used to be put on the mesh by the act of asking for less.
        const { wasPublishing } = await setDiscoveryFlag(
          userId,
          SET_PUBLISH_FOLLOW_GRAPH_SQL,
          publishFollowGraph,
        );

        if (publishFollowGraph) {
          // Opt-in: republish from current state on the next sweep cycle.
          markFollowListDirty(userId).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to mark follow list dirty"));
        } else {
          // Opt-out: retract immediately by publishing an empty kind 3 — unless
          // there was never one to retract.
          retractFollowList(userId, { wasPublishing }).catch((err) =>
            logger.warn({ err, userId }, "privacy: failed to retract follow list"));
        }
      }

      // ----- Email discoverability (§S16) -----
      //
      // Nothing to publish or retract: this one only decides whether a lookup
      // ANSWERS, so the column is the whole of it.
      if (discoverableByEmail !== undefined) {
        await pool.query(
          "UPDATE accounts SET discoverable_by_email = $1, updated_at = now() WHERE id = $2",
          [discoverableByEmail, userId],
        );
      }

      // Return the resulting state so the client can reconcile.
      const { rows } = await pool.query<{
        discovery_enabled: boolean;
        publish_follow_graph: boolean;
        discoverable_by_email: boolean;
      }>(
        "SELECT discovery_enabled, publish_follow_graph, discoverable_by_email FROM accounts WHERE id = $1",
        [userId],
      );
      return reply.send({
        ok: true,
        discoveryEnabled: rows[0]?.discovery_enabled ?? false,
        publishFollowGraph: rows[0]?.publish_follow_graph ?? true,
        discoverableByEmail: rows[0]?.discoverable_by_email ?? false,
      });
    },
  );
}
