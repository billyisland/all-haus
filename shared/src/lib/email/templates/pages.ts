import { siteUrl } from "../format.js";
import { link, p, post, strong, type Block } from "../layout.js";

// =============================================================================
// The pages the gateway serves itself, outside the web app — reached from a
// link in an email, so they wear the email's look (`renderPage`).
// =============================================================================

export interface PageContent {
  heading: string;
  blocks: Block[];
}

export type UnsubscribeOutcome =
  | { kind: "confirm"; targetName: string; actionUrl: string }
  | { kind: "done"; targetName: string }
  | { kind: "rate_limited" }
  | { kind: "missing_params" }
  | { kind: "unknown_type" }
  | { kind: "bad_token" }
  | { kind: "failed" };

export function unsubscribePage(outcome: UnsubscribeOutcome): PageContent {
  switch (outcome.kind) {
    // The link in the email lands HERE and changes nothing: a mail scanner
    // (Outlook SafeLinks and its kind) opens every link it sees, so a GET that
    // unsubscribed was unsubscribing people who never clicked. The press is
    // the POST.
    case "confirm":
      return {
        heading: "Unsubscribe?",
        blocks: [
          p("Stop the emails about new pieces from ", strong(outcome.targetName), "?"),
          post(outcome.actionUrl, "Unsubscribe"),
          p("You'll still be able to read them on all.haus. Nothing else about your account changes."),
        ],
      };
    case "done":
      return {
        heading: "Unsubscribed",
        blocks: [
          p("You won't get any more emails about new pieces from ", strong(outcome.targetName), "."),
          p("Changed your mind? You can turn them back on under Subscriptions, in your ", link(siteUrl("/account"), "Ledger"), "."),
        ],
      };
    case "rate_limited":
      return { heading: "Too many requests", blocks: [p("That's more requests than we can take at once. Please wait a minute and try again.")] };
    case "missing_params":
      return {
        heading: "This link doesn't work",
        blocks: [p("This unsubscribe link is incomplete. It may have been cut short on its way here, so please press the link in the email again.")],
      };
    case "unknown_type":
      return {
        heading: "This link doesn't work",
        blocks: [p("This link names a kind of email we don't send, so there's nothing to unsubscribe from.")],
      };
    case "bad_token":
      return {
        heading: "This link doesn't work",
        blocks: [
          p(
            "We couldn't check this unsubscribe link. It may have been changed or cut short. Please press the link in the email again, or turn the emails off under Subscriptions, in your ",
            link(siteUrl("/account"), "Ledger"),
            ".",
          ),
        ],
      };
    case "failed":
      return {
        heading: "Something went wrong",
        blocks: [p("That didn't work, and the fault is ours. Please try again later.")],
      };
  }
}
