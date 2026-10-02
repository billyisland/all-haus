import { button, fine, p, strong, type EmailContent } from "../layout.js";

// =============================================================================
// Tributes (suspended behind TRIBUTES_ENABLED): an author offers a share of a
// piece's earnings to the person who inspired it. Three emails — the offer to
// the inspirer (carries the claim link), the author's reference copy (never
// carries it), and the reminder.
// =============================================================================

/** `12.5` from 1250 bps, `10` from 1000. */
export function tributePercent(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
}

export function tributeOfferEmail(args: {
  authorName: string;
  articleTitle: string;
  percent: string;
  note: string | null;
  claimUrl: string;
}): EmailContent {
  return {
    subject: `${args.authorName} wants to share earnings with you on all.haus`,
    heading: "You've been credited as an inspiration",
    blocks: [
      p(
        strong(args.authorName),
        ` credits you as an inspiration for “${args.articleTitle}”, and would like to give you `,
        strong(`${args.percent}%`),
        " of what it earns.",
      ),
      ...(args.note ? [p(`They added: “${args.note}”`)] : []),
      p(
        "No catch, and nothing to buy. Create a free account, read the piece, and decide.",
      ),
      button(args.claimUrl, "Read it & decide"),
      p(
        "Accept, and you'll be paid that share of everything the piece earns — what it has made so far, and whatever it makes from then on.",
      ),
      fine(
        "Do nothing and nothing is held in your name: the offer lapses and the share stays with the writer. Ignoring this email is perfectly fine.",
      ),
    ],
  };
}

/** The author's copy. The claim link is private to the inspirer. */
export function tributeAuthorCopyEmail(args: {
  inviteEmail: string;
  articleTitle: string;
  percent: string;
}): EmailContent {
  return {
    subject: `Your tribute offer for “${args.articleTitle}” is on its way`,
    heading: "Offer sent",
    blocks: [
      p(
        "We've emailed ",
        strong(args.inviteEmail),
        " your offer to share ",
        strong(`${args.percent}%`),
        ` of “${args.articleTitle}”.`,
      ),
      p(
        "A personal note does two jobs: it conveys the spirit of the tribute, and it gets the message past spam filters. Their claim link is private, so it isn't included here.",
      ),
      fine(
        "Until they accept, the share is reserved within your earnings. If they never do, it's yours.",
      ),
    ],
  };
}

export function tributeReminderEmail(args: {
  authorName: string;
  articleTitle: string;
  percent: string;
  claimUrl: string;
}): EmailContent {
  return {
    subject: `Reminder: ${args.authorName} would still like to share earnings with you`,
    heading: "The offer still stands",
    blocks: [
      p(
        "A while back, ",
        strong(args.authorName),
        " offered you ",
        strong(`${args.percent}%`),
        ` of what “${args.articleTitle}” earns on all.haus, by way of thanks for the inspiration. To read the piece and decide, create a free account.`,
      ),
      button(args.claimUrl, "Read it & decide"),
      fine("Do nothing and the share returns to the writer. Ignoring this is perfectly fine."),
    ],
  };
}
