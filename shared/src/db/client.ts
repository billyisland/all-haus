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
// =============================================================================

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
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
    tabSettlementThresholdPence: int(map, 'tab_settlement_threshold_pence', 800),
    monthlyFallbackMinimumPence: int(map, 'monthly_fallback_minimum_pence', 200),
    writerPayoutThresholdPence: int(map, 'writer_payout_threshold_pence', 2000),
    publicationPayoutThresholdPence: int(map, 'publication_payout_threshold_pence', 2000),
    platformFeeBps: int(map, 'platform_fee_bps', 800),
    monthlyFallbackDays: int(map, 'monthly_fallback_days', 30),
    payoutMaxSlices: int(map, 'payout_max_slices', 20),
    allocatedResidualAlertBps: int(map, 'allocated_residual_alert_bps', 2000),
    allocationSyncFreshnessHours: int(map, 'allocation_sync_freshness_hours', 24),
    payoutHaltEscalationHours: int(map, 'payout_halt_escalation_hours', 24),
  }

  cachedConfig = config
  cachedConfigAt = Date.now()
  return config
}

function int(map: Map<string, string>, key: string, fallback: number): number {
  const val = map.get(key)
  if (val === undefined) return fallback
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? fallback : parsed
}
