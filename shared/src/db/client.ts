import pg, { type PoolClient } from 'pg'
import type { PlatformConfig } from '../types/config.js'
import logger from '../lib/logger.js'

// =============================================================================
// Shared Database Client
//
// Single connection pool shared across all services in the same process.
// Both payment-service and key-service import { pool, withTransaction, loadConfig }
// from this module.
//
// Connection pooling: 20 connections by default, tunable via env.
// Statement timeout: 10s to prevent runaway queries from holding connections.
// Idle timeout: 30s to reclaim unused connections under low load.
// =============================================================================

const {Pool} = pg

// ---------------------------------------------------------------------------
// A PASSWORD IN A URL IS URL SYNTAX, and compose interpolates it raw.
//
// Every service's `DATABASE_URL` is assembled in `docker-compose.yml` as
// `postgresql://platformpub:${POSTGRES_PASSWORD}@postgres:5432/platformpub`,
// with no escaping available at that layer. So the characters that mean
// something in a URL break it, and each breaks it differently:
//
//   `/` and `#`  — the URL does not parse at all, and what the operator sees
//                  is a connection error that says nothing about the password.
//   `@`          — parses (the delimiter is the LAST `@`), but the value the
//                  driver ends up with depends on whose parser you ask, so the
//                  symptom is an authentication failure against a password that
//                  is, character for character, correct.
//   `%`          — becomes an invalid percent-escape; decoding it yields
//                  something that is not the password, or throws.
//
// None of these is detectable from the failure they produce, so the check is
// here, at the one place every service builds its pool, and it says which
// character is the problem.
//
// IT THROWS ONLY WHERE THE URL CANNOT WORK AT ALL, and warns where it merely
// might not — the same terminal-vs-ambiguous split the Stripe and outbound
// classifiers make, applied to this check itself. An unparseable URL is
// already broken, so refusing costs nothing. `@` and `%` in a password may be
// working RIGHT NOW on a deployment whose parsers happen to agree, and turning
// a running platform's boot into a hard failure over a lint of its password
// would be a far worse outcome than the confusing auth error it prevents. So
// that arm is a WARN naming the character, and the operator decides.
// ---------------------------------------------------------------------------
function assertUsableDatabaseUrl(raw: string | undefined): void {
  if (!raw) return // absent is the caller's problem, and pg reports it clearly
  try {
    // eslint-disable-next-line no-new
    new URL(raw)
  } catch {
    throw new Error(
      'DATABASE_URL is not a parseable URL. The usual cause is a password ' +
        'containing a character that is URL syntax — `/`, `#`, `?` or a space ' +
        'break the parse outright. Use a password made only of letters, digits ' +
        'and -_.~ , or percent-encode it in the URL.',
    )
  }
  const userinfo = raw.slice(raw.indexOf('//') + 2).split('@').slice(0, -1).join('@')
  const password = userinfo.includes(':') ? userinfo.slice(userinfo.indexOf(':') + 1) : ''
  const offenders = [...new Set([...password].filter((c) => '@%'.includes(c)))]
  if (offenders.length > 0) {
    logger.warn(
      { characters: offenders },
      "DATABASE_URL's password contains characters that are URL syntax (@ or %). " +
        'Different parsers disagree about what the password actually is, so if ' +
        'this deployment ever starts failing to authenticate against a password ' +
        'that is character-for-character correct, this is why. Prefer a password ' +
        'of letters, digits and -_.~ , or percent-encode it in the URL.',
    )
  }
}

assertUsableDatabaseUrl(process.env.DATABASE_URL)

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  // JIT off for every service connection: our queries are OLTP-shaped (small
  // result sets, cold each time), so JIT compilation is pure overhead — the
  // feed items query was measured spending 2.5s compiling 334 functions to
  // return a 20-row page (2026-07-25). Connection-level so it ships with the
  // code and needs no per-environment postgresql.conf step.
  options: '-c jit=off',
})

// Fatal pool errors mean the connection is broken — exit so the orchestrator restarts us
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error — exiting')
  process.exit(1)
})

// =============================================================================
// withTransaction
//
// Acquires a client, runs the callback inside BEGIN/COMMIT, and releases.
// ROLLBACK on any error. The caller never touches client lifecycle.
//
// Usage:
//   const result = await withTransaction(async (client) => {
//     await client.query('INSERT INTO ...')
//     return someValue
//   })
//
// THE ROLLBACK MUST NOT BE ABLE TO SPEAK OVER THE ERROR IT IS ROLLING BACK.
// A bare `await client.query('ROLLBACK')` in the catch throws its OWN error on
// failure, and that error replaces the one the caller actually needs — so the
// caller sees `Connection terminated unexpectedly` where the ledger write, the
// Stripe classifier or the constraint name was. And the two are not independent:
// ROLLBACK fails almost exclusively when the connection is already gone, which
// is the same event that raised the original error. So the substitution happens
// precisely in the case where the original is most worth having, and it happens
// on EVERY money path, since they all run through here.
//
// The original is therefore always what propagates. A rollback failure is our
// fault rather than the caller's — the terminal/ambiguous split one layer down
// — so it goes to the log with the original attached as `cause`, and it is
// never allowed to become the thrown value. And the client goes back WITH the
// rollback error: pg-pool discards a dead connection by itself, but a ROLLBACK
// that failed on a LIVE one (a timeout) would otherwise return a client still
// inside an aborted transaction.
// =============================================================================

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  let releaseErr: Error | undefined
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      logger.error(
        { err: rollbackErr, cause: err },
        'ROLLBACK failed; rethrowing the original error'
      )
      // pg-pool already discards a DEAD client; this covers the one that is
      // still queryable (a ROLLBACK that timed out), which would otherwise go
      // back to the pool inside an aborted transaction.
      releaseErr = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
    throw err
  } finally {
    client.release(releaseErr)
  }
}

// =============================================================================
// withAdvisoryLock
//
// Single-instances a job with a SESSION-level advisory lock: try the lock, run
// `fn` if we got it, unlock. Returns false (and runs nothing) when another
// session holds it.
//
// The unlock is a cleanup, so the withTransaction rule applies — and one more
// thing is at stake. A bare `finally { await unlock }` lets an unlock failure
// replace `fn`'s own error. Worse, if the unlock fails while the SESSION
// survives, a plain `release()` returns a connection still holding the lock to
// the pool, and every later tick skips as "another instance holds the lock"
// until the process restarts. So a failed unlock is logged with the original
// attached, and the client is released WITH the error: pg-pool then destroys
// it, and a closed session frees its advisory locks.
// =============================================================================

export async function withAdvisoryLock(
  lockId: number,
  fn: () => Promise<unknown>
): Promise<boolean> {
  const client = await pool.connect()
  let releaseErr: Error | undefined
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockId]
    )
    if (!rows[0].locked) return false
    let failure: unknown
    let failed = false
    try {
      await fn()
    } catch (err) {
      failed = true
      failure = err
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId])
    } catch (unlockErr) {
      releaseErr = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr))
      logger.error(
        { err: unlockErr, cause: failed ? failure : undefined, lockId },
        'advisory unlock failed; destroying the connection to free the lock'
      )
    }
    if (failed) throw failure
    return true
  } finally {
    client.release(releaseErr)
  }
}

// =============================================================================
// loadConfig
//
// Reads platform_config table into a typed PlatformConfig object.
// Cached in-memory after first call — invalidate by calling loadConfig(true).
//
// All monetary values are in pence (integers). Fee is in basis points.
//
// The fallbacks below match config-defaults.sql, which is where these nine
// dials now live. They used to be seeded by an INSERT inside schema.sql itself,
// until f8c73e6 regenerated it with --schema-only and silently dropped the data
// — so from then until 2026-07-20 every one of them (the platform fee, the free
// allowance, both settlement thresholds) existed ONLY as the fallback here, and
// was untunable by an operator: an UPDATE on a missing row changes nothing and
// raises nothing. Never re-add config data to schema.sql (a regeneration will
// drop it again — that is the whole lesson).
//
// "Keep the two in step" is now enforced rather than asked for:
// shared/tests/config-fallback-parity.test.ts drives this loader against an
// empty table and diffs every fallback against the SQL file, and fails if a
// dial is added here without a line there. A drifted fallback is invisible
// exactly when the row is missing, which is the one case it exists for.
// =============================================================================

let cachedConfig: PlatformConfig | null = null
let cachedConfigAt = 0
const CONFIG_TTL_MS = 30_000

export async function loadConfig(forceRefresh = false): Promise<PlatformConfig> {
  if (cachedConfig && !forceRefresh && Date.now() - cachedConfigAt < CONFIG_TTL_MS) return cachedConfig

  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM platform_config'
  )

  const map = new Map(rows.map((r) => [r.key, r.value]))

  const config: PlatformConfig = {
    freeAllowancePence: int(map, 'free_allowance_pence', 500),
    arrivalGiftCapPence: int(map, 'arrival_gift_cap_pence', 200),
    tabSettlementThresholdPence: int(map, 'tab_settlement_threshold_pence', 800),
    tabCeilingPence: int(map, 'tab_ceiling_pence', 800),
    monthlyFallbackMinimumPence: int(map, 'monthly_fallback_minimum_pence', 200),
    writerPayoutThresholdPence: int(map, 'writer_payout_threshold_pence', 2000),
    publicationPayoutThresholdPence: int(map, 'publication_payout_threshold_pence', 2000),
    platformFeeBps: int(map, 'platform_fee_bps', 800),
    monthlyFallbackDays: int(map, 'monthly_fallback_days', 30),
    payoutMaxSlices: int(map, 'payout_max_slices', 20),
    allocatedResidualAlertBps: int(map, 'allocated_residual_alert_bps', 2000),
    allocationSyncFreshnessHours: int(map, 'allocation_sync_freshness_hours', 24),
    payoutHaltEscalationHours: int(map, 'payout_halt_escalation_hours', 24),
    unpayableWithdrawalDays: int(map, 'unpayable_withdrawal_days', 180),
    unpayableNoticeDays: int(map, 'unpayable_notice_days', 30),
  }

  cachedConfig = config
  cachedConfigAt = Date.now()
  return config
}

// ABSENT AND MALFORMED ARE DIFFERENT FACTS, and only the first is what the
// fallback is for.
//
// A missing row is the ordinary case: `config-defaults.sql` self-heals it on
// the next migrate, and the in-code fallback is the parity-tested twin of the
// seeded value. A row that IS there and does not parse is an operator typo —
// `1,000`, `50%`, a pasted newline — and silently substituting the default
// there means the dial reports success, changes nothing, and reads exactly like
// a dial that was never wired up (which this repo has shipped: `free_allowance_pence`
// was dead for months). The value still falls back, because a money path must
// not die on a bad string, but it says so once per key so the operator can find
// out why their edit did nothing.
const warnedMalformedKeys = new Set<string>()

const INTEGER_RE = /^-?\d+$/

function int(map: Map<string, string>, key: string, fallback: number): number {
  const val = map.get(key)
  if (val === undefined) return fallback
  // WHOLE-STRING match, not parseInt (CA-F2): parseInt reads a prefix, so
  // "8.50" became 8 and "1,000" became 1 — a malformed value applied as a
  // different number rather than falling back, the one outcome worse than the
  // fallback this function exists for.
  if (!INTEGER_RE.test(val.trim())) {
    if (!warnedMalformedKeys.has(key)) {
      warnedMalformedKeys.add(key)
      logger.warn(
        { key, value: val, fallback },
        'platform_config value is not a whole number — falling back to the built-in default. The stored value is being ignored.',
      )
    }
    return fallback
  }
  return parseInt(val, 10)
}
