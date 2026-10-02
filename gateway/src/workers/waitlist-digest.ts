import { pool } from "@platform-pub/shared/db/client.js";
import { sendEmail } from "@platform-pub/shared/lib/email.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { renderEmail } from "@platform-pub/shared/lib/email/layout.js";
import { waitlistDigestEmail } from "@platform-pub/shared/lib/email/templates/waitlist.js";
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
// WRITER APPLICATIONS RIDE THE SAME DIGEST (READER-WRITER-SPLIT-ADR §8): one
// more line and one more watermark, never a second digest. The two lists are
// two windows — `writer_applications_digest_watermark` is the applications'
// twin of the waitlist's, with the same rules — and one cadence: a digest goes
// when EITHER has moved, and each watermark advances only if its own rows were
// in the message. An application names the member's handle, which the
// operator judges from; it carries nothing else (O4).
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
/** The applications' twin of WATERMARK_KEY: the newest application reported. */
const APPS_WATERMARK_KEY = "writer_applications_digest_watermark";

interface ApplicationRow {
  username: string | null;
  display_name: string | null;
  created_at: Date;
  created_at_exact: string;
}

interface WaitlistRow {
  email: string;
  created_at: Date;
  /** The same instant as Postgres renders it, MICROSECONDS INTACT. The
   *  watermark is stored from this, never from `created_at` — see below. */
  created_at_exact: string;
}


/**
 * Returns the number of new rows reported — waitlist joins plus writer
 * applications (0 when not due, when
 * nothing is new, when there is nobody to tell, or when the send failed).
 * Never throws: a digest is a courtesy and must not take a worker tick down.
 */
export async function sendWaitlistDigest(): Promise<number> {
  try {
    const { rows: cfg } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_config
        WHERE key IN ($1, $2, $3, 'waitlist_digest_interval_hours')`,
      [WATERMARK_KEY, LAST_SENT_KEY, APPS_WATERMARK_KEY],
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
    const appsWatermarkRaw = config.get(APPS_WATERMARK_KEY);
    const appsWatermark = parseStamp(appsWatermarkRaw) ? appsWatermarkRaw : undefined;
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

    // The applications' window, on the same rules and its own watermark
    // (epoch on cold start, Postgres's own precision). Every application is
    // considered, granted or not, so the watermark is a max over what was
    // looked at; a deleted member's shows as such rather than vanishing.
    const { rows: apps } = await pool.query<ApplicationRow>(
      `SELECT a.username, a.display_name, wa.created_at,
              wa.created_at::text AS created_at_exact
         FROM writer_applications wa
         JOIN accounts a ON a.id = wa.account_id
        WHERE wa.created_at > $1::timestamptz
        ORDER BY wa.created_at DESC`,
      [appsWatermark ?? new Date(0).toISOString()],
    );

    // Neither key advances: nothing was reported.
    if (rows.length === 0 && apps.length === 0) return 0;

    // A count and the addresses, and nothing else. The digest used to break the
    // total down by who had ticked "I'd also like to publish"; that question is
    // gone from the page (2026-07-27) and the reporting went with it — keeping
    // the breakdown would have been the same signal-gathering, one remove away.
    // (Writer applications below are a different thing: a member's own
    // request, made inside, and the operator must act on it.)
    let total = 0;
    if (rows.length > 0) {
      const { rows: totals } = await pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM waitlist`,
      );
      total = Number(totals[0]?.total ?? rows.length);
    }
    let pendingApplications = 0;
    if (apps.length > 0) {
      const { rows: pend } = await pool.query<{ pending: string }>(
        `SELECT count(*) AS pending FROM writer_applications wa
           JOIN accounts a ON a.id = wa.account_id
          WHERE wa.admitted_at IS NULL AND a.status <> 'deleted'`,
      );
      pendingApplications = Number(pend[0]?.pending ?? apps.length);
    }
    const reported = rows.length + apps.length;

    // Recipients are the admin accounts — the same set `requireAdmin` gates the
    // dashboard on, resolved through its one home. An admin with no email on
    // the account (dev seeds have none) simply isn't a recipient.
    const adminIds = await getAdminIds();
    if (adminIds.length === 0) {
      logger.warn(
        { newRows: reported },
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
        { adminIds: adminIds.length, newRows: reported },
        "Waitlist digest: admin accounts have no email address — nobody to notify",
      );
      return 0;
    }

    const email = renderEmail(
      waitlistDigestEmail({
        joiners: rows.map((r) => ({ email: r.email, joinedAt: r.created_at })),
        total,
        applicants: apps.map((a) => ({
          username: a.username,
          displayName: a.display_name,
          appliedAt: a.created_at,
        })),
        pendingApplications,
      }),
    );

    // ONE FAILING RECIPIENT IS A PARTIAL SEND, NOT A FAILED ONE. `sendEmail`
    // throws (Postmark answers 406 for an inactive recipient, which is what a
    // bounced admin address becomes), so a bare `for … await` aborted the loop
    // on the second admin — leaving the watermark unmoved, so the next hourly
    // tick re-sent the WHOLE digest to the first admin, and the one after that,
    // for as long as the second address stayed broken. The rows were reported;
    // the worker just could not tell that it had reported them.
    //
    // So each recipient is sent independently and the outcome is counted. The
    // watermark advances on ANY success, which is the choice worth stating:
    // advancing only on a clean sweep is the bug above, and advancing
    // unconditionally would let a total email outage swallow a batch of
    // prospects silently. On a partial send one admin misses one batch — the
    // rows are still in the table and the panel still reads them — and the
    // failure is named in the log rather than absorbed into a retry that
    // spams whoever is still reachable.
    let delivered = 0;
    const failed: string[] = [];
    for (const r of recipients) {
      try {
        await sendEmail({ to: r.email, ...email });
        delivered += 1;
      } catch (err) {
        failed.push(r.email);
        logger.error(
          { err, to: r.email, newRows: reported },
          "Waitlist digest: send to one admin failed",
        );
      }
    }
    if (delivered === 0) {
      // Nobody heard. The marker stays put and the next run retries the same
      // rows — the same contract the catch below has, reached deliberately.
      logger.error(
        { recipients: recipients.length, newRows: reported },
        "Waitlist digest: every recipient failed — not advancing the watermark",
      );
      return 0;
    }
    if (failed.length > 0) {
      logger.warn(
        { delivered, failed: failed.length, newRows: reported },
        "Waitlist digest: partial send — advancing the watermark anyway",
      );
    }

    // Both facts move, and only after the send. The watermark goes to the
    // newest row we actually REPORTED — never to now(), which would swallow
    // anything that arrived mid-run. Upsert both, because on the first ever
    // send neither key exists and an UPDATE would match nothing and quietly
    // claim success (how `jetstream_healthy` never persisted).
    //
    // Each watermark moves only if its own list was in the message: a digest
    // carrying only applications must leave the waitlist's window open, and
    // the other way round.
    //
    // FIXED STATEMENTS, not a VALUES list built at run time:
    // `state-keys-derived.test.ts` reads every runtime platform_config writer
    // out of the source, and a key it cannot see is a key the config editor
    // would let somebody hand-edit. The applications' mark goes first, so a
    // failure before the second statement re-reports the waitlist half (its
    // cadence stamp has not moved) and never loses either.
    const sentAt = new Date(now).toISOString();
    // Locals, not `rows[0].…` inside the params: the scanner reads the array
    // up to its first `]`.
    const newest = rows[0]?.created_at_exact;
    const newestApp = apps[0]?.created_at_exact;
    if (apps.length > 0) {
      await pool.query(
        `INSERT INTO platform_config (key, value, description) VALUES
           ($1, $2, 'Runtime state: newest writer application carried by a digest (READER-WRITER-SPLIT-ADR §8). Absent = none ever reported.')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [APPS_WATERMARK_KEY, newestApp],
      );
    }
    if (rows.length > 0) {
      await pool.query(
        `INSERT INTO platform_config (key, value, description) VALUES
           ($1, $2, 'Runtime state: newest waitlist row carried by a digest (CLOSED-BETA-ADR §XI). Absent = none ever reported.'),
           ($3, $4, 'Runtime state: when the waitlist digest last went out (CLOSED-BETA-ADR §XI). Absent = never sent.')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [WATERMARK_KEY, newest, LAST_SENT_KEY, sentAt],
      );
    } else {
      // Applications only: the waitlist's window stays open, the cadence moves.
      await pool.query(
        `INSERT INTO platform_config (key, value, description) VALUES
           ($1, $2, 'Runtime state: when the waitlist digest last went out (CLOSED-BETA-ADR §XI). Absent = never sent.')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [LAST_SENT_KEY, sentAt],
      );
    }

    logger.info(
      { newRows: rows.length, applications: apps.length, delivered, failed: failed.length, total },
      "Waitlist digest sent",
    );
    return reported;
  } catch (err) {
    // Including a send failure: the marker has not moved, so the next run
    // retries the same rows. Nothing here is worth taking the tick down for.
    logger.error({ err }, "Waitlist digest failed");
    return 0;
  }
}
