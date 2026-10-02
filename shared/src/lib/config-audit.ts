// =============================================================================
// config_audit append helper (L5.2, migration 209)
//
// The one home for writing the durable record of an operator act that changes
// what the platform does with other people's money without touching a line of
// code. Three such acts exist:
//
//   · editing a `platform_config` dial   (gateway, PATCH /admin/dashboard/config)
//   · releasing a payout halt            (payment-service, POST /payouts/resume
//                                         and its W4 per-account twin)
//   · FREEZING one account's payouts as a decision rather than a reconciler
//     finding (payment-service, POST /payouts/halt/:accountId — D9 §4.1's
//     sanctions freeze, which was a hand-written INSERT until 2026-09-17 and
//     therefore left no record of who took it at all)
//
// And one REQUEST-shaped kind (walkthrough A17): the owner dashboard's two
// manual triggers, which run the settlement sweep or the payout cycle early
// (keys `operator_trigger:settlement` / `operator_trigger:payout`, new_value
// 'requested'). They change no dial, but they charge cards and pay writers on
// a person's say-so, so the say-so is recorded. The work happens in another
// service, so no transaction can span it: the gateway writes the row in its
// own transaction BEFORE proxying, and runs nothing if the write fails. The
// row records that the operator ASKED; what the cycle did is its own record.
//
// They live in two services, which is exactly why the helper lives in `shared`:
// two copies of this INSERT would drift where only somebody holding both could
// see it, and the thing that would drift is the evidence.
//
// THE CALLER PASSES ITS IN-FLIGHT TRANSACTION CLIENT, on the `recordLedger`
// pattern and for the same reason: the row commits or rolls back atomically
// with the change it records. Written outside, a crash between the two leaves
// either a change nobody can account for or a record of one that never
// happened — and afterwards there is no way to tell which. There is no
// pool-using overload on purpose; an evidence write that can be made without a
// transaction will be.
//
// The table is append-only (DB-enforced), so this helper only ever inserts.
// =============================================================================

/**
 * Structural, not `PoolClient`: the two callers hold different client types
 * (the gateway's `withTransaction` client, the payment service's own
 * `Queryable`) and both are transactions. Spelled this way so neither has to
 * cast — a cast at an evidence write is a place the compiler stops helping.
 */
export interface ConfigAuditClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface ConfigAuditEntry {
  /**
   * The admin's OWN account id. In the gateway that is `req.session.sub`; in
   * the payment service it is the `actorId` the gateway forwarded off that same
   * session. Never the internal service token, which proves only that something
   * inside the mesh asked, and never a service name — "payment-service changed
   * the fee rate" is not an answer to "who changed the fee rate".
   */
  actorAccountId: string
  /** The `platform_config` key, runtime-state keys included. */
  key: string
  /** The W4 per-account halt's subject; NULL for everything platform-wide. */
  subjectAccountId?: string | null
  /** NULL means the key did not exist before. */
  oldValue?: string | null
  /**
   * NULL means the key was DELETEd — which is how a payout halt is released
   * (`payouts_halted` is presence-means-halted), so this is an ordinary case
   * and not a corner one.
   */
  newValue?: string | null
  /**
   * Required, and required again by the column's CHECK. A blank string is
   * refused by Postgres rather than stored as a reason nobody gave.
   */
  reason: string
}

export async function recordConfigAudit(
  client: ConfigAuditClient,
  entry: ConfigAuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO config_audit
       (actor_account_id, key, subject_account_id, old_value, new_value, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorAccountId,
      entry.key,
      entry.subjectAccountId ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.reason,
    ],
  )
}
