import { sendEmail, emailDeliverable } from "./email.js";
import { pool } from "../db/client.js";
import logger from "./logger.js";
import { renderEmail } from "./email/layout.js";
import {
  chargebackNoticeEmail,
  moderationNoticeEmail,
  unpayableWithdrawalNoticeEmail,
  type ModerationNoticeKind,
} from "./email/templates/notices.js";

// The vocabulary is the template's; re-exported for the callers that choose
// a kind (`moderation.ts`).
export {
  MODERATION_NOTICE_KINDS,
  type ModerationNoticeKind,
} from "./email/templates/notices.js";

// =============================================================================
// TELLING A MEMBER SOMETHING HAPPENED TO THEM (L5.5; Writer Agreement 8.3 and
// 11.2; D5 §9; D7 §5).
//
// Two events on this platform take something away from a member, and neither
// said a word to them.
//
//   · A CHARGEBACK. A reader disputes a settlement, the Writer's
//     `writer_accrual` is reversed, and money that appeared in their earnings
//     leaves again. Writer 8.3 says they are told and may put evidence in;
//     until this, the figure simply went down, with the Writer left to notice
//     and guess. The notice names the piece, names the amount and asks for
//     whatever they have.
//   · A REMOVAL OR SUSPENSION. Their work is tombstoned to the relay, or their
//     account is closed to them. D5 §9 and D7 §5 say they are told WHY and how
//     to appeal. The operator's screen took a reason and dropped it on the
//     floor (`moderation.ts`), so a member learned they had been suspended by
//     failing to sign in.
//
// THE PARTIAL-OUTCOME RULE GOVERNS THE LOOP. One chargeback can reverse several
// Writers at once, and a bare `for … await` over a throwing send aborts at the
// first bad address and says nothing about the rest — which is exactly how one
// inactive admin stopped the whole waitlist digest. So each send is caught
// individually, the loop runs to the end, and the SHORTFALL is counted and
// returned beside the total. A caller that logs `{ sent, skipped }` can see the
// difference between "nobody was affected" and "nobody could be reached".
//
// A NOTICE IS NEVER THE EVENT'S GATEKEEPER. Both are fired after their
// transaction has committed and neither propagates: an email outage must not
// roll back a chargeback that Stripe has already made, nor leave a moderation
// action half-applied. `email-health.ts` is what makes a silent outage visible.
//
// WHAT each notice says is `./email/templates/notices.ts`; this file decides
// who is told and counts who could not be.
// =============================================================================

interface Recipient {
  email: string;
  displayName: string;
}

async function recipient(accountId: string): Promise<Recipient | null> {
  const { rows } = await pool.query<{
    email: string | null;
    display_name: string | null;
    username: string;
  }>(`SELECT email, display_name, username FROM accounts WHERE id = $1`, [
    accountId,
  ]);
  if (rows.length === 0 || !rows[0].email) return null;
  return {
    email: rows[0].email,
    displayName: rows[0].display_name ?? rows[0].username,
  };
}

/**
 * What a loop of notices did. `skipped` ships beside `sent` because a total
 * alone cannot tell "nobody was affected" from "nobody could be reached", and
 * the second is an incident.
 */
export interface NoticeOutcome {
  sent: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// The chargeback notice (Writer 8.3)
// ---------------------------------------------------------------------------

export interface ChargebackNotice {
  writerId: string;
  /** The Writer's own reversal, POSITIVE — what left their earnings. */
  amountPence: number;
  /** The pieces the disputed settlement paid for. May be several. */
  titles: string[];
}

/**
 * Tell each affected Writer that a reader's chargeback has reversed their
 * earnings on named pieces, and invite whatever evidence they have.
 *
 * Never throws: the reversal has already happened at Stripe and in our ledger,
 * and an email that cannot be sent is not a reason to leave those disagreeing.
 */
export async function sendChargebackNoticeEmails(
  notices: ChargebackNotice[],
): Promise<NoticeOutcome> {
  let sent = 0;
  let skipped = 0;

  for (const notice of notices) {
    try {
      const to = await recipient(notice.writerId);
      if (!to) {
        // No address on the account — a seeded account, or a member who
        // signed up through a path that collects none. Counted, not silent.
        skipped++;
        continue;
      }
      await sendEmail({
        to: to.email,
        ...renderEmail(
          chargebackNoticeEmail({
            displayName: to.displayName,
            amountPence: notice.amountPence,
            titles: notice.titles,
          }),
        ),
      });
      sent++;
    } catch (err) {
      // One bad address is a fact about that address. The rest of the Writers
      // on this chargeback still have to be told.
      logger.error(
        { err, writerId: notice.writerId },
        "Chargeback notice failed for one writer — continuing",
      );
      skipped++;
    }
  }

  return { sent, skipped };
}

// ---------------------------------------------------------------------------
// The moderation notice (D5 §9, D7 §5)
// ---------------------------------------------------------------------------

export interface ModerationNoticeOptions {
  /**
   * The one-use appeal link (D7 §5's "appeal route"), minted by the caller
   * against the member's own account and carried in this email because it is
   * the ONLY channel a suspended member has left — `requireAuth` answers 403 to
   * them on every route this platform serves.
   *
   * Optional, and its absence is not silent: without one the notice falls back
   * to the support mailbox, which is what it said before the route existed.
   */
  appealUrl?: string;
  /** When the appeal window closes, rendered as a date the member can read. */
  appealDeadline?: Date;
}

/**
 * Tell a member what was done to their account or their work, why, and how to
 * challenge it.
 *
 * Returns whether the notice went. Never throws: a member who cannot be emailed
 * must not also be left un-moderated, and the caller logs the shortfall.
 */
export async function sendModerationNoticeEmail(
  accountId: string,
  kind: ModerationNoticeKind,
  reason: string,
  opts: ModerationNoticeOptions = {},
): Promise<NoticeOutcome> {
  try {
    const to = await recipient(accountId);
    if (!to) return { sent: 0, skipped: 1 };

    await sendEmail({
      to: to.email,
      ...renderEmail(
        moderationNoticeEmail({
          displayName: to.displayName,
          kind,
          reason,
          appealUrl: opts.appealUrl,
          appealDeadline: opts.appealDeadline,
        }),
      ),
    });
    return { sent: 1, skipped: 0 };
  } catch (err) {
    logger.error({ err, accountId, kind }, "Moderation notice failed to send");
    return { sent: 0, skipped: 1 };
  }
}

// ---------------------------------------------------------------------------
// The unpayable-writer notice (Writer 9.3)
// ---------------------------------------------------------------------------

/**
 * Tell a Writer we have been unable to pay them for long enough that we intend
 * to stop offering paid access to their work, and how long they have.
 *
 * The notice is a PRECONDITION of the withdrawal (9.3: "after giving you at
 * least 30 days' notice"), so the caller stamps its record only on a delivered
 * notice — which is why this reports rather than throws, and why a failure
 * delays the withdrawal instead of skipping the warning.
 */
export async function sendUnpayableWithdrawalNoticeEmail(
  accountId: string,
  noticeDays: number,
): Promise<NoticeOutcome> {
  // A LOG LINE IS NOT NOTICE (§0z item 7). The `console` provider resolves
  // normally, so until 2026-09-18 an unconfigured payment-service reported
  // this notice SENT, the sweep stamped `unpayable_notice_sent_at`, and thirty
  // days later withdrew paid access from a writer nobody had told — the exact
  // inverse of what three documents said an unconfigured provider did. Every
  // other notice in this file may go to a log and be a lost email; this one is
  // the first half of a legal notice period, so it refuses to count itself
  // sent, and the sweep's don't-stamp contract holds the withdrawal back.
  if (!emailDeliverable()) {
    logger.error(
      { accountId, provider: process.env.EMAIL_PROVIDER ?? "unset" },
      "Unpayable withdrawal notice NOT sent: EMAIL_PROVIDER is console, and a log line is not notice. The withdrawal will not proceed until a real provider is configured on payment-service.",
    );
    return { sent: 0, skipped: 1 };
  }
  try {
    const to = await recipient(accountId);
    if (!to) return { sent: 0, skipped: 1 };

    await sendEmail({
      to: to.email,
      ...renderEmail(
        unpayableWithdrawalNoticeEmail({ displayName: to.displayName, noticeDays }),
      ),
    });
    return { sent: 1, skipped: 0 };
  } catch (err) {
    logger.error({ err, accountId }, "Unpayable-withdrawal notice failed to send");
    return { sent: 0, skipped: 1 };
  }
}
