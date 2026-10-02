import { createHmac, timingSafeEqual } from "crypto";
import { requireEnv } from "./env.js";

// =============================================================================
// Unsubscribe tokens for the publish notification email — signed here, checked
// by the unsubscribe route. The email itself is
// `./email/templates/publish.ts`.
// =============================================================================

const appUrl = () => requireEnv("APP_URL");

// ---------------------------------------------------------------------------
// Signed unsubscribe tokens
// ---------------------------------------------------------------------------

// Only a subscription carries `notify_on_publish` (CA-D4 removed the two
// types whose tables never had the column).
type TargetType = "subscription";

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
  return `${appUrl()}/api/v1/email/unsubscribe?${params.toString()}`;
}
