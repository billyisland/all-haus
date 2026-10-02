// =============================================================================
// PRESENCE HEALTH — the one home for "the network refused this credential"
// (CROSS-NETWORK-ROUNDTRIP-ADR C4).
//
// A linked presence whose token the far end no longer accepts must stop being
// used: outbound dispatch targets `is_valid` presences only, Settings shows an
// invalid one as needing a reconnect, and the notification poller stops asking.
// Before rung C the only writers of `is_valid = FALSE` were account deletion,
// the unlink and the atproto token-refresh cron — so a Mastodon token revoked
// on the member's instance was retried on every cross-post and polled for
// ever, each time failing in exactly the same way. The poller, the outbound
// worker and the refresh cron now write it through here.
//
// WHAT COUNTS IS NARROW ON PURPOSE. Invalidating a presence stops every
// cross-post until the member reconnects, so a false positive costs the member
// something they cannot see coming. A refusal is only:
//   • Mastodon 401 — the token is unknown, expired or revoked. NOT 403: a 403
//     is a token that is fine but may not do THIS (a scope the grant lacks,
//     which `requireScope` answers before the call) or an account the
//     instance has disabled, and neither is fixed by reconnecting.
//   • atproto TokenRevokedError / TokenInvalidError — the OAuth client's own
//     verdict that the session is gone. TokenRefreshError is NOT one: it wraps
//     a failed refresh, which a network fault produces as readily as a revoked
//     grant (the refresh cron keeps its own, older classification of it).
// Anything else is ambiguous and leaves the presence alone.
// =============================================================================

import logger from "./logger.js";

/**
 * Prefix of `network_presences.notifications_poll_error` for a token minted
 * before the scopes the notification poller needs were asked for. That is a
 * capability the member's grant lacks, not a failure of the presence, so the
 * dashboard counts it apart from real failures (and Settings already offers
 * the reconnect, off the same stored grant).
 */
export const NOTIFICATIONS_NEEDS_RECONNECT = "needs_reconnect:";

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }>;
}

/** Marked on an error that means "the network no longer accepts this token". */
export interface CredentialRefusal {
  readonly credentialRefused: true;
}

const DEFINITIVE_ATPROTO_SESSION_ERRORS = new Set([
  "TokenRevokedError",
  "TokenInvalidError",
]);

/** Is this error the far end refusing the credential itself? */
export function isCredentialRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { credentialRefused?: unknown }).credentialRefused === true) return true;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && DEFINITIVE_ATPROTO_SESSION_ERRORS.has(name);
}

/**
 * Mark a presence invalid. Idempotent: answers whether THIS call changed it,
 * so a caller that logs or counts does so once per presence, not per attempt.
 */
export async function invalidatePresence(
  db: Queryable,
  presenceId: string,
  reason: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE network_presences
        SET is_valid = FALSE, updated_at = now()
      WHERE id = $1 AND is_valid = TRUE`,
    [presenceId],
  );
  const changed = (res.rowCount ?? 0) > 0;
  if (changed) logger.warn({ presenceId, reason }, "network presence invalidated");
  return changed;
}
