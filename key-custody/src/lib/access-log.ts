import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// The record that a member's key was used to open something
//
// L6.6. `key_access_log` (migration 213) is the DPIA's claim that decryption
// paths are logged, made true. They were "logged" at `logger.debug`, which is
// below `LOG_LEVEL=info`, so in every deployment this platform has ever run
// they were logged nowhere at all.
//
// TWO PURPOSES AND NOT FIVE. This service decrypts a member's private key for
// five things; only two of them OPEN SOMETHING ALREADY WRITTEN — reading a
// direct message, and unwrapping a paywalled article's content key. Signing an
// event the member composed and encrypting a message they just typed are the
// member's own act coming through the front door, already evidenced by the
// thing it produced. Exporting the key has its own, better record
// (`account_key_exports`, migration 192, which also mails the owner).
// Migration 213's header carries the same list; adding a path here means
// widening the CHECK there.
//
// THE ROW GOES DOWN BEFORE THE PLAINTEXT GOES OUT, and a failure to write it
// fails the request. That is the export rule's shape (authorise before the
// work, record before the disclosure) and it costs nothing in availability
// that was not already spent: decrypting the key reads
// `accounts.nostr_privkey_enc` from this same database, so a decrypt has never
// been able to succeed without it. A caller that gets a 500 here has learned
// nothing and been given nothing.
//
// What this rests on, and what is still outstanding (nothing prunes the table;
// the member's own rows are not yet in their export): `docs/adr/LEGAL-BRAKES.md`.
// =============================================================================

export type KeyAccessPurpose = 'dm_decrypt' | 'paywall_unwrap'

export async function recordKeyAccess(opts: {
  accountId: string
  purpose: KeyAccessPurpose
  actorAccountId: string
  /**
   * The signer type the route resolved. A PUBLICATION is not a member, its id
   * is not an `accounts.id`, and the foreign key would refuse the row — so a
   * publication access cannot be recorded in this table as it stands.
   *
   * It is not swallowed: it goes to the log as a WARNING, because a hole in an
   * audit trail that says nothing is indistinguishable from an audit trail
   * with nothing in it. In practice nothing reaches this branch today (the
   * publications system is suspended behind `PUBLICATIONS_ENABLED`, and both
   * live callers pass an account), which is exactly why it would have gone
   * unnoticed if it ever started to.
   */
  signerType: 'account' | 'publication'
  /**
   * How many disclosures this call records — one row EACH, because the table
   * records disclosures, not requests. Defaults to 1; the batch decrypt passes
   * the number of plaintexts it is about to hand back, and they go down in ONE
   * statement (an inbox of 500 was 500 serial round trips). Zero writes nothing.
   */
  count?: number
}): Promise<void> {
  const count = opts.count ?? 1
  if (count <= 0) return

  if (opts.signerType !== 'account') {
    logger.warn(
      { signerId: opts.accountId, purpose: opts.purpose, signerType: opts.signerType, count },
      'Key access NOT recorded: key_access_log holds account keys only',
    )
    return
  }

  await pool.query(
    `INSERT INTO key_access_log (account_id, purpose, actor_account_id)
     SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
    [opts.accountId, opts.purpose, opts.actorAccountId, count],
  )
}
