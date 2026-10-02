import { formatStampUtc } from "../format.js";
import { button, fine, list, p, strong, type EmailContent } from "../layout.js";

// =============================================================================
// The closed beta's waiting list (CLOSED-BETA-ADR §XI), and the writers'
// waiting list beside it (READER-WRITER-SPLIT-ADR §8).
// =============================================================================

// The invitation carries NO LOGIN TOKEN, on purpose: a magic link expires in
// minutes and an invitation is read hours or days later, so it points at the
// login page and names the address to enter instead.
//
// The waitlist page promises "we'll write when we're ready for you", so the
// subject is the sentence that keeps it. If the page's wording moves, move this
// with it: a promise and its fulfilment reading differently is how a real
// message starts to sound like a template.
export function waitlistInviteEmail(args: { to: string; loginUrl: string }): EmailContent {
  return {
    subject: "We're ready for you on all.haus",
    heading: "Your account is ready",
    blocks: [
      p("You asked us to say when we were ready for you. We are, and your account is waiting."),
      p(
        "Log in with this address (",
        strong(args.to),
        ") and we'll email you a link to get in. No password to remember, or to forget.",
      ),
      button(args.loginUrl, "Log in"),
      p(
        "all.haus gathers the open social web (Bluesky, Mastodon, Substack, RSS and more) into channels that run on rules you set, rather than rules set on you. Make as many as you like.",
      ),
      fine(
        "We're still small and still fixing things. If something's broken, please reply to this email. It reaches a person, not a queue.",
      ),
    ],
  };
}

/** One writer application, as the digest names it. */
export interface DigestApplicant {
  username: string | null;
  displayName: string | null;
  appliedAt: Date;
}

/** To the operator: who joined since the last digest, and who asked to write.
 *  A count and the addresses or handles, and nothing else. Either half may be
 *  empty, never both (the worker sends nothing then). */
export function waitlistDigestEmail(args: {
  joiners: { email: string; joinedAt: Date }[];
  total: number;
  /** Writer applications since the last digest (READER-WRITER-SPLIT-ADR §8). */
  applicants?: DigestApplicant[];
  /** Applications not yet granted, in total. */
  pendingApplications?: number;
}): EmailContent {
  const n = args.joiners.length;
  const applicants = args.applicants ?? [];
  const a = applicants.length;
  const joinWords = `${n} new on the waiting list`;
  const applyWords = `${a} writer application${a === 1 ? "" : "s"}`;
  const heading = n > 0 && a > 0 ? `${joinWords}, ${applyWords}` : n > 0 ? joinWords : applyWords;
  const subject =
    n > 0 && a > 0
      ? `all.haus waiting list — ${n} new, ${applyWords}`
      : n > 0
        ? `all.haus waiting list — ${n} new`
        : `all.haus — ${applyWords}`;
  return {
    subject,
    heading,
    blocks: [
      ...(n > 0
        ? [
            list(args.joiners.map((j) => [strong(j.email), ` — joined ${formatStampUtc(j.joinedAt)}`])),
            p(`The list now holds ${args.total} in total.`),
            fine(
              "They haven't heard from us: the waiting list records interest and never writes back. Admitting someone is still done by hand.",
            ),
          ]
        : []),
      ...(a > 0
        ? [
            p("Members asking to write:"),
            list(
              applicants.map((x) => [
                strong(x.username ? `@${x.username}` : "an account since deleted"),
                x.displayName ? ` (${x.displayName})` : "",
                ` — asked ${formatStampUtc(x.appliedAt)}`,
              ]),
            ),
            p(
              `${args.pendingApplications ?? a} waiting in total. Grant writing access from the Writers section of the waiting-list page.`,
            ),
          ]
        : []),
    ],
  };
}

/** To the member, when the operator admits them as a writer. Sent after the
 *  grant commits; a failed send leaves the grant standing. */
export function writerAccessGrantedEmail(args: { writeUrl: string }): EmailContent {
  return {
    subject: "You can now publish on all.haus",
    heading: "You're a writer on all.haus",
    blocks: [
      p("You asked to write on all.haus, and you're in: you can now publish articles, free or paywalled."),
      button(args.writeUrl, "Write an article"),
      p(
        "Notes and replies work as they always have. The first time you publish a paid piece, we'll ask you to accept the Writer Agreement.",
      ),
      fine("If something's broken, please reply to this email. It reaches a person, not a queue."),
    ],
  };
}
