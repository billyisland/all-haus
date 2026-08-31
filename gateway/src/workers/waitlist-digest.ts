import { pool } from "@platform-pub/shared/db/client.js";
import { sendEmail } from "@platform-pub/shared/lib/email.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getAdminIds } from "../middleware/admin.js";

// =============================================================================
// Waitlist operator digest — CLOSED-BETA-ADR §XI, D8.2. Runs hourly from
// gateway/index.ts under ADVISORY_LOCKS.WAITLIST_DIGEST; sends at most one
// message a day, and only when the list has actually moved.
//
// WHY THIS EXISTS. `POST /waitlist` stores a prospect and sends nothing (D2 —
// capture, not a mailto), and until the panel is built (§XI.2) nothing reads
// the table. On 2026-07-27 that combination meant a real prospect sat unseen
// for eight hours and was found only because the operator went looking for a
// missing confirmation email. This closes that: the count moves, you hear
// about it. It is the smallest possible fix for the actual failure, which is
// why §XI.3 puts it first — ahead of the joiner's acknowledgement, which is
// more visible and less urgent.
//
// TWO KEYS, BECAUSE THEY ARE TWO FACTS. `waitlist_digest_watermark` is
// "everything created at or before this instant has been reported" and holds a
// ROW's `created_at`; `waitlist_digest_last_sent_at` is when a digest actually
// went out and holds a CLOCK reading. The window is asked of the first, the
// cadence of the second, and they are never swapped. One key doing both was
// the first cut of this worker, and it drifted: on a quiet list the watermark
// is soon older than the interval, so every tick reads as due — harmless while
// nothing is new, wrong the moment something is (a digest at 10:00 whose
// newest row was from 02:00 would fire again at 02:00 the next day, not 10:00).
// The unit tests all passed; a run against a real database is what showed it.
//
// The watermark advances to the newest REPORTED row's `created_at` — not to
// `now()`, which would silently swallow anything that arrived between the
// SELECT and the write. Two consequences worth keeping:
//
//   · Nothing to report → NEITHER key moves. The window stays open and keeps
//     widening, so a join can never fall between two digests.
//   · The send failed → neither key moves either, so the next run retries the
//     same rows rather than dropping a day's joins on one bad minute at
//     Postmark. That is D7's rule applied here: mail is the courtesy, the row
//     is the product.
//
// Both are runtime STATE, so both are deliberately absent from
// config-defaults.sql (the same posture as `payouts_halted`) — absence means
// "never sent", which is the correct cold-start reading. The cadence beside them
// (`waitlist_digest_interval_hours`) IS a dial and IS in the defaults file.
// Both are written by upsert, never a bare UPDATE, which against an absent key
// matches zero rows and reports success — the way `jetstream_healthy` once
// silently never persisted.
//
// THE MESSAGE CARRIES ADDRESSES, NOT JUST A COUNT — a count alone would not
// tell the operator WHO is waiting, which is the whole reason the digest
// exists. That choice, its data-protection basis and the conditions under
// which it would be narrowed are recorded in
// docs/adr/WAITLIST-PRIVACY-NOTE.md (docs/ deliberately does not ship to the
// public mirror, which is why the reasoning lives there and not here). If it
// is ever narrowed, the change is local: drop the address list from the body
// and keep the counts — nothing else in this worker moves.
// =============================================================================

const DEFAULT_INTERVAL_HOURS = 24;
/** Reported-up-to: the newest row any digest has carried. Window start. */
const WATERMARK_KEY = "waitlist_digest_watermark";
/** When a digest last actually went out. Cadence only. */
const LAST_SENT_KEY = "waitlist_digest_last_sent_at";

interface WaitlistRow {
  email: string;
  created_at: Date;
  /** The same instant as Postgres renders it, MICROSECONDS INTACT. The
   *  watermark is stored from this, never from `created_at` — see below. */
  created_at_exact: string;
}

/** `27 Jul, 08:55 UTC` — absolute, because an operator picking a cohort wants
 *  the date, not "8h ago" (the same reasoning as the panel's column, §XI.2). */
function stamp(d: Date): string {
  return (
    d.toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC"
  );
}

function renderText(rows: WaitlistRow[], total: number): string {
  const lines = rows.map(
    (r) => `  ${r.email}\n    joined ${stamp(r.created_at)}`,
  );
  return [
    `${rows.length} new ${rows.length === 1 ? "person" : "people"} on the all.haus waiting list.`,
    "",
    ...lines,
    "",
    `The list now holds ${total} in total.`,
    "",
    "Nothing has been sent to them — the waiting list stores interest and does",
    "not write back (CLOSED-BETA-ADR D2). Admitting someone is still manual.",
  ].join("\n");
}

function renderHtml(rows: WaitlistRow[], total: number): string {
  const items = rows
    .map(
      (r) =>
        `<li style="margin-bottom:10px;">` +
        `<span style="font-weight:500;">${escapeHtml(r.email)}</span>` +
        `<br><span style="color:#57534e;font-size:13px;">joined ${escapeHtml(stamp(r.created_at))}</span>` +
        `</li>`,
    )
    .join("");
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
      <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
        ${rows.length} new on the waiting list
      </h2>
      <ul style="font-size: 15px; color: #1c1917; line-height: 1.5; padding-left: 18px;">${items}</ul>
      <p style="font-size: 14px; color: #57534e; line-height: 1.6;">
        The list now holds ${total} in total.
      </p>
      <p style="font-size: 13px; color: #78716c; line-height: 1.6;">
        Nothing has been sent to them &mdash; the waiting list stores interest
        and does not write back. Admitting someone is still manual.
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Returns the number of new waitlist rows reported (0 when not due, when
 * nothing is new, when there is nobody to tell, or when the send failed).
 * Never throws: a digest is a courtesy and must not take a worker tick down.
 */
export async function sendWaitlistDigest(): Promise<number> {
  try {
    const { rows: cfg } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_config
        WHERE key IN ($1, $2, 'waitlist_digest_interval_hours')`,
      [WATERMARK_KEY, LAST_SENT_KEY],
    );
    const config = new Map(cfg.map((r) => [r.key, r.value]));

    const intervalHours =
      Math.max(
        1,
        parseInt(
          config.get("waitlist_digest_interval_hours") ??
            String(DEFAULT_INTERVAL_HOURS),
          10,
        ) || DEFAULT_INTERVAL_HOURS,
      ) || DEFAULT_INTERVAL_HOURS;

    const parseStamp = (raw: string | undefined): Date | null => {
      if (!raw) return null;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    // The watermark is carried as TEXT, never re-serialised through a Date
    // (that is what loses the microseconds). It is only parsed to check it is
    // a date at all; the string itself is what goes back to Postgres.
    const watermarkRaw = config.get(WATERMARK_KEY);
    const watermark = parseStamp(watermarkRaw) ? watermarkRaw : undefined;
    const lastSent = parseStamp(config.get(LAST_SENT_KEY));

    // DUE is asked of the CLOCK, never of the watermark. They are different
    // facts and conflating them was a real bug, caught by running this against
    // a real database rather than by the unit tests: the watermark holds a
    // ROW's timestamp, so on a quiet list it is soon older than the interval
    // and every tick reads as due. Harmless there (nothing new, so nothing
    // sends) but wrong the moment the list moves — a digest at 10:00 whose
    // newest row was created at 02:00 would go again at 02:00 the next day,
    // fourteen hours later, not twenty-four. A null last-sent means never sent.
    const now = Date.now();
    if (lastSent && now - lastSent.getTime() < intervalHours * 3600_000) {
      return 0;
    }

    // WINDOW is asked of the watermark, never of the clock — INCLUDING on cold
    // start. Absent (first ever run) the window opens at epoch: everything
    // never reported IS the report. The first cut instead took "the interval's
    // worth of history" (now − 24h), reasoning a cold start should be a digest
    // and not a dump of the whole table — but a clock-relative window quietly
    // breaks the guarantee two comments up: any join older than the interval at
    // first-run time falls OUTSIDE it, is never reported, and the watermark it
    // would have set never lands, so it stays unreported forever. That is not
    // hypothetical: the deploy that shipped this worker landed >24h after the
    // three 2026-07-27 joins it was written for, the first run reported
    // nothing, and the check "the first thing that happens should be an email
    // naming them" silently evaluated to no email at all. A whole-table first
    // digest at operator scale is the correct behaviour, and it happens once.
    const since = watermark ?? new Date(0).toISOString();

    // `$1::timestamptz` and `created_at::text`, both deliberate: Postgres keeps
    // MICROSECONDS and a JS Date keeps milliseconds, so a watermark that has
    // been through `Date.toISOString()` lands up to 999µs BEFORE the row it was
    // taken from — and that row then satisfies `created_at > watermark` again on
    // the next run. Every digest would re-report its own newest joiner, forever.
    // Round-tripping the value as Postgres's own text keeps the comparison exact.
    // (Found by driving this against a real database; the unit tests could not
    // see it, because a mocked JS Date has no microseconds to lose.)
    const { rows } = await pool.query<WaitlistRow>(
      `SELECT email, created_at, created_at::text AS created_at_exact
         FROM waitlist
        WHERE created_at > $1::timestamptz
        ORDER BY created_at DESC`,
      [since],
    );
    if (rows.length === 0) return 0; // neither key advances: nothing was reported

    // A count and the addresses, and nothing else. The digest used to break the
    // total down by who had ticked "I'd also like to publish"; that question is
    // gone from the page (2026-07-27) and the reporting went with it — keeping
    // the breakdown would have been the same signal-gathering, one remove away.
    const { rows: totals } = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM waitlist`,
    );
    const total = Number(totals[0]?.total ?? rows.length);

    // Recipients are the admin accounts — the same set `requireAdmin` gates the
    // dashboard on, resolved through its one home. An admin with no email on
    // the account (dev seeds have none) simply isn't a recipient.
    const adminIds = await getAdminIds();
    if (adminIds.length === 0) {
      logger.warn(
        { newRows: rows.length },
        "Waitlist digest: no admin_account_ids configured — nobody to notify",
      );
      return 0;
    }
    const { rows: recipients } = await pool.query<{ email: string }>(
      `SELECT email FROM accounts WHERE id = ANY($1::uuid[]) AND email IS NOT NULL`,
      [adminIds],
    );
    if (recipients.length === 0) {
      logger.warn(
        { adminIds: adminIds.length, newRows: rows.length },
        "Waitlist digest: admin accounts have no email address — nobody to notify",
      );
      return 0;
    }

    const subject = `all.haus waiting list — ${rows.length} new`;
    const textBody = renderText(rows, total);
    const htmlBody = renderHtml(rows, total);

    for (const r of recipients) {
      await sendEmail({ to: r.email, subject, textBody, htmlBody });
    }

    // Both facts move, and only after the send. The watermark goes to the
    // newest row we actually REPORTED — never to now(), which would swallow
    // anything that arrived mid-run. Upsert both, because on the first ever
    // send neither key exists and an UPDATE would match nothing and quietly
    // claim success (how `jetstream_healthy` never persisted).
    const newest = rows[0].created_at_exact;
    await pool.query(
      `INSERT INTO platform_config (key, value, description) VALUES
         ($1, $2, 'Runtime state: newest waitlist row carried by a digest (CLOSED-BETA-ADR §XI). Absent = none ever reported.'),
         ($3, $4, 'Runtime state: when the waitlist digest last went out (CLOSED-BETA-ADR §XI). Absent = never sent.')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        WATERMARK_KEY,
        newest,
        LAST_SENT_KEY,
        new Date(now).toISOString(),
      ],
    );

    logger.info(
      { newRows: rows.length, recipients: recipients.length, total },
      "Waitlist digest sent",
    );
    return rows.length;
  } catch (err) {
    // Including a send failure: the marker has not moved, so the next run
    // retries the same rows. Nothing here is worth taking the tick down for.
    logger.error({ err }, "Waitlist digest failed");
    return 0;
  }
}
