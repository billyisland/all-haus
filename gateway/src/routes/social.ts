import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";

// =============================================================================
// Social Routes — block/mute CRUD + list endpoints
//
// GET    /my/blocks           — list blocked accounts
// POST   /my/blocks/:userId   — block a user
// DELETE /my/blocks/:userId   — unblock a user
// GET    /my/mutes            — list muted accounts
// POST   /my/mutes/:userId    — mute a user
// DELETE /my/mutes/:userId    — unmute a user
// =============================================================================

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

      if (blockerId === userId) {
        return reply.status(400).send({ error: "Cannot block yourself" });
      }

      await pool.query(
        `INSERT INTO blocks (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [blockerId, userId],
      );
      return reply.send({ ok: true });
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

      if (muterId === userId) {
        return reply.status(400).send({ error: "Cannot mute yourself" });
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
      await pool.query(
        `DELETE FROM mutes WHERE muter_id = $1 AND muted_id = $2`,
        [muterId, userId],
      );
      return reply.send({ ok: true });
    },
  );
}
