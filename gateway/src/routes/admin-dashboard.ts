import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, loadConfig, withTransaction } from '@platform-pub/shared/db/client.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireEnv, publicationsEnabled } from '@platform-pub/shared/lib/env.js'
import { requireAdmin } from '../middleware/admin.js'
import { getParityReport } from '../lib/internal-parity.js'
import { invalidatePlatformConfig } from '../lib/platform-config.js'
import { provisionAccount } from '../lib/account-provision.js'
import { freezeFeedIntoFormula, formulaMaxSources } from './feeds/formulas.js'
import { sendWaitlistInviteEmail } from '@platform-pub/shared/lib/email.js'
import { getEmailHealth } from '@platform-pub/shared/lib/email-health.js'

// =============================================================================
// Owner dashboard — operator visibility over the money pipeline, users,
// content, config, and regulatory thresholds. Spec:
// planning-archive/OWNER-DASHBOARD-SPEC.md (adapted to the shipped ledger
// views and the post-145 schema — no is_writer column; earnings are the
// ledger_writer_earned − ledger_writer_earnings difference).
//
// GET  /admin/dashboard/overview    — money pipeline stage-by-stage
// GET  /admin/dashboard/users       — account totals, growth, KYC-stuck writers
// GET  /admin/dashboard/content     — publishing activity + system health
// GET  /admin/dashboard/config      — all platform_config rows
// PATCH /admin/dashboard/config     — update existing keys (never insert)
// GET  /admin/dashboard/regulatory  — revenue vs UK tax thresholds, custody
// GET  /admin/dashboard/waitlist    — the closed-beta waiting list
// GET  /admin/dashboard/allocation-coverage — funds segregation, measured (W2)
// GET  /admin/dashboard/seed-formula   — what every new account is seeded from
// POST /admin/dashboard/seed-formula   — designate that (FEED-FORMULAS D6/D11)
// POST /admin/dashboard/waitlist/admit — admit one waitlister (creates their
//                                        account, sends the invitation)
// POST /admin/dashboard/waitlist/remove — drop one UNADMITTED waitlister
// POST /admin/dashboard/dead-jobs/reap — clear one arm of the dead-job pile
// POST /admin/dashboard/trigger-settlements — proxy to payment-service
// POST /admin/dashboard/trigger-payouts     — proxy to payment-service
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
const STATE_KEYS = new Set(['payouts_halted', 'jetstream_healthy', 'feed_ingest_heartbeat'])

// The in-code twin of config-defaults.sql's ingest_heartbeat_alert_seconds.
// Exported so the fallback-parity suite can hold the two copies together — a
// drifted fallback never errors, it just substitutes silently, in exactly the
// case it exists for (the row missing).
export const INGEST_HEARTBEAT_ALERT_SECONDS_FALLBACK = 600

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
  method: 'GET' | 'POST' = 'POST'
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
    ...(isRead ? {} : { body: JSON.stringify({}) }),
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

      const [tabs, readStates, settlements, payouts, outstanding, halt, revenue, custody, counts, holdingDial, haltedAccounts, ingestBeat, ingestProtocols, deadJobs] =
        await Promise.all([
          pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE balance_pence > 0) AS active_tab_count,
               COALESCE(SUM(balance_pence) FILTER (WHERE balance_pence > 0), 0) AS total_accrued_pence,
               COALESCE(-SUM(balance_pence) FILTER (WHERE balance_pence < 0), 0) AS total_credit_pence,
               COUNT(*) FILTER (WHERE balance_pence >= $1) AS near_threshold_tabs
             FROM reading_tabs`,
            [nearThresholdPence]
          ),
          pool.query(
            `SELECT state, COUNT(*) AS n, COALESCE(SUM(amount_pence), 0) AS total_pence
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
            `SELECT COUNT(*) AS held_read_count,
                    COALESCE(SUM(amount_pence), 0) AS total_held_pence,
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
          pool.query(
            `SELECT protocol::text AS protocol,
                    COUNT(*)::int AS active_sources,
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
          totalCreditPence: num(t.total_credit_pence),
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
            })),
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
             COUNT(*) FILTER (WHERE stripe_customer_id IS NULL AND free_allowance_remaining_pence > 0) AS on_free_allowance,
             COUNT(*) FILTER (WHERE stripe_customer_id IS NULL AND free_allowance_remaining_pence <= 0) AS allowance_exhausted,
             COUNT(*) FILTER (WHERE card_action_required_at IS NOT NULL) AS card_action_required,
             COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS signups_7d,
             COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS signups_30d
           FROM accounts WHERE status <> 'deleted'`
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
          `SELECT COALESCE(SUM(amount_pence), 0) AS total_held_pence,
                  MIN(read_at) AS oldest_held_read_at
           FROM read_events
           -- Unclaimed by EITHER cycle (migration 168) — see the ops-overview twin.
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
  // actually went, and they are separate because the send happens outside
  // the admission transaction and can fail on its own. A row that is admitted
  // but not invited is the state the panel offers a retry on — an admission
  // nobody heard about is the exact failure this section exists to stop.
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
                  COUNT(*) FILTER (WHERE admitted_at IS NOT NULL AND invited_at IS NULL) AS admitted_not_invited
             FROM waitlist`
        ),
        pool.query(
          `SELECT w.email, w.created_at,
                  w.admitted_at, w.invited_at, a.username
             FROM waitlist w
             LEFT JOIN accounts a ON a.id = w.admitted_account_id
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
        },
        lastDigestAt: digest.rows[0]?.value ?? null,
        truncated,
        shown: rows.length,
        entries: rows.map((r: any) => ({
          email: r.email as string,
          joinedAt: new Date(r.created_at).toISOString(),
          admittedAt: r.admitted_at ? new Date(r.admitted_at).toISOString() : null,
          invitedAt: r.invited_at ? new Date(r.invited_at).toISOString() : null,
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
  // POST /admin/dashboard/waitlist/admit — admit one waitlister
  //
  // CLOSED-BETA-ADR §XI.2 "Actions", build order item 3. The one write on this
  // panel, and the §3.7 minimum for running a closed beta at all: until now,
  // converting a waitlister into a member meant hand-writing SQL on the box.
  //
  // It does three things, in this order, and the order is the design:
  //
  //   1. CLAIM the row (`admitted_at IS NULL` → now()). One statement, so two
  //      concurrent admits — the operator double-clicking a slow button — race
  //      on the database and exactly one wins. The loser reads the row back to
  //      find out WHICH outcome it lost to — already admitted, or removed out
  //      from under it — rather than reporting the one it assumed.
  //   2. Find-or-create the account. `provisionAccount` deliberately BYPASSES
  //      the CLOSED_BETA gate: that constant exists to reserve account creation
  //      to a human decision, and this IS that decision, taken by an admin
  //      behind requireAdmin. A prospect who is already a member (the operator
  //      testing the form with their own address is the likely first case, and
  //      one of the three live prod rows is exactly that) is LINKED, not
  //      duplicated — accounts.email is unique, so a blind insert would 500.
  //   3. Send the invitation, and stamp `invited_at` only if it went.
  //
  // THE EMAIL IS OUTSIDE THE CLAIM, AND ITS FAILURE DOES NOT UNDO ANYTHING
  // (D7's rule, applied to admission). The account is the product; the message
  // is the courtesy. A Postmark blip must not roll back a real account or
  // release the claim, because the retry would then try to create it again.
  // Instead the row rests at "admitted, not yet told", the panel shows that
  // state and offers a resend, and this route's own resend path is the same
  // endpoint called again.
  //
  // RESERVE→CREATE→CONFIRM, so a failure between the claim and the account is
  // not a stuck row: if provisioning throws, the claim is RELEASED (guarded on
  // `admitted_account_id IS NULL`, so it can never clobber a concurrent
  // success) and the operator can simply click again.
  // ---------------------------------------------------------------------------
  const AdmitSchema = z.object({
    email: z.string().trim().max(254).email(),
  })

  app.post('/admin/dashboard/waitlist/admit', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AdmitSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    // POST /waitlist lower-cases before insert, so the stored key is lower-case
    // and the lookup has to match it.
    const email = parsed.data.email.toLowerCase().trim()
    const adminId = (req as any).session!.sub as string

    try {
      const existingRow = await pool.query<{
        id: string
        admitted_at: Date | null
        invited_at: Date | null
        admitted_account_id: string | null
      }>(
        `SELECT id, admitted_at, invited_at, admitted_account_id
           FROM waitlist WHERE email = $1`,
        [email]
      )

      if (existingRow.rows.length === 0) {
        // Deliberately a real 404 with a real reason. This endpoint is behind
        // requireAdmin, so there is no enumeration surface to protect here —
        // that concern belongs to the public POST /waitlist, and blurring the
        // admin's error would only hide a typo from the one person who can fix
        // it.
        return reply.status(404).send({ error: 'not_on_list' })
      }

      const row = existingRow.rows[0]

      if (row.admitted_at && row.invited_at) {
        return reply.status(409).send({ error: 'already_admitted' })
      }

      let accountId = row.admitted_account_id
      let username: string | null = null
      let accountCreated = false
      // Read once, before the claim moves it: this call is either the admission
      // or a resend to a row that was admitted and never told, and step 3 needs
      // to know which when it loses a race.
      const isResend = Boolean(row.admitted_at)

      if (!row.admitted_at) {
        // 1. Claim.
        const claim = await pool.query<{ id: string }>(
          `UPDATE waitlist SET admitted_at = now()
            WHERE id = $1 AND admitted_at IS NULL
            RETURNING id`,
          [row.id]
        )
        if (claim.rows.length === 0) {
          // The claim found nothing to stamp, and since Remove landed there
          // are two ways that happens: a concurrent admit took the row (the
          // double-click this claim exists to absorb), or a concurrent remove
          // deleted it. Read back rather than assume — reporting "already
          // admitted" for a row that no longer exists would tell the operator
          // someone is a member when nothing was created.
          const still = await pool.query('SELECT admitted_at FROM waitlist WHERE id = $1', [
            row.id,
          ])
          if (still.rows.length === 0) {
            return reply.status(404).send({ error: 'removed_meanwhile' })
          }
          return reply.status(409).send({ error: 'already_admitted' })
        }

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
            // carries, and the member renames themselves in Settings.
            const provisioned = await provisionAccount(email, email.split('@')[0])
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
              // The release itself failing leaves a claimed row with no
              // account — the one state that needs a human, so say so loudly
              // rather than burying it under the provisioning error.
              logger.error(
                { err: releaseErr, waitlistId: row.id },
                'waitlist admit: FAILED TO RELEASE CLAIM — row is admitted with no account'
              )
            })
          throw err
        }
      } else {
        // Already admitted, never told: this call is the resend.
        if (!accountId) {
          // Stamped, but with no account behind it — which means either another
          // click is between its claim and its account (the mid-flight window),
          // or one failed AND its release failed too (loudly logged above).
          // Both are indistinguishable from here and neither is a resend: this
          // call must not invite someone to an account it cannot confirm
          // exists. Refusing also keeps a second click out of the first's way
          // rather than racing it.
          return reply.status(409).send({ error: 'admit_in_progress' })
        }
        // Read back the username so the response can name who they are.
        const account = accountId
          ? await pool.query<{ username: string | null }>(
              'SELECT username FROM accounts WHERE id = $1',
              [accountId]
            )
          : { rows: [] as Array<{ username: string | null }> }
        username = account.rows[0]?.username ?? null
      }

      // 3. Tell them — and claim the invitation the same way the admission was
      // claimed, for the same reason. Without it there is a window between the
      // admission claim and the send in which a second click reads the row as
      // "admitted, never told", takes the resend path, and mails the person a
      // duplicate. Stamping FIRST and releasing on failure closes it: two
      // clicks contend on one statement and exactly one sends.
      let invited = false
      const inviteClaim = await pool.query<{ id: string }>(
        `UPDATE waitlist SET invited_at = now()
          WHERE id = $1 AND invited_at IS NULL
          RETURNING id`,
        [row.id]
      )

      if (inviteClaim.rows.length === 0) {
        // Someone else's click is sending it, or already has. If this call had
        // nothing else to do — a resend that lost the race — say so rather than
        // reporting a send it did not make.
        if (isResend) {
          return reply.status(409).send({ error: 'already_admitted' })
        }
        invited = true
      } else {
        try {
          await sendWaitlistInviteEmail(email)
          invited = true
        } catch (err) {
          // Release the stamp. The admission stands — the account is real and
          // the person is a member — but the row must go on saying "not yet
          // told", because that is the state the panel offers the retry on and
          // an invitation nobody received is the failure this section exists to
          // stop.
          await pool
            .query(
              `UPDATE waitlist SET invited_at = NULL WHERE id = $1`,
              [row.id]
            )
            .catch((releaseErr) => {
              logger.error(
                { err: releaseErr, waitlistId: row.id },
                'waitlist admit: FAILED TO RELEASE INVITE STAMP — row reads as told when it was not'
              )
            })
          logger.error(
            { err, waitlistId: row.id, email: email.slice(0, 3) + '***' },
            'waitlist admit: invitation email failed — admission stands, not yet told'
          )
        }
      }

      logger.info(
        { adminId, waitlistId: row.id, accountId, accountCreated, invited },
        'waitlist admit'
      )

      return reply.send({
        email,
        admitted: true,
        accountCreated,
        username,
        invited,
      })
    } catch (err) {
      req.log.error({ err }, 'waitlist admit failed')
      return reply.status(500).send({ error: 'Failed to admit' })
    }
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
            }
          : null,
        feeds: feeds.map((r: any) => ({
          id: r.id,
          name: r.name,
          sourceCount: num(r.source_count),
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
        return { formulaId, minted: true, previous: previous[0] ?? null }
      })

      if ('error' in outcome) {
        if (outcome.error === 'feed_not_found')
          return reply.status(404).send({ error: 'feed_not_found' })
        if (outcome.error === 'unnamed')
          return reply.status(400).send({
            error: 'seed_feed_unnamed',
            message:
              'This feed has no name. A feed can go without one, but the default seed cannot — name the feed, or give the seed a name here.',
          })
        if (outcome.error === 'empty')
          return reply.status(400).send({
            error: 'formula_empty',
            message:
              'A seed formula must carry at least one shareable source — a sourceless feed shows every new member the platform stream instead.',
          })
        return reply.status(409).send({
          error: 'formula_too_large',
          message: 'This feed has more sources than a formula may carry.',
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
  // ---------------------------------------------------------------------------
  app.post(
    '/admin/dashboard/trigger-settlements',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const adminId = (req as any).session!.sub as string
        logger.info({ adminId }, 'owner dashboard: monthly settlement check triggered')
        const { status, body } = await callPaymentService('/settlement-check/monthly')
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err }, 'trigger-settlements proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )

  app.post(
    '/admin/dashboard/trigger-payouts',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const adminId = (req as any).session!.sub as string
        logger.info({ adminId }, 'owner dashboard: payout cycle triggered')
        const { status, body } = await callPaymentService('/payout-cycle')
        return reply.status(status).send(body)
      } catch (err) {
        req.log.error({ err }, 'trigger-payouts proxy failed')
        return reply.status(502).send({ error: 'Payment service unreachable' })
      }
    }
  )
}
