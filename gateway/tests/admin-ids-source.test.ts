import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// Where admin access comes from, and whether the system says so.
//
// `platform_config.admin_account_ids` is seeded EMPTY by config-defaults.sql,
// so the `ADMIN_ACCOUNT_IDS` env fallback is what makes a fresh deployment
// reachable at all — it cannot be removed. What it must not be is silent:
// clearing the list in the config editor reads as revoking admin access, and
// with the env var set it revokes nothing.
//
// The DB read failing is a third state, and it must not be cached: an
// unreachable `platform_config` is ambiguous, not an answer, and caching the
// env set for a minute on the strength of it serves a possibly-wrong admin set
// to every request in that window.
// =============================================================================

const mockQuery = vi.fn()
const warn = vi.fn()
const info = vi.fn()

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...a: any[]) => mockQuery(...a) },
}))
vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: (...a: any[]) => info(...a), warn: (...a: any[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../src/middleware/auth.js', () => ({ requireAuth: vi.fn() }))

import { getAdminIds, invalidateAdminIdsCache } from '../src/middleware/admin.js'

const DB_ADMIN = '11111111-1111-1111-1111-111111111111'
const ENV_ADMIN = '22222222-2222-2222-2222-222222222222'

const originalEnv = process.env.ADMIN_ACCOUNT_IDS

beforeEach(() => {
  mockQuery.mockReset()
  warn.mockReset()
  info.mockReset()
  invalidateAdminIdsCache()
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.ADMIN_ACCOUNT_IDS
  else process.env.ADMIN_ACCOUNT_IDS = originalEnv
})

describe('getAdminIds', () => {
  it('prefers the DB list and logs nothing about the env', async () => {
    process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
    mockQuery.mockResolvedValue({ rows: [{ value: ` ${DB_ADMIN} ` }] })

    expect(await getAdminIds()).toEqual([DB_ADMIN])
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to the env var when the DB list is empty — AND SAYS SO', async () => {
    process.env.ADMIN_ACCOUNT_IDS = `${ENV_ADMIN}, ${DB_ADMIN}`
    mockQuery.mockResolvedValue({ rows: [{ value: '' }] })

    expect(await getAdminIds()).toEqual([ENV_ADMIN, DB_ADMIN])
    // The whole finding: this used to happen with nothing in the log, so an
    // operator who cleared the list saw admin access continue and had no way to
    // find out why.
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][1])).toMatch(/ADMIN_ACCOUNT_IDS/)
    expect(warn.mock.calls[0][0]).toMatchObject({ adminCount: 2, dbReadFailed: false })
  })

  it('warns on the TRANSITION, not on every resolution', async () => {
    // Fake timers, because the point is a SECOND real resolution past the TTL
    // rather than a cache hit — and a cache hit would satisfy "warned once"
    // without exercising the transition memory at all.
    vi.useFakeTimers()
    try {
      process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
      mockQuery.mockResolvedValue({ rows: [{ value: '' }] })

      await getAdminIds()
      vi.advanceTimersByTime(61_000)
      await getAdminIds()

      expect(mockQuery).toHaveBeenCalledTimes(2) // it really did re-resolve
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns AGAIN when the source swings back to the env, and reports the return', async () => {
    vi.useFakeTimers()
    try {
      process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
      mockQuery.mockResolvedValue({ rows: [{ value: '' }] })
      await getAdminIds()
      expect(warn).toHaveBeenCalledOnce()

      // Operator sets the list: the source swings back to the DB and says so.
      mockQuery.mockResolvedValue({ rows: [{ value: DB_ADMIN }] })
      vi.advanceTimersByTime(61_000)
      expect(await getAdminIds()).toEqual([DB_ADMIN])
      expect(info).toHaveBeenCalledOnce()

      // Operator clears it again: the reinstatement is reported a second time,
      // because it is a second event and not the same one still in force.
      mockQuery.mockResolvedValue({ rows: [{ value: '' }] })
      vi.advanceTimersByTime(61_000)
      expect(await getAdminIds()).toEqual([ENV_ADMIN])
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the env var is also empty — there is no reinstatement to report', async () => {
    delete process.env.ADMIN_ACCOUNT_IDS
    mockQuery.mockResolvedValue({ rows: [{ value: '' }] })

    expect(await getAdminIds()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('caches the DB answer (one query for two calls)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ value: DB_ADMIN }] })
    await getAdminIds()
    await getAdminIds()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('caches the ENV answer too — the deployment shape that most needs the cache never had it', async () => {
    process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
    mockQuery.mockResolvedValue({ rows: [{ value: '' }] })
    await getAdminIds()
    await getAdminIds()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a failed DB read — an unreachable config is ambiguous', async () => {
    process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
    mockQuery.mockRejectedValue(new Error('connection refused'))

    expect(await getAdminIds()).toEqual([ENV_ADMIN])
    // Second call retries rather than serving the fallback set for a minute.
    mockQuery.mockResolvedValue({ rows: [{ value: DB_ADMIN }] })
    expect(await getAdminIds()).toEqual([DB_ADMIN])
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('reports the failure as its own cause, distinct from an empty list', async () => {
    process.env.ADMIN_ACCOUNT_IDS = ENV_ADMIN
    mockQuery.mockRejectedValue(new Error('connection refused'))
    await getAdminIds()
    const fallbackWarn = warn.mock.calls.find(c => c[0] && 'dbReadFailed' in c[0])
    expect(fallbackWarn?.[0]).toMatchObject({ dbReadFailed: true })
  })
})
