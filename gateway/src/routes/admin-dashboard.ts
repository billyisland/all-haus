import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, loadConfig, withTransaction } from '@platform-pub/shared/db/client.js'
import { isIntegerDialKey } from '@platform-pub/shared/db/dial-kinds.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { recordConfigAudit } from '@platform-pub/shared/lib/config-audit.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { NOTIFICATIONS_NEEDS_RECONNECT } from '@platform-pub/shared/lib/presence-health.js'
import { requireEnv, publicationsEnabled } from '@platform-pub/shared/lib/env.js'
import { requireAdmin, invalidateAdminIdsCache } from '../middleware/admin.js'
import { grantWriterAccess } from '../lib/writer-gate.js'
import { UUID_RE } from '../lib/uuid.js'
import { getParityReport } from '../lib/internal-parity.js'
import { invalidatePlatformConfig } from '../lib/platform-config.js'
import { provisionAccount } from '../lib/account-provision.js'
import { freezeFeedIntoFormula, formulaMaxSources } from './feeds/formulas.js'
import {
  appendAccountToSeed,
  carryAdmittedIntoSeed,
  countCarryForFeed,
  type SeedAppendOutcome,
} from './feeds/seed-append.js'
import {
  sendWaitlistInviteEmail,
  sendWriterAccessGrantedEmail,
} from '@platform-pub/shared/lib/email.js'
import { getEmailHealth } from '@platform-pub/shared/lib/email-health.js'
import {
  currentTermsVersion,
  termsMajor,
} from '@platform-pub/shared/lib/terms-versions.js'

// =============================================================================
// Owner dashboard — operator visibility over the money pipeline, users,
// content, config, and regulatory thresholds. Spec:
// planning-archive/OWNER-DASHBOARD-SPEC.md (adapted to the shipped ledger
// views and the post-145 schema — no is_writer column; earnings are the
// ledger_writer_earned − ledger_writer_earnings difference).
//
// GET  /admin/dashboard/overview    — money pipeline stage-by-stage
// GET  /admin/dashboard/users       — account totals, growth, KYC-stuck writers
// GET  /admin/dashboard/members     — the roster itself, searchable by
//                                     address / handle / display name
// GET  /admin/dashboard/content     — publishing activity + system health
// GET  /admin/dashboard/config      — all platform_config rows
// PATCH /admin/dashboard/config     — update existing keys (never insert)
// GET  /admin/dashboard/regulatory  — revenue vs UK tax thresholds, custody
// GET  /admin/dashboard/waitlist    — the closed-beta waiting list
// GET  /admin/dashboard/allocation-coverage — funds segregation, measured (W2)
// GET  /admin/dashboard/reader-credits — reading tabs in credit (W1 incident)
// GET  /admin/dashboard/seed-formula   — what every new account is seeded from
// POST /admin/dashboard/seed-formula   — designate that (FEED-FORMULAS D6/D11)
// POST /admin/dashboard/waitlist/admit — admit a batch (creates accounts,
//                                        appends them to the seed, sends nothing)
// POST /admin/dashboard/waitlist/invite — send the invitation to admitted rows
// POST /admin/dashboard/waitlist/remove — drop one UNADMITTED waitlister
// GET  /admin/dashboard/writer-applications — the writers' waiting list
// POST /admin/dashboard/writer-applications/grant — admit one as a writer
//                                        (reason required, config_audit row)
// POST /admin/dashboard/dead-jobs/reap — clear one arm of the dead-job pile
// POST /admin/dashboard/trigger-settlements — proxy to payment-service
// POST /admin/dashboard/trigger-payouts     — proxy to payment-service
//                                        (both: reason required, request
//                                        recorded in config_audit first)
// POST /admin/dashboard/resume-payouts[/:accountId] — release a payout halt
//                                        (proxy; actor + reason recorded)
// POST /admin/dashboard/halt-payouts/:accountId — freeze ONE account's payouts
//                                        as an operator decision (D9 §4.1;
//                                        proxy; actor + reason + class recorded)
//
// All numbers are computed live; at launch scale that is fine (spec §1).
// =============================================================================

const PAYMENT_SERVICE_URL = requireEnv('PAYMENT_SERVICE_URL')
const INTERNAL_SERVICE_TOKEN = requireEnv('INTERNAL_SERVICE_TOKEN')

const num = (v: unknown): number => Number(v ?? 0)

// Runtime-state keys that live in platform_config but are not operator dials —
// shown read-only in the config editor, never editable through it.
// (payouts_halted is presence-means-halted and is DELETEd to resume;
// jetstream_healthy is written by the ingest listener.)
// (feed_ingest_heartbeat is stamped every 60s by the feed-ingest poll; editing
// it by hand would forge the liveness signal the overview alarms on.)
// (jetstream_cursor is the listener's stream position, written by its cursor
// flush; editing it by hand would replay or skip the firehose.)
// (the waitlist digest's two watermarks and last-sent stamp, and the engagement
// sweep's resume cursor, are positions their workers upsert; a bad hand edit
// re-sends or skips digests, or re-walks or skips the long tail — CA-F3.)
// Every runtime `INSERT INTO platform_config` in the services must name a key
// here: `gateway/tests/state-keys-derived.test.ts` finds them in the source.
const STATE_KEYS = new Set([
  'payouts_halted',
  'jetstream_healthy',
  'feed_ingest_heartbeat',
  'jetstream_cursor',
  'waitlist_digest_watermark',
  'waitlist_digest_last_sent_at',
  'writer_applications_digest_watermark',
  'engagement_daily_sweep_cursor',
])

// The in-code twin of config-defaults.sql's ingest_heartbeat_alert_seconds.
// Exported so the fallback-parity suite can hold the two copies together — a
// drifted fallback never errors, it just substitutes silently, in exactly the
// case it exists for (the row missing).
export const INGEST_HEARTBEAT_ALERT_SECONDS_FALLBACK = 600

// The in-code twins of config-defaults.sql's two linked-notification dials the
// overview reads (CROSS-NETWORK-ROUNDTRIP-ADR C4), parity-tested like the rest.
export const LINKED_NOTIFICATIONS_POLL_SECONDS_FALLBACK = 300
export const LINKED_NOTIFICATIONS_STALE_INTERVALS_FALLBACK = 6

// The in-code twin of config-defaults.sql's dead_job_arrival_window_hours,
// parity-tested for the same reason as the one above.
export const DEAD_JOB_ARRIVAL_WINDOW_HOURS_FALLBACK = 24

// The regulatory tax thresholds. Canonical values live in
// shared/src/db/config-defaults.sql; these fallbacks are tripwired against it
// by gateway/tests/admin-dashboard.test.ts (the §0h.7 parity pattern).
export const REGULATORY_DIAL_DEFAULTS = {
  tax_trading_allowance_pence: 100_000,
  tax_vat_threshold_pence: 9_000_000,
  tax_vat_warning_pct: 80,
  tax_corp_small_profits_pence: 5_000_000,
  tax_corp_main_rate_pence: 25_000_000,
  regulatory_holding_warning_days: 14,
} as const
type RegulatoryDial = keyof typeof REGULATORY_DIAL_DEFAULTS

const NUMERIC_RE = /^-?\d+(\.\d+)?$/

// A malformed dial falls back — in the SQL below, where the threshold is
// applied — and says so here, once per key (a fallback is for an ABSENT value).
const warnedMalformedDial = new Set<string>()
function warnIfMalformedDial(key: string, raw: unknown): void {
  if (raw == null || /^[0-9]+$/.test(String(raw)) || warnedMalformedDial.has(key)) return
  warnedMalformedDial.add(key)
  logger.warn({ key, value: raw }, 'platform_config value malformed; using fallback')
}

// One reading of every presence the notification poller serves (the same
// predicate its claim uses) against the two dials, in one statement. DOWN
// counts from the last SUCCESS, never the last attempt, and from the link date
// where there has never been one; `awaiting_reconnect` is the subset of DOWN
// whose last poll said the grant lacks a scope.
export const LINKED_POLL_HEALTH_SQL = `
    WITH dial AS (
      SELECT
        (SELECT value FROM platform_config WHERE key = 'linked_notifications_poll_seconds') AS poll_raw,
        (SELECT value FROM platform_config WHERE key = 'linked_notifications_stale_intervals') AS stale_raw,
        COALESCE((SELECT NULLIF(value, '')::numeric FROM platform_config
                   WHERE key = 'linked_notifications_poll_seconds'
                     AND value ~ '^[0-9]+$'), ${LINKED_NOTIFICATIONS_POLL_SECONDS_FALLBACK}) AS poll_seconds,
        COALESCE((SELECT NULLIF(value, '')::numeric FROM platform_config
                   WHERE key = 'linked_notifications_stale_intervals'
                     AND value ~ '^[0-9]+$'), ${LINKED_NOTIFICATIONS_STALE_INTERVALS_FALLBACK}) AS stale_intervals
    ),
    served AS (
      SELECT np.notifications_polled_at, np.created_at, np.notifications_poll_error
        FROM network_presences np
        JOIN accounts a ON a.id = np.account_id AND a.status = 'active'
       WHERE np.lifecycle_state = 'active'
         AND np.is_valid = TRUE
         AND np.provenance <> 'concierge'
         AND np.protocol IN ('atproto', 'activitypub')
    )
    SELECT dial.poll_raw, dial.stale_raw, dial.poll_seconds, dial.stale_intervals,
           COUNT(served.*)::int AS presences,
           COUNT(served.*) FILTER (WHERE stale)::int AS down,
           COUNT(served.*) FILTER (
             WHERE stale AND served.notifications_poll_error LIKE $1 || '%'
           )::int AS awaiting_reconnect,
           MIN(served.notifications_polled_at) AS oldest_success_at
      FROM dial
      LEFT JOIN LATERAL (
        SELECT s.*,
               COALESCE(s.notifications_polled_at, s.created_at)
                 < now() - make_interval(secs => dial.poll_seconds * dial.stale_intervals) AS stale
          FROM served s
      ) served ON TRUE
     GROUP BY dial.poll_raw, dial.stale_raw, dial.poll_seconds, dial.stale_intervals`

// -----------------------------------------------------------------------------
// Dead background jobs (CONSOLIDATED-TODO §8.15).
//
// The heartbeat above answers *is the worker running*. It cannot answer *is the
// worker failing everything it picks up*: a job that exhausts its attempts stops
// being retried and sits in graphile_worker's table forever, mentioning itself
// to nobody. That is how `relay_outbox_prune` was red for 84 consecutive nights
// on prod, with the fault underneath it silently deactivating members' feeds.
//
// THE CONSTRAINT THAT SHAPES ALL OF THIS: successful jobs are DELETED. "Has this
// task ever succeeded?" is not answerable here. Failures are all you can see.
//
// WHY THE PRIVATE TABLE. The public `graphile_worker.jobs` view omits `payload`,
// and the payload is where the only non-drifting cron discriminator lives (see
// below). Reading `_private_jobs` is reaching past a supported API, so the
// caller catches its own failure and the surface renders "unavailable" rather
// than a reassuring zero — and a graphile upgrade that renames it costs this
// panel, never the money page it sits on.
//
// THE DISCRIMINATOR IS STRUCTURAL, NOT A LIST. graphile stamps `_cron` into the
// payload of every job it queues from the crontab (`makeJobForItem`,
// graphile-worker/dist/cron.js) — verified against live rows on the dev stack,
// not inferred from the source. So the two arms need no hand-maintained task
// list that can drift out of step with feed-ingest's crontab, and it stays
// correct for the `?id=`-aliased entries (trust_epoch_*) that a join against
// known_crontabs would silently misfile.
//
//   CRON/SINGLETON — one scheduled run, no payload. A dead row means THAT RUN
//   DID NOT HAPPEN. Always worth alarming, at count >= 1.
//
//   PER-ENTITY — carries a sourceId; one dead row is one source among hundreds.
//   Informational only. A threshold on the total is red from day one and gets
//   learned past, which is the exact failure the alarm would exist to avoid.
//
// FAILED vs ABANDONED, which the item did not have and which changes what the
// numbers mean. Only 25 of dev's 1038 dead rows carry an error at all. The rest
// have `last_error IS NULL`: the worker was interrupted mid-job (a restart, a
// SIGTERM), attempts had already been incremented, and the poll's per-source
// enqueue sets `maxAttempts: 1` — so there is no second chance and the job is
// dead having never actually failed. They cluster on restart days (420 on 19
// Jul, 281 on 10 Aug), not evenly. Reporting those 1013 as failures would state
// a fault that isn't there, on the one surface built to be believed, so the two
// are counted apart. Both still mean "this will never run", which is why both
// feed the cron alarm.
//
// Neither kind blocks anything: graphile frees the job key on permanent failure
// (every dead row here has `key IS NULL`, checked on dev), so the next enqueue
// for that source inserts cleanly and an active source keeps being polled.
//
// RETRYING is reported beside them because it is the same fault ARRIVING. Those
// seven `relay_outbox_prune` rows on dev sat at attempts 10-24 of 25 while the
// briefed predicate (attempts >= max_attempts) rendered them as nothing — a
// cron task failing all day, reading as a clean bill of health on the page that
// exists to end exactly that. It is informational and never the alarm: a
// retrying row's `last_error` can predate a fix that has not been retried yet
// (which is precisely what those seven are), and one transient failure of a
// once-a-minute task would otherwise flash red for seconds at a time.
//
// $1 = the arrival window in hours. The pile is cumulative and grows by
// construction; the RATE is the signal.
// -----------------------------------------------------------------------------
export const DEAD_JOBS_SQL = `
  WITH j AS (
    SELECT t.identifier AS task,
           (job.payload -> '_cron') IS NOT NULL AS is_cron,
           job.attempts >= job.max_attempts AND job.locked_at IS NULL AS is_dead,
           job.last_error,
           job.updated_at
      FROM graphile_worker._private_jobs job
      JOIN graphile_worker._private_tasks t ON t.id = job.task_id
     -- A row is interesting if it is dead, or if it has failed at least once and
     -- still has attempts left. A locked row on its final attempt is neither: it
     -- may yet succeed, and counting it as dead would report a running job as a
     -- permanent failure once a minute, forever.
     WHERE (job.attempts >= job.max_attempts AND job.locked_at IS NULL)
        OR job.last_error IS NOT NULL
  )
  SELECT task,
         is_cron,
         COUNT(*) FILTER (WHERE is_dead AND last_error IS NOT NULL)::int AS failed,
         COUNT(*) FILTER (WHERE is_dead AND last_error IS NULL)::int     AS abandoned,
         COUNT(*) FILTER (WHERE NOT is_dead)::int                        AS retrying,
         COUNT(*) FILTER (WHERE is_dead
                            AND updated_at > now() - make_interval(hours => $1::int))::int
           AS recent,
         MAX(updated_at) FILTER (WHERE is_dead) AS last_dead_at,
         (array_agg(last_error ORDER BY updated_at DESC)
            FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
    FROM j
   GROUP BY task, is_cron
   ORDER BY is_cron DESC, failed DESC, abandoned DESC, task`

type DeadJobRow = {
  task: string
  is_cron: boolean
  failed: number
  abandoned: number
  retrying: number
  recent: number
  last_dead_at: Date | null
  last_error: string | null
}

/**
 * The arrival window, in hours, over which new deaths are counted.
 *
 * A dial because the pile is cumulative and the useful question is how fast it
 * is growing, and the answer depends on cadence and on how often the operator
 * looks — 1038 rows accrued since July says nothing, nine of them arriving today
 * says something. Junk or a non-positive value falls back rather than becoming a
 * window of NaN (which compares false against everything, so nothing is ever
 * recent) or of zero (which reports every arrival as old news).
 *
 * Truncated to an integer HERE, the one home — DEAD_JOBS_SQL binds
 * make_interval(hours => $1::int) and Postgres rejects the text form of a
 * fractional value outright (`invalid input syntax for type integer: "36.5"`),
 * which would darken the whole panel and blame graphile for an operator's
 * `0.5`. A sub-hour setting floors to 1 rather than to a zero-width window.
 */
export async function deadJobWindowHoursDial(): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'dead_job_arrival_window_hours'`
  )
  const v = Number(rows[0]?.value)
  return Number.isFinite(v) && v > 0
    ? Math.trunc(v) || 1
    : DEAD_JOB_ARRIVAL_WINDOW_HOURS_FALLBACK
}

// Designate the default-seed formula (FEED-FORMULAS-ADR D6/D11): either name a
// formula that already exists, or cut one of the admin's own feeds into a new
// one. A union rather than two optional fields, so "neither" and "both" are
// rejected by the parse instead of by a hand-written check further down.
// ONE body, one act: name one of your own feeds and it is frozen into a new
// seed row and designated in the same transaction. The `{ formulaId }` branch
// retired with FEED-SHARE-LIVE-LINKS-ADR L5 — a seed is CUT, never adopted.
// With one live link per feed, designating an existing row would have let an
// operator designate a MEMBER's share link, which `feed_formulas_seed_never_
// revoked` would then have made unrevocable: seizing somebody's link and
// removing their ability to withdraw it.
const SeedFormulaSchema = z
  .object({
    feedId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    // RESHAPE-PLAN-2026-10 §A.2.7: a re-cut carries the outgoing seed's
    // admitted members across unless the operator starts this seed without
    // them. Absent means carry — the silent loss is the failure this guards.
    carryAdmitted: z.boolean().optional(),
  })
  .strict()

const PatchConfigSchema = z.object({
  updates: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        value: z.string().max(10_000),
      })
    )
    .min(1)
    .max(50),
  // REQUIRED (L5.2). A dial edit changes what the platform does with other
  // people's money — the fee rate, the settlement threshold, the tab cap — and
  // an operator who cannot say why in one line is about to make a change
  // somebody will have to reconstruct from a diff of two numbers. Required in
  // three places, the refund precedent: here, and in the `config_audit`
  // column's own CHECK, with the button refusing an empty field so nobody meets
  // the 400 by accident. `.trim()` before `.min(1)` because a space is not a
  // reason. One reason covers the whole batch: the batch is the operator's act.
  reason: z.string().trim().min(1).max(500),
})

// Which arm of the dead-job surface to clear. Two values, never "all": the two
// arms mean categorically different things (see DEAD_JOBS_SQL) and reaping a
// cron row destroys the evidence of a scheduled run that did not happen, so the
// operator says which pile they mean.
const ReapDeadJobsSchema = z.object({ scope: z.enum(['cron', 'per_entity']) }).strict()

// UK financial (tax) year runs 6 April → 5 April.
export function ukFinancialYear(now: Date): { start: string; end: string; daysRemaining: number } {
  const y = now.getUTCFullYear()
  const thisYearStart = Date.UTC(y, 3, 6) // 6 April (month is 0-based)
  const inNewTaxYear = now.getTime() >= thisYearStart
  const startMs = inNewTaxYear ? thisYearStart : Date.UTC(y - 1, 3, 6)
  const endMs = inNewTaxYear ? Date.UTC(y + 1, 3, 5) : Date.UTC(y, 3, 5)
  const daysRemaining = Math.max(0, Math.ceil((endMs - now.getTime()) / 86_400_000))
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(endMs).toISOString().slice(0, 10),
    daysRemaining,
  }
}

// The trigger proxies run a whole cron cycle, so they wait a minute. A read
// proxy is on a page load and must fail fast instead — an unreachable payment
// service should cost the panel a moment, not the operator a minute of blank
// dashboard.
const PAYMENT_SERVICE_WRITE_TIMEOUT_MS = 60_000
const PAYMENT_SERVICE_READ_TIMEOUT_MS = 10_000

async function callPaymentService(
  path: string,
  method: 'GET' | 'POST' = 'POST',
  // The trigger proxies send the actor and their reason; the refund sends what
  // it is about. An OPTIONAL body rather than a second helper: the token, the
  // timeouts and the non-2xx log line below are the parts that must not be
  // written twice, and they are all here.
  payload?: unknown
): Promise<{ status: number; body: unknown }> {
  const isRead = method === 'GET'
  const res = await fetch(`${PAYMENT_SERVICE_URL}/api/v1${path}`, {
    method,
    headers: {
      'x-internal-token': INTERNAL_SERVICE_TOKEN,
      ...(isRead ? {} : { 'Content-Type': 'application/json' }),
    },
    signal: AbortSignal.timeout(
      isRead ? PAYMENT_SERVICE_READ_TIMEOUT_MS : PAYMENT_SERVICE_WRITE_TIMEOUT_MS
    ),
    ...(isRead ? {} : { body: JSON.stringify(payload ?? {}) }),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = { error: 'Upstream returned a non-JSON response' }
  }

  // AN UPSTREAM REFUSAL MUST LEAVE A FOOTPRINT. Every caller passes the status
  // and body straight to the browser, and the per-route try/catch only fires
  // when `fetch` itself throws — so before this, a 403 or 500 from the payment
  // service reached the operator's screen having written NOTHING to the gateway
  // log. That is precisely how an `INTERNAL_SERVICE_TOKEN` mismatch survived on
  // prod (2026-08-07): payment-service answered 403 to every proxied call
  // — including `/gate-pass`, so paywalled unlocks were failing — and the only
  // visible symptom was one admin panel saying "unavailable", with no log line
  // anywhere naming the status. Logged here rather than per route so all three
  // proxies get it from one place.
  if (res.status < 200 || res.status >= 300) {
    logger.warn(
      { path, method, status: res.status, body },
      'payment-service proxy returned non-2xx — check INTERNAL_SERVICE_TOKEN parity between gateway/.env and payment-service/.env if this is a 403'
    )
  }

  return { status: res.status, body }
}

export async function adminDashboardRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/overview — the money pipeline
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/overview', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const config = await loadConfig()
      const nearThresholdPence = Math.floor(config.tabSettlementThresholdPence * 0.8)

      const deadJobWindowHours = await deadJobWindowHoursDial()

      const [tabs, readStates, settlements, payouts, outstanding, halt, revenue, custody, counts, holdingDial, haltedAccounts, ingestBeat, ingestProtocols, deadJobs, linkedPolls] =
        await Promise.all([
          pool.query(
            // NO CREDIT FILTER HERE, DELIBERATELY. This block carried a
            // `-SUM(balance_pence) FILTER (WHERE balance_pence < 0)` that the
            // page rendered as an ordinary stat card, "Reader credit", between
            // Active tabs and Near threshold — a figure with no count, no
            // account, no alarm and no suggestion that anything was wrong. A
            // reading tab in credit is an INCIDENT with a runbook
            // (PAYMENT-PERIMETER-ADR W1), and stating its total in the voice of
            // a metric is how it becomes a number somebody stops reading. It
            // now has its own banner, fed by the payment service's own detector
            // — the one home for the predicate — with the count, the deepest
            // accounts and what to do. One figure, one place.
            `SELECT
               COUNT(*) FILTER (WHERE balance_pence > 0) AS active_tab_count,
               COALESCE(SUM(balance_pence) FILTER (WHERE balance_pence > 0), 0) AS total_accrued_pence,
               COUNT(*) FILTER (WHERE balance_pence >= $1) AS near_threshold_tabs
             FROM reading_tabs`,
            [nearThresholdPence]
          ),
          pool.query(
            // chargeable_pence, not the list price: a read part-covered by the
            // free allowance was never charged for those pence, so counting
            // them here reports money that does not exist in any state.
            `SELECT state, COUNT(*) AS n, COALESCE(SUM(chargeable_pence), 0) AS total_pence
             FROM read_events GROUP BY state`
          ),
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
               COALESCE(SUM(amount_pence) FILTER (WHERE status = 'pending'), 0) AS pending_pence,
               MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
               COALESCE(SUM(amount_pence) FILTER (WHERE status = 'completed'), 0) AS completed_pence,
               MAX(settled_at) FILTER (WHERE status = 'completed') AS last_completed_at,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
             FROM tab_settlements`
          ),
          pool.query(
            `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_pence), 0) AS total_pence,
                    MAX(triggered_at) AS last_at
             FROM writer_payouts GROUP BY status`
          ),
          // Money the platform owes writers: modeled earning minus paid-out,
          // per account, summed over positive balances (the two ledger views).
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE outstanding_pence > 0) AS writers_awaiting,
               COALESCE(SUM(outstanding_pence) FILTER (WHERE outstanding_pence > 0), 0) AS outstanding_pence
             FROM (
               SELECT COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) AS outstanding_pence
               FROM ledger_writer_earned e
               FULL OUTER JOIN ledger_writer_earnings p USING (account_id)
             ) q`
          ),
          pool.query(
            `SELECT value, description, updated_at FROM platform_config WHERE key = 'payouts_halted'`
          ),
          pool.query(
            `SELECT
               COALESCE(SUM(platform_fee_pence), 0) AS all_time,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '30 days'), 0) AS last_30d,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '7 days'), 0) AS last_7d,
               COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '1 day'), 0) AS today
             FROM tab_settlements WHERE status = 'completed'`
          ),
          pool.query(
            // GROSS COLLECTED, and chargeable_pence is what that means: the
            // platform cannot be holding pence the free allowance gave away and
            // nobody ever paid. It is deliberately still gross of the platform
            // fee — this tile asks how much settled money is sitting unclaimed,
            // not what is owed to writers; that figure is the ledger view pair
            // (ledger_writer_earned − ledger_writer_earnings).
            `SELECT COUNT(*) AS held_read_count,
                    COALESCE(SUM(chargeable_pence), 0) AS total_held_pence,
                    MIN(read_at) AS oldest_held_read_at
             FROM read_events
             -- Unclaimed by EITHER cycle (migration 168). A publication read is
             -- claimed on publication_payout_id, so checking only the writer's
             -- column reports pooled money as still held.
             WHERE state = 'platform_settled'
               AND writer_payout_id IS NULL AND publication_payout_id IS NULL`
          ),
          pool.query(
            `SELECT
               (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted') AS total_accounts,
               (SELECT COUNT(*) FROM accounts WHERE status = 'active') AS active_accounts,
               (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND stripe_customer_id IS NOT NULL) AS readers_with_card,
               (SELECT COUNT(DISTINCT writer_id) FROM articles WHERE published_at IS NOT NULL AND deleted_at IS NULL) AS publishing_writers,
               (SELECT COUNT(DISTINCT reader_id) FROM read_events) AS readers_ever,
               (SELECT COUNT(*) FROM moderation_reports WHERE status IN ('open', 'under_review')) AS open_report_count`
          ),
          pool.query<{ value: string }>(
            `SELECT value FROM platform_config WHERE key = 'regulatory_holding_warning_days'`
          ),
          // W4 per-account payout halts. Read here rather than proxied from
          // payment-service's /payouts/halt-status because this dashboard
          // already reads the global flag straight from the same DB, and a
          // freeze the ONLY operator surface cannot see is the invisible-halt
          // failure this work exists to bound, one granularity down.
          //
          // UNCAPPED, for the reason the attribution query is: a capped list
          // reading as a total tells the operator everyone is paid but twenty.
          pool.query(
            `SELECT h.account_id, h.mismatch_class, h.reason, h.created_at,
                    a.username, a.display_name
               FROM payouts_halted_accounts h
               JOIN accounts a ON a.id = h.account_id
              ORDER BY h.created_at ASC`
          ),
          // Ingest liveness (prod incident 2026-08-11). Both halves in one
          // round trip: the heartbeat + its dial, and the per-protocol last
          // fetch. See the `ingest` block below for what each is FOR — they
          // answer different questions and must not be merged.
          pool.query(
            `SELECT
               (SELECT value FROM platform_config WHERE key = 'feed_ingest_heartbeat') AS heartbeat,
               (SELECT value FROM platform_config WHERE key = 'ingest_heartbeat_alert_seconds') AS alert_seconds`
          ),
          // Per protocol: how many active sources, when any of them last
          // delivered, and — the §0aa.2 figure — how many are ACTIVE AND
          // UNREADABLE. That last state is the one nothing could see: a source
          // refused for want of a signature stays active and on schedule and
          // delivers nothing for ever, which is indistinguishable from an
          // author who has not posted. `MAX(last_fetched_at)` cannot show it,
          // because we DO keep fetching; only the refusal stamp can.
          //
          // The FILTER rides this query rather than sitting in its own, so the
          // two figures are read of the same table at the same instant: a
          // separate round trip could report 40 refused out of 30 active and
          // send an operator looking for a bug that is theirs.
          pool.query(
            `SELECT protocol::text AS protocol,
                    COUNT(*)::int AS active_sources,
                    COUNT(*) FILTER (
                      WHERE signed_fetch_refused_at IS NOT NULL
                    )::int AS refused_sources,
                    MIN(signed_fetch_refused_at) AS refused_since,
                    MAX(last_fetched_at) AS last_fetched_at
               FROM external_sources
              WHERE is_active = TRUE
              GROUP BY protocol
              ORDER BY protocol`
          ),
          // Dead background jobs (§8.15). Caught rather than allowed to reject:
          // this is the one query in the round trip that reads past a supported
          // API (DEAD_JOBS_SQL's header), and a graphile upgrade that renamed
          // the private table must cost this panel, not the money dashboard it
          // is rendered beside. `null` becomes an explicit "unavailable" below —
          // never a zero, which is the reassuring reading of an absence this
          // whole item exists to end.
          pool.query<DeadJobRow>(DEAD_JOBS_SQL, [deadJobWindowHours]).catch((err) => {
            req.log.warn({ err }, 'dead-job query failed — graphile_worker schema may have moved')
            return null
          }),
          // Linked-account notification polling (rung C). The dials ride the
          // same statement so the threshold and the count are one reading.
          pool.query(LINKED_POLL_HEALTH_SQL, [NOTIFICATIONS_NEEDS_RECONNECT]),
        ])

      const stateRow = (state: string) => {
        const r = readStates.rows.find((x: any) => x.state === state)
        return { count: num(r?.n), totalPence: num(r?.total_pence) }
      }
      const payoutRow = (status: string) => {
        const r = payouts.rows.find((x: any) => x.status === status)
        return { count: num(r?.n), totalPence: num(r?.total_pence), lastAt: r?.last_at ?? null }
      }

      const t = tabs.rows[0]
      const s = settlements.rows[0]
      const o = outstanding.rows[0]
      const r = revenue.rows[0]
      const cu = custody.rows[0]
      const c = counts.rows[0]
      const haltRow = halt.rows[0]
      const oldestHeld = cu.oldest_held_read_at ? new Date(cu.oldest_held_read_at) : null

      const provisional = stateRow('provisional')
      const accrued = stateRow('accrued')
      const chargedBack = stateRow('charged_back')
      const initiated = payoutRow('initiated')
      const pendingPayouts = payoutRow('pending')
      const completedPayouts = payoutRow('completed')
      const failedPayouts = payoutRow('failed')
      const reversedPayouts = payoutRow('reversed')

      return reply.send({
        accrual: {
          activeTabCount: num(t.active_tab_count),
          totalAccruedPence: num(t.total_accrued_pence),
          nearThresholdTabs: num(t.near_threshold_tabs),
          settlementThresholdPence: config.tabSettlementThresholdPence,
          provisionalReadCount: provisional.count,
          provisionalTotalPence: provisional.totalPence,
          accruedReadCount: accrued.count,
          accruedTotalPence: accrued.totalPence,
        },
        settlement: {
          pendingCount: num(s.pending_count),
          pendingPence: num(s.pending_pence),
          oldestPendingAt: s.oldest_pending_at ?? null,
          completedCount: num(s.completed_count),
          completedPence: num(s.completed_pence),
          lastCompletedAt: s.last_completed_at ?? null,
          failedCount: num(s.failed_count),
          chargedBackReadCount: chargedBack.count,
          chargedBackPence: chargedBack.totalPence,
        },
        payout: {
          writersAwaitingPayout: num(o.writers_awaiting),
          outstandingEarningsPence: num(o.outstanding_pence),
          pendingCount: pendingPayouts.count,
          pendingPence: pendingPayouts.totalPence,
          initiatedCount: initiated.count,
          initiatedPence: initiated.totalPence,
          completedCount: completedPayouts.count,
          completedPence: completedPayouts.totalPence,
          failedCount: failedPayouts.count,
          failedPence: failedPayouts.totalPence,
          reversedCount: reversedPayouts.count,
          reversedPence: reversedPayouts.totalPence,
          lastPayoutAt: completedPayouts.lastAt,
          // The PLATFORM-wide freeze. Kept distinct from the per-account set
          // below: an operator reading "one writer is halted" as "the platform
          // is halted" would resume the wrong control.
          halted: haltRow?.value === 'true',
          haltReason: haltRow?.description ?? null,
          haltedSince: haltRow?.updated_at ?? null,
          haltedAccounts: haltedAccounts.rows.map((h: any) => ({
            accountId: h.account_id,
            username: h.username,
            displayName: h.display_name,
            mismatchClass: h.mismatch_class,
            reason: h.reason,
            since: h.created_at,
          })),
        },
        revenue: {
          allTimePlatformFeePence: num(r.all_time),
          last30DaysPlatformFeePence: num(r.last_30d),
          last7DaysPlatformFeePence: num(r.last_7d),
          todayPlatformFeePence: num(r.today),
        },
        custody: {
          heldReadCount: num(cu.held_read_count),
          totalHeldPence: num(cu.total_held_pence),
          oldestHeldReadAt: cu.oldest_held_read_at ?? null,
          holdingDurationDays: oldestHeld
            ? Math.floor((Date.now() - oldestHeld.getTime()) / 86_400_000)
            : 0,
          // The dial the regulatory page honours — served here too so the
          // Overview tile's warn state can't drift from a retuned threshold
          // (same fallback discipline as the regulatory endpoint's dial()).
          holdingWarningDays: (() => {
            const v = Number(holdingDial.rows[0]?.value)
            return Number.isFinite(v)
              ? v
              : REGULATORY_DIAL_DEFAULTS.regulatory_holding_warning_days
          })(),
        },
        // Shared-secret parity (slice 2). Served here because the healthcheck
        // and the log are both passive — `docker compose ps` and a log tail are
        // things an operator does when already suspicious, and the fault this
        // reports is precisely the one that gives you nothing to be suspicious
        // ABOUT. This page is where money state is checked, so it is where a
        // silently broken paywall belongs. Read from process memory, no query.
        parity: getParityReport(),
        // Outbound email. Here for the reason `parity` and `ingest` are, and it
        // is the incident that stated the reason best: for up to 17 days every
        // email this platform sent failed on a rejected Postmark token, and the
        // one surface that would have shown it — a count of failed sends — did
        // not exist. The login route catches the send error and still answers
        // 200 (deliberately: a delivery failure must not reveal whether an
        // account exists), so there is no user-visible symptom at all.
        //
        // `credential` is a probe verdict with a real THIRD state: `null` is
        // never-confirmed, and rendering it as healthy is this feature's own
        // failure mode. `attempted` ships beside `failed` because zero failures
        // out of zero sends is not a healthy send path — it is silence.
        // Process memory, no query; see shared/lib/email-health.ts.
        email: getEmailHealth(),
        // Ingest liveness. Here for the same reason `parity` is: the fault this
        // reports is precisely the one that gives an operator nothing to be
        // suspicious about. On 2026-08-11 feed-ingest took a stray SIGTERM and
        // nothing restarted it; every container was green, /health was green,
        // and the whole content pipeline was dead for 21 hours until a human
        // noticed their own feeds were stale.
        //
        // TWO SEPARATE QUESTIONS, deliberately not merged into one "ingest OK".
        //
        //   `worker` — is the ingest worker running AT ALL. Derived from the
        //   ABSENCE of a write: the poll stamps feed_ingest_heartbeat every 60s
        //   and this reads its age, so a stopped worker cannot report itself
        //   healthy. `null` heartbeat means it has never written one — which is
        //   `down`, not `unknown`: on a live database the only ways to get here
        //   are a worker that has never run and one whose writes stopped before
        //   this feature shipped, and both want the operator looking. (Contrast
        //   jetstream_healthy, a self-declared boolean that was stuck at `true`
        //   throughout the outage because the process that owns it was gone.)
        //
        //   `protocols` — per-protocol freshness, INFORMATIONAL only, never an
        //   alarm. Each protocol's cadence differs by an order of magnitude and
        //   two are push-driven (atproto's last_fetched_at only moves when a
        //   subscribed account posts; email never sets it at all), so a
        //   threshold here would either cry wolf every quiet night or be so
        //   loose it reports nothing. `lastFetchedAt: null` is rendered as
        //   "never", never as zero or as stale — no measurement is not a bad
        //   measurement.
        ingest: (() => {
          const beat = ingestBeat.rows[0] ?? {}
          const alertSeconds = (() => {
            const v = Number(beat.alert_seconds)
            // Fallback matches config-defaults.sql; parity-tested.
            return Number.isFinite(v) && v > 0 ? v : INGEST_HEARTBEAT_ALERT_SECONDS_FALLBACK
          })()
          const beatAt = beat.heartbeat ? new Date(beat.heartbeat) : null
          const ageSeconds =
            beatAt && !isNaN(beatAt.getTime())
              ? Math.floor((Date.now() - beatAt.getTime()) / 1000)
              : null
          return {
            worker: {
              heartbeatAt: beatAt && !isNaN(beatAt.getTime()) ? beatAt.toISOString() : null,
              ageSeconds,
              alertSeconds,
              // No heartbeat and a stale heartbeat are the same verdict, and it
              // is the loud one.
              down: ageSeconds === null || ageSeconds > alertSeconds,
            },
            protocols: ingestProtocols.rows.map((p: any) => ({
              protocol: p.protocol,
              activeSources: num(p.active_sources),
              lastFetchedAt: p.last_fetched_at ?? null,
              // How many of those active sources we currently cannot read at
              // all, and since when the oldest of them has been that way.
              // Zero is the ordinary answer and is rendered as nothing.
              refusedSources: num(p.refused_sources),
              refusedSince: p.refused_since
                ? new Date(p.refused_since).toISOString()
                : null,
            })),
          }
        })(),
        // Linked-account notifications (CROSS-NETWORK-ROUNDTRIP-ADR C4). The
        // heartbeat is PER PRESENCE and stamped only by a poll that succeeded,
        // so a presence whose poll keeps failing — or a poller that has stopped
        // — ages here rather than reporting itself fine. One that has never
        // been polled ages from its link date: down, never "unknown", once it
        // has had the threshold's worth of chances. Those awaiting a reconnect
        // (a grant from before the notification scopes) are counted apart: a
        // capability the member lacks is not a failure of ours, and an alarm
        // that mixes them is one an operator learns past.
        linkedNotifications: (() => {
          const r = linkedPolls.rows[0] ?? {}
          warnIfMalformedDial('linked_notifications_poll_seconds', r.poll_raw)
          warnIfMalformedDial('linked_notifications_stale_intervals', r.stale_raw)
          const pollSeconds = Number(r.poll_seconds) || LINKED_NOTIFICATIONS_POLL_SECONDS_FALLBACK
          const staleIntervals = Number(r.stale_intervals) || LINKED_NOTIFICATIONS_STALE_INTERVALS_FALLBACK
          return {
            presences: num(r.presences),
            down: num(r.down),
            awaitingReconnect: num(r.awaiting_reconnect),
            staleSeconds: pollSeconds * staleIntervals,
            oldestSuccessAt: r.oldest_success_at ? new Date(r.oldest_success_at).toISOString() : null,
          }
        })(),
        // Dead background jobs (§8.15). The third arm of the same question the
        // two above ask — the worker can be running, and every source fresh,
        // while a scheduled task has failed every night for three months.
        // DEAD_JOBS_SQL's header carries the reasoning; this only shapes it.
        //
        // `readable: false` is a THIRD state beside cron and per-entity, not a
        // zero: the query is the one here that can fail on its own terms, and
        // an unreadable table rendering as "no dead jobs" would be this
        // feature's own failure mode, committed by the feature itself.
        jobs: (() => {
          if (!deadJobs) {
            return { readable: false as const, windowHours: deadJobWindowHours }
          }
          const shape = (row: DeadJobRow) => ({
            task: row.task,
            failed: num(row.failed),
            abandoned: num(row.abandoned),
            retrying: num(row.retrying),
            recent: num(row.recent),
            lastDeadAt: row.last_dead_at ? new Date(row.last_dead_at).toISOString() : null,
            // Truncated for the panel; the whole error is a `docker compose logs`
            // away and a 4KB stack trace in a JSON payload helps nobody.
            lastError: row.last_error ? row.last_error.slice(0, 300) : null,
          })
          const arm = (rows: DeadJobRow[]) => {
            const tasks = rows.map(shape)
            const sum = (k: 'failed' | 'abandoned' | 'retrying' | 'recent') =>
              tasks.reduce((n, t) => n + t[k], 0)
            return {
              tasks: tasks.filter((t) => t.failed + t.abandoned + t.retrying > 0),
              failed: sum('failed'),
              abandoned: sum('abandoned'),
              retrying: sum('retrying'),
              recent: sum('recent'),
              // What the cron banner alarms on: a dead run is a run that did not
              // happen, whether it errored or was abandoned mid-flight.
              dead: sum('failed') + sum('abandoned'),
            }
          }
          return {
            readable: true as const,
            windowHours: deadJobWindowHours,
            cron: arm(deadJobs.rows.filter((r) => r.is_cron)),
            perEntity: arm(deadJobs.rows.filter((r) => !r.is_cron)),
          }
        })(),
        counts: {
          totalAccounts: num(c.total_accounts),
          activeAccounts: num(c.active_accounts),
          readersWithCard: num(c.readers_with_card),
          publishingWriters: num(c.publishing_writers),
          readersEver: num(c.readers_ever),
          openReportCount: num(c.open_report_count),
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard overview failed')
      return reply.status(500).send({ error: 'Failed to load overview' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/users — account metrics + KYC-stuck writers
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/users', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [totals, kyc, funnel] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'active') AS active,
             COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
             COUNT(*) FILTER (WHERE status = 'moderated') AS moderated,
             COUNT(*) FILTER (WHERE status = 'deactivated') AS deactivated,
             COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL) AS with_card,
             -- Card or no card: a card holder spends what is left of the
             -- allowance before anything reaches their tab (walkthrough A1,
             -- 2026-09-24), so "has a card" no longer means "off the allowance".
             COUNT(*) FILTER (WHERE free_allowance_remaining_pence > 0) AS on_free_allowance,
             COUNT(*) FILTER (WHERE free_allowance_remaining_pence <= 0) AS allowance_exhausted,
             COUNT(*) FILTER (WHERE card_action_required_at IS NOT NULL) AS card_action_required,
             -- WHO THE TWO TERMS REFUSALS WILL ACTUALLY TURN AWAY, and nobody
             -- else. Not "has not accepted": most members have no card and
             -- have never sold paid access, so they are not being asked and
             -- counting them would bury the figure that matters under the
             -- whole membership. These two are the pre-text cohorts — a reader
             -- who registered a card before the Reader Terms existed, and a
             -- writer with paid work published before the Writer Agreement did.
             --
             -- Compared on MAJOR ALONE, the same rule as
             -- termsAcceptanceIsCurrent: a text-only bump must not light
             -- this tile up with the entire membership. The versions arrive as
             -- params rather than as literals, so there is only ever one copy.
             COUNT(*) FILTER (
               WHERE stripe_customer_id IS NOT NULL
                 AND split_part(COALESCE(reader_terms_version, ''), '.', 1) IS DISTINCT FROM $1
             ) AS reader_terms_outstanding,
             COUNT(*) FILTER (
               WHERE split_part(COALESCE(writer_terms_version, ''), '.', 1) IS DISTINCT FROM $2
                 AND EXISTS (
                   SELECT 1 FROM articles ar
                    WHERE ar.writer_id = accounts.id
                      AND ar.access_mode = 'paywalled'
                      AND ar.deleted_at IS NULL
                 )
             ) AS writer_terms_outstanding,
             COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS signups_7d,
             COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS signups_30d
           FROM accounts WHERE status <> 'deleted'`,
          [
            termsMajor(currentTermsVersion('reader')),
            termsMajor(currentTermsVersion('writer')),
          ]
        ),
        // Writers holding modeled-but-unpaid earnings who cannot receive a
        // payout: KYC incomplete (or Connect never started). The outstanding
        // figure is the ledger pair difference — earned minus paid out.
        pool.query(
          `SELECT a.id, a.username, a.display_name,
                  (a.stripe_connect_id IS NOT NULL) AS connect_started,
                  COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) AS pending_earnings_pence
           FROM accounts a
           LEFT JOIN ledger_writer_earned e ON e.account_id = a.id
           LEFT JOIN ledger_writer_earnings p ON p.account_id = a.id
           WHERE a.status <> 'deleted'
             AND a.stripe_connect_kyc_complete = FALSE
             AND COALESCE(e.earned_pence, 0) - COALESCE(p.earned_pence, 0) > 0
           ORDER BY pending_earnings_pence DESC
           LIMIT 50`
        ),
        pool.query(
          `SELECT
             (SELECT COUNT(DISTINCT reader_id) FROM read_events) AS readers_ever,
             (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND free_allowance_remaining_pence <= 0) AS exhausted_allowance,
             (SELECT COUNT(*) FROM accounts WHERE status <> 'deleted' AND stripe_customer_id IS NOT NULL) AS connected_card`
        ),
      ])

      const t = totals.rows[0]
      const f = funnel.rows[0]
      const exhausted = num(f.exhausted_allowance)
      const connected = num(f.connected_card)

      return reply.send({
        totals: {
          accounts: num(t.total),
          active: num(t.active),
          suspended: num(t.suspended),
          moderated: num(t.moderated),
          deactivated: num(t.deactivated),
          readersWithCard: num(t.with_card),
          readersOnFreeAllowance: num(t.on_free_allowance),
          readersAllowanceExhausted: num(t.allowance_exhausted),
          cardActionRequired: num(t.card_action_required),
          // Beside the KYC-stuck tile: a writer who cannot publish paid access
          // and a reader who cannot make a paid read are both stuck on
          // something only they can clear, and the operator has no other way
          // to see it.
          readerTermsOutstanding: num(t.reader_terms_outstanding),
          writerTermsOutstanding: num(t.writer_terms_outstanding),
        },
        growth: {
          signupsLast7d: num(t.signups_7d),
          signupsLast30d: num(t.signups_30d),
        },
        kycIncomplete: {
          count: kyc.rows.length,
          writers: kyc.rows.map((w: any) => ({
            id: w.id,
            username: w.username,
            displayName: w.display_name ?? null,
            connectStarted: Boolean(w.connect_started),
            pendingEarningsPence: num(w.pending_earnings_pence),
          })),
        },
        conversionFunnel: {
          totalReadersEver: num(f.readers_ever),
          exhaustedAllowance: exhausted,
          connectedCard: connected,
          conversionRate: exhausted > 0 ? connected / exhausted : null,
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard users failed')
      return reply.status(500).send({ error: 'Failed to load user metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/members — the roster, searchable
  //
  // The tab above this one has been aggregates since it shipped: totals,
  // growth, a conversion funnel and the KYC-stuck list. It could tell the
  // operator that four accounts are suspended and nothing at all about WHICH.
  // Its own closing line said so ("a standalone account search is a
  // follow-on"), and the gap had a sharper edge than a missing screen: the
  // platform's one direct moderation power, POST /admin/suspend/:accountId
  // (moderation.ts), takes an account UUID, and no surface anywhere in the
  // dashboard has ever rendered one. Suspending somebody the operator found
  // herself — rather than through a report — meant psql on the box, which is
  // the same shape of failure §XI was written about: a capability that exists
  // and is unreachable from the only screen that looks.
  //
  // SEARCH IS TYPED, NOT INFERRED. The roster matches a substring against the
  // three things an operator actually holds when they go looking — the address
  // somebody emailed from, the handle on a post, the display name on a card —
  // and does nothing else. No scoring, no "suspicious account" flag, no
  // heuristic about who looks like a test row: the same rule the waitlist
  // panel is built on (CLOSED-BETA-ADR §XI.2, "triage, not policy"), for the
  // same reason — a rule about people belongs to a person reading a screen.
  //
  // THE PATTERN IS ESCAPED. `%` and `_` are ILIKE wildcards, so an operator
  // searching for a literal underscore in a username would otherwise match any
  // character, and a stray `%` would match everybody while looking like it had
  // matched somebody. `likePattern` escapes both (and the escape character
  // itself) — this is not injection defence, the value is still a bound
  // parameter; it is the search meaning what it says.
  //
  // DELETED ROWS ARE OUT UNLESS ASKED FOR. The default list is everyone who
  // still exists; `status=deleted` is how you look at the others, and it is
  // the one filter that widens rather than narrows. `deactivated` is NOT the
  // same state and is never hidden — that is a member's own choice and they
  // are still here.
  //
  // THE COUNTS DO NOT MOVE WHEN THE FILTER DOES. Every per-status count is
  // computed against the SEARCH alone, so switching between Active and
  // Suspended doesn't rewrite the numbers on the buttons you are switching
  // between. `matched` is derived from those same counts rather than a second
  // query, so the two can't disagree.
  //
  // Capped at 200 with an explicit `truncated` flag, like the waitlist: a
  // silent LIMIT reads as "that's everyone" precisely when it isn't.
  // ---------------------------------------------------------------------------
  const ROSTER_CAP = 200

  const MEMBER_STATUSES = [
    'active',
    'suspended',
    'moderated',
    'deactivated',
    'deleted',
  ] as const

  const MembersQuerySchema = z.object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(MEMBER_STATUSES).optional(),
  })

  /**
   * A literal substring as an ILIKE pattern. `%`, `_` and `\` are escaped, so
   * the search matches the characters the operator typed and not the wildcard
   * they didn't know they were writing. Paired with `ESCAPE '\'` in the SQL.
   */
  const likePattern = (q: string): string =>
    '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'

  app.get('/admin/dashboard/members', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = MembersQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const q = parsed.data.q ? likePattern(parsed.data.q) : null
    const status = parsed.data.status ?? null

    try {
      const [counts, rows] = await Promise.all([
        // Cast on the first use, then again where the type differs — node-
        // postgres sends parameters untyped and infers from first use, so an
        // uncast `$1` here would be resolved by whichever comparison Postgres
        // reached first.
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'active') AS active,
             COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
             COUNT(*) FILTER (WHERE status = 'moderated') AS moderated,
             COUNT(*) FILTER (WHERE status = 'deactivated') AS deactivated,
             COUNT(*) FILTER (WHERE status = 'deleted') AS deleted
           FROM accounts
           WHERE ($1::text IS NULL
                  OR email ILIKE $1::text ESCAPE '\\'
                  OR username ILIKE $1::text ESCAPE '\\'
                  OR display_name ILIKE $1::text ESCAPE '\\')`,
          [q]
        ),
        pool.query(
          `SELECT a.id, a.username, a.display_name, a.email, a.status::text AS status,
                  a.created_at, a.onboarded_at,
                  (a.stripe_customer_id IS NOT NULL) AS has_card,
                  (a.stripe_connect_id IS NOT NULL) AS connect_started,
                  a.stripe_connect_kyc_complete,
                  a.reader_terms_version, a.writer_terms_version,
                  h.mismatch_class AS halt_class, h.created_at AS halt_since,
                  COALESCE(p.published, 0) AS articles_published
             FROM accounts a
             LEFT JOIN payouts_halted_accounts h ON h.account_id = a.id
             LEFT JOIN (
                   SELECT writer_id, COUNT(*) AS published
                     FROM articles
                    WHERE deleted_at IS NULL AND published_at IS NOT NULL
                    GROUP BY writer_id
                 ) p ON p.writer_id = a.id
            WHERE ($1::text IS NOT NULL OR a.status <> 'deleted')
              AND ($1::text IS NULL OR a.status = $1::account_status)
              AND ($2::text IS NULL
                   OR a.email ILIKE $2::text ESCAPE '\\'
                   OR a.username ILIKE $2::text ESCAPE '\\'
                   OR a.display_name ILIKE $2::text ESCAPE '\\')
            ORDER BY a.created_at DESC
            LIMIT $3`,
          [status, q, ROSTER_CAP + 1]
        ),
      ])

      const c = counts.rows[0]
      const byStatus = {
        active: num(c.active),
        suspended: num(c.suspended),
        moderated: num(c.moderated),
        deactivated: num(c.deactivated),
        deleted: num(c.deleted),
      }
      // Derived from the counts above rather than asked for separately, so the
      // number under the list and the numbers on the filters cannot disagree.
      // With no filter the list excludes deleted rows, and so does this.
      const matched = status
        ? byStatus[status]
        : byStatus.active + byStatus.suspended + byStatus.moderated + byStatus.deactivated

      const truncated = rows.rows.length > ROSTER_CAP
      const shown = truncated ? rows.rows.slice(0, ROSTER_CAP) : rows.rows

      return reply.send({
        byStatus,
        matched,
        truncated,
        shown: shown.length,
        members: shown.map((r: any) => ({
          id: r.id as string,
          username: (r.username as string | null) ?? null,
          displayName: (r.display_name as string | null) ?? null,
          // An account can exist with no address — a seeded dev account, and
          // anyone who arrived by a route that never asked for one. NULL here
          // means we do not have one, never that it is hidden.
          email: (r.email as string | null) ?? null,
          status: r.status as string,
          joinedAt: new Date(r.created_at).toISOString(),
          // The member-level once-per-member gate (feeds rule). Absent means
          // they have never finished arriving, which is a different thing from
          // never having come back.
          onboardedAt: r.onboarded_at ? new Date(r.onboarded_at).toISOString() : null,
          hasCard: Boolean(r.has_card),
          connectStarted: Boolean(r.connect_started),
          connectKycComplete: Boolean(r.stripe_connect_kyc_complete),
          // Which legal text this member accepted — the version string as
          // stored, not a boolean. NULL means they have never accepted that
          // text; a version that is not the current one is a member who
          // accepted an older one, and the roster shows the difference rather
          // than collapsing both into "no". Nothing here refuses anything.
          readerTermsVersion: (r.reader_terms_version as string | null) ?? null,
          writerTermsVersion: (r.writer_terms_version as string | null) ?? null,
          articlesPublished: num(r.articles_published),
          // WHETHER THIS MEMBER'S PAYOUTS ARE FROZEN, and under what — read
          // here so the row can say so and so the freeze button is not offered
          // on somebody already frozen. It is a fact about their MONEY and not
          // about their status: a frozen member is otherwise an ordinary
          // member, which is exactly what makes the freeze silent and exactly
          // why the roster has to render it rather than leave it on a page the
          // operator is not looking at.
          payoutsHalted: r.halt_class
            ? {
                mismatchClass: r.halt_class as string,
                since: new Date(r.halt_since).toISOString(),
              }
            : null,
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard members failed')
      return reply.status(500).send({ error: 'Failed to load the member list' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/content — publishing activity + system health
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/content', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [articles, notes, engagement, drives, health] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total_published,
             COUNT(*) FILTER (WHERE published_at > now() - interval '7 days') AS published_7d,
             COUNT(*) FILTER (WHERE published_at > now() - interval '30 days') AS published_30d,
             COUNT(*) FILTER (WHERE access_mode = 'paywalled') AS paywalled,
             COUNT(*) FILTER (WHERE access_mode <> 'paywalled') AS free,
             ROUND(AVG(price_pence) FILTER (WHERE access_mode = 'paywalled')) AS avg_price_pence
           FROM articles WHERE published_at IS NOT NULL AND deleted_at IS NULL`
        ),
        pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE published_at > now() - interval '7 days') AS last_7d,
                  COUNT(*) FILTER (WHERE published_at > now() - interval '30 days') AS last_30d
           FROM notes`
        ),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM read_events) AS reads_total,
             (SELECT COUNT(*) FROM read_events WHERE read_at > now() - interval '7 days') AS reads_7d,
             (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments_total,
             (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL AND published_at > now() - interval '7 days') AS comments_7d,
             (SELECT COUNT(*) FROM votes) AS votes_total,
             (SELECT COUNT(*) FROM votes WHERE created_at > now() - interval '7 days') AS votes_7d`
        ),
        // Pledge drives are parked behind PLEDGES_ENABLED — counts stay
        // visible here (operator surface) so parked money is never invisible.
        pool.query(
          `SELECT status, COUNT(*) AS n FROM pledge_drives GROUP BY status`
        ),
        pool.query(
          `SELECT
             (SELECT MAX(scored_at) FROM feed_scores) AS feed_scores_refreshed_at,
             (SELECT value FROM platform_config WHERE key = 'jetstream_healthy') AS jetstream_healthy,
             (SELECT COUNT(*) FROM relay_outbox WHERE status = 'pending') AS outbox_pending,
             (SELECT MIN(created_at) FROM relay_outbox WHERE status = 'pending') AS outbox_oldest_pending_at,
             (SELECT COUNT(*) FROM relay_outbox WHERE status IN ('failed', 'abandoned')) AS outbox_failed`
        ),
      ])

      const a = articles.rows[0]
      const n = notes.rows[0]
      const e = engagement.rows[0]
      const h = health.rows[0]
      const driveRow = (status: string) => num(drives.rows.find((x: any) => x.status === status)?.n)
      const pledged = await pool.query(
        `SELECT COALESCE(SUM(current_total_pence), 0) AS total FROM pledge_drives WHERE status IN ('open', 'funded')`
      )
      const refreshedAt = h.feed_scores_refreshed_at ? new Date(h.feed_scores_refreshed_at) : null

      return reply.send({
        articles: {
          totalPublished: num(a.total_published),
          publishedLast7d: num(a.published_7d),
          publishedLast30d: num(a.published_30d),
          paywalledCount: num(a.paywalled),
          freeCount: num(a.free),
          avgPricePence: a.avg_price_pence === null ? null : num(a.avg_price_pence),
        },
        notes: {
          total: num(n.total),
          last7d: num(n.last_7d),
          last30d: num(n.last_30d),
        },
        engagement: {
          totalReadEvents: num(e.reads_total),
          readEventsLast7d: num(e.reads_7d),
          totalComments: num(e.comments_total),
          commentsLast7d: num(e.comments_7d),
          totalVotes: num(e.votes_total),
          votesLast7d: num(e.votes_7d),
        },
        drives: {
          openCount: driveRow('open'),
          fundedCount: driveRow('funded'),
          publishedCount: driveRow('published'),
          fulfilledCount: driveRow('fulfilled'),
          activePledgedPence: num(pledged.rows[0].total),
        },
        health: {
          feedScoresRefreshedAt: h.feed_scores_refreshed_at ?? null,
          feedScoresStalenessMinutes: refreshedAt
            ? Math.floor((Date.now() - refreshedAt.getTime()) / 60_000)
            : null,
          jetstreamHealthy: h.jetstream_healthy === null ? null : h.jetstream_healthy === 'true',
          relayOutboxPending: num(h.outbox_pending),
          relayOutboxOldestPendingAt: h.outbox_oldest_pending_at ?? null,
          relayOutboxFailed: num(h.outbox_failed),
        },
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard content failed')
      return reply.status(500).send({ error: 'Failed to load content metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/config — every platform_config row
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/config', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT key, value, description, updated_at FROM platform_config ORDER BY key`
      )
      return reply.send({
        config: rows.map((r: any) => ({
          key: r.key,
          value: r.value,
          description: r.description ?? null,
          updatedAt: r.updated_at,
          readOnly: STATE_KEYS.has(r.key),
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard config read failed')
      return reply.status(500).send({ error: 'Failed to load config' })
    }
  })

  // ---------------------------------------------------------------------------
  // PATCH /admin/dashboard/config — update existing keys only
  //
  // Never inserts: new dials go through shared/src/db/config-defaults.sql
  // (the platform_config invariant). Numeric keys must stay numeric; *_bps
  // keys must stay within 0..10000; runtime-state keys are not editable.
  // ---------------------------------------------------------------------------
  app.patch('/admin/dashboard/config', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = PatchConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    try {
      const keys = parsed.data.updates.map((u) => u.key)
      const { rows: existing } = await pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM platform_config WHERE key = ANY($1)`,
        [keys]
      )
      const existingByKey = new Map(existing.map((r) => [r.key, r.value]))

      // Validate the whole batch before touching anything
      for (const u of parsed.data.updates) {
        if (STATE_KEYS.has(u.key)) {
          return reply
            .status(400)
            .send({ error: `'${u.key}' is runtime state, not an operator dial` })
        }
        const current = existingByKey.get(u.key)
        if (current === undefined) {
          return reply.status(400).send({
            error: `Unknown config key '${u.key}' — new dials are added via config-defaults.sql, not the dashboard`,
          })
        }
        if (NUMERIC_RE.test(current) && !NUMERIC_RE.test(u.value)) {
          return reply
            .status(400)
            .send({ error: `'${u.key}' is numeric; got a non-numeric value` })
        }
        // A whole-number dial takes a whole number (CA-F2): "20.00" for a
        // pence threshold was accepted here and read as 20p. The fractional
        // dials (gravity, alphas, bands) keep NUMERIC_RE alone.
        if (isIntegerDialKey(u.key) && !/^-?\d+$/.test(u.value)) {
          return reply
            .status(400)
            .send({ error: `'${u.key}' is a whole number; got '${u.value}'` })
        }
        if (u.key.endsWith('_bps')) {
          const v = Number(u.value)
          if (!Number.isInteger(v) || v < 0 || v > 10_000) {
            return reply
              .status(400)
              .send({ error: `'${u.key}' must be an integer between 0 and 10000` })
          }
        }
        if (u.key.endsWith('_pct')) {
          const v = Number(u.value)
          if (!Number.isFinite(v) || v < 0 || v > 100) {
            return reply.status(400).send({ error: `'${u.key}' must be between 0 and 100` })
          }
        }
      }

      // One transaction: a mid-batch failure rolls the whole batch back
      // instead of leaving an unreported partial apply. rowCount is checked
      // even though existence was pre-validated above — a key DELETEd between
      // the check and the write would otherwise no-op silently (the bare-
      // UPDATE-matches-zero-rows hazard the platform_config invariant names).
      const applied: { key: string; oldValue: string | undefined; newValue: string }[] = []
      await withTransaction(async (client) => {
        for (const u of parsed.data.updates) {
          const oldValue = existingByKey.get(u.key)
          if (oldValue === u.value) continue
          const result = await client.query(
            `UPDATE platform_config SET value = $2, updated_at = now() WHERE key = $1`,
            [u.key, u.value]
          )
          if (result.rowCount !== 1) {
            throw new Error(`config key '${u.key}' vanished mid-update`)
          }
          // THE EVIDENCE, IN THE SAME TRANSACTION AS THE CHANGE (L5.2,
          // migration 209). Outside it, a crash between the two leaves either a
          // change nobody can account for or a record of one that never
          // happened — and afterwards there is no way to tell which. The pino
          // line below still fires, for the operator watching a terminal; this
          // is the row that survives log retention and can be read beside the
          // dial it describes. A no-op edit (`oldValue === u.value`) is skipped
          // above and therefore records nothing: it changed nothing.
          await recordConfigAudit(client, {
            actorAccountId: adminId,
            key: u.key,
            oldValue: oldValue ?? null,
            newValue: u.value,
            reason: parsed.data.reason,
          })
          applied.push({ key: u.key, oldValue, newValue: u.value })
        }
      })
      // Drop this process's 30s config cache, or the operator's own UPDATE is
      // invisible to the gateway that just made it for up to half a minute —
      // long enough to reload the page, see the old number and change it again.
      // This is the "known config write" invalidatePlatformConfig documents, and
      // it was the only one; nothing called it (found via knip, 2026-08-24).
      // Other processes keep their own caches and still age out on the TTL.
      if (applied.length > 0) invalidatePlatformConfig()
      // The admin set has its own 60s cache (`getAdminIds`), so an operator who
      // adds or removes an admin sees it take effect on the next request here,
      // not a minute later (CA-I8). Other processes age out on the TTL.
      if (applied.some((a) => a.key === 'admin_account_ids')) invalidateAdminIdsCache()

      // Log after commit so a rolled-back batch leaves no "changed" lines.
      for (const entry of applied) {
        logger.info(
          { adminId, ...entry },
          'platform_config changed via owner dashboard'
        )
      }

      return reply.send({ ok: true, updated: applied.length })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard config update failed')
      return reply.status(500).send({ error: 'Failed to update config' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/regulatory — revenue vs UK thresholds, custody
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/regulatory', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const [cfg, revenue, custody] = await Promise.all([
        pool.query<{ key: string; value: string }>(
          `SELECT key, value FROM platform_config WHERE key = ANY($1)`,
          [Object.keys(REGULATORY_DIAL_DEFAULTS)]
        ),
        pool.query(
          `SELECT
             COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at > now() - interval '12 months'), 0) AS rolling_12m,
             COALESCE(SUM(platform_fee_pence) FILTER (WHERE settled_at >= date_trunc('month', now())), 0) AS current_month
           FROM tab_settlements WHERE status = 'completed'`
        ),
        pool.query(
          `SELECT COALESCE(SUM(chargeable_pence), 0) AS total_held_pence,
                  MIN(read_at) AS oldest_held_read_at
           FROM read_events
           -- Unclaimed by EITHER cycle (migration 168) — see the ops-overview
           -- twin, which also carries why this is chargeable_pence and why it
           -- stays gross of the platform fee. The two must agree: they are the
           -- same figure on two pages.
           WHERE state = 'platform_settled'
             AND writer_payout_id IS NULL AND publication_payout_id IS NULL`
        ),
      ])

      const dial = (key: RegulatoryDial): number => {
        const row = cfg.rows.find((r) => r.key === key)
        const v = row ? Number(row.value) : NaN
        return Number.isFinite(v) ? v : REGULATORY_DIAL_DEFAULTS[key]
      }

      const tradingAllowancePence = dial('tax_trading_allowance_pence')
      const vatThresholdPence = dial('tax_vat_threshold_pence')
      const vatWarningPct = dial('tax_vat_warning_pct')
      const corpSmallProfitsPence = dial('tax_corp_small_profits_pence')
      const corpMainRatePence = dial('tax_corp_main_rate_pence')
      const holdingWarningDays = dial('regulatory_holding_warning_days')

      const rolling12m = num(revenue.rows[0].rolling_12m)
      const currentMonth = num(revenue.rows[0].current_month)
      const cu = custody.rows[0]
      const oldestHeld = cu.oldest_held_read_at ? new Date(cu.oldest_held_read_at) : null
      const oldestHeldDays = oldestHeld
        ? Math.floor((Date.now() - oldestHeld.getTime()) / 86_400_000)
        : 0

      const vatPct = vatThresholdPence > 0 ? (rolling12m / vatThresholdPence) * 100 : 0

      return reply.send({
        rolling12MonthRevenuePence: rolling12m,
        currentMonthRevenuePence: currentMonth,
        annualisedRunRatePence: currentMonth * 12,
        thresholds: {
          tradingAllowance: {
            thresholdPence: tradingAllowancePence,
            currentPence: rolling12m,
            percentUsed:
              tradingAllowancePence > 0 ? (rolling12m / tradingAllowancePence) * 100 : 0,
            status: rolling12m > tradingAllowancePence ? 'exceeded' : 'within',
          },
          vatRegistration: {
            thresholdPence: vatThresholdPence,
            warningPct: vatWarningPct,
            currentPence: rolling12m,
            percentUsed: vatPct,
            status:
              vatPct >= 100 ? 'exceeded' : vatPct >= vatWarningPct ? 'approaching' : 'clear',
          },
          corporationTax: {
            smallProfitsThresholdPence: corpSmallProfitsPence,
            mainRateThresholdPence: corpMainRatePence,
            // Revenue, not profit — the UI labels this caveat.
            currentRevenuePence: rolling12m,
            status:
              rolling12m > corpMainRatePence
                ? 'main_rate'
                : rolling12m > corpSmallProfitsPence
                  ? 'marginal_relief'
                  : 'below_small_profits',
          },
        },
        custody: {
          totalHeldPence: num(cu.total_held_pence),
          oldestHeldDays,
          warningThresholdDays: holdingWarningDays,
          status: oldestHeldDays > holdingWarningDays ? 'warning' : 'normal',
        },
        financialYear: ukFinancialYear(new Date()),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard regulatory failed')
      return reply.status(500).send({ error: 'Failed to load regulatory metrics' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/waitlist — the closed-beta waiting list, read-only
  //
  // CLOSED-BETA-ADR §XI.2. The list has been write-only since migration 162:
  // POST /waitlist stores a prospect and nothing reads the table, so the only
  // way to see who was waiting was psql on the box — which is how a real
  // prospect went unnoticed for eight hours on 2026-07-27. The digest (§XI.4)
  // now says the count moved; this says WHO, which is the half an operator
  // needs to pick a cohort.
  //
  // NO `publish_interest` ANYWHERE HERE (2026-07-27). The "I'd also like to
  // publish" tickbox was removed from the page, and its tile and column went
  // with it rather than being left to report on a question nobody is being
  // asked. The COLUMN survives — those were answers people gave, and ceasing to
  // ask is not the same as deleting what was said — but nothing reads it.
  //
  // The admission state (migration 163) rides along: `admittedAt` says an
  // account exists for this address, `invitedAt` says the invitation email
  // actually went. Since the admit/invite split (RESHAPE-PLAN-2026-10 §A.2.2)
  // "admitted, not invited" is ALSO the ordinary state of a cohort waiting to
  // be told, so it is no longer the failure signal: `inviteFailedAt` is, set
  // by a send that failed and cleared by a good one. `inSeed` says whether
  // the member is in the designated seed (NULL with nothing designated) —
  // false on an admitted row is the repair cue, and admitting again re-runs
  // the append. `arrived` says whether they have signed in (the age
  // declaration), which is when other members' source lists start naming them.
  //
  // NO FILTERING, BY DESIGN. The list attracts disposable addresses — one of
  // the first three real rows was from a temp-mail domain. The domain is right
  // there in the address for an operator to read; auto-rejecting a domain list
  // is a policy decision with false positives, and it belongs to a person
  // looking at a screen, not to a heuristic in a route. Sort and see.
  //
  // The cap is 500 with an explicit `truncated` flag rather than pagination:
  // the beta is 20–30 people, but a silent LIMIT would read as "that's
  // everyone" precisely when it isn't.
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/waitlist', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const CAP = 500
      const [totals, entries, digest] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS joined_7d,
                  COUNT(*) FILTER (WHERE admitted_at IS NOT NULL) AS admitted,
                  COUNT(*) FILTER (WHERE admitted_at IS NOT NULL AND invited_at IS NULL) AS admitted_not_invited,
                  COUNT(*) FILTER (WHERE admitted_at IS NOT NULL AND invited_at IS NULL
                                     AND invite_failed_at IS NOT NULL) AS invite_failed
             FROM waitlist`
        ),
        pool.query(
          `SELECT w.email, w.created_at,
                  w.admitted_at, w.invited_at, w.invite_failed_at, a.username,
                  CASE WHEN a.id IS NULL OR a.status = 'deleted' THEN NULL
                       ELSE a.age_declared_at IS NOT NULL END AS arrived,
                  -- NULL, not false, for a DELETED account: the replay skips
                  -- one (skippedGone), so there is nothing to repair and the
                  -- panel must not offer to.
                  CASE WHEN a.id IS NULL OR a.status = 'deleted' OR seed.id IS NULL THEN NULL
                       ELSE EXISTS (SELECT 1 FROM feed_formula_sources s
                                     WHERE s.formula_id = seed.id AND s.source_type = 'account'
                                       AND s.tag_value = a.nostr_pubkey)
                  END AS in_seed
             FROM waitlist w
             LEFT JOIN accounts a ON a.id = w.admitted_account_id
             LEFT JOIN feed_formulas seed ON seed.is_default_seed
            ORDER BY w.created_at DESC
            LIMIT $1`,
          [CAP + 1]
        ),
        // When the operator was last told. The digest is the only thing that
        // reports this list unprompted, so "last told" belongs beside it —
        // absent means never, which is the honest cold-start reading.
        pool.query(
          `SELECT value FROM platform_config WHERE key = 'waitlist_digest_last_sent_at'`
        ),
      ])

      const t = totals.rows[0]
      const truncated = entries.rows.length > CAP
      const rows = truncated ? entries.rows.slice(0, CAP) : entries.rows

      return reply.send({
        totals: {
          total: num(t.total),
          joinedLast7d: num(t.joined_7d),
          admitted: num(t.admitted),
          admittedNotInvited: num(t.admitted_not_invited),
          inviteFailed: num(t.invite_failed),
        },
        lastDigestAt: digest.rows[0]?.value ?? null,
        truncated,
        shown: rows.length,
        entries: rows.map((r: any) => ({
          email: r.email as string,
          joinedAt: new Date(r.created_at).toISOString(),
          admittedAt: r.admitted_at ? new Date(r.admitted_at).toISOString() : null,
          invitedAt: r.invited_at ? new Date(r.invited_at).toISOString() : null,
          inviteFailedAt: r.invite_failed_at ? new Date(r.invite_failed_at).toISOString() : null,
          inSeed: (r.in_seed as boolean | null) ?? null,
          // NULL with no account behind the row, like `username`.
          arrived: (r.arrived as boolean | null) ?? null,
          // NULL for an unadmitted row, and also for one whose member has since
          // deleted their account (the FK is ON DELETE SET NULL) — the panel
          // reads it as "admitted, account gone", not as "never admitted",
          // because admittedAt is what answers that.
          username: (r.username as string | null) ?? null,
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard waitlist failed')
      return reply.status(500).send({ error: 'Failed to load the waiting list' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/waitlist/admit — admit a batch of waitlisters
  //
  // CLOSED-BETA-ADR §XI.2 "Actions", as split by RESHAPE-PLAN-2026-10 §A.2.
  // ADMITTING AND INVITING ARE TWO ACTS NOW: this route makes accounts and
  // appends each new member to the default seed, and SENDS NOTHING. A cohort
  // is admitted first and invited together (POST …/waitlist/invite), so each
  // member's first workspace load finds the whole cohort in their seed feed —
  // the seed is a snapshot taken at that load, and anyone admitted after it is
  // not in it.
  //
  // Per row, in this order, and the order is the design:
  //
  //   1. CLAIM the row (`admitted_at IS NULL` → now()). One statement, so two
  //      concurrent admits — a double-click, two admin tabs — race on the
  //      database and exactly one wins. The loser reads the row back to find
  //      out WHICH outcome it lost to — already admitted, or removed out from
  //      under it — rather than reporting the one it assumed.
  //   2. Find-or-create the account. `provisionAccount` deliberately BYPASSES
  //      the CLOSED_BETA gate: that constant exists to reserve account creation
  //      to a human decision, and this IS that decision, taken by an admin
  //      behind requireAdmin. A prospect who is already a member (the operator
  //      testing the form with their own address) is LINKED, not duplicated —
  //      accounts.email is unique, so a blind insert would 500. Only a CREATED
  //      account is marked `provisioned_by_admit`, which is what keeps its
  //      email-derived name out of other members' source lists until its owner
  //      arrives (feeds/sources.ts › accountArrivedSql).
  //   3. Append the account to the designated seed (`appendAccountToSeed`), in
  //      its own transaction with its `config_audit` row. `provisionAccount`
  //      commits on its own, so this cannot share its transaction; an append
  //      that fails afterwards leaves a member who exists but is not in the
  //      seed. So RE-ADMITTING AN ADMITTED ROW RE-RUNS THE APPEND — a no-op
  //      when the row is there — rather than answering `already_admitted`, and
  //      every result says what the append did.
  //
  // RESERVE→CREATE→CONFIRM, so a failure between the claim and the account is
  // not a stuck row: if provisioning throws, the claim is RELEASED (guarded on
  // `admitted_account_id IS NULL`, so it can never clobber a concurrent
  // success) and the operator can simply press again.
  //
  // A PARTIAL OUTCOME IS NOT A TOTAL ONE. The batch runs row by row; a failure
  // on one row is a fact about that row, the loop does not abort, and the
  // shortfall ships beside the total. `reason` is the operator's one note for
  // the batch (the cohort's name is enough) and lands on every append's audit
  // row, which is what makes the trail readable later.
  // ---------------------------------------------------------------------------
  const WAITLIST_BATCH_MAX = 200
  const AdmitSchema = z.object({
    emails: z.array(z.string().trim().max(254).email()).min(1).max(WAITLIST_BATCH_MAX),
    reason: z.string().trim().min(1).max(500),
  })

  type SeedResult = SeedAppendOutcome | 'error'
  type AdmitRowResult =
    | {
        email: string
        outcome: 'admitted' | 'already_admitted'
        accountCreated: boolean
        username: string | null
        seed: SeedResult
      }
    | { email: string; outcome: 'not_on_list' | 'removed_meanwhile' | 'admit_in_progress' | 'error' }

  async function appendToSeedFor(accountId: string, adminId: string, reason: string): Promise<SeedResult> {
    try {
      return await withTransaction((client) =>
        appendAccountToSeed(client, { accountId, actorId: adminId, reason })
      )
    } catch (err) {
      // The admission stands — the account is real — and the row says the
      // append did not happen, which is the repair cue: admitting again
      // re-runs it.
      logger.error({ err, accountId }, 'waitlist admit: seed append failed — member exists, not in the seed')
      return 'error'
    }
  }

  async function admitOne(email: string, adminId: string, reason: string): Promise<AdmitRowResult> {
    const existingRow = await pool.query<{
      id: string
      admitted_at: Date | null
      admitted_account_id: string | null
    }>(
      `SELECT id, admitted_at, admitted_account_id
         FROM waitlist WHERE email = $1`,
      [email]
    )
    // A real reason, not a blurred one: this is behind requireAdmin, so there
    // is no enumeration surface here, and blurring would hide a typo from the
    // one person who can fix it.
    if (existingRow.rows.length === 0) return { email, outcome: 'not_on_list' }
    const row = existingRow.rows[0]

    if (row.admitted_at) {
      // The repair path. With no account behind the stamp, either another
      // press is between its claim and its account, or one failed AND its
      // release failed too (logged loudly below) — indistinguishable from
      // here, and neither is this call's to append for.
      if (!row.admitted_account_id) return { email, outcome: 'admit_in_progress' }
      const account = await pool.query<{ username: string | null }>(
        'SELECT username FROM accounts WHERE id = $1',
        [row.admitted_account_id]
      )
      return {
        email,
        outcome: 'already_admitted',
        accountCreated: false,
        username: account.rows[0]?.username ?? null,
        seed: await appendToSeedFor(row.admitted_account_id, adminId, reason),
      }
    }

    // 1. Claim.
    const claim = await pool.query<{ id: string }>(
      `UPDATE waitlist SET admitted_at = now()
        WHERE id = $1 AND admitted_at IS NULL
        RETURNING id`,
      [row.id]
    )
    if (claim.rows.length === 0) {
      // A concurrent admit took the row, or a concurrent remove deleted it.
      // Read back rather than assume: "already admitted" for a row that no
      // longer exists would tell the operator someone is a member when
      // nothing was created.
      const still = await pool.query('SELECT admitted_at FROM waitlist WHERE id = $1', [row.id])
      if (still.rows.length === 0) return { email, outcome: 'removed_meanwhile' }
      return { email, outcome: 'admit_in_progress' }
    }

    let accountId: string
    let username: string | null
    let accountCreated = false
    try {
      // 2. Find-or-create.
      const account = await pool.query<{ id: string; username: string | null }>(
        'SELECT id, username FROM accounts WHERE email = $1',
        [email]
      )
      if (account.rows.length > 0) {
        accountId = account.rows[0].id
        username = account.rows[0].username
      } else {
        // Display name from the local part — it is all a waitlist row
        // carries, and the member renames themselves once they are in.
        const provisioned = await provisionAccount(email, email.split('@')[0], null, {
          byAdmit: true,
        })
        accountId = provisioned.accountId
        username = provisioned.username
        accountCreated = true
      }

      await pool.query('UPDATE waitlist SET admitted_account_id = $1 WHERE id = $2', [
        accountId,
        row.id,
      ])
    } catch (err) {
      // Release the claim so a retry is possible. Guarded on
      // admitted_account_id IS NULL: if a concurrent admit somehow got
      // further than this one, its stamp survives.
      await pool
        .query(
          `UPDATE waitlist SET admitted_at = NULL
            WHERE id = $1 AND admitted_account_id IS NULL`,
          [row.id]
        )
        .catch((releaseErr) => {
          // The release itself failing leaves a claimed row with no account —
          // the one state that needs a human, so say so loudly rather than
          // burying it under the provisioning error.
          logger.error(
            { err: releaseErr, cause: err, waitlistId: row.id },
            'waitlist admit: FAILED TO RELEASE CLAIM — row is admitted with no account'
          )
        })
      throw err
    }

    // 3. Append. An admit that LINKED an existing account appends too; the
    // index makes that harmless.
    const seed = await appendToSeedFor(accountId, adminId, reason)
    logger.info(
      { adminId, waitlistId: row.id, accountId, accountCreated, seed },
      'waitlist admit'
    )
    return { email, outcome: 'admitted', accountCreated, username, seed }
  }

  app.post('/admin/dashboard/waitlist/admit', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AdmitSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string
    // POST /waitlist lower-cases before insert, so the stored key is
    // lower-case and the lookup has to match it. De-duplicated after folding,
    // or one address typed twice would race itself.
    const emails = [...new Set(parsed.data.emails.map((e) => e.toLowerCase().trim()))]

    const results: AdmitRowResult[] = []
    for (const email of emails) {
      try {
        results.push(await admitOne(email, adminId, parsed.data.reason))
      } catch (err) {
        req.log.error({ err, email: email.slice(0, 3) + '***' }, 'waitlist admit: row failed')
        results.push({ email, outcome: 'error' })
      }
    }
    const done = results.filter((r) => r.outcome === 'admitted' || r.outcome === 'already_admitted')
    return reply.send({
      results,
      admitted: results.filter((r) => r.outcome === 'admitted').length,
      // Everything that did not end with an account — counted, never omitted.
      skipped: results.length - done.length,
      seedAppended: done.filter((r) => 'seed' in r && r.seed === 'appended').length,
    })
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/waitlist/invite — tell admitted members they are in
  //
  // The second act of the split (RESHAPE-PLAN-2026-10 §A.2.2). `{ emails }`
  // invites those rows; `{ allPending: true }` invites every admitted row not
  // yet told — the "invite the cohort" press.
  //
  // THE CLAIM IS THE ONE THE OLD SINGLE ROUTE USED, AND FOR THE SAME REASON.
  // `invited_at` is stamped FIRST (`invited_at IS NULL` → now()) and released
  // when the send fails: without it, two presses both read the row as untold
  // and the person gets two emails. Two presses contend on one statement and
  // exactly one sends.
  //
  // A FAILED SEND NEEDS ITS OWN SIGNAL. "Admitted, not invited" used to arise
  // only from a failed send; it is now also the ordinary state of a cohort
  // waiting to be told, so the release branch stamps `invite_failed_at` and a
  // good send clears it. The panel reads that, not the absence of
  // `invited_at`, to put a row in red.
  //
  // THE EMAIL'S FAILURE UNDOES NOTHING (D7's rule, applied to admission). The
  // account is the product; the message is the courtesy.
  // ---------------------------------------------------------------------------
  const InviteSchema = z.union([
    z.object({ emails: z.array(z.string().trim().max(254).email()).min(1).max(WAITLIST_BATCH_MAX) }),
    z.object({ allPending: z.literal(true) }),
  ])

  type InviteOutcome =
    | 'invited'
    | 'send_failed'
    | 'already_invited'
    | 'not_admitted'
    | 'admit_in_progress'
    | 'not_on_list'
    | 'error'

  async function inviteOne(email: string): Promise<InviteOutcome> {
    const found = await pool.query<{
      id: string
      admitted_at: Date | null
      invited_at: Date | null
      admitted_account_id: string | null
    }>(
      `SELECT id, admitted_at, invited_at, admitted_account_id FROM waitlist WHERE email = $1`,
      [email]
    )
    if (found.rows.length === 0) return 'not_on_list'
    const row = found.rows[0]
    if (!row.admitted_at) return 'not_admitted'
    // Never invite someone to an account this call cannot confirm exists.
    if (!row.admitted_account_id) return 'admit_in_progress'
    if (row.invited_at) return 'already_invited'

    const inviteClaim = await pool.query<{ id: string }>(
      `UPDATE waitlist SET invited_at = now()
        WHERE id = $1 AND invited_at IS NULL
        RETURNING id`,
      [row.id]
    )
    // Someone else's press is sending it, or already has.
    if (inviteClaim.rows.length === 0) return 'already_invited'

    try {
      await sendWaitlistInviteEmail(email)
    } catch (err) {
      // Release the stamp and say the send failed. The admission stands; the
      // row must go on saying "not yet told", now marked as a failure so the
      // retry cue stands out from rows nobody has tried yet.
      await pool
        .query(
          `UPDATE waitlist SET invited_at = NULL, invite_failed_at = now() WHERE id = $1`,
          [row.id]
        )
        .catch((releaseErr) => {
          logger.error(
            { err: releaseErr, cause: err, waitlistId: row.id },
            'waitlist invite: FAILED TO RELEASE INVITE STAMP — row reads as told when it was not'
          )
        })
      logger.error(
        { err, waitlistId: row.id, email: email.slice(0, 3) + '***' },
        'waitlist invite: invitation email failed — admission stands, not yet told'
      )
      return 'send_failed'
    }
    await pool.query(`UPDATE waitlist SET invite_failed_at = NULL WHERE id = $1`, [row.id])
    return 'invited'
  }

  app.post('/admin/dashboard/waitlist/invite', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = InviteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    let emails: string[]
    if ('allPending' in parsed.data) {
      try {
        const { rows } = await pool.query<{ email: string }>(
          `SELECT email FROM waitlist
            WHERE admitted_at IS NOT NULL AND admitted_account_id IS NOT NULL
              AND invited_at IS NULL
            ORDER BY admitted_at ASC`
        )
        emails = rows.map((r) => r.email)
      } catch (err) {
        req.log.error({ err }, 'waitlist invite: pending read failed')
        return reply.status(500).send({ error: 'Failed to read the admitted rows' })
      }
    } else {
      emails = [...new Set(parsed.data.emails.map((e) => e.toLowerCase().trim()))]
    }

    const results: Array<{ email: string; outcome: InviteOutcome }> = []
    for (const email of emails) {
      try {
        results.push({ email, outcome: await inviteOne(email) })
      } catch (err) {
        req.log.error({ err, email: email.slice(0, 3) + '***' }, 'waitlist invite: row failed')
        results.push({ email, outcome: 'error' })
      }
    }
    const invited = results.filter((r) => r.outcome === 'invited').length
    logger.info({ adminId, asked: results.length, invited }, 'waitlist invite')
    return reply.send({ results, invited, skipped: results.length - invited })
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/waitlist/remove — drop one waitlister off the list
  //
  // CLOSED-BETA-ADR §XI.2 "Actions". Admit was the only thing this panel could
  // do, so the list only ever grew: a disposable-mail signup, a typo'd address
  // and a duplicate someone made with a plus-alias all sat there forever, and
  // "Still waiting" counted them. The list is the operator's cohort-picking
  // surface, so a row nobody will ever admit is noise on the one number the
  // panel exists to report.
  //
  // A HARD DELETE, NOT A TOMBSTONE, AND THAT IS THE DESIGN. A `removed_at`
  // column would read better right up until the person joins again: POST
  // /waitlist is `ON CONFLICT (email) DO NOTHING`, so their second signup would
  // land on the tombstone, do nothing, return the same cheerful ack, and never
  // appear on this page — someone waiting, told they were on the list, invisible
  // to the only screen that looks. Deleting the row keeps that honest: removal
  // clears what we know about them TODAY and nothing more, and a genuine
  // re-signup mints a fresh row that shows up like anyone else's. Suppressing an
  // address for good is a different feature (a block list) and would need to be
  // built as one, visibly, rather than fall out of a soft-delete flag.
  //
  // AN ADMITTED ROW IS NEVER REMOVABLE (409). Past admission the row is no
  // longer a request to join — it is the record that we created someone an
  // account and emailed them, and the account outlives anything this panel
  // does. Deleting it would leave a member with no trace of where they came
  // from, and the page would say nobody was ever admitted while they are
  // logged in. Removing the PERSON means deleting the account, which is not
  // this screen.
  //
  // The guard rides the DELETE itself (`admitted_at IS NULL`), the same
  // single-statement claim the admit path uses and for the same reason: an
  // operator's Remove click racing their own Admit click contends in Postgres,
  // exactly one wins, and the loser reads the row back to find out which
  // outcome it lost to rather than reporting the one it assumed.
  //
  // Not undoable, and the log cannot undo it either — the address is redacted
  // there like every other email in this file, so what the log preserves is
  // that a removal happened and to which row, not enough to retype it. The
  // confirm on the panel is where that is said out loud.
  // ---------------------------------------------------------------------------
  const RemoveSchema = z.object({
    email: z.string().trim().max(254).email(),
  })

  app.post('/admin/dashboard/waitlist/remove', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = RemoveSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    // Stored lower-cased by POST /waitlist, so the lookup has to match it —
    // same as the admit path.
    const email = parsed.data.email.toLowerCase().trim()
    const adminId = (req as any).session!.sub as string

    try {
      // The delete IS the guard. Nothing is read first: a SELECT-then-DELETE
      // would decide the row is unadmitted, then delete it on a second
      // statement that a concurrent admit may have stamped in between —
      // destroying the record of a real admission.
      const deleted = await pool.query<{ id: string; created_at: Date }>(
        `DELETE FROM waitlist
          WHERE email = $1 AND admitted_at IS NULL
          RETURNING id, created_at`,
        [email]
      )

      if (deleted.rows.length === 0) {
        // Nothing went. Two different reasons, and the operator needs to know
        // which, so read the row back rather than guessing: absent means the
        // address never joined (or another click already removed it), present
        // means it has been admitted and is no longer this panel's to delete.
        const still = await pool.query<{ admitted_at: Date | null }>(
          'SELECT admitted_at FROM waitlist WHERE email = $1',
          [email]
        )
        if (still.rows.length === 0) {
          return reply.status(404).send({ error: 'not_on_list' })
        }
        return reply.status(409).send({ error: 'already_admitted' })
      }

      logger.info(
        {
          adminId,
          waitlistId: deleted.rows[0].id,
          joinedAt: deleted.rows[0].created_at,
          email: email.slice(0, 3) + '***',
        },
        'waitlist remove'
      )

      return reply.send({ email, removed: true })
    } catch (err) {
      req.log.error({ err }, 'waitlist remove failed')
      return reply.status(500).send({ error: 'Failed to remove' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/writer-applications — the writers' waiting list
  //
  // READER-WRITER-SPLIT-ADR §8 (D3). Readers who pressed "Apply to write",
  // OLDEST FIRST — the order they asked in, and no other. NO HEURISTIC TRIAGE
  // (CLOSED-BETA-ADR §XI.2): the application carries nothing but the account
  // and the moment (O4), and the operator judges from what the member has
  // posted, which is what the profile link on each row is for.
  //
  // A deleted account's application is left out: there is nobody to grant.
  // A suspended one is shown with its status, because whether to grant is the
  // operator's call and the row must not hide the fact it would be made on.
  //
  // The granted half is the record (newest first, the last 50): who was
  // admitted, when, and by whom. Capped with an explicit `truncated` flag on
  // the pending half, like the waitlist — a silent LIMIT would read as
  // "that's everyone" precisely when it isn't.
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/writer-applications', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const CAP = 500
      const GRANTED_SHOWN = 50
      const [totals, pending, granted] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE wa.admitted_at IS NULL) AS pending,
                  COUNT(*) FILTER (WHERE wa.admitted_at IS NOT NULL) AS granted
             FROM writer_applications wa
             JOIN accounts a ON a.id = wa.account_id
            WHERE a.status <> 'deleted'`
        ),
        pool.query(
          `SELECT wa.account_id, wa.created_at, a.username, a.display_name, a.status,
                  a.created_at AS member_since
             FROM writer_applications wa
             JOIN accounts a ON a.id = wa.account_id
            WHERE wa.admitted_at IS NULL AND a.status <> 'deleted'
            ORDER BY wa.created_at ASC
            LIMIT $1`,
          [CAP + 1]
        ),
        pool.query(
          `SELECT wa.account_id, wa.created_at, wa.admitted_at, a.username, a.display_name,
                  a.status, a.created_at AS member_since, g.username AS admitted_by_username
             FROM writer_applications wa
             JOIN accounts a ON a.id = wa.account_id
             LEFT JOIN accounts g ON g.id = wa.admitted_by
            WHERE wa.admitted_at IS NOT NULL AND a.status <> 'deleted'
            ORDER BY wa.admitted_at DESC
            LIMIT $1`,
          [GRANTED_SHOWN]
        ),
      ])

      const t = totals.rows[0]
      const truncated = pending.rows.length > CAP
      const rows = truncated ? pending.rows.slice(0, CAP) : pending.rows
      const member = (r: any) => ({
        accountId: r.account_id as string,
        username: (r.username as string | null) ?? null,
        displayName: (r.display_name as string | null) ?? null,
        status: r.status as string,
        memberSince: new Date(r.member_since).toISOString(),
        appliedAt: new Date(r.created_at).toISOString(),
      })

      return reply.send({
        totals: { pending: num(t?.pending), granted: num(t?.granted) },
        truncated,
        pending: rows.map(member),
        granted: granted.rows.map((r: any) => ({
          ...member(r),
          grantedAt: new Date(r.admitted_at).toISOString(),
          grantedBy: (r.admitted_by_username as string | null) ?? null,
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard writer applications failed')
      return reply.status(500).send({ error: 'Failed to load the writer applications' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/writer-applications/grant — admit one as a writer
  //
  // READER-WRITER-SPLIT-ADR §8. The work is `grantWriterAccess` (lib/
  // writer-gate.ts): the column, the application's stamp and the
  // `config_audit` row, in THIS route's transaction. This route adds only that
  // an application must exist — a grant with none is D4's to offer (plan §D.5
  // q3), and the function already takes one — and the email.
  //
  // THE EMAIL WAITS FOR COMMIT, and a failed send does not undo the grant: the
  // member can publish whether or not they have been told, and a rolled-back
  // grant because Postmark hiccupped would be the mail deciding who writes.
  // The response says what happened to it (`emailed`), and the panel says a
  // failure in red, so the operator can tell them another way.
  //
  // Refusals are chosen statuses with fixed codes: 404 `no_application` /
  // `no_account`, 409 `already_writer` (a second admin's press, or a double
  // click, lost the claim and recorded nothing).
  // ---------------------------------------------------------------------------
  const GrantWriterSchema = z.object({
    accountId: z.string().regex(UUID_RE),
    reason: z.string().trim().min(1).max(500),
  })

  app.post('/admin/dashboard/writer-applications/grant', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = GrantWriterSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const { accountId, reason } = parsed.data
    const adminId = (req as any).session!.sub as string

    const result = await withTransaction(async (client) => {
      const app = await client.query(
        'SELECT 1 FROM writer_applications WHERE account_id = $1',
        [accountId]
      )
      if (app.rows.length === 0) return { outcome: 'no_application' as const, email: null }
      const grant = await grantWriterAccess(client, { accountId, adminId, reason })
      if (grant.outcome !== 'granted') return { outcome: grant.outcome, email: null }
      const acct = await client.query<{ email: string | null }>(
        'SELECT email FROM accounts WHERE id = $1',
        [accountId]
      )
      return { outcome: 'granted' as const, email: acct.rows[0]?.email ?? null }
    })

    if (result.outcome === 'no_application' || result.outcome === 'no_account') {
      return reply.status(404).send({ error: result.outcome })
    }
    if (result.outcome === 'already_writer') {
      return reply.status(409).send({ error: 'already_writer' })
    }

    // Nothing to invalidate: the writer gate and /auth/me both read the column
    // uncached (the auth-state cache holds status and age only).
    let emailed: 'sent' | 'failed' | 'no_address' = 'no_address'
    if (result.email) {
      try {
        await sendWriterAccessGrantedEmail(result.email)
        emailed = 'sent'
      } catch (err) {
        emailed = 'failed'
        logger.error({ err, accountId }, 'writer grant: email failed — the grant stands, the member has not been told')
      }
    }
    logger.info({ adminId, accountId, emailed }, 'writer access granted')
    return reply.send({ outcome: 'granted', emailed })
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/allocation-coverage — funds segregation, measured
  //
  // PAYMENT-PERIMETER-ADR W2. A PROXY rather than a query here, unlike the W4
  // halt set above: the numbers are the allocation model's own (the tri-state
  // `allocated_pence`, the empty-denominator rule, the payout-side residual and
  // the dial it judges against), and a second copy of that reasoning in the
  // gateway is how the two segregation figures start disagreeing.
  //
  // Its own endpoint, not folded into /overview: allocation-reconcile reports to
  // logs alone today, so this is a new hop across a service boundary, and one
  // unreachable payment service must cost the operator this panel — not the
  // whole money dashboard.
  // ---------------------------------------------------------------------------
  app.get(
    '/admin/dashboard/allocation-coverage',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const { status, body } = await callPaymentService('/allocation-coverage', 'GET')
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err }, 'allocation-coverage proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/reader-credits — who is in credit (W1, L3.4)
  //
  // A reading tab in credit is the platform owing a reader, redeemable against
  // future reads. Reader Terms 4.3 (published) promises to refund it to the
  // card rather than let anyone spend it, so it is a state to END. Until this
  // panel the only surface was a FATAL log line three times a day — the right
  // shape for an alert and the wrong one for "is anyone in credit right now",
  // which is the question an operator actually arrives with. Runbook:
  // docs/runbooks/reader-tab-credit.md.
  //
  // A PROXY, for the allocation-coverage reason one level down: the detector is
  // exported from `reconcile-ledger.ts` as its one home precisely so the
  // scheduled check and anything else asking run the same statement, and a
  // retyped `balance_pence < 0` here would be a second definition of the
  // incident. The gateway adds only what the payment service has no business
  // knowing: who these account ids belong to. A uuid alone is not actionable,
  // and the runbook's first step is to go and look at a person.
  //
  // The enrichment is a LEFT-side lookup: a credit on an account row that has
  // since gone still reports, with no name. Dropping it would hide the one
  // account whose state is strangest.
  // ---------------------------------------------------------------------------
  app.get(
    '/admin/dashboard/reader-credits',
    { preHandler: requireAdmin },
    async (req, reply) => {
      let body: any
      try {
        const res = await callPaymentService('/reader-credits', 'GET')
        if (res.status !== 200) {
          req.log.error({ status: res.status }, 'reader-credits upstream returned non-200')
          return reply.status(502).send({ error: 'Payment service unreachable' })
        }
        body = res.body
      } catch (err) {
        req.log.error({ err }, 'reader-credits proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }

      const accounts: any[] = Array.isArray(body?.accounts) ? body.accounts : []
      const ids = accounts.map((a) => a.accountId).filter(Boolean)
      const names = new Map<string, { username: string | null; displayName: string | null }>()
      if (ids.length > 0) {
        const { rows } = await pool.query<{
          id: string
          username: string | null
          display_name: string | null
        }>(`SELECT id, username, display_name FROM accounts WHERE id = ANY($1::uuid[])`, [ids])
        for (const r of rows) {
          names.set(r.id, { username: r.username, displayName: r.display_name })
        }
      }

      return reply.status(200).send({
        ...body,
        accounts: accounts.map((a) => ({
          ...a,
          username: names.get(a.accountId)?.username ?? null,
          displayName: names.get(a.accountId)?.displayName ?? null,
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/refund — send one payable back to the card (L3.1)
  //
  // Reader Terms 4.3, published and live at /reader-terms, says that where a
  // billing error leaves a reader in credit "we will refund that amount to the
  // payment method it came from". Migration 206 made the first half true (the
  // tab stops being somewhere a credit can live); until this there was no path
  // in the repo that called `refunds.create` at all, so the promise had a
  // detector, a banner and a runbook behind it and no button.
  //
  // A PROXY, and it decides nothing. The three-phase create, the idempotency
  // key, the terminal/ambiguous split and every refusal live in the payment
  // service, which is the only service that may talk to Stripe. What the
  // gateway adds is the two things the payment service cannot know: that the
  // caller is an admin, and WHICH admin — forwarded as `actorId` off the
  // session, never the service token, which proves only that something inside
  // the mesh asked.
  //
  // THE REASON IS REQUIRED HERE TOO. It is required by this schema, by the
  // service, and by the column's own CHECK. Three places rather than one
  // because money leaving with nothing said about why is a payment and not a
  // record — and each of the three is a door somebody could otherwise walk
  // round.
  //
  // The upstream status passes through: every refusal the service distinguishes
  // is a different thing for the operator to do, and collapsing them into one
  // "could not refund" sends them to the runbook with no idea which page.
  // ---------------------------------------------------------------------------
  const RefundBody = z.object({
    creditId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  })

  app.post('/admin/dashboard/refund', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = RefundBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    try {
      const { status, body } = await callPaymentService(
        '/reader-credits/refund',
        'POST',
        { ...parsed.data, actorId: adminId }
      )
      req.log.info(
        { adminId, creditId: parsed.data.creditId, status },
        'admin reader-credit refund attempted'
      )
      return reply.status(status).send(body)
    } catch (err) {
      // `fetch` itself threw — a timeout or a refused connection. The refund MAY
      // have been made: the request left, and nothing here knows whether it
      // arrived. So this is not "it failed", and it must not read as one.
      req.log.error({ err, adminId, creditId: parsed.data.creditId }, 'refund proxy failed')
      return reply.status(502).send({
        kind: 'unknown',
        error: 'Payment service unreachable — the refund MAY have been made. Reload before trying again.',
      })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /admin/dashboard/seed-formula — what every new account is seeded from
  //
  // This panel replaced a hand-run `UPDATE feeds SET is_starter_template = true`
  // (FEED-FORMULAS-ADR D6, Phase 2). The flag is gone as of migration 179, so
  // the designated formula is now the whole of the answer — but the reason the
  // panel exists is unchanged and is worth restating where the query lives: the
  // failure this feature ends is an operator who cannot see which object is
  // load-bearing. So it always says what seeds a new account, including when
  // the answer is "nothing does".
  // ---------------------------------------------------------------------------
  app.get('/admin/dashboard/seed-formula', { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as any).session!.sub as string
    try {
      const { rows: designated } = await pool.query(
        `SELECT ff.id, ff.name, ff.description, ff.created_at,
                ff.source_count, ff.excluded_count, ff.source_feed_id,
                ff.author_id, COALESCE(a.display_name, a.username) AS author_name
           FROM feed_formulas ff JOIN accounts a ON a.id = ff.author_id
          WHERE ff.is_default_seed`
      )
      // WHAT IN THIS SEED WOULD FAIL AT EVERY SIGNUP, RIGHT NOW (§0u.2).
      // A seed is FROZEN at designation (L3), so one cut before the 2026-08-31
      // publications suspension still carries its publication rows — and the
      // replay skips them per source, per account, forever, with nothing on
      // this page to say so. The whole reason the panel exists is that an
      // operator cannot otherwise see which object is load-bearing; a seed that
      // silently delivers less than it names is that failure one level in.
      //
      // Counted only while the flag is dark, because it is a fact about NOW
      // rather than about the row: reinstating publications makes these rows
      // travel again with no re-cut, and the panel must stop warning the moment
      // that happens.
      const suspended = designated[0] && !publicationsEnabled()
        ? await pool.query(
            `SELECT COUNT(*)::int AS n FROM feed_formula_sources
              WHERE formula_id = $1 AND source_type = 'publication'`,
            [designated[0].id]
          )
        : null
      // The admin's own feeds, because cutting one of them is now the only
      // thing this panel can do (L5). The `candidates` list went with the
      // `{ formulaId }` branch: with nothing to designate, a list of things to
      // designate has no consumer.
      const { rows: feeds } = await pool.query(
        `SELECT f.id, f.name,
                (SELECT COUNT(*)::int FROM feed_sources fs WHERE fs.feed_id = f.id) AS source_count
           FROM feeds f WHERE f.owner_id = $1
          ORDER BY f.sort_rank ASC, f.created_at ASC`,
        [adminId]
      )
      // THE ADMITTED MEMBERS, AND WHO OF THEM HAS NOT ARRIVED (§A.2.6, §A.2.7).
      // The operator is the one person who sees the whole composition, so the
      // panel says how many of the seed's members admission put there, how
      // many of those other members cannot yet see named (not arrived), and —
      // per feed — how many a re-cut from it would carry across, stated before
      // the press rather than discovered after.
      const admittedStats = designated[0]
        ? await pool.query<{ admitted: number; awaiting: number }>(
            `SELECT COUNT(*)::int AS admitted,
                    COUNT(*) FILTER (WHERE a.provisioned_by_admit AND a.age_declared_at IS NULL)::int AS awaiting
               FROM feed_formula_sources s
               JOIN accounts a ON a.nostr_pubkey = s.tag_value
              WHERE s.formula_id = $1 AND s.source_type = 'account'
                AND EXISTS (SELECT 1 FROM waitlist w WHERE w.admitted_account_id = a.id)`,
            [designated[0].id]
          )
        : null
      const carryCounts = designated[0]
        ? await Promise.all(
            feeds.map((f: any) =>
              countCarryForFeed(pool, { fromFormulaId: designated[0].id, feedId: f.id })
            )
          )
        : feeds.map(() => 0)
      return reply.send({
        designated: designated[0]
          ? {
              id: designated[0].id,
              name: designated[0].name,
              description: designated[0].description ?? null,
              // No `/f/` URL (L10): a seed has no address. Its token was only
              // ever the freeze's by-product, and the public routes 404 it —
              // showing one here would offer the operator a link that does not
              // work, and under a live-link scheme would have meant one URL
              // standing for two different compositions.
              sourceCount: num(designated[0].source_count),
              excludedCount: num(designated[0].excluded_count),
              createdAt: designated[0].created_at,
              authorName: designated[0].author_name,
              authorIsSelf: designated[0].author_id === adminId,
              sourceFeedId: designated[0].source_feed_id,
              suspendedSourceCount: num(suspended?.rows[0]?.n ?? 0),
              admittedCount: num(admittedStats?.rows[0]?.admitted ?? 0),
              awaitingArrivalCount: num(admittedStats?.rows[0]?.awaiting ?? 0),
            }
          : null,
        feeds: feeds.map((r: any, i: number) => ({
          id: r.id,
          name: r.name,
          sourceCount: num(r.source_count),
          carryCount: carryCounts[i],
        })),
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard seed-formula read failed')
      return reply.status(500).send({ error: 'Failed to load the seed formula' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/seed-formula — designate the default seed
  //
  // ONE body, one act: `{ feedId }` cuts one of the admin's own feeds into a
  // NEW frozen formula and designates it in the same transaction. This is also
  // how the seed is REFRESHED — designating the same feed again cuts a fresh
  // snapshot of its current state, which is what the panel's *Re-cut from this
  // feed* control calls.
  //
  // Four things about this endpoint are load-bearing:
  //
  //  1. It is NOT gated on FEED_FORMULAS_ENABLED. That brake gates the share
  //     link and redeem-by-token; the seed path must not share it (ADR §6), or
  //     an operator who turns the flag off can no longer mint the thing every
  //     new account depends on.
  //  2. There is no way to CLEAR the designation, deliberately (D11).
  //     Undesignating happens only by designating a replacement, so this route
  //     swaps both rows in one transaction and never merely clears one. The
  //     schema refuses to delete or revoke a designated row; a route that could
  //     empty the slot would be the same outage through a door the schema
  //     cannot close.
  //  3. A formula with no sources is refused. A sourceless seed feed
  //     auto-serves the explore placeholder, so every new member would open
  //     what they believe the platform composed for them and be shown the
  //     platform stream (the §12 departure, one level up). The refusal belongs
  //     HERE, at designation, where an operator is present to be told — which
  //     is the whole argument for the seed staying frozen while share links
  //     went live (FEED-SHARE-LIVE-LINKS-ADR L3).
  //  4. The outgoing seed is REVOKED in the same transaction (L5), legal the
  //     instant it is undesignated. It is not deleted: the row is the record of
  //     what a cohort of members was actually seeded from, and by L9 nothing
  //     about their feeds moves when it is retired.
  // ---------------------------------------------------------------------------
  app.post('/admin/dashboard/seed-formula', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = SeedFormulaSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    try {
      const outcome = await withTransaction(async (client) => {
        // Owner-scoped: the admin cuts one of THEIR feeds. freezeFeedIntoFormula
        // writes author_id from this, and a designated formula's author cannot
        // delete their account (the D11 trigger through the CASCADE) — so
        // silently making some other member's account undeletable is not a
        // thing an admin should be able to do by typing a uuid.
        const { rows: owned } = await client.query<{ name: string; appearance: any }>(
          `SELECT name, appearance FROM feeds WHERE id = $1 AND owner_id = $2`,
          [parsed.data.feedId, adminId]
        )
        if (owned.length === 0) return { error: 'feed_not_found' as const }

        // A FEED may be untitled (migration 190 — the numeral is its identity);
        // a FORMULA may not, and the two constraints diverge on purpose:
        // `feed_formulas.name` is what the *Default seed* panel prints back to
        // the operator and what `fromStarter` provenance carries for the whole
        // cohort seeded from it, so a nameless one is a slot nobody can read.
        // Caught here rather than left to `feed_formulas_name_check`, which
        // would answer the operator's press with a raw 500 naming a constraint
        // — which is exactly the failure migration 190 exists to end, one level
        // up. `name` on the body is the operator's own override, so this is
        // only reachable when they neither named the feed nor supplied one.
        const seedName = (parsed.data.name ?? owned[0].name).trim()
        if (!seedName) return { error: 'unnamed' as const }

        const frozen = await freezeFeedIntoFormula(client, {
          feedId: parsed.data.feedId,
          ownerId: adminId,
          name: seedName,
          description: parsed.data.description ?? null,
          appearance: owned[0].appearance ?? {},
          maxSources: await formulaMaxSources(),
        })
        if (!frozen.ok) return { error: frozen.reason }
        const formulaId = frozen.formulaId

        // The swap, in this order because the partial unique index permits
        // exactly one TRUE at a time and is not deferrable. Clear-then-revoke
        // inside one transaction is legal because
        // `feed_formulas_seed_never_revoked` is evaluated per statement (L5).
        const { rows: previous } = await client.query<{ id: string; name: string }>(
          `UPDATE feed_formulas SET is_default_seed = FALSE
            WHERE is_default_seed AND id <> $1
            RETURNING id, name`,
          [formulaId]
        )
        if (previous.length > 0)
          await client.query(
            `UPDATE feed_formulas SET revoked_at = COALESCE(revoked_at, now())
              WHERE id = ANY($1::uuid[])`,
            [previous.map((p) => p.id)]
          )
        await client.query(`UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`, [
          formulaId,
        ])
        // The carry (§A.2.7) — after the swap, because the swap's UPDATE is
        // what waits out an admit holding the outgoing seed's lock, so a
        // member appended in that window is read here rather than lost.
        const carry =
          previous.length > 0 && parsed.data.carryAdmitted !== false
            ? await carryAdmittedIntoSeed(client, {
                fromFormulaId: previous[0].id,
                toFormulaId: formulaId,
              })
            : { carried: 0, dropped: 0 }
        return { formulaId, minted: true, previous: previous[0] ?? null, carry }
      })

      if ('error' in outcome) {
        if (outcome.error === 'feed_not_found')
          return reply.status(404).send({ error: 'feed_not_found' })
        if (outcome.error === 'unnamed')
          return reply.status(400).send({
            error: 'seed_feed_unnamed',
            message:
              'This channel has no name. A channel can go without one, but the default seed cannot — name the channel, or give the seed a name here.',
          })
        if (outcome.error === 'empty')
          return reply.status(400).send({
            error: 'formula_empty',
            message:
              'A seed formula must carry at least one shareable source — a sourceless channel shows every new member the platform stream instead.',
          })
        return reply.status(409).send({
          error: 'formula_too_large',
          message: 'This channel has more sources than a formula may carry.',
        })
      }

      const { rows: now } = await pool.query<{
        name: string
        source_count: number
        author_id: string
        author_name: string | null
      }>(
        `SELECT ff.name, ff.source_count, ff.author_id,
                COALESCE(a.display_name, a.username) AS author_name
           FROM feed_formulas ff JOIN accounts a ON a.id = ff.author_id
          WHERE ff.id = $1`,
        [outcome.formulaId]
      )
      logger.info(
        {
          adminId,
          formulaId: outcome.formulaId,
          minted: outcome.minted,
          replaced: outcome.previous?.id ?? null,
          authorId: now[0]?.author_id,
          carried: outcome.carry.carried,
          carryDropped: outcome.carry.dropped,
        },
        'owner dashboard: default-seed formula designated'
      )
      return reply.send({
        designated: {
          id: outcome.formulaId,
          name: now[0]?.name ?? null,
          sourceCount: num(now[0]?.source_count),
          authorName: now[0]?.author_name ?? null,
          authorIsSelf: now[0]?.author_id === adminId,
        },
        minted: outcome.minted,
        replaced: outcome.previous,
        // Carried admitted members, and those the cap refused — counted,
        // never dropped quietly.
        carried: outcome.carry.carried,
        carryDropped: outcome.carry.dropped,
      })
    } catch (err) {
      req.log.error({ err }, 'admin dashboard seed-formula designation failed')
      return reply.status(500).send({ error: 'Failed to designate the seed formula' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/dead-jobs/reap — clear one arm of the dead pile
  //
  // Nothing reaps these automatically, on purpose: clearing a row destroys the
  // evidence the surface exists to show, and a retention window would take the
  // cron banner green a week after a QUARTERLY task failed — with the fault
  // unfixed and the next run three months out. That is the reassuring-absence
  // failure §8.15 was opened to end, rebuilt inside its own remedy.
  //
  // So clearing is an operator act, and for the cron arm it IS the
  // acknowledgement: the banner stays up until a human has seen it. Note the
  // asymmetry that makes this easy to get wrong — reaping a cron row hides a
  // fault, reaping a per-entity one tidies debris — which is why `scope` is
  // required and there is no "clear everything".
  //
  // `complete_jobs` is graphile's supported API and silently skips locked rows,
  // so the reply reports what was actually cleared rather than what was asked
  // for; a row mid-retry is left alone to finish, and is caught next time.
  // ---------------------------------------------------------------------------
  app.post('/admin/dashboard/dead-jobs/reap', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ReapDeadJobsSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string
    const isCron = parsed.data.scope === 'cron'

    try {
      const { rows } = await pool.query<{ cleared: string }>(
        `WITH dead AS (
           SELECT job.id
             FROM graphile_worker._private_jobs job
            WHERE job.attempts >= job.max_attempts
              AND job.locked_at IS NULL
              AND ((job.payload -> '_cron') IS NOT NULL) = $1::boolean
         )
         SELECT COUNT(*)::text AS cleared
           FROM graphile_worker.complete_jobs(ARRAY(SELECT id FROM dead))`,
        [isCron]
      )
      const cleared = num(rows[0]?.cleared)
      // Logged because for the cron arm this is the acknowledgement itself —
      // the one record that a human saw the fault before the count went to nil.
      logger.info({ adminId, scope: parsed.data.scope, cleared }, 'owner dashboard: dead jobs reaped')
      return reply.send({ cleared })
    } catch (err) {
      req.log.error({ err }, 'dead-job reap failed')
      return reply.status(500).send({ error: 'Failed to clear the dead jobs' })
    }
  })

  // ---------------------------------------------------------------------------
  // Trigger proxies — payment-service internal endpoints (x-internal-token)
  //
  // Each runs a whole cron cycle early: the settlement sweep charges every tab
  // past the fallback window, the payout cycle pays every writer over the
  // threshold. Neither changes a dial, but at the card networks the effect is
  // indistinguishable from a decision, so each takes a REQUIRED reason and
  // leaves a `config_audit` row (walkthrough A17), key
  // `operator_trigger:settlement` / `operator_trigger:payout`.
  //
  // THE ROW IS WRITTEN AT THE REQUEST, BEFORE THE PROXY, IN ITS OWN
  // TRANSACTION — the one departure from "same transaction as the change"
  // (ops-and-config.md): the change happens in another service, so no
  // transaction spans it. It records that the operator ASKED, which is the
  // decision; the outcome is the cycle's own records. If the row cannot be
  // written nothing is run — evidence first — and the answer says so
  // (`not_recorded`), which is the ONE failure the dashboard may call
  // "nothing ran". Every failure after the request left is AMBIGUOUS (a
  // 60-second cycle can time out mid-run), so a 502 says "may have run".
  // ---------------------------------------------------------------------------
  const TriggerBody = z.object({
    reason: z.string().trim().min(1).max(500),
  })

  const TRIGGERS = [
    {
      route: '/admin/dashboard/trigger-settlements',
      key: 'operator_trigger:settlement',
      upstream: '/settlement-check/monthly',
      what: 'monthly settlement check',
    },
    {
      route: '/admin/dashboard/trigger-payouts',
      key: 'operator_trigger:payout',
      upstream: '/payout-cycle',
      what: 'payout cycle',
    },
  ] as const

  for (const t of TRIGGERS) {
    app.post(t.route, { preHandler: requireAdmin }, async (req, reply) => {
      const parsed = TriggerBody.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const adminId = (req as any).session!.sub as string
      const reason = parsed.data.reason

      try {
        await withTransaction(async (client) => {
          await recordConfigAudit(client, {
            actorAccountId: adminId,
            key: t.key,
            newValue: 'requested',
            reason,
          })
        })
      } catch (err) {
        req.log.error({ err, adminId }, `${t.what} trigger: audit row not written, nothing run`)
        return reply.status(500).send({
          error: 'not_recorded',
          message: 'The request could not be recorded, so nothing was run.',
        })
      }

      try {
        logger.info({ adminId, reason }, `owner dashboard: ${t.what} triggered`)
        const { status, body } = await callPaymentService(t.upstream, 'POST', {
          actorId: adminId,
          reason,
        })
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err, adminId }, `${t.what} trigger proxy failed`)
        return reply.status(502).send({
          error: 'upstream_ambiguous',
          message: `The payment service did not answer. The ${t.what} may have run — check before pressing again.`,
        })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/resume-payouts[/:accountId] — release a payout halt
  //
  // The halt has been visible on this dashboard since W4 and there was no way
  // to lift it from anywhere but a psql prompt: `POST /payouts/resume` sits
  // behind the internal token, which no browser holds. So the control that
  // freezes every writer's money had a display and no inverse, which is the
  // same asymmetry the reinstate route closed for suspensions.
  //
  // A PROXY, and it decides nothing: what the gateway adds is that the caller
  // is an admin and WHICH admin, forwarded as `actorId` off the session (the
  // refund precedent). The reason is required here, by the payment service's
  // schema, and by the `config_audit` column's own CHECK — three doors, because
  // a freeze lifted with nothing said about why is not a decision anybody can
  // review.
  //
  // The two granularities stay two routes, exactly as they are two halts: an
  // operator lifting the platform-wide freeze and an operator lifting one
  // writer's are doing different things, and a single route with an optional id
  // would let a slip do the larger one.
  // ---------------------------------------------------------------------------
  const ResumePayoutsBody = z.object({
    reason: z.string().trim().min(1).max(500),
  })

  app.post('/admin/dashboard/resume-payouts', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ResumePayoutsBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const adminId = (req as any).session!.sub as string

    try {
      const { status, body } = await callPaymentService('/payouts/resume', 'POST', {
        actorId: adminId,
        reason: parsed.data.reason,
      })
      logger.info({ adminId, status }, 'owner dashboard: global payout halt release attempted')
      return reply.status(status).send(body)
    } catch (err) {
      req.log.error({ err, adminId }, 'resume-payouts proxy failed')
      return reply.status(502).send({ error: 'Payment service unreachable' })
    }
  })

  app.post<{ Params: { accountId: string } }>(
    '/admin/dashboard/resume-payouts/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = ResumePayoutsBody.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { accountId } = req.params
      // A path id answers 404, never 400 and never a 500 from the cast
      // downstream (`lib/request-inputs.ts`).
      if (!UUID_RE.test(accountId)) {
        return reply.status(404).send({ resumed: false, error: 'account_not_halted' })
      }
      const adminId = (req as any).session!.sub as string

      try {
        const { status, body } = await callPaymentService(
          `/payouts/resume/${accountId}`,
          'POST',
          { actorId: adminId, reason: parsed.data.reason }
        )
        logger.info(
          { adminId, accountId, status },
          'owner dashboard: per-account payout halt release attempted'
        )
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err, adminId, accountId }, 'resume-payouts proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/dashboard/halt-payouts/:accountId — freeze one account's money
  //
  // The inverse of the release above, and it arrives later for the same reason
  // the release did: the halt was a machine's act, so nothing needed a button.
  // D9 §4.1 then made it a PERSON's act — on knowledge or suspicion that a
  // writer is a designated person, freeze before the next cycle pays them — and
  // shipped with an INSERT statement in the policy document for the operator to
  // paste into psql. That is the roster's own founding complaint (a capability
  // that exists and is unreachable from the only screen that looks), against a
  // table the reconciler also writes, at speed.
  //
  // A PROXY, deciding nothing but WHO: `actorId` off the admin's session, the
  // refund and resume precedent. The reason is required here, by the payment
  // service's schema and by `config_audit`'s own CHECK.
  //
  // THE CLASS VOCABULARY IS A SECOND COPY AND IS PINNED BY A TEST, never by
  // agreement — there is no module path between these workspaces, so
  // `web/tests/operator-halt-wire.test.ts` reads this file, the web's copy and
  // `payment-service/src/lib/payout-halt.ts` and asserts all three match.
  // A class this end accepts and that end refuses is a 400 on an emergency
  // freeze; one this end sends and that end stores unrecognised is a legal hold
  // filed as a books divergence.
  //
  // IT DOES NOT SUSPEND, AND SUSPENDING DOES NOT DO THIS. The two are one click
  // apart on the roster and they are not alternatives: a suspension removes the
  // member's published work, emails them the reason and offers an appeal (D7),
  // all three of which are wrong for a sanctions review, which must be silent.
  // The freeze touches `accounts.status` not at all, so the moderation freeze's
  // one home (`moderation.ts`) stays the one writer of that column.
  // ---------------------------------------------------------------------------
  const OPERATOR_HALT_CLASSES = ['sanctions_review'] as const

  const HaltPayoutsBody = z.object({
    reason: z.string().trim().min(1).max(500),
    mismatchClass: z.enum(OPERATOR_HALT_CLASSES),
  })

  app.post<{ Params: { accountId: string } }>(
    '/admin/dashboard/halt-payouts/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = HaltPayoutsBody.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { accountId } = req.params
      if (!UUID_RE.test(accountId)) {
        // The path-id rule, and the same answer the payment service gives an id
        // that belongs to nobody: a malformed id and an absent one are the same
        // fact to the operator who typed one.
        return reply.status(404).send({ halted: false, error: 'no_such_account' })
      }
      const adminId = (req as any).session!.sub as string

      try {
        const { status, body } = await callPaymentService(
          `/payouts/halt/${accountId}`,
          'POST',
          { actorId: adminId, reason: parsed.data.reason, mismatchClass: parsed.data.mismatchClass }
        )
        logger.warn(
          { adminId, accountId, mismatchClass: parsed.data.mismatchClass, status },
          'owner dashboard: per-account payout freeze attempted'
        )
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err, adminId, accountId }, 'halt-payouts proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )
}
