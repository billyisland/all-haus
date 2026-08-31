import { sendEmail } from "./email.js";
import { pool } from "../db/client.js";
import { escapeHtml } from "./text.js";

// =============================================================================
// Subscription Email Templates
//
// All subscription lifecycle emails: renewal, cancellation, expiry warning,
// and new subscriber notification to writer.
// =============================================================================

const APP_URL = process.env.APP_URL ?? "http://localhost:3010";

// Shared email wrapper — exported for unit testing
export function emailHtml(heading: string, body: string): string {
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
      <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
        ${heading}
      </h2>
      ${body}
      <p style="font-size: 12px; color: #d6d3d1; margin-top: 32px;">
        all.haus — writing worth reading
      </p>
    </div>
  `.trim();
}

export function paragraph(text: string): string {
  return `<p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 16px;">${text}</p>`;
}

export function button(href: string, label: string): string {
  return `<a href="${href}" style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; border-radius: 6px; text-decoration: none; margin-bottom: 16px;">${label}</a>`;
}

export function formatPounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Helper: look up email + display name for an account
// ---------------------------------------------------------------------------

async function getAccountInfo(
  accountId: string,
): Promise<{ email: string; displayName: string; username: string } | null> {
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
    username: rows[0].username,
  };
}

// ---------------------------------------------------------------------------
// Renewal confirmation — sent to reader after auto-renewal
// ---------------------------------------------------------------------------

export async function sendSubscriptionRenewedEmail(
  readerId: string,
  writerId: string,
  pricePence: number,
  nextPeriodEnd: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;

  const writerName = writer.displayName;

  await sendEmail({
    to: reader.email,
    subject: `Your subscription to ${writerName} renewed`,
    textBody: [
      `Your subscription to ${writerName} has renewed.`,
      `${formatPounds(pricePence)} has been added to your reading tab.`,
      `Next renewal: ${formatDate(nextPeriodEnd)}.`,
      "",
      `Manage your subscriptions: ${APP_URL}/account`,
    ].join("\n"),
    htmlBody: emailHtml(
      "Subscription renewed",
      paragraph(
        `Your subscription to <strong>${escapeHtml(writerName)}</strong> has renewed. ${formatPounds(pricePence)} has been added to your reading tab.`,
      ) +
        paragraph(`Next renewal: ${formatDate(nextPeriodEnd)}.`) +
        button(`${APP_URL}/account`, "Manage subscriptions"),
    ),
  });
}

// ---------------------------------------------------------------------------
// Cancellation confirmation — sent to reader after they cancel
// ---------------------------------------------------------------------------

export async function sendSubscriptionCancelledEmail(
  readerId: string,
  writerId: string,
  accessUntil: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;

  const writerName = writer.displayName;

  await sendEmail({
    to: reader.email,
    subject: `Subscription to ${writerName} cancelled`,
    textBody: [
      `You've cancelled your subscription to ${writerName}.`,
      `You'll have access until ${formatDate(accessUntil)}.`,
      "",
      `You can resubscribe anytime from their profile: ${APP_URL}/${writer.username}`,
    ].join("\n"),
    htmlBody: emailHtml(
      "Subscription cancelled",
      paragraph(
        `You've cancelled your subscription to <strong>${escapeHtml(writerName)}</strong>.`,
      ) +
        paragraph(
          `You'll still have access until <strong>${formatDate(accessUntil)}</strong>. Articles you've already read remain permanently unlocked.`,
        ) +
        button(`${APP_URL}/${writer.username}`, "Resubscribe"),
    ),
  });
}

// ---------------------------------------------------------------------------
// Expiry warning — sent 3 days before period end for non-auto-renewing subs
// ---------------------------------------------------------------------------

export async function sendSubscriptionExpiryWarningEmail(
  readerId: string,
  writerId: string,
  expiresAt: Date,
): Promise<void> {
  const reader = await getAccountInfo(readerId);
  const writer = await getAccountInfo(writerId);
  if (!reader || !writer) return;

  const writerName = writer.displayName;

  await sendEmail({
    to: reader.email,
    subject: `Your subscription to ${writerName} expires soon`,
    textBody: [
      `Your subscription to ${writerName} expires on ${formatDate(expiresAt)}.`,
      `Resubscribe to keep reading: ${APP_URL}/${writer.username}`,
    ].join("\n"),
    htmlBody: emailHtml(
      "Subscription expiring soon",
      paragraph(
        `Your subscription to <strong>${escapeHtml(writerName)}</strong> expires on <strong>${formatDate(expiresAt)}</strong>.`,
      ) +
        paragraph(
          "Articles you've already read remain permanently unlocked, but you won't be able to read new paywalled content.",
        ) +
        button(`${APP_URL}/${writer.username}`, "Resubscribe"),
    ),
  });
}

// ---------------------------------------------------------------------------
// New subscriber notification — sent to writer when someone subscribes
// ---------------------------------------------------------------------------

export async function sendNewSubscriberEmail(
  writerId: string,
  readerId: string,
  pricePence: number,
): Promise<void> {
  const writer = await getAccountInfo(writerId);
  const reader = await getAccountInfo(readerId);
  if (!writer || !reader) return;

  const readerName = reader.displayName;

  await sendEmail({
    to: writer.email,
    subject: `New subscriber: ${readerName}`,
    textBody: [
      `${readerName} just subscribed to your writing for ${formatPounds(pricePence)}/mo.`,
      "",
      `View your subscribers: ${APP_URL}/dashboard?tab=subscribers`,
    ].join("\n"),
    htmlBody: emailHtml(
      "New subscriber",
      paragraph(
        `<strong>${escapeHtml(readerName)}</strong> just subscribed to your writing for ${formatPounds(pricePence)}/mo.`,
      ) + button(`${APP_URL}/dashboard?tab=subscribers`, "View subscribers"),
    ),
  });
}

// ---------------------------------------------------------------------------
// Welcome — sent to the READER on subscribing, in the writer's own words
//
// The writer's half of the exchange `sendNewSubscriberEmail` above is the
// platform's half of. Subscribing is the one moment a reader has just chosen a
// particular writer and is waiting to hear from them, and until this it was
// silent on the reader's side.
//
// The message is the writer's, so it is PLAIN TEXT and escaped here — never
// stored or sent as markup (migration 180 says why at length). A writer who has
// set nothing gets the default below, which is a real welcome rather than a
// placeholder: NULL means "never set one", not "wants no welcome".
// ---------------------------------------------------------------------------

// Split a writer's plain-text message into paragraphs on blank lines. Escaped
// per paragraph, and single newlines inside one become `<br>` — a writer who
// laid out a list with line breaks must not have it run together into prose.
export function welcomeParagraphs(message: string): string {
  return message
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => paragraph(escapeHtml(para).replace(/\n/g, "<br>")))
    .join("");
}

export function defaultWelcomeText(writerName: string): string {
  return `Thanks for subscribing to ${writerName}. Their new writing will arrive in your inbox, and everything they publish is yours to read.`;
}

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

  const writer = rows[0];
  const writerName = writer.display_name ?? writer.username;
  const profileUrl = `${APP_URL}/${writer.username}`;

  // Empty string is a writer who cleared the box; today it reads the same as
  // never having set one. Migration 180 keeps the two distinct in the column so
  // a later "send nothing" opt-out has somewhere to live.
  const custom = writer.subscription_welcome_message?.trim();
  const body = custom && custom.length > 0 ? custom : defaultWelcomeText(writerName);

  await sendEmail({
    to: reader.email,
    subject: `You're subscribed to ${writerName}`,
    textBody: [
      body,
      "",
      `Read ${writerName}: ${profileUrl}`,
      `Manage your subscriptions: ${APP_URL}/account`,
    ].join("\n"),
    htmlBody: emailHtml(
      `You're subscribed to ${escapeHtml(writerName)}`,
      // `button` interpolates its label raw, so the name is escaped here —
      // a display name reaches this from the writer's own profile field.
      welcomeParagraphs(body) + button(profileUrl, `Read ${escapeHtml(writerName)}`),
    ),
  });
}
