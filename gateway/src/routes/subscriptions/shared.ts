import { loadConfig } from '@platform-pub/shared/db/client.js'
import { recordLedger, applyLedgerDelta } from '@platform-pub/shared/lib/ledger.js'

// =============================================================================
// Helper — log subscription charge and earning events (audit F1, 2026-07-05)
//
// The hourly renewal/expiry worker lives in workers/subscription-expiry.ts
// and imports logSubscriptionCharge from this file (via the directory index).
//
// BEFORE F1 this only wrote two subscription_events rows and the CALLER
// decremented accounts.free_allowance_remaining_pence. That column is NOT the
// reading tab: no code path ever converted a negative allowance into a
// settleable balance, so subscription revenue was never collected and the
// writer's credit never entered a payout (audit finding 1, a P0). F1 makes the
// charge collectable by the SAME settlement machinery reads use:
//
//   • Reader leg — debit reading_tabs.balance_pence by the full price (a debt,
//     exactly like a read accrual) and post the mirror subscription_charge
//     ledger entry (−price), so −SUM(reader entries) == reading_tabs.balance_pence
//     holds and settlement.ts collects it. The free_allowance decrement is
//     removed from all call sites.
//   • Writer leg — post subscription_earning (+net) for WRITER subscriptions and
//     fold it into the per-read payout base (payout.ts claims it once via
//     subscription_events.writer_payout_id). Publication subscriptions collect
//     (reader leg) and post no earning ledger entry here — like publication
//     reads, they enter the ledger only at payout time (publication_split
//     entries); the publication payout cycle claims the earning event via
//     subscription_events.publication_payout_id and distributes it through the
//     pool (§1.3, migration 152).
//
// Rounding (audit F11): the platform fee now FLOORs (Math.floor), matching the
// per-row-then-floor rule the rest of the money paths follow — not the prior
// Math.round, a second definition of "net".
// =============================================================================

// A subscription targets a writer (writerId) XOR a publication (publicationId);
// the event's writer_id / publication_id mirrors that. subscription_events
// requires at least one target (migration 103).
export async function logSubscriptionCharge(
  client: any,
  subscriptionId: string,
  readerId: string,
  writerId: string | null,
  pricePence: number,
  periodStart: Date,
  periodEnd: Date,
  publicationId: string | null = null,
) {
  const { platformFeeBps } = await loadConfig()
  const platformFeePence = Math.floor((pricePence * platformFeeBps) / 10000)
  const writerEarningPence = pricePence - platformFeePence
  const feePct = (platformFeeBps / 100).toFixed(platformFeeBps % 100 === 0 ? 0 : 2)

  // --- Reader leg: collect via the reading tab, not the free-allowance column. ---
  // Debit the full price as a tab movement (a debt, exactly like a read accrual);
  // applyLedgerDelta upserts the tab (the reader may not have one yet), moves the
  // balance by +price, and posts the mirror subscription_charge entry (−price) as
  // one pair. The debit event is created first so the ledger entry can reference it.
  const { rows: [chargeEvent] } = await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, publication_id, amount_pence, period_start, period_end, description)
     VALUES ($1, 'subscription_charge', $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [subscriptionId, readerId, writerId, publicationId, pricePence, periodStart, periodEnd,
     `Subscription charge`]
  )
  const { balancePence } = await applyLedgerDelta(client, {
    accountId: readerId,
    counterpartyId: writerId,
    deltaPence: pricePence,
    triggerType: 'subscription_charge',
    refTable: 'subscription_events',
    refId: chargeEvent.id,
    touch: ['last_read_at'],
  })

  // Collection gate (migration 146): a post-charge balance <= 0 means the
  // charge was fully funded by pre-paid credit (negative balance = platform
  // owes reader), so it is already collected — no settlement will ever fire
  // for it (nothing to charge), and the earning is payable immediately.
  // Otherwise the earning stays settled_at NULL until confirmSettlement stamps
  // it when the reader's tab settlement lands.
  const chargeCollected = balancePence <= 0

  // Credit event for writer/publication (after platform fee)
  const { rows: [earningEvent] } = await client.query(
    `INSERT INTO subscription_events
       (subscription_id, event_type, reader_id, writer_id, publication_id, amount_pence, period_start, period_end, description, settled_at)
     VALUES ($1, 'subscription_earning', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [subscriptionId, readerId, writerId, publicationId, writerEarningPence, periodStart, periodEnd,
     `Subscriber income (after ${feePct}% fee)`,
     chargeCollected ? new Date() : null]
  )

  // Writer leg: only WRITER subscriptions post an earned ledger entry + fold into
  // the per-read payout base. The +net credits the writer's earned total (mirror
  // of the reader's subscription_charge debit); payout.ts pays it via the base
  // UNION, claimed once by subscription_events.writer_payout_id. A PUBLICATION
  // earning posts no ledger entry (publication distribution is modeled at payout
  // time, per split) — the pool cycle claims it via publication_payout_id (§1.3).
  if (writerId) {
    await recordLedger(client, {
      accountId: writerId,
      counterpartyId: readerId,
      amountPence: writerEarningPence,
      triggerType: 'subscription_earning',
      refTable: 'subscription_events',
      refId: earningEvent.id,
    })
  }
}
