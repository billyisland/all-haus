import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "@platform-pub/shared/db/client.js";
import { recordConfigAudit } from "@platform-pub/shared/lib/config-audit.js";

// =============================================================================
// "May this member write?" — the one home (READER-WRITER-SPLIT-ADR, D1)
//
// `accounts.writer_admitted_at` is the fact; NULL means READER. A reader posts
// notes and replies, reads, pays and subscribes; a writer also publishes
// articles and sells access to them. Migration 271 admitted every account made
// before 2026-10-01 and everyone who had already acted as a writer, so the
// readers are the accounts admitted since.
//
// TWO SIDES, ONE COLUMN.
//
//   ACTOR — the acts that make somebody a publisher or a seller refuse a
//           reader: `requireWriter` on the route (after `requireAuth`), the
//           kind-30023 check inside the two signing routes, and the typed
//           throw inside `publishPersonalArticle`, which the scheduler
//           un-schedules on exactly as it does the Writer Agreement's.
//   TARGET — a route that moves a reader's money TO an account refuses a
//           reader target (`writerAdmittedSql`, joined into the lookup the
//           route already makes): a reader is not sold. A fact about the
//           object, so it gates the whole route (money.md).
//
// WHAT IT NEVER GATES: taking down or reading back one's own work, and any
// path that pays out money already earned. Connect onboarding asks
// `canWrite OR holdsWriterLedger` instead, so nobody opens a Stripe account for
// nothing and nobody holding earnings is locked out of collecting them. Which
// route is which is `gateway/tests/route-classes.ts`, and an unclassified route
// fails CI.
//
// THE READ FAILS CLOSED. A missing account row answers "reader": a refusal
// costs a retry, a wrong "writer" publishes or sells for somebody the operator
// never admitted. Not cached: writer acts are rare, and a grant must take
// effect on the next press, not eight seconds later.
//
// THE GRANT is `grantWriterAccess`, the one writer of the column after the
// migration-271 backfill (D3, the writers' waiting list). It takes an
// application or none: a member's request (`writer_applications`) is stamped
// when there is one, and a grant with none is the same call, so promoting a
// member straight from the roster (plan §D.5 q3) costs a button.
// =============================================================================

/** The refusal code every writer door answers with. */
export const WRITER_ACCESS_REQUIRED = "writer_access_required";

const REFUSAL_MESSAGE =
  "Publishing articles is open to members admitted as writers.";

/** Thrown by the server-side publisher; the scheduler un-schedules on it. */
export class WriterAccessRequiredError extends Error {
  constructor(accountId: string) {
    super(
      `Account ${accountId} has not been admitted as a writer — ` +
        `publishing an article is refused.`,
    );
    this.name = "WriterAccessRequiredError";
  }
}

/** The recipient predicate, as SQL, for joining into an existing lookup. */
export function writerAdmittedSql(alias: string): string {
  return `${alias}.writer_admitted_at IS NOT NULL`;
}

/** Has this account been admitted as a writer? Fails closed on a missing row. */
export async function canWrite(
  accountId: string,
  client: Pick<PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await client.query<{ can_write: boolean }>(
    `SELECT ${writerAdmittedSql("a")} AS can_write FROM accounts a WHERE a.id = $1`,
    [accountId],
  );
  return rows[0]?.can_write === true;
}

/**
 * Has this account ever been credited anything a writer is paid? The positive
 * earning entries only — a carve or a reversal is money leaving them, and a
 * payout is money that already left. Asked only by Connect
 * onboarding, beside `canWrite`: a reader holding earnings must be able to
 * collect them. Empty by construction today (migration 271 made every earner a
 * writer, and the recipient side stops new ones), and kept because anything
 * that un-darks a way to pay a non-writer — the tributes — would fill it.
 */
export async function holdsWriterLedger(
  accountId: string,
  client: Pick<PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM ledger_entries
      WHERE account_id = $1
        AND trigger_type IN ('writer_accrual', 'subscription_earning',
                             'tribute_payout', 'publication_split')
      LIMIT 1`,
    [accountId],
  );
  return rows.length > 0;
}

/** The body every writer refusal sends. */
export function writerAccessRefusal() {
  return { error: WRITER_ACCESS_REQUIRED, message: REFUSAL_MESSAGE };
}

/**
 * preHandler, AFTER `requireAuth`: 403 `writer_access_required` for a reader.
 * `preHandler: [requireAuth, requireWriter]` — the registry test reads the
 * array for this function by identity.
 */
export async function requireWriter(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const accountId = req.session?.sub;
  if (!accountId) {
    // requireAuth has already answered; never reached in a correct chain.
    if (!reply.sent) reply.status(401).send({ error: "Authentication required" });
    return;
  }
  if (!(await canWrite(accountId))) {
    reply.status(403).send(writerAccessRefusal());
  }
}

// -----------------------------------------------------------------------------
// The grant (READER-WRITER-SPLIT-ADR §8)
// -----------------------------------------------------------------------------

/** What a grant did. A runtime array so the web's wire test can read it. */
export const WRITER_GRANT_OUTCOMES = ["granted", "already_writer", "no_account"] as const;
export type WriterGrantOutcome = (typeof WRITER_GRANT_OUTCOMES)[number];

/** The `config_audit` key a grant is recorded under. */
export const WRITER_GRANT_AUDIT_KEY = "writer_access:grant";

export interface WriterGrantResult {
  outcome: WriterGrantOutcome;
  /** On `granted`: whether a pending application was stamped with it. */
  fromApplication: boolean;
}

/**
 * Admit an account as a writer. THE CALLER'S TRANSACTION: the column, the
 * application's stamp and the `config_audit` row commit together, or none of
 * them does — a writer can sell, so the grant is an operator act about money
 * and its evidence is not optional. Any email waits for the caller's COMMIT.
 *
 * CLAIM FIRST. The UPDATE's `writer_admitted_at IS NULL` is the guard, so two
 * admins pressing Grant at once race in Postgres and exactly one records
 * anything; the loser reads the row back to say why it lost. A grant to an
 * account that is already a writer is REFUSED rather than recorded — there is
 * nothing to record — and a deleted account is `no_account`.
 */
export async function grantWriterAccess(
  client: Pick<PoolClient, "query">,
  args: { accountId: string; adminId: string; reason: string },
): Promise<WriterGrantResult> {
  const claim = await client.query(
    `UPDATE accounts
        SET writer_admitted_at = now(), writer_admitted_by = $2
      WHERE id = $1 AND writer_admitted_at IS NULL AND status <> 'deleted'
      RETURNING id`,
    [args.accountId, args.adminId],
  );
  if (claim.rows.length === 0) {
    const { rows } = await client.query<{ status: string; can_write: boolean }>(
      `SELECT status, ${writerAdmittedSql("a")} AS can_write FROM accounts a WHERE a.id = $1`,
      [args.accountId],
    );
    const row = rows[0];
    if (!row || row.status === "deleted") return { outcome: "no_account", fromApplication: false };
    return { outcome: "already_writer", fromApplication: false };
  }

  const stamped = await client.query(
    `UPDATE writer_applications
        SET admitted_at = now(), admitted_by = $2
      WHERE account_id = $1 AND admitted_at IS NULL
      RETURNING account_id`,
    [args.accountId, args.adminId],
  );

  await recordConfigAudit(client, {
    actorAccountId: args.adminId,
    key: WRITER_GRANT_AUDIT_KEY,
    subjectAccountId: args.accountId,
    oldValue: null,
    newValue: stamped.rows.length > 0 ? "granted:application" : "granted:direct",
    reason: args.reason,
  });

  return { outcome: "granted", fromApplication: stamped.rows.length > 0 };
}

/**
 * A reader's pending application, for `/auth/me`: when they asked, or null.
 * A writer has none to show (a granted application is history, not a state).
 */
export async function pendingWriterApplication(
  accountId: string,
  client: Pick<PoolClient, "query"> = pool,
): Promise<{ appliedAt: string } | null> {
  const { rows } = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM writer_applications
      WHERE account_id = $1 AND admitted_at IS NULL`,
    [accountId],
  );
  return rows[0] ? { appliedAt: new Date(rows[0].created_at).toISOString() } : null;
}
