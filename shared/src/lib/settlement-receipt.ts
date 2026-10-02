import { pool } from "../db/client.js";
import { sendEmail } from "./email.js";
import logger from "./logger.js";
import { renderEmail } from "./email/layout.js";
import { settlementReceiptEmail } from "./email/templates/receipt.js";

// =============================================================================
// THE RECEIPT FOR ONE CARD CHARGE (Reader Terms 5.2; compliance audit 4.5)
//
// "We will give you a receipt for every charge, itemising the pieces it covers,
// the Writers concerned and what you paid for each."
//
// Nothing of that shape existed. The settlement made no email or notification
// call; the PaymentIntent set no `receipt_email`, so Stripe's own receipt was
// not triggered either; and the account statement showed a bare "Balance
// settled £X" row that linked to no reads and named no Writer. The Reader
// learned of a card charge from their bank.
//
// ONE HOME FOR THE QUESTION "WHAT DID THIS CHARGE COVER". The gateway route the
// reader opens and the email the confirm sends are two surfaces on one fact, and
// two copies of this SQL would drift — with the divergence visible only to
// somebody holding the email and the page side by side, which is nobody. So the
// query and the shape live here and both sides read them.
//
// THE WRITER IS NAMED AS THE SELLER. Reader Terms 1.1: the contract for a piece
// is with the Writer, and all.haus concludes the sale as the Writer's disclosed
// agent. A receipt naming only the platform says the opposite of the structure
// the whole agreement rests on.
//
// WHAT THE READER PAID IS `chargeable_pence`, NEVER `amount_pence`. The free
// allowance is a gift: a read it covered cost the reader nothing and earned the
// writer nothing, ever (`.claude/rules/money.md`; migration 164). Such a read
// appears here at £0.00 beside the piece it bought. Its LIST price is not what
// they paid and has no place on a receipt.
//
// A SETTLEMENT'S ITEMS DO NOT ALWAYS SUM TO ITS CHARGE, AND THE RECEIPT SAYS SO.
// `confirmSettlement` advances every accrued read on the tab whose `read_at` is
// at or before the settlement's snapshot — which includes a read that landed
// between the charge being reserved and the webhook confirming it, whose penny
// is collected by the NEXT charge. That attribution is deliberately approximate
// (the Wave-5 P3 note in `settlement.ts`), so the itemised total can exceed the
// amount charged. Money conserves across settlements; one settlement's
// arithmetic need not close. Printing both totals and leaving the reader to
// reconcile them would be worse than printing neither, so the difference is its
// own named field with its own sentence. **The amount CHARGED is authoritative**
// — it is what left the card.
//
// SUBSCRIPTION CHARGES ARE ITEMS TOO. A subscription is debited to the same tab
// and collected by the same charge (`subscription_events.tab_settlement_id`,
// migration 165); omitting them would leave most of a subscriber's receipt
// unexplained. The column is stamped on the CHARGE row by confirmSettlement
// (`STAMP_SUBSCRIPTION_CHARGES_SQL`, payment-service) beside the earning it
// pairs with — until 2026-09-29 only the earning was stamped, so no receipt
// ever carried a subscription line and every one fell into the gap sentence as
// balance "carried on your tab" (CA-A4). Pinned by the DB-backed
// `payment-service/tests/subscription-receipt-integration.test.ts`.
// =============================================================================

// WHAT THE RECEIPT SAYS — the discharge sentence (Reader Terms 1.4), the gap
// sentence, the free-allowance note — lives with the email's words in
// `./email/templates/receipt.ts`, which `web/tests/settlement-receipt-copy
// .test.ts` reads to pin the page against. Re-exported here for callers that
// already import it from the fact's home.
export {
  DISCHARGE_SENTENCE,
  GAP_CARRIED_PHRASE,
  GAP_UNCOVERED_PHRASE,
  gapSentence,
} from "./email/templates/receipt.js";

export interface ReceiptItem {
  kind: "read" | "subscription";
  description: string;
  /** The Writer, named as the SELLER (Reader Terms 1.1). */
  writerName: string;
  writerUsername: string;
  /** What the reader paid for this item, in pence. A gifted read is 0. */
  pricePence: number;
  /** Where the piece lives, when there is one. */
  link: string | null;
  at: string;
}

export interface SettlementReceipt {
  settlementId: string;
  settledAt: string;
  /** What left the card. The authoritative figure. */
  amountPence: number;
  triggerType: string;
  reversedAt: string | null;
  items: ReceiptItem[];
  itemisedPence: number;
  /** `amountPence − itemisedPence`. Zero on an ordinary receipt; positive when
   *  this charge carries items a later one collects. Never rendered as a number
   *  on its own — see the surfaces, which put it in words. */
  unitemisedPence: number;
}

interface SettlementRow {
  id: string;
  amount_pence: number;
  settled_at: Date;
  trigger_type: string;
  reversed_at: Date | null;
}

interface ItemRow {
  kind: "read" | "subscription";
  description: string;
  writer_name: string | null;
  writer_username: string | null;
  price_pence: number;
  link: string | null;
  at: Date;
}

// Both kinds in one statement so their order is one order. Neither arm computes
// a fee: what the reader owes is the price of the content, and the platform's
// fee is a matter between us and the Writer under the Writer Agreement — putting
// it on the Reader's receipt would state a charge they did not incur.
//
// $1 = settlement id.
export const RECEIPT_ITEMS_SQL = `
  SELECT 'read' AS kind,
         art.title AS description,
         COALESCE(w.display_name, w.username) AS writer_name,
         w.username AS writer_username,
         re.chargeable_pence AS price_pence,
         CASE WHEN art.nostr_d_tag IS NOT NULL
              THEN '/article/' || art.nostr_d_tag ELSE NULL END AS link,
         re.read_at AS at
    FROM read_events re
    JOIN articles art ON art.id = re.article_id
    JOIN accounts w ON w.id = re.writer_id
   WHERE re.tab_settlement_id = $1

  UNION ALL

  SELECT 'subscription' AS kind,
         'Subscription to ' || COALESCE(w.display_name, w.username, p.name) AS description,
         COALESCE(w.display_name, w.username, p.name) AS writer_name,
         w.username AS writer_username,
         se.amount_pence AS price_pence,
         CASE WHEN w.username IS NOT NULL THEN '/' || w.username ELSE NULL END AS link,
         se.created_at AS at
    FROM subscription_events se
    -- LEFT, both (§0z item 19b): a PUBLICATION subscription carries no
    -- writer_id, and an inner join dropped its line from the receipt — the
    -- charge was right and the itemisation short, which the gap sentence
    -- then explained as reading "on your next receipt" that never came.
    LEFT JOIN accounts w ON w.id = se.writer_id
    LEFT JOIN publications p ON p.id = se.publication_id
   WHERE se.tab_settlement_id = $1
     AND se.event_type = 'subscription_charge'

  ORDER BY at ASC
`;

// Scoped to the reader in the WHERE clause, never checked afterwards: this is
// the reader's own receipt and nobody else's, and a row that is not theirs must
// be indistinguishable from one that does not exist.
//
// `status = 'completed'` is part of the same predicate. A pending settlement has
// charged nobody and a failed one charged nobody either, so there is no receipt
// to give and the answer is the same absence. A REVERSED settlement keeps its
// receipt and says so: the charge did happen, and a reader looking for it needs
// to find it.
const SETTLEMENT_SQL = `
  SELECT id, amount_pence, settled_at, trigger_type, reversed_at
    FROM tab_settlements
   WHERE id = $1 AND reader_id = $2 AND status = 'completed'
`;

/** What the loader needs of a connection: the pool by default, or a caller's
 *  own client so a DB-backed test can render a receipt off rows inside a
 *  transaction it then rolls back. */
export type ReceiptQueryable = Pick<typeof pool, "query">;

export async function loadSettlementReceipt(
  settlementId: string,
  readerId: string,
  db: ReceiptQueryable = pool,
): Promise<SettlementReceipt | null> {
  const { rows: settlements } = await db.query<SettlementRow>(SETTLEMENT_SQL, [
    settlementId,
    readerId,
  ]);
  if (settlements.length === 0) return null;
  const settlement = settlements[0];

  const { rows: itemRows } = await db.query<ItemRow>(RECEIPT_ITEMS_SQL, [
    settlementId,
  ]);

  const items: ReceiptItem[] = itemRows.map((r) => ({
    kind: r.kind,
    description: r.description,
    // Both columns are NOT NULL on an account a read joined to; the fallback is
    // for a row whose display name was cleared by a deletion.
    writerName: r.writer_name ?? r.writer_username ?? "Writer",
    writerUsername: r.writer_username ?? "",
    pricePence: Number(r.price_pence),
    link: r.link,
    at: r.at.toISOString(),
  }));

  const itemisedPence = items.reduce((sum, i) => sum + i.pricePence, 0);

  return {
    settlementId: settlement.id,
    settledAt: settlement.settled_at.toISOString(),
    amountPence: settlement.amount_pence,
    triggerType: settlement.trigger_type,
    reversedAt: settlement.reversed_at
      ? settlement.reversed_at.toISOString()
      : null,
    items,
    itemisedPence,
    unitemisedPence: settlement.amount_pence - itemisedPence,
  };
}

// ---------------------------------------------------------------------------
// The email, sent on the CONFIRM and never on the create.
//
// A create that returns ambiguously may or may not have charged the card
// (`.claude/rules/money.md`: terminal vs ambiguous), so emailing a receipt there
// tells a reader money left their account when nobody yet knows whether it did.
// `payment_intent.succeeded` is the first moment the charge is a fact, and it is
// also the moment the reads are stamped with this settlement — so it is the
// first moment there is anything to itemise.
// ---------------------------------------------------------------------------

/** The soft delete rewrites the address to `deleted-<id>@deleted`; a receipt
 *  addressed there is a receipt sent to nobody, and is refused rather than
 *  counted as sent. */
const TOMBSTONE_EMAIL_RE = /@deleted$/i;

export async function sendSettlementReceiptEmail(
  settlementId: string,
  readerId: string,
): Promise<void> {
  // THE ADDRESS IS THE SETTLEMENT'S FIRST (migration 227; §0z item 9). An
  // `account_closure` charge is reserved and then the account's address is
  // tombstoned in the same closure, so by the confirm the account row points
  // nowhere. `receipt_email` was stamped at reserve from the address the
  // reader had; the account's current address is the fallback for rows from
  // before the column existed.
  const { rows } = await pool.query<{
    email: string | null;
    display_name: string | null;
    username: string;
  }>(
    `SELECT COALESCE(ts.receipt_email, a.email) AS email, a.display_name, a.username
       FROM accounts a
       LEFT JOIN tab_settlements ts ON ts.id = $2 AND ts.reader_id = a.id
      WHERE a.id = $1`,
    [readerId, settlementId],
  );
  // A seeded or invited account may have no address. That is not a failure of
  // this send; it is an account there is nowhere to send to.
  if (rows.length === 0 || !rows[0].email) {
    logger.info(
      { settlementId, readerId },
      "Settlement receipt not sent: the account has no email address",
    );
    return;
  }
  if (TOMBSTONE_EMAIL_RE.test(rows[0].email)) {
    logger.warn(
      { settlementId, readerId },
      "Settlement receipt not sent: the only address is the deletion tombstone — the settlement carried no receipt_email",
    );
    return;
  }
  const to = rows[0].email;

  const receipt = await loadSettlementReceipt(settlementId, readerId);
  if (!receipt) {
    logger.warn(
      { settlementId, readerId },
      "Settlement receipt not sent: no completed settlement for this reader",
    );
    return;
  }

  await sendEmail({ to, ...renderEmail(settlementReceiptEmail({ receipt })) });
}
