import { pool } from "@platform-pub/shared/db/client.js";
import { formatMomentUtc } from "@platform-pub/shared/lib/email/format.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "./platform-config.js";

// =============================================================================
// The hold an email change puts on the key export (migration 273).
//
// Login is by email, and the export's step-up is mailed to whatever address the
// account holds when it is asked for. So an email change is the one act that
// moves the export's confirmation channel, and a stolen session that makes one
// would otherwise confirm its own export minutes later. The Nostr key cannot be
// rotated, so the old address's undo link (POST /auth/undo-email-change) is only
// worth something if it lands BEFORE the key leaves. The hold is what keeps that
// ordering: for this many days after a change nobody has undone, the export
// waits.
//
// A DELAY, NEVER A REFUSAL. The export is the member's own right, so the hold
// always ends on a date and says which. An undone change lifts it, because the
// undo is the real owner coming back.
//
// The same length is the undo link's lifetime: the link is good for exactly as
// long as there is still something it can protect.
// =============================================================================

export const EMAIL_CHANGE_EXPORT_HOLD_DAYS_FALLBACK = 7;

// Whole string, digits only: `Number("")` is 0, and 0 is the value that turns
// the hold OFF, so a blanked row must fall back rather than parse.
let warnedMalformed = false;
export async function emailChangeExportHoldDays(): Promise<number> {
  const raw = (await getPlatformConfig()).get("email_change_export_hold_days");
  if (raw !== undefined && /^\d+$/.test(raw)) return Number(raw);
  if (raw !== undefined && !warnedMalformed) {
    warnedMalformed = true;
    logger.warn(
      { key: "email_change_export_hold_days", value: raw },
      "Malformed dial; using the in-code fallback",
    );
  }
  return EMAIL_CHANGE_EXPORT_HOLD_DAYS_FALLBACK;
}

export interface ExportHold {
  changedAt: Date;
  opensAt: Date;
}

/** The hold in force on this account's export, or null when there is none. */
export async function exportHold(accountId: string): Promise<ExportHold | null> {
  const days = await emailChangeExportHoldDays();
  if (days === 0) return null;
  const { rows } = await pool.query<{ changed_at: Date }>(
    `SELECT max(changed_at) AS changed_at
       FROM account_email_changes
      WHERE account_id = $1
        AND undone_at IS NULL
        AND changed_at > now() - make_interval(days => $2)`,
    [accountId, days],
  );
  const changedAt = rows[0]?.changed_at;
  if (!changedAt) return null;
  return {
    changedAt,
    opensAt: new Date(changedAt.getTime() + days * 24 * 60 * 60 * 1000),
  };
}

/** The refusal body both export routes send while a hold is in force. */
export function exportHeldBody(hold: ExportHold) {
  return {
    error: "export_held",
    message:
      `Your sign-in email changed on ${formatMomentUtc(hold.changedAt)}, so exporting your account is paused until ${formatMomentUtc(hold.opensAt)}. ` +
      "That gives your old address time to undo a change it didn't make.",
    opensAt: hold.opensAt.toISOString(),
  };
}
