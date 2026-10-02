import { formatDate, formatPounds, siteUrl } from "../format.js";
import { button, fine, link, p, strong, type Block, type EmailContent } from "../layout.js";

// =============================================================================
// The subscription lifecycle: renewal, cancellation, expiry, lapse, and the
// two halves of subscribing — the writer's notice and the reader's welcome.
// =============================================================================

interface Party {
  /** Display name, or the username where there is none. */
  name: string;
  username: string;
}

const profileUrl = (who: Party) => siteUrl(`/${who.username}`);

export function subscriptionRenewedEmail(args: {
  writer: Party;
  pricePence: number;
  nextPeriodEnd: Date;
}): EmailContent {
  const w = args.writer.name;
  return {
    subject: `Your subscription to ${w} renewed`,
    heading: "Renewed",
    blocks: [
      // NAMES THE SELLER (Reader Terms 1.1). The reader buys from the Writer,
      // and we collect on the Writer's behalf — never "added to your tab", which
      // leaves the platform alone in the sentence.
      p(
        "Your subscription to ",
        strong(w),
        ` has renewed: ${formatPounds(args.pricePence)} is now owed to them on your reading tab, and we'll collect it on their behalf with your next charge.`,
      ),
      p(`Next renewal: ${formatDate(args.nextPeriodEnd)}.`),
      button(siteUrl("/account"), "Manage subscriptions"),
    ],
  };
}

export function subscriptionCancelledEmail(args: {
  writer: Party;
  accessUntil: Date;
}): EmailContent {
  return {
    subject: `Subscription to ${args.writer.name} cancelled`,
    heading: "Cancelled, as requested",
    blocks: [
      p("You've cancelled your subscription to ", strong(args.writer.name), "."),
      p(
        "You can read on until ",
        strong(formatDate(args.accessUntil)),
        ", and anything you've already unlocked stays unlocked for good.",
      ),
      button(profileUrl(args.writer), "Resubscribe"),
    ],
  };
}

/** Three days before the end of a subscription that will not renew. */
export function subscriptionExpiryWarningEmail(args: {
  writer: Party;
  expiresAt: Date;
}): EmailContent {
  return {
    subject: `Your subscription to ${args.writer.name} ends soon`,
    heading: "Ending soon",
    blocks: [
      p(
        "Your subscription to ",
        strong(args.writer.name),
        " ends on ",
        strong(formatDate(args.expiresAt)),
        ".",
      ),
      p(
        "What you've already unlocked stays yours. Anything they put behind the paywall after that date won't be.",
      ),
      button(profileUrl(args.writer), "Resubscribe"),
    ],
  };
}

/**
 * The renewal that did not happen because the Writer's paid access is
 * withdrawn (Writer 9.3). Says what is true for the reader — not renewed, not
 * charged, what they read stays theirs — and nothing about the Writer's Stripe
 * account, which is between us and the Writer.
 */
export function subscriptionLapsedNotForSaleEmail(args: { writer: Party }): EmailContent {
  return {
    subject: `Your subscription to ${args.writer.name} has ended`,
    heading: "Subscription ended",
    blocks: [
      p(
        strong(args.writer.name),
        "'s paid writing isn't on sale at the moment, so your subscription hasn't renewed and you haven't been charged.",
      ),
      p(
        "Everything you've already unlocked is still yours to read. If their paid writing returns, you can subscribe again.",
      ),
      button(profileUrl(args.writer), "See their profile"),
    ],
  };
}

/** To the Writer, when somebody subscribes. */
export function newSubscriberEmail(args: { readerName: string; pricePence: number }): EmailContent {
  return {
    subject: `New subscriber: ${args.readerName}`,
    heading: `${args.readerName} bought a subscription`,
    blocks: [
      p(
        strong(args.readerName),
        ` has just subscribed to your writing at ${formatPounds(args.pricePence)}/mo.`,
      ),
      button(siteUrl("/dashboard?tab=subscribers"), "View subscribers"),
    ],
  };
}

// ---------------------------------------------------------------------------
// The welcome — to the READER, in the Writer's own words
//
// The message is the Writer's, so it is PLAIN TEXT (migration 180): split into
// paragraphs on blank lines, with single newlines kept as line breaks so a list
// laid out by hand does not run together into prose. A Writer who has set
// nothing gets the default, which is a real welcome rather than a placeholder.
// ---------------------------------------------------------------------------

export function welcomeParagraphs(message: string): Block[] {
  return message
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => p(para));
}

export function defaultWelcomeText(writerName: string): string {
  return `Thanks for subscribing to ${writerName}. Everything they publish is now yours to read, and new pieces will turn up in your inbox as they appear.`;
}

export function subscriptionWelcomeEmail(args: {
  writer: Party;
  /** The Writer's own message, or null/blank for the default. */
  message: string | null;
}): EmailContent {
  const w = args.writer.name;
  const custom = args.message?.trim();
  const body = custom && custom.length > 0 ? custom : defaultWelcomeText(w);
  return {
    subject: `You're subscribed to ${w}`,
    heading: "Welcome",
    blocks: [
      ...welcomeParagraphs(body),
      button(profileUrl(args.writer), `Read ${w}`),
      fine("Manage your subscriptions at ", link(siteUrl("/account")), "."),
    ],
  };
}
