import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { isUuid } from "../lib/request-inputs.js";
import { viewerRelation } from "../lib/blocks.js";
import { markFollowListDirty } from "../lib/discovery-publish.js";
import { cancelAtPeriodEnd } from "./subscriptions/writer.js";

// =============================================================================
// Social Routes — block/mute CRUD + list endpoints
//
// GET    /my/blocks           — list blocked accounts
// POST   /my/blocks/:userId   — block a user
// DELETE /my/blocks/:userId   — unblock a user
// GET    /my/mutes            — list muted accounts
// POST   /my/mutes/:userId    — mute a user
// DELETE /my/mutes/:userId    — unmute a user
// GET    /my/relations/:userId — what the viewer has done to one account
//
// A MUTE hides; a BLOCK severs (W2, operator ruling 2026-09-24). Muting is
// one-sided and silent — the muted member's words stop reaching the muter
// (threads, notifications, feeds, the inbox) and nothing else changes. A block
// is about the PAIR (lib/blocks.ts), and on top of hiding it ends the standing
// relationships between them, in the block's own transaction:
//
//   · FOLLOWS, both directions. Neither may follow the other while it stands
//     (`POST /follows` and `addSource` already refuse), so a follow left over
//     from before it would be the one relationship the block did not reach.
//     Only the graph row goes — an `account` source in either party's feed
//     stays where it is and delivers nothing, because the feed arm filters
//     blocked authors per reader. Unblocking restores no follow.
//   · SUBSCRIPTIONS, both directions, RUN TO PERIOD END: `auto_renew` off,
//     access kept until `current_period_end`, nothing refunded and nothing
//     charged. The web states this before the press, in the confirm.
//
// An unknown account id answers 404 on both writes — it used to reach the
// INSERT and answer the foreign key's 500.
// =============================================================================

// Does the account exist at all? Any status: blocking a suspended or
// deactivated member is a reasonable thing to want to have in place before
// they come back.
async function accountExists(id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM accounts WHERE id = $1`, [id]);
  return rows.length > 0;
}

export async function socialRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /my/blocks — list blocked accounts with display info
  // ---------------------------------------------------------------------------

  app.get("/my/blocks", { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub;
    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string | null;
      avatar_blossom_url: string | null;
      blocked_at: string;
    }>(
      `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url, b.blocked_at
         FROM blocks b
         JOIN accounts a ON a.id = b.blocked_id
         WHERE b.blocker_id = $1
         ORDER BY b.blocked_at DESC`,
      [userId],
    );
    return reply.send({
      blocks: result.rows.map((r) => ({
        userId: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        blockedAt: r.blocked_at,
      })),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /my/blocks/:userId — block a user
  // ---------------------------------------------------------------------------

  app.post<{ Params: { userId: string } }>(
    "/my/blocks/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const blockerId = req.session!.sub;
      const { userId } = req.params;
      if (!isUuid(userId)) {
        return reply.status(404).send({ error: "not_found" });
      }

      if (blockerId === userId) {
        return reply.status(400).send({ error: "You can't block yourself." });
      }
      if (!(await accountExists(userId))) {
        return reply.status(404).send({ error: "not_found" });
      }

      const result = await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO blocks (blocker_id, blocked_id)
           VALUES ($1, $2)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
          [blockerId, userId],
        );

        const dropped = await client.query<{ follower_id: string }>(
          `DELETE FROM follows
            WHERE (follower_id = $1 AND followee_id = $2)
               OR (follower_id = $2 AND followee_id = $1)
           RETURNING follower_id`,
          [blockerId, userId],
        );
        // Each follower whose published kind-3 list just lost an entry.
        for (const { follower_id } of dropped.rows) {
          await markFollowListDirty(follower_id, client);
        }

        const ending: { subscriptionId: string; accessUntil: string }[] = [];
        for (const [readerId, writerId] of [
          [blockerId, userId],
          [userId, blockerId],
        ]) {
          const sub = await cancelAtPeriodEnd(client, readerId, writerId);
          if (sub) {
            ending.push({
              subscriptionId: sub.id,
              accessUntil: sub.current_period_end.toISOString(),
            });
          }
        }

        return { followsDropped: dropped.rowCount ?? 0, subscriptionsEnding: ending };
      });

      logger.info({ blockerId, blockedId: userId, ...result }, "Block created");
      return reply.send({ ok: true, ...result });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /my/blocks/:userId — unblock a user
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { userId: string } }>(
    "/my/blocks/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const blockerId = req.session!.sub;
      const { userId } = req.params;
      if (!isUuid(userId)) {
        return reply.status(404).send({ error: "not_found" });
      }
      await pool.query(
        `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [blockerId, userId],
      );
      return reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /my/mutes — list muted accounts with display info
  // ---------------------------------------------------------------------------

  app.get("/my/mutes", { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub;
    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string | null;
      avatar_blossom_url: string | null;
      muted_at: string;
    }>(
      `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url, m.muted_at
         FROM mutes m
         JOIN accounts a ON a.id = m.muted_id
         WHERE m.muter_id = $1
         ORDER BY m.muted_at DESC`,
      [userId],
    );
    return reply.send({
      mutes: result.rows.map((r) => ({
        userId: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        mutedAt: r.muted_at,
      })),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /my/mutes/:userId — mute a user
  // ---------------------------------------------------------------------------

  app.post<{ Params: { userId: string } }>(
    "/my/mutes/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const muterId = req.session!.sub;
      const { userId } = req.params;
      if (!isUuid(userId)) {
        return reply.status(404).send({ error: "not_found" });
      }

      if (muterId === userId) {
        return reply.status(400).send({ error: "You can't mute yourself." });
      }
      if (!(await accountExists(userId))) {
        return reply.status(404).send({ error: "not_found" });
      }

      await pool.query(
        `INSERT INTO mutes (muter_id, muted_id)
         VALUES ($1, $2)
         ON CONFLICT (muter_id, muted_id) DO NOTHING`,
        [muterId, userId],
      );
      return reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /my/mutes/:userId — unmute a user
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { userId: string } }>(
    "/my/mutes/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const muterId = req.session!.sub;
      const { userId } = req.params;
      if (!isUuid(userId)) {
        return reply.status(404).send({ error: "not_found" });
      }
      await pool.query(
        `DELETE FROM mutes WHERE muter_id = $1 AND muted_id = $2`,
        [muterId, userId],
      );
      return reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /my/relations/:userId — { muted, blocked }, what the VIEWER has done
  //
  // For a surface that draws Mute/Block controls without a profile payload to
  // carry the state (the DM header). One direction only — a block the OTHER
  // party set is never reported (lib/blocks.ts, `viewerRelation`). Yourself
  // and an unknown id both answer 404: there is no relationship to state.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { userId: string } }>(
    "/my/relations/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const viewerId = req.session!.sub;
      const { userId } = req.params;
      if (!isUuid(userId) || userId === viewerId || !(await accountExists(userId))) {
        return reply.status(404).send({ error: "not_found" });
      }
      return reply.send(await viewerRelation(viewerId, userId));
    },
  );
}
