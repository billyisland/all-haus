import { createHmac, timingSafeEqual } from "crypto";
import { emailHtml, paragraph, button } from "./subscription-emails.js";
import { escapeHtml } from "./text.js";

// =============================================================================
// Publish Email Template + Unsubscribe Token Helpers
//
// Used by publish-emails.ts to build the improved publish notification email
// and by the unsubscribe endpoint to verify signed tokens.
// =============================================================================

const APP_URL = process.env.APP_URL ?? "http://localhost:3010";

// ---------------------------------------------------------------------------
// Signed unsubscribe tokens
// ---------------------------------------------------------------------------

type TargetType = "subscription" | "follow" | "publication_follow";

export function generateUnsubscribeToken(
  accountId: string,
  targetId: string,
  targetType: TargetType,
  secret: string,
): string {
  const payload = `${accountId}:${targetId}:${targetType}`;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyUnsubscribeToken(
  token: string,
  accountId: string,
  targetId: string,
  targetType: TargetType,
  secret: string,
): boolean {
  const expected = generateUnsubscribeToken(
    accountId,
    targetId,
    targetType,
    secret,
  );
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export function buildUnsubscribeUrl(
  accountId: string,
  targetId: string,
  targetType: TargetType,
  secret: string,
): string {
  const token = generateUnsubscribeToken(
    accountId,
    targetId,
    targetType,
    secret,
  );
  const params = new URLSearchParams({
    aid: accountId,
    tid: targetId,
    type: targetType,
    token,
  });
  return `${APP_URL}/api/v1/email/unsubscribe?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Email template
// ---------------------------------------------------------------------------

function truncateToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}

interface PublishEmailParams {
  writerName: string;
  writerAvatarUrl: string | null;
  title: string;
  summary: string | null;
  contentFree: string | null;
  articleUrl: string;
  unsubscribeUrl: string;
}

export function publishEmailSubject(writerName: string, title: string): string {
  return `${writerName}: ${title}`;
}

export function publishEmailText(params: PublishEmailParams): string {
  const excerpt =
    params.summary || truncateToWords(params.contentFree ?? "", 40);
  return [
    `${params.writerName}: ${params.title}`,
    "",
    excerpt,
    "",
    `Read on all.haus: ${params.articleUrl}`,
    "",
    `You follow ${params.writerName} on all.haus.`,
    `Unsubscribe: ${params.unsubscribeUrl}`,
    "",
    "all.haus — writing worth reading",
  ].join("\n");
}

export function publishEmailBody(params: PublishEmailParams): string {
  const safeWriter = escapeHtml(params.writerName);
  const safeTitle = escapeHtml(params.title);
  const excerpt = escapeHtml(
    params.summary || truncateToWords(params.contentFree ?? "", 40),
  );

  const avatarBlock = params.writerAvatarUrl
    ? `<img src="${escapeHtml(params.writerAvatarUrl)}" alt="" width="40" height="40" style="border-radius: 50%; vertical-align: middle; margin-right: 10px;" />`
    : "";

  const header =
    `<div style="margin-bottom: 20px;">` +
    avatarBlock +
    `<strong style="font-size: 15px; color: #1c1917; vertical-align: middle;">${safeWriter}</strong>` +
    `</div>`;

  const titleBlock = `<h3 style="font-size: 18px; color: #1c1917; margin: 0 0 12px 0;">${safeTitle}</h3>`;

  const excerptBlock = excerpt
    ? paragraph(`<span style="color: #78716c;">${excerpt}</span>`)
    : "";

  const footer =
    `<p style="font-size: 12px; color: #a8a29e; margin-top: 28px; line-height: 1.5;">` +
    `You follow ${safeWriter} on all.haus.<br />` +
    `<a href="${escapeHtml(params.unsubscribeUrl)}" style="color: #a8a29e; text-decoration: underline;">Unsubscribe from these emails</a>` +
    `</p>`;

  return emailHtml(
    `${safeWriter}`,
    header +
      titleBlock +
      excerptBlock +
      button(params.articleUrl, "Read on all.haus") +
      footer,
  );
}
