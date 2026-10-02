import { randomBytes, createHash } from 'node:crypto'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { sendEmail } from '@platform-pub/shared/lib/email.js'
import { renderEmail } from '@platform-pub/shared/lib/email/layout.js'
import { tributePercent, tributeReminderEmail } from '@platform-pub/shared/lib/email/templates/tributes.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'

// =============================================================================
// Tribute lifecycle sweep — Upstream Edges Phase 2.
//
// The contact window needs an owner: a periodic sweep, not an implicit wait. On
// each tick it (1) sends the 30-day reminder for still-proposed tributes whose
// first contact was >= 30 days ago and unreminded, and (2) flips proposed →
// lapsed past the 60-day window.
//
// State only — this worker moves NO money. Dial A: a proposed tribute never
// accrues (a share is frozen only for a `live` tribute), so lapse/decline are
// pure status flips with no held suspense to sweep back.
//
// Registered in gateway/src/index.ts on the hourly worker cadence, advisory-
// locked (ADVISORY_LOCKS.TRIBUTES), and only when TRIBUTES_ENABLED is set.
// =============================================================================

const REMINDER_DAYS = 30

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function runTributeSweep(): Promise<void> {
  await sendReminders()
  await lapseExpired()
}

interface ReminderRow {
  id: string
  invite_email: string | null
  resolved_account_id: string | null
  percentage_bps: number
  article_title: string
  author_email: string | null
  author_display_name: string | null
  author_username: string | null
}

// 30-day reminder. For an UNCLAIMED external invite (an email but no bound
// account yet) we rotate the claim token and re-send the link — we only kept the
// token's hash, so the original link can't be reproduced; a fresh token is the
// honest way to remind. For an in-app member (or an already-claimed invite) the
// standing notification is the reminder, so we only stamp reminder_sent_at.
async function sendReminders(): Promise<void> {
  const { rows } = await pool.query<ReminderRow>(
    `SELECT t.id, t.invite_email, t.resolved_account_id, t.percentage_bps,
            a.title AS article_title,
            auth.email AS author_email,
            auth.display_name AS author_display_name,
            auth.username AS author_username
       FROM tributes t
       JOIN articles a ON a.id = t.article_id
       JOIN accounts auth ON auth.id = t.author_account_id
      WHERE t.status = 'proposed' AND t.deleted_at IS NULL
        AND t.reminder_sent_at IS NULL
        AND t.first_contact_at IS NOT NULL
        AND t.first_contact_at <= now() - ($1 || ' days')::interval`,
    [String(REMINDER_DAYS)],
  )

  for (const r of rows) {
    try {
      if (r.invite_email && r.resolved_account_id == null) {
        // Rotate the token and re-send, then persist the new hash + stamp
        // reminder_sent_at in ONE write — but only AFTER a confirmed send. The
        // old link stays live until the new one is delivered: if the send
        // throws, nothing is persisted, so the prior token is still valid and
        // the row retries next tick (with a fresh token) rather than being
        // stranded with a dead old link and an undelivered new one.
        const rawToken = randomBytes(32).toString('base64url')
        await sendReminderEmail(r, rawToken)
        await pool.query(
          `UPDATE tributes SET invite_token_hash = $1, reminder_sent_at = now()
            WHERE id = $2 AND reminder_sent_at IS NULL`,
          [hashToken(rawToken), r.id],
        )
      } else {
        // In-app member (or already-claimed invite): the standing notification
        // is the reminder, so just stamp reminder_sent_at.
        await pool.query(
          `UPDATE tributes SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL`,
          [r.id],
        )
      }
    } catch (err) {
      logger.error({ err, tributeId: r.id }, 'Tribute reminder failed')
    }
  }
  if (rows.length > 0) logger.info({ count: rows.length }, 'Tribute reminders swept')
}

async function sendReminderEmail(r: ReminderRow, rawToken: string): Promise<void> {
  if (!r.invite_email) return
  const appUrl = requireEnv('APP_URL')
  const claimUrl = `${appUrl}/tribute/claim?token=${encodeURIComponent(rawToken)}`
  const authorName = r.author_display_name ?? r.author_username ?? 'A writer on all.haus'

  await sendEmail({
    to: r.invite_email,
    ...renderEmail(
      tributeReminderEmail({
        authorName,
        articleTitle: r.article_title,
        percent: tributePercent(r.percentage_bps),
        claimUrl,
      }),
    ),
  })
}

// 60-day lapse. Flip proposed → lapsed. (The trigger early-returns for a lapsed
// row, so no ceiling/D1 re-check.) Dial A: a proposed tribute never accrued, so
// there is no held suspense to sweep — this is a pure status flip.
async function lapseExpired(): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE tributes SET status = 'lapsed'
        WHERE status = 'proposed' AND deleted_at IS NULL AND window_expires_at <= now()
      RETURNING id`,
    )
    if (rows.length === 0) return
    logger.info({ count: rows.length }, 'Tributes lapsed (window expired)')
  })
}
