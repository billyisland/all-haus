import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  loadFeed,
  stepToThroughput,
  throughputToStep,
} from "./shared.js";
import { addSource } from "./sources.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { isUuid } from "../../lib/request-inputs.js";

export function registerAuthorVolumeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET    /feeds/:id/author-volume/:pubkey — slice 14 pip-panel surface
  // PUT    /feeds/:id/author-volume/:pubkey   body: { step: 0..5, sampling }
  // DELETE /feeds/:id/author-volume/:pubkey   ("passive" — no commitment)
  //
  // Reuses feed_sources.account rows so the items query already honours mute
  // (slice 4 filters on muted_at) and, since migration 202, the throughput and
  // sampling mode too: they select which of this author's posts reach this
  // feed, inside this author's own posts (lib/source-selection.ts). Slice 14 makes the surface real and the data shape
  // forward-compatible. A row with throughput set + muted_at=NULL is the
  // commitment the handoff doc describes; absence of a row = passive default.
  //
  // THE PASSIVE DEFAULT IS TOP (operator decision, 2026-09-14), and since
  // migration 203 the stored column default is 'scored' too — the same value,
  // so this route no longer preselects one thing while the schema stores
  // another. That split existed because `sampling_mode` doubled as the feed's
  // ordering mode and defaulting it would have turned every new feed into a
  // ranked one; migration 202 removed the coupling, and the half-measure went
  // with it.
  //
  // THE ROW IS MADE THROUGH `addSource`, AND UNMADE BY NOBODY HERE (CA-A9,
  // 2026-09-29). This route INSERTed and DELETEd `feed_sources` account rows
  // directly — no self-source refusal, no block check either way, no `active`
  // check, no `feed_sub` lock — and a card's author is not necessarily a
  // source already (tag sources, replies, hydrated threads), so a mute from a
  // card minted an unguarded source. The PUT now asks `addSource` for a row
  // that does not exist, WITHOUT `ownerChose`: turning an author down, or
  // off, is not following them, and a follow written here would publish a
  // kind-3 claim the member never made. The DELETE no longer deletes: it
  // RESETS the row to the passive default (throughput 1, TOP, unmuted) and
  // leaves the row and any follow alone — the old DELETE skipped
  // `removeSource`'s last-feed teardown, so it left a `follows` row with no
  // source, the state crud.ts's H6 sweep exists to clean up.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string; pubkey: string } }>(
    "/feeds/:id/author-volume/:pubkey",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, pubkey } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(404).send({ error: "We couldn't find that author." });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const { rows: accRows } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
        [pubkey.toLowerCase()],
      );
      if (accRows.length === 0) {
        return reply.send({
          authorPubkey: pubkey,
          accountId: null,
          step: null,
          sampling: "top",
          muted: false,
        });
      }
      const accountId = accRows[0].id;

      const { rows } = await pool.query<{
        throughput: string;
        sampling_mode: string;
        muted_at: Date | null;
      }>(
        `SELECT throughput, sampling_mode, muted_at
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
          sampling: "top",
          muted: false,
        });
      }
      return reply.send({
        authorPubkey: pubkey,
        accountId,
        step: row.muted_at ? 0 : throughputToStep(Number(row.throughput)),
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
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(404).send({ error: "We couldn't find that author." });
      }

      const parsed = z
        .object({
          step: z.number().int().min(0).max(5),
          // OPTIONAL, not defaulted. A `.default("top")` makes every caller
          // that omits it an author of the mode: a bare `{ step: 0 }` — which
          // this API accepts, and which is mute — would flip a source the
          // reader had set to RANDOM over to scored, on the write that was
          // meant to say nothing about ranking at all. Absent means unchanged
          // on an existing row (see the upsert below), exactly as it does on
          // the `sources.ts` PATCH one route over.
          sampling: z.enum(["random", "top"]).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(zodValidationError(parsed.error));
      }
      const { step, sampling } = parsed.data;

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const { rows: accRows } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE nostr_pubkey = $1`,
        [pubkey.toLowerCase()],
      );
      if (accRows.length === 0)
        return reply.status(404).send({ error: "We couldn't find that author." });
      const accountId = accRows[0].id;

      // No row yet: make one through the one door every account source goes
      // through — its guards, its lock — and NOT as a chosen follow. A
      // concurrent add that wins the race answers DUPLICATE, and the upsert
      // below then finds the row exactly as if it had always been there.
      const { rows: existingRows } = await pool.query<{ id: string }>(
        `SELECT id FROM feed_sources
          WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
        [id, accountId],
      );
      if (existingRows.length === 0) {
        try {
          await addSource(id, ownerId, { sourceType: "account", accountId });
        } catch (err) {
          const code = (err as { code?: string } | null)?.code;
          if (code === "SELF_SOURCE") {
            return reply.status(400).send({
              error: "self_source",
              message: "You can't add your own account to a channel.",
            });
          }
          if (code === "TARGET_BLOCKED") {
            return reply.status(403).send({
              error: "target_blocked",
              message: "You can't add this account to a channel.",
            });
          }
          if (code === "TARGET_NOT_FOUND") {
            return reply.status(404).send({ error: "We couldn't find that author." });
          }
          if (code !== "DUPLICATE") throw err;
        }
      }

      const throughput = stepToThroughput(step);
      // "scored" is the fresh-ROW default only — what a source with no
      // history gets — never a value imposed on an existing one.
      const samplingMode = sampling === "random" ? "random" : "scored";
      const isMute = step === 0;
      const keepStoredMode = isMute || sampling === undefined;

      // Upsert a feed_sources account row scoped to (feed, author). Setting
      // step=0 keeps the row but records muted_at; the items query already
      // skips muted sources.
      //
      // MUTE DOES NOT SPEND THE LEVEL — AND IT DOES NOT SPEND THE MODE EITHER.
      // Step 0 carries no throughput of its own — `VOLUME_THROUGHPUT[0]` is the
      // 1.0 placeholder that only exists to satisfy the `throughput > 0` CHECK
      // — so on an existing row it keeps whatever the reader last chose, and a
      // source muted at 20% comes back at 20%. `sampling_mode` is the same
      // question one column over, and it was being written unconditionally:
      // mute is not a statement about ranking, so it keeps the stored mode, and
      // so does any call that simply did not mention one. On a fresh row there
      // is nothing to keep and the placeholder is the schema default anyway.
      const { rows: storedRows } = await pool.query<{ sampling_mode: string }>(
        `INSERT INTO feed_sources (feed_id, source_type, account_id, throughput, sampling_mode, muted_at)
         VALUES ($1, 'account', $2, $3, $4, $5)
         ON CONFLICT (feed_id, account_id) WHERE source_type = 'account'
         DO UPDATE SET
           throughput = CASE WHEN $6::boolean
                             THEN feed_sources.throughput
                             ELSE EXCLUDED.throughput END,
           sampling_mode = CASE WHEN $7::boolean
                                THEN feed_sources.sampling_mode
                                ELSE EXCLUDED.sampling_mode END,
           muted_at = EXCLUDED.muted_at
         RETURNING sampling_mode`,
        [
          id,
          accountId,
          throughput,
          samplingMode,
          isMute ? new Date() : null,
          isMute,
          keepStoredMode,
        ],
      );

      // Report the ROW, not the request. Now that a mute (or a call with no
      // `sampling`) keeps the stored mode, echoing the input would tell the
      // client a mode the database does not hold — and the control repaints
      // from this response.
      return reply.send({
        authorPubkey: pubkey,
        accountId,
        step,
        sampling: storedRows[0]?.sampling_mode === "random" ? "random" : "top",
        muted: isMute,
      });
    },
  );

  app.delete<{ Params: { id: string; pubkey: string } }>(
    "/feeds/:id/author-volume/:pubkey",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, pubkey } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(404).send({ error: "We couldn't find that author." });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

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
      // A RESET, NOT A REMOVAL (CA-A9): the row stays, and so does any follow
      // it carries. The volume goes back to the passive default the header
      // describes — the column DEFAULTs, so this and the schema cannot
      // disagree about what "passive" is. Removing the source is the feed
      // composer's act, through `removeSource`, with its last-feed teardown.
      await pool.query(
        `UPDATE feed_sources
            SET throughput = DEFAULT, sampling_mode = DEFAULT, muted_at = NULL
          WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
        [id, accRows[0].id],
      );
      return reply.status(204).send();
    },
  );
}
