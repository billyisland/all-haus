import { CONTACT_ADDRESSES } from "../../contact-addresses.js";
import { formatDateUtc, formatPounds, siteUrl } from "../format.js";
import { link, list, mail, p, strong, type Block, type EmailContent } from "../layout.js";

// =============================================================================
// Telling a member something happened to them: a chargeback on their writing
// (Writer 8.3), a moderation decision (D5 §9, D7 §5), and the warning before
// we stop selling the work of a Writer we cannot pay (Writer 9.3).
//
// Each says what happened, what the member KEEPS, and what they can do — in
// that order. Who is told, and how a failure is counted, is `member-notices.ts`.
// =============================================================================

export function chargebackNoticeEmail(args: {
  displayName: string;
  /** The Writer's own reversal, POSITIVE — what left their earnings. */
  amountPence: number;
  /** The pieces the disputed settlement paid for. May be several, or none. */
  titles: string[];
}): EmailContent {
  const n = args.titles.length;
  return {
    subject: "A reader has disputed a payment for your writing",
    heading: "A payment has been reversed",
    blocks: [
      p(
        `${args.displayName}, a reader's bank has clawed back a payment that included your writing, ` +
          `and ${formatPounds(args.amountPence)} has come out of your earnings.`,
      ),
      ...(n > 0 ? [p(n === 1 ? "The piece it covered:" : "The pieces it covered:"), list(args.titles)] : []),
      p(
        "The decision was the bank's, not ours, and we cannot undo it alone. If you have anything that shows the reading was genuine — " +
          "correspondence with the reader, say, or how they came to your work — send it to ",
        mail(CONTACT_ADDRESSES.support),
        " and we will put it to the card network.",
      ),
      p("Your earnings: ", link(siteUrl("/account")), "."),
    ],
  };
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * What we did. A vocabulary rather than free text, because the sentence a
 * member reads depends on which of these happened and they are not
 * interchangeable — a member warned must never be told their work was removed.
 */
export const MODERATION_NOTICE_KINDS = [
  "content_removed",
  "content_warned",
  "account_suspended",
  "account_suspended_7d",
  "account_terminated",
  "account_reinstated",
  "appeal_upheld",
  "appeal_reversed",
] as const;
export type ModerationNoticeKind = (typeof MODERATION_NOTICE_KINDS)[number];

const SUBJECT: Record<ModerationNoticeKind, string> = {
  content_removed: "We've removed something you published",
  content_warned: "A warning about something you published on all.haus",
  account_suspended: "Your all.haus account has been suspended",
  account_suspended_7d: "Your all.haus account has been suspended for 7 days",
  account_terminated: "Your all.haus account has been closed",
  account_reinstated: "Your all.haus account has been reinstated",
  appeal_upheld: "We've reviewed your appeal",
  appeal_reversed: "We've reviewed your appeal and reversed our decision",
};

const HEADING: Record<ModerationNoticeKind, string> = {
  content_removed: "Content removed",
  content_warned: "A warning, not a removal",
  account_suspended: "Account suspended",
  account_suspended_7d: "Account suspended for 7 days",
  account_terminated: "Account closed",
  account_reinstated: "Your account is open again",
  appeal_upheld: "Our decision stands",
  appeal_reversed: "We got it wrong",
};

/**
 * The one paragraph that says what happened. THE MONEY SENTENCE IS PART OF
 * WHAT HAPPENED (L8.6, Writer Agreement 6.6): a decision against an account
 * pauses its payouts, and it is written to be true of a member who has never
 * earned a penny — "if you had earnings waiting" — because these go to every
 * member, not only Writers.
 */
const WHAT_HAPPENED: Record<ModerationNoticeKind, string> = {
  content_removed:
    "Something you published has been removed from all.haus and from the relays it had reached.",
  content_warned:
    "Something you published breaches our content standards. We have left it up: this is a warning rather than an action, and a repeat would be dealt with more firmly.",
  account_suspended:
    "Your account has been suspended. You cannot sign in, and your published writing has been removed from all.haus and from the relays it had reached. Any earnings waiting to be paid out are still yours and held for you, but payouts are paused while the suspension stands.",
  account_suspended_7d:
    "Your account has been suspended for 7 days. You cannot sign in until then, and your published writing has been removed from all.haus and from the relays it had reached. The suspension ends by itself; the removal does not. Any earnings waiting to be paid out are still yours and held for you, and payouts resume when the suspension lifts.",
  account_terminated:
    `Your account has been closed. You cannot sign in, and your published writing has been removed from all.haus and from the relays it had reached. Any earnings waiting to be paid out are still yours and held for you. Payouts are paused, but once the appeal period has passed, write to ${CONTACT_ADDRESSES.support} and we will pay you what you are owed.`,
  account_reinstated:
    "Your account has been reinstated, and you can sign in again. Anything removed in the meantime stays removed: a removal goes out to other relays, and there is no calling it back. Earnings held during the suspension are released, and go out with the next payout run.",
  appeal_upheld:
    "We have re-read your appeal and the material it concerns, against the same guidance as the first time, and reached the same conclusion.",
  appeal_reversed:
    "We have re-read your appeal and the material it concerns, and we were mistaken. Where the decision was against your account, it has been lifted. Removed content cannot be restored — a removal goes out to other relays, and there is no calling it back — but you are free to publish it again.",
};

/** The kinds that are an action AGAINST a member, and so carry an appeal. */
export const APPEALABLE: ReadonlySet<ModerationNoticeKind> = new Set([
  "content_removed",
  "content_warned",
  "account_suspended",
  "account_suspended_7d",
  "account_terminated",
]);

export function moderationNoticeEmail(args: {
  displayName: string;
  kind: ModerationNoticeKind;
  /** Rendered as given, never summarised into a category: a member told only
   *  "you breached the guidelines" has been told nothing they can answer. */
  reason: string;
  /** The one-use appeal link. Without one the notice falls back to the
   *  support mailbox — a route nobody can reach is not one. */
  appealUrl?: string;
  appealDeadline?: Date;
}): EmailContent {
  const appeal: Block[] = [];
  if (APPEALABLE.has(args.kind)) {
    if (args.appealUrl) {
      const by = args.appealDeadline ? ` You have until ${formatDateUtc(args.appealDeadline)}.` : "";
      appeal.push(
        p(
          `If you think we have got this wrong, you can appeal.${by} Tell us why, and a person will re-read the material against the same guidance and answer within 7 days.`,
        ),
        p(link(args.appealUrl)),
      );
    } else {
      appeal.push(
        p(
          "If you think we have got this wrong, reply to this email or write to ",
          mail(CONTACT_ADDRESSES.support),
          " and tell us why. A person will read it and answer.",
        ),
      );
    }
  }
  return {
    subject: SUBJECT[args.kind],
    heading: HEADING[args.kind],
    blocks: [
      p(`${args.displayName},`),
      p(WHAT_HAPPENED[args.kind]),
      p(strong("Why:"), ` ${args.reason}`),
      ...appeal,
    ],
  };
}

// ---------------------------------------------------------------------------
// The unpayable-writer notice (Writer 9.3)
//
// "Withdraw from sale" is easy to read as deletion, and 9.3's last sentence
// exists because it is not; the money is not forfeited either (9.4). Both facts
// are stated before the deadline, not after it.
// ---------------------------------------------------------------------------

export function unpayableWithdrawalNoticeEmail(args: {
  displayName: string;
  noticeDays: number;
}): EmailContent {
  return {
    subject: "We haven't been able to pay you",
    heading: "Your payouts are stuck",
    blocks: [
      p(`${args.displayName},`),
      p(
        "Payouts go through Stripe, and your Stripe account isn't in a state we can transfer to — usually because onboarding was never finished, or because Stripe has restricted it.",
      ),
      p(
        "Your earnings are safe, and still yours. We hold them until we can pay you, and not a moment longer.",
      ),
      p(
        "If nothing changes, in ",
        strong(`${args.noticeDays} days`),
        " we will stop offering paid access to your writing. Nothing is deleted: your work stays published and yours, and goes back on sale the day your Stripe account can receive a transfer.",
      ),
      p(
        "Sort it out at ",
        link(siteUrl("/account")),
        ", or write to ",
        mail(CONTACT_ADDRESSES.support),
        " if Stripe won't budge.",
      ),
    ],
  };
}
