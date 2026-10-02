import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";

// =============================================================================
// POST /writer-applications — a reader asks to write (READER-WRITER-SPLIT-ADR §8)
//
// ONE PRESS, NOTHING ASKED (O4). The operator judges from what the member has
// posted, so the row carries the account and the moment and nothing else.
//
// IDEMPOTENT, IN THE SCHEMA. The key is the account, so a second press lands
// on the first row (`ON CONFLICT DO NOTHING`) and answers the original
// `appliedAt`. A writer asking is refused with a fixed code (409
// `already_writer`); the INSERT itself only admits a reader, so a grant landing
// between two statements cannot leave a writer with a pending application.
//
// Authenticated, so none of the public waitlist's enumeration-safety applies:
// the caller is asking about themselves. `neither` in the route registry:
// applying is a reader's act, and it makes nobody a seller. The grant is the
// operator's, at `POST /admin/dashboard/writer-applications/grant`.
//
// Nothing in the member's web presses this until D2 wires the "Apply to write"
// entry; the digest tells the operator when it has been.
// =============================================================================

export const ALREADY_WRITER = "already_writer";

export async function writerApplicationRoutes(app: FastifyInstance) {
  app.post("/writer-applications", { preHandler: requireAuth }, async (req, reply) => {
    const accountId = req.session!.sub;

    await pool.query(
      `INSERT INTO writer_applications (account_id)
       SELECT id FROM accounts WHERE id = $1 AND writer_admitted_at IS NULL
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId],
    );

    const { rows } = await pool.query<{ can_write: boolean | null; created_at: Date | null }>(
      `SELECT a.writer_admitted_at IS NOT NULL AS can_write, wa.created_at
         FROM accounts a
         LEFT JOIN writer_applications wa ON wa.account_id = a.id
        WHERE a.id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (row?.can_write === true) {
      return reply.status(409).send({
        error: ALREADY_WRITER,
        message: "You can already publish articles.",
      });
    }
    if (!row?.created_at) {
      // requireAuth let a session through for an account with no row. Ours,
      // not the member's, so it takes the fault's exit.
      throw new Error(`writer application: no row for account ${accountId} after insert`);
    }
    return reply.status(200).send({ appliedAt: new Date(row.created_at).toISOString() });
  });
}
