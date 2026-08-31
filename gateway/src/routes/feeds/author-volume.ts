import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { UUID_RE, loadFeed, stepToWeight, weightToStep } from "./shared.js";

export function registerAuthorVolumeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET    /feeds/:id/author-volume/:pubkey — slice 14 pip-panel surface
  // PUT    /feeds/:id/author-volume/:pubkey   body: { step: 0..5, sampling }
  // DELETE /feeds/:id/author-volume/:pubkey   ("passive" — no commitment)
  //
  // Reuses feed_sources.account rows so the items query already honours mute
  // (slice 4 filters on muted_at). Weight is recorded but the items query
  // doesn't yet rank by it (chronological per slice 4) — that's the eventual
  // ranking story. Slice 14 makes the surface real and the data shape
  // forward-compatible. A row with weight set + muted_at=NULL is the
  // commitment the handoff doc describes; absence of a row = passive default.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string; pubkey: string } }>(
    "/feeds/:id/author-volume/:pubkey",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, pubkey } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: "Invalid pubkey" });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const { rows: accRows } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
        [pubkey.toLowerCase()],
      );
      if (accRows.length === 0) {
        return reply.send({
          authorPubkey: pubkey,
          accountId: null,
          step: null,
          sampling: "random",
          muted: false,
        });
      }
      const accountId = accRows[0].id;

      const { rows } = await pool.query<{
        weight: string;
        sampling_mode: string;
        muted_at: Date | null;
      }>(
        `SELECT weight, sampling_mode, muted_at
           FROM feed_sources
           WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
        [id, accountId],
      );
      const row = rows[0];
      if (!row) {
        return reply.send({
          authorPubkey: pubkey,
          accountId,
          step: null,
          sampling: "random",
          muted: false,
        });
      }
      return reply.send({
        authorPubkey: pubkey,
        accountId,
        step: row.muted_at ? 0 : weightToStep(Number(row.weight)),
        sampling: row.sampling_mode === "scored" ? "top" : "random",
        muted: !!row.muted_at,
      });
    },
  );

  app.put<{ Params: { id: string; pubkey: string }; Body: unknown }>(
    "/feeds/:id/author-volume/:pubkey",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, pubkey } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: "Invalid pubkey" });
      }

      const parsed = z
        .object({
          step: z.number().int().min(0).max(5),
          sampling: z.enum(["random", "top"]).default("random"),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { step, sampling } = parsed.data;

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const { rows: accRows } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
        [pubkey.toLowerCase()],
      );
      if (accRows.length === 0)
        return reply.status(404).send({ error: "Author not found" });
      const accountId = accRows[0].id;

      const weight = stepToWeight(step);
      const samplingMode = sampling === "top" ? "scored" : "chronological";

      // Upsert a feed_sources account row scoped to (feed, author). Setting
      // step=0 keeps the row but records muted_at; the items query already
      // skips muted sources.
      await pool.query(
        `INSERT INTO feed_sources (feed_id, source_type, account_id, weight, sampling_mode, muted_at)
         VALUES ($1, 'account', $2, $3, $4, $5)
         ON CONFLICT (feed_id, account_id) WHERE source_type = 'account'
         DO UPDATE SET
           weight = EXCLUDED.weight,
           sampling_mode = EXCLUDED.sampling_mode,
           muted_at = EXCLUDED.muted_at`,
        [id, accountId, weight, samplingMode, step === 0 ? new Date() : null],
      );

      return reply.send({
        authorPubkey: pubkey,
        accountId,
        step,
        sampling,
        muted: step === 0,
      });
    },
  );

  app.delete<{ Params: { id: string; pubkey: string } }>(
    "/feeds/:id/author-volume/:pubkey",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, pubkey } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: "Invalid pubkey" });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const { rows: accRows } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
        [pubkey.toLowerCase()],
      );
      if (accRows.length === 0) {
        // Nothing to clear — return success rather than 404; the client only
        // ever calls this to reset commitment, and a missing author row means
        // there is no commitment to begin with.
        return reply.status(204).send();
      }
      await pool.query(
        `DELETE FROM feed_sources
           WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
        [id, accRows[0].id],
      );
      return reply.status(204).send();
    },
  );
}
