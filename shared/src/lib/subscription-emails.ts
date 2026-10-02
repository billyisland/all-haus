import { sendEmail } from "./email.js";
import { pool } from "../db/client.js";
import { renderEmail } from "./email/layout.js";
import {
  newSubscriberEmail,
  subscriptionCancelledEmail,
  subscriptionExpiryWarningEmail,
  subscriptionLapsedNotForSaleEmail,
  subscriptionRenewedEmail,
  subscriptionWelcomeEmail,
} from "./email/templates/subscriptions.js";

// =============================================================================
// Subscription emails — WHO is told and WHEN. What they are told is
// `./email/templates/subscriptions.ts`.
// =============================================================================

// ---------------------------------------------------------------------------
// Helper: look up email + display name for an account
// ---------------------------------------------------------------------------

async function getAccountInfo(
  accountId: string,
): Promise<{ email: string; name: string; username: string } | null> {
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
    name: rows[0].display_name ?? rows[0].username,
    username: rows[0].username,
  };
}

export async function sendSubscriptionRenewedEmail(
  readerId: string,
  writerId: string,
  pricePence: number,
  nextPeriodEnd: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;
  await sendEmail({
    to: reader.email,
    ...renderEmail(subscriptionRenewedEmail({ writer, pricePence, nextPeriodEnd })),
  });
}

export async function sendSubscriptionCancelledEmail(
  readerId: string,
  writerId: string,
  accessUntil: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;
  await sendEmail({
    to: reader.email,
    ...renderEmail(subscriptionCancelledEmail({ writer, accessUntil })),
  });
}

/** Sent 3 days before period end for non-auto-renewing subscriptions. */
export async function sendSubscriptionExpiryWarningEmail(
  readerId: string,
  writerId: string,
  expiresAt: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;
  await sendEmail({
    to: reader.email,
    ...renderEmail(subscriptionExpiryWarningEmail({ writer, expiresAt })),
  });
}

/** Sent to the READER at the renewal that did not happen because the writer's
 *  paid access is withdrawn (Writer 9.3; §0z item 10). */
export async function sendSubscriptionLapsedNotForSaleEmail(
  readerId: string,
  writerId: string,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;
  await sendEmail({
    to: reader.email,
    ...renderEmail(subscriptionLapsedNotForSaleEmail({ writer })),
  });
}

/** Sent to the WRITER when someone subscribes. */
export async function sendNewSubscriberEmail(
  writerId: string,
  readerId: string,
  pricePence: number,
): Promise<void> {
  const writer = await getAccountInfo(writerId);
  const reader = await getAccountInfo(readerId);
  if (!writer || !reader) return;
  await sendEmail({
    to: writer.email,
    ...renderEmail(newSubscriberEmail({ readerName: reader.name, pricePence })),
  });
}

/**
 * Sent to the READER on subscribing, in the writer's own words — the other
 * half of `sendNewSubscriberEmail`. The message is the writer's plain text
 * (migration 180); a writer who has set nothing gets the template's default.
 */
export async function sendSubscriptionWelcomeEmail(
  readerId: string,
  writerId: string,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  if (!reader) return;

  // One query, and it is the writer's row that carries the message — so a
  // caller never has to fetch it and can never pass a stale one.
  const { rows } = await pool.query<{
    email: string | null;
    display_name: string | null;
    username: string;
    subscription_welcome_message: string | null;
  }>(
    `SELECT email, display_name, username, subscription_welcome_message
       FROM accounts WHERE id = $1`,
    [writerId],
  );
  if (rows.length === 0) return;
  const w = rows[0];

  // Empty string is a writer who cleared the box; today it reads the same as
  // never having set one. Migration 180 keeps the two distinct in the column so
  // a later "send nothing" opt-out has somewhere to live.
  await sendEmail({
    to: reader.email,
    ...renderEmail(
      subscriptionWelcomeEmail({
        writer: { name: w.display_name ?? w.username, username: w.username },
        message: w.subscription_welcome_message,
      }),
    ),
  });
}
