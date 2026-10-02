import type { EmailContent } from "./layout.js";
import { siteUrl } from "./format.js";
import * as auth from "./templates/auth.js";
import * as waitlist from "./templates/waitlist.js";
import * as subscriptions from "./templates/subscriptions.js";
import * as publish from "./templates/publish.js";
import * as receipt from "./templates/receipt.js";
import * as notices from "./templates/notices.js";
import * as tributes from "./templates/tributes.js";
import * as pages from "./templates/pages.js";

// =============================================================================
// EVERY EMAIL, WITH SAMPLE DATA — the review surface.
//
// `scripts/email-preview.ts` renders this list into one page; the snapshot
// test renders it into `shared/tests/__snapshots__/`, so a change to any
// email's words or look shows up in the diff. `shared/tests/email-catalogue
// .test.ts` fails when a template in `./templates/` has no entry here, so this
// list cannot fall behind what we send.
//
// An email with several shapes gets one entry per shape worth seeing (every
// moderation kind; a receipt with and without a gap).
// =============================================================================

export const TEMPLATE_MODULES = { auth, waitlist, subscriptions, publish, receipt, notices, tributes, pages };

export interface CatalogueEntry {
  id: string;
  family: keyof typeof TEMPLATE_MODULES;
  /** The template function, so completeness can be checked by identity. */
  template: (...args: never[]) => unknown;
  /** Who gets it, and what sends it. */
  when: string;
  render: () => EmailContent | pages.PageContent;
  /** A gateway page rather than an email. */
  page?: true;
}

const writer = { name: "Vita Sackville-West", username: "vita" };

const RECEIPT_BASE = {
  settlementId: "00000000-0000-0000-0000-000000000001",
  settledAt: "2026-09-20T10:00:00.000Z",
  triggerType: "threshold",
  reversedAt: null,
  items: [
    { kind: "read" as const, description: "The Edwardians", writerName: "Vita Sackville-West", writerUsername: "vita", pricePence: 300, link: null, at: "2026-09-18T09:00:00.000Z" },
    { kind: "read" as const, description: "A Room of One's Own", writerName: "Virginia Woolf", writerUsername: "virginia", pricePence: 0, link: null, at: "2026-09-19T09:00:00.000Z" },
    { kind: "subscription" as const, description: "Subscription — September", writerName: "Virginia Woolf", writerUsername: "virginia", pricePence: 500, link: null, at: "2026-09-19T09:00:00.000Z" },
  ],
};

export const CATALOGUE: CatalogueEntry[] = [
  // --- auth ---
  {
    id: "magic-link", family: "auth", template: auth.magicLinkEmail,
    when: "Anyone asking to log in (POST /auth/magic-link).",
    render: () => auth.magicLinkEmail({ verifyUrl: siteUrl("/auth/verify?token=SAMPLE"), expiresInMinutes: 15 }),
  },
  {
    id: "email-change", family: "auth", template: auth.emailChangeVerificationEmail,
    when: "The NEW address, when a member changes their email.",
    render: () => auth.emailChangeVerificationEmail({ verifyUrl: siteUrl("/auth/verify?emailChange=SAMPLE") }),
  },
  {
    id: "email-changed-notice", family: "auth", template: auth.emailChangedNoticeEmail,
    when: "The OLD address, when an email change is confirmed (POST /auth/verify-email-change).",
    render: () => auth.emailChangedNoticeEmail({
      newEmailMasked: "r***@example.com",
      changedAt: new Date("2026-10-02T14:05:00Z"),
      undoUrl: siteUrl("/auth/undo-email-change?change=SAMPLE&token=SAMPLE"),
      holdDays: 7,
    }),
  },
  {
    id: "key-export-step-up", family: "auth", template: auth.keyExportStepUpEmail,
    when: "A member asking to export their account (incl. Nostr secret key).",
    render: () => auth.keyExportStepUpEmail({ confirmUrl: siteUrl("/account/export?token=SAMPLE"), expiresInMinutes: 15 }),
  },
  {
    id: "key-export-notice", family: "auth", template: auth.keyExportNoticeEmail,
    when: "The member, after every completed export.",
    render: () => auth.keyExportNoticeEmail({ exportedAt: new Date("2026-09-27T14:05:00Z") }),
  },

  // --- waitlist ---
  {
    id: "waitlist-invite", family: "waitlist", template: waitlist.waitlistInviteEmail,
    when: "A waitlisted person, when the operator admits them.",
    render: () => waitlist.waitlistInviteEmail({ to: "reader@example.com", loginUrl: siteUrl("/auth") }),
  },
  {
    id: "waitlist-digest", family: "waitlist", template: waitlist.waitlistDigestEmail,
    when: "The operator (admin accounts), at most once per digest interval.",
    render: () => waitlist.waitlistDigestEmail({
      joiners: [
        { email: "one@example.com", joinedAt: new Date("2026-09-26T08:55:00Z") },
        { email: "two@example.com", joinedAt: new Date("2026-09-26T11:20:00Z") },
      ],
      total: 41,
    }),
  },
  {
    id: "waitlist-digest-with-applications", family: "waitlist", template: waitlist.waitlistDigestEmail,
    when: "The same digest, when members have also asked to write since the last one.",
    render: () => waitlist.waitlistDigestEmail({
      joiners: [{ email: "one@example.com", joinedAt: new Date("2026-09-26T08:55:00Z") }],
      total: 41,
      applicants: [
        { username: "vita", displayName: "Vita Sackville-West", appliedAt: new Date("2026-09-26T09:30:00Z") },
        { username: null, displayName: null, appliedAt: new Date("2026-09-26T10:05:00Z") },
      ],
      pendingApplications: 3,
    }),
  },
  {
    id: "writer-access-granted", family: "waitlist", template: waitlist.writerAccessGrantedEmail,
    when: "A member, when the operator grants them writer access.",
    render: () => waitlist.writerAccessGrantedEmail({ writeUrl: siteUrl("/write") }),
  },

  // --- subscriptions ---
  {
    id: "subscription-renewed", family: "subscriptions", template: subscriptions.subscriptionRenewedEmail,
    when: "The reader, after an auto-renewal.",
    render: () => subscriptions.subscriptionRenewedEmail({ writer, pricePence: 500, nextPeriodEnd: new Date("2026-10-27T00:00:00Z") }),
  },
  {
    id: "subscription-cancelled", family: "subscriptions", template: subscriptions.subscriptionCancelledEmail,
    when: "The reader, after they cancel.",
    render: () => subscriptions.subscriptionCancelledEmail({ writer, accessUntil: new Date("2026-10-27T00:00:00Z") }),
  },
  {
    id: "subscription-expiry-warning", family: "subscriptions", template: subscriptions.subscriptionExpiryWarningEmail,
    when: "The reader, 3 days before a non-renewing subscription ends.",
    render: () => subscriptions.subscriptionExpiryWarningEmail({ writer, expiresAt: new Date("2026-09-30T00:00:00Z") }),
  },
  {
    id: "subscription-lapsed-not-for-sale", family: "subscriptions", template: subscriptions.subscriptionLapsedNotForSaleEmail,
    when: "The reader, when a renewal is skipped because the writer's paid access is withdrawn.",
    render: () => subscriptions.subscriptionLapsedNotForSaleEmail({ writer }),
  },
  {
    id: "new-subscriber", family: "subscriptions", template: subscriptions.newSubscriberEmail,
    when: "The writer, when somebody subscribes.",
    render: () => subscriptions.newSubscriberEmail({ readerName: "Leonard Woolf", pricePence: 500 }),
  },
  {
    id: "subscription-welcome-default", family: "subscriptions", template: subscriptions.subscriptionWelcomeEmail,
    when: "The reader, on subscribing — writer has set no message.",
    render: () => subscriptions.subscriptionWelcomeEmail({ writer, message: null }),
  },
  {
    id: "subscription-welcome-custom", family: "subscriptions", template: subscriptions.subscriptionWelcomeEmail,
    when: "The reader, on subscribing — in the writer's own words.",
    render: () => subscriptions.subscriptionWelcomeEmail({
      writer,
      message: "Thank you — truly.\n\nI publish every other Tuesday. Things to start with:\n- The Edwardians\n- Portrait of a Marriage",
    }),
  },

  // --- publish ---
  {
    id: "publish-notification", family: "publish", template: publish.publishNotificationEmail,
    when: "Each subscriber who has publish emails on, when a writer publishes (broadcast stream).",
    render: () => publish.publishNotificationEmail({
      writerName: "Vita Sackville-West",
      writerAvatarUrl: null,
      title: "The Edwardians",
      summary: "On the last summer of a vanished world, and the house that outlived it.",
      contentFree: null,
      articleUrl: siteUrl("/article/the-edwardians"),
      unsubscribeUrl: siteUrl("/api/v1/email/unsubscribe?SAMPLE"),
    }),
  },

  // --- receipt ---
  {
    id: "receipt", family: "receipt", template: receipt.settlementReceiptEmail,
    when: "The reader, when a card charge is CONFIRMED (payment_intent.succeeded).",
    render: () => receipt.settlementReceiptEmail({ receipt: { ...RECEIPT_BASE, amountPence: 800, itemisedPence: 800, unitemisedPence: 0 } }),
  },
  {
    id: "receipt-carried-gap", family: "receipt", template: receipt.settlementReceiptEmail,
    when: "As above, where the charge carried earlier balance (positive gap).",
    render: () => receipt.settlementReceiptEmail({ receipt: { ...RECEIPT_BASE, amountPence: 1300, itemisedPence: 800, unitemisedPence: 500 } }),
  },
  {
    id: "receipt-uncovered-gap", family: "receipt", template: receipt.settlementReceiptEmail,
    when: "As above, where itemised reading exceeds the charge (negative gap).",
    render: () => receipt.settlementReceiptEmail({ receipt: { ...RECEIPT_BASE, amountPence: 700, itemisedPence: 800, unitemisedPence: -100 } }),
  },

  // --- notices ---
  {
    id: "chargeback", family: "notices", template: notices.chargebackNoticeEmail,
    when: "Each writer whose earnings a chargeback reversed.",
    render: () => notices.chargebackNoticeEmail({ displayName: "Vita", amountPence: 276, titles: ["The Edwardians", "The Lighthouse Keepers"] }),
  },
  ...notices.MODERATION_NOTICE_KINDS.map((kind): CatalogueEntry => ({
    id: `moderation-${kind}`, family: "notices", template: notices.moderationNoticeEmail,
    when: `The member, on a moderation decision (${kind}).`,
    render: () => notices.moderationNoticeEmail({
      displayName: "Vita",
      kind,
      reason: "Repeatedly posting work that is not yours.",
      appealUrl: siteUrl("/appeal/SAMPLE?token=SAMPLE"),
      appealDeadline: new Date("2026-10-27T00:00:00Z"),
    }),
  })),
  {
    id: "moderation-no-appeal-link", family: "notices", template: notices.moderationNoticeEmail,
    when: "As above, when no appeal token could be minted (falls back to the mailbox).",
    render: () => notices.moderationNoticeEmail({ displayName: "Vita", kind: "account_suspended", reason: "Spam." }),
  },
  {
    id: "unpayable-withdrawal", family: "notices", template: notices.unpayableWithdrawalNoticeEmail,
    when: "A writer we have been unable to pay, before paid access is withdrawn (Writer 9.3).",
    render: () => notices.unpayableWithdrawalNoticeEmail({ displayName: "Vita", noticeDays: 30 }),
  },

  // --- tributes (suspended) ---
  {
    id: "tribute-offer", family: "tributes", template: tributes.tributeOfferEmail,
    when: "An inspirer who is not a member, when an author offers a tribute. SUSPENDED.",
    render: () => tributes.tributeOfferEmail({
      authorName: "Vita Sackville-West", articleTitle: "The Edwardians", percent: "10",
      note: "Your letters made this.", claimUrl: siteUrl("/tribute/claim?token=SAMPLE"),
    }),
  },
  {
    id: "tribute-author-copy", family: "tributes", template: tributes.tributeAuthorCopyEmail,
    when: "The author, as a record of the offer (no claim link). SUSPENDED.",
    render: () => tributes.tributeAuthorCopyEmail({ inviteEmail: "virginia@example.com", articleTitle: "The Edwardians", percent: "10" }),
  },
  {
    id: "tribute-reminder", family: "tributes", template: tributes.tributeReminderEmail,
    when: "The inspirer, if the offer is still unclaimed. SUSPENDED.",
    render: () => tributes.tributeReminderEmail({
      authorName: "Vita Sackville-West", articleTitle: "The Edwardians", percent: "10",
      claimUrl: siteUrl("/tribute/claim?token=SAMPLE"),
    }),
  },

  // --- gateway pages ---
  {
    id: "unsubscribe-page-confirm", family: "pages", template: pages.unsubscribePage, page: true,
    when: "The page an unsubscribe link opens (GET) — asks before it acts.",
    render: () => pages.unsubscribePage({
      kind: "confirm",
      targetName: "Vita Sackville-West",
      actionUrl: siteUrl("/api/v1/email/unsubscribe?SAMPLE"),
    }),
  },
  ...(["done", "rate_limited", "missing_params", "unknown_type", "bad_token", "failed"] as const).map(
    (kind): CatalogueEntry => ({
      id: `unsubscribe-page-${kind}`, family: "pages", template: pages.unsubscribePage, page: true,
      when: `The page an unsubscribe link opens (${kind}).`,
      render: () => pages.unsubscribePage(kind === "done" ? { kind, targetName: "Vita Sackville-West" } : { kind }),
    }),
  ),
];
