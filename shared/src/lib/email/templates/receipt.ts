import { CONTACT_ADDRESSES } from "../../contact-addresses.js";
import type { SettlementReceipt } from "../../settlement-receipt.js";
import { formatDate, formatPounds, siteUrl } from "../format.js";
import { button, ledger, mail, p, strong, type EmailContent } from "../layout.js";

// =============================================================================
// THE RECEIPT FOR ONE CARD CHARGE (Reader Terms 5.2) — its words.
//
// What the charge covered is asked in ONE place, `settlement-receipt.ts`, which
// both the page and this email read. What the receipt SAYS lives here, and the
// page in `web/` says the same sentences: there is no module path between the
// two workspaces, so `web/tests/settlement-receipt-copy.test.ts` reads THIS
// FILE's source and pins the page's copy against it.
//
// Each line names the Writer, because the Writer is who the reader bought from
// (Reader Terms 1.1). A gifted read is £0.00 and says why — a bare £0.00 reads
// as something having failed.
// =============================================================================

/** Reader Terms 1.4, in the clause's own terms. The one spelling. */
export const DISCHARGE_SENTENCE =
  "Paying us settles what you owed each Writer in full. We collect it on their behalf, and once a charge has gone through, that debt is discharged.";

/**
 * The gap between what was charged and what is itemised, in words, BY SIGN
 * (§0z item 19b). A positive gap is balance carried from before — a charge
 * restored after a reversal, a released credit — and is not reading at all; a
 * negative one is reading the NEXT charge collects. The amount charged is
 * authoritative; the gap is never printed as a second total.
 */
export const GAP_CARRIED_PHRASE = "carried on your tab from earlier activity";
export const GAP_UNCOVERED_PHRASE = "collected with your next charge";

export function gapSentence(unitemisedPence: number): string | null {
  if (unitemisedPence > 0) {
    return `${formatPounds(unitemisedPence)} of this charge is balance ${GAP_CARRIED_PHRASE} — a charge restored after a reversal, or a credit that was released back to your tab — rather than the reading and subscriptions listed above.`;
  }
  if (unitemisedPence < 0) {
    return `The reading listed above comes to ${formatPounds(-unitemisedPence)} more than this charge; the difference is still on your tab and is ${GAP_UNCOVERED_PHRASE}.`;
  }
  return null;
}

export const FREE_ALLOWANCE_NOTE = "covered by your free allowance";

export function settlementReceiptEmail(args: { receipt: SettlementReceipt }): EmailContent {
  const r = args.receipt;
  const charged = formatPounds(r.amountPence);
  const gap = gapSentence(r.unitemisedPence);
  return {
    subject: `Your all.haus receipt — ${charged}`,
    heading: "Your receipt",
    blocks: [
      p(
        "We charged your card ",
        strong(charged),
        ` on ${formatDate(new Date(r.settledAt))}. This covered:`,
      ),
      ledger(
        r.items.map((i) => ({
          label: i.description,
          detail: i.writerName,
          amount: formatPounds(i.pricePence),
          note: i.pricePence === 0 ? FREE_ALLOWANCE_NOTE : undefined,
        })),
      ),
      ...(gap ? [p(gap)] : []),
      p(DISCHARGE_SENTENCE),
      button(siteUrl("/reader?overlay=ledger"), "See it online"),
      // Reader Terms 14.1 names this box and promises an answer within five
      // working days. It is the one spelling (`contact-addresses.ts`).
      p("Something wrong with this charge? Write to ", mail(CONTACT_ADDRESSES.support), "."),
    ],
  };
}
