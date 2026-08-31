import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Task } from 'graphile-worker'

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
}
const mockPool = {
  connect: vi.fn(async () => mockClient),
}
const publishMock = vi.fn()

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: mockPool,
}))
vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../adapters/nostr-outbound.js', () => ({
  publishNostrToRelaysDetailed: publishMock,
}))

// The detailed adapter resolves to { eventId, succeeded, failed }. Helper to
// build that shape; by default every target relay accepted.
function ok(relayUrls: string[], failed: string[] = []) {
  return {
    eventId: SIGNED_EVENT.id,
    succeeded: relayUrls.filter((u) => !failed.includes(u)),
    failed,
  }
}

const { relayPublish, computeBackoff } = await import('./relay-publish.js')

const SIGNED_EVENT = {
  id: 'aaaa'.padEnd(64, '0'),
  pubkey: 'bbbb'.padEnd(64, '0'),
  created_at: 1_700_000_000,
  kind: 30023,
  tags: [],
  content: '',
  sig: 'cc'.padEnd(128, '0'),
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    entity_type: 'article',
    entity_id: '00000000-0000-0000-0000-000000000002',
    signed_event: SIGNED_EVENT,
    target_relay_urls: ['wss://relay.test'],
    status: 'pending',
    attempts: 0,
    max_attempts: 10,
    ...overrides,
  }
}

// Minimal Helpers shim — relayPublish only touches helpers.addJob.
type TestHelpers = Parameters<Task>[1] & { addJob: ReturnType<typeof vi.fn> }
function makeHelpers(): TestHelpers {
  return { addJob: vi.fn() } as unknown as TestHelpers
}

// Shape the scripted responses for a run: SELECT row, advisory-lock, then whatever
// UPDATE/COMMIT the code issues are executed via passthrough.
function scriptClient(selectRow: unknown, lockGranted = true) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  mockClient.query.mockReset()
  mockClient.release.mockReset()
  mockClient.query.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve({ rows: [] })
    }
    if (/^SELECT id, entity_type/i.test(sql)) {
      return Promise.resolve({ rows: selectRow ? [selectRow] : [] })
    }
    if (/pg_try_advisory_xact_lock/.test(sql)) {
      return Promise.resolve({ rows: [{ got: lockGranted }] })
    }
    if (/^UPDATE relay_outbox/i.test(sql)) {
      return Promise.resolve({ rows: [] })
    }
    return Promise.resolve({ rows: [] })
  })
  return calls
}

describe('computeBackoff', () => {
  const NOW = new Date('2026-01-01T00:00:00Z').getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('scales 2^attempts minutes, ±10% jitter', () => {
    // attempts=1 → base 2min = 120000ms. ±10% → [108000, 132000]ms.
    const at = computeBackoff(1).getTime() - NOW
    expect(at).toBeGreaterThanOrEqual(108_000)
    expect(at).toBeLessThanOrEqual(132_000)
  })

  it('caps at 1 hour', () => {
    // attempts=20 → 2^20 minutes » 1h; should saturate at 3_600_000ms ±10%.
    const at = computeBackoff(20).getTime() - NOW
    expect(at).toBeGreaterThanOrEqual(3_240_000)
    expect(at).toBeLessThanOrEqual(3_960_000)
  })
})

describe('relayPublish', () => {
  beforeEach(() => {
    publishMock.mockReset()
  })

  it('sends successfully → UPDATE status=sent', async () => {
    const calls = scriptClient(baseRow())
    publishMock.mockResolvedValueOnce(SIGNED_EVENT.id)

    await relayPublish({ outboxId: baseRow().id }, makeHelpers())

    expect(publishMock).toHaveBeenCalledOnce()
    expect(publishMock).toHaveBeenCalledWith(SIGNED_EVENT, ['wss://relay.test'])

    const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'sent'/)
    expect(updates[0].sql).toMatch(/attempts = attempts \+ 1/)

    // Final command in the script is COMMIT (not ROLLBACK)
    expect(calls.at(-1)?.sql).toBe('COMMIT')
    expect(mockClient.release).toHaveBeenCalledOnce()
  })

  it('discovery row: retries when only the in-house relay accepted (D6)', async () => {
    const prev = process.env.PLATFORM_RELAY_WS_URL
    process.env.PLATFORM_RELAY_WS_URL = 'wss://in-house.test'
    try {
      const row = baseRow({
        entity_type: 'follow_list',
        target_relay_urls: ['wss://in-house.test', 'wss://public.test'],
        attempts: 0,
      })
      const calls = scriptClient(row)
      // In-house accepted, the public fan-out relay rejected.
      publishMock.mockResolvedValueOnce(ok(row.target_relay_urls, ['wss://public.test']))
      const helpers = makeHelpers()

      await relayPublish({ outboxId: row.id }, helpers)

      const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
      expect(updates).toHaveLength(1)
      expect(updates[0].sql).toMatch(/status = 'failed'/)
      expect(updates[0].params[3]).toMatch(/in-house relay only/)
      expect(helpers.addJob).toHaveBeenCalledOnce()
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_RELAY_WS_URL
      else process.env.PLATFORM_RELAY_WS_URL = prev
    }
  })

  it('discovery row: marks sent when a public relay accepted (D6)', async () => {
    const prev = process.env.PLATFORM_RELAY_WS_URL
    process.env.PLATFORM_RELAY_WS_URL = 'wss://in-house.test'
    try {
      const row = baseRow({
        entity_type: 'profile',
        target_relay_urls: ['wss://in-house.test', 'wss://public.test'],
      })
      const calls = scriptClient(row)
      publishMock.mockResolvedValueOnce(ok(row.target_relay_urls)) // both accepted
      const helpers = makeHelpers()

      await relayPublish({ outboxId: row.id }, helpers)

      const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
      expect(updates).toHaveLength(1)
      expect(updates[0].sql).toMatch(/status = 'sent'/)
      expect(helpers.addJob).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_RELAY_WS_URL
      else process.env.PLATFORM_RELAY_WS_URL = prev
    }
  })

  it('on relay failure → UPDATE status=failed + schedules retry', async () => {
    const calls = scriptClient(baseRow({ attempts: 2 }))
    publishMock.mockRejectedValueOnce(new Error('relay timeout'))
    const helpers = makeHelpers()

    await relayPublish({ outboxId: baseRow().id }, helpers)

    const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'failed'/)
    expect(updates[0].params[1]).toBe(3) // newAttempts = 2 + 1
    expect(updates[0].params[3]).toBe('relay timeout')

    expect(helpers.addJob).toHaveBeenCalledOnce()
    const [taskName, payload, opts] = helpers.addJob.mock.calls[0]
    expect(taskName).toBe('relay_publish')
    expect(payload).toEqual({ outboxId: baseRow().id })
    expect(opts?.jobKey).toBe(`relay_publish_${baseRow().id}_r3`)
    expect(opts?.maxAttempts).toBe(1)
    expect(opts?.runAt).toBeInstanceOf(Date)
  })

  it('at max_attempts → UPDATE status=abandoned, no retry scheduled', async () => {
    const calls = scriptClient(baseRow({ attempts: 9, max_attempts: 10 }))
    publishMock.mockRejectedValueOnce(new Error('permanent reject'))
    const helpers = makeHelpers()

    await relayPublish({ outboxId: baseRow().id }, helpers)

    const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'abandoned'/)
    expect(updates[0].params[1]).toBe(10)
    expect(updates[0].params[2]).toBe('permanent reject')

    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('is a no-op when row already sent', async () => {
    const calls = scriptClient(baseRow({ status: 'sent' }))
    const helpers = makeHelpers()

    await relayPublish({ outboxId: baseRow().id }, helpers)

    expect(publishMock).not.toHaveBeenCalled()
    expect(calls.filter(c => /^UPDATE/i.test(c.sql))).toHaveLength(0)
    // Finishes with ROLLBACK (no state changes to commit).
    expect(calls.at(-1)?.sql).toBe('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalledOnce()
  })

  it('is a no-op when row vanishes (SELECT FOR UPDATE SKIP LOCKED missed)', async () => {
    const calls = scriptClient(null)
    const helpers = makeHelpers()

    await relayPublish({ outboxId: baseRow().id }, helpers)

    expect(publishMock).not.toHaveBeenCalled()
    expect(calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('defers when a peer holds the advisory lock', async () => {
    const calls = scriptClient(baseRow(), /* lockGranted */ false)
    const helpers = makeHelpers()

    await relayPublish({ outboxId: baseRow().id }, helpers)

    expect(publishMock).not.toHaveBeenCalled()
    // No state updates; the redrive cron picks the row up on the next minute.
    expect(calls.filter(c => /^UPDATE/i.test(c.sql))).toHaveLength(0)
    expect(calls.at(-1)?.sql).toBe('ROLLBACK')
  })

  it('fails the row when no target relay URLs are configured', async () => {
    const prev = process.env.PLATFORM_RELAY_WS_URL
    delete process.env.PLATFORM_RELAY_WS_URL
    try {
      const calls = scriptClient(baseRow({ target_relay_urls: [] }))
      const helpers = makeHelpers()

      await relayPublish({ outboxId: baseRow().id }, helpers)

      expect(publishMock).not.toHaveBeenCalled()
      const updates = calls.filter(c => /^UPDATE relay_outbox/i.test(c.sql))
      expect(updates).toHaveLength(1)
      expect(updates[0].sql).toMatch(/status = 'failed'/)
    } finally {
      if (prev !== undefined) process.env.PLATFORM_RELAY_WS_URL = prev
    }
  })

  it('simulates a deletion-path retry: first call fails, second call succeeds', async () => {
    // Phase 6 acceptance criterion: pre-existing deletion paths demonstrably
    // retry on simulated relay failure. Two invocations on the same outbox id
    // (the pattern the redrive cron + helpers.addJob produce); the first hits
    // a relay blip, the second gets through.
    const row = baseRow({ entity_type: 'article_deletion', attempts: 0 })
    publishMock
      .mockRejectedValueOnce(new Error('relay blip'))
      .mockResolvedValueOnce(row.signed_event.id)

    // First attempt: failed
    const firstCalls = scriptClient(row)
    const helpers = makeHelpers()
    await relayPublish({ outboxId: row.id }, helpers)

    const firstUpdate = firstCalls.find(c => /^UPDATE relay_outbox/i.test(c.sql))
    expect(firstUpdate?.sql).toMatch(/status = 'failed'/)
    expect(helpers.addJob).toHaveBeenCalledOnce()

    // Second attempt: the redrive picks it up — row.status is now 'failed',
    // which the worker accepts.
    const secondCalls = scriptClient({ ...row, status: 'failed', attempts: 1 })
    await relayPublish({ outboxId: row.id }, makeHelpers())

    const secondUpdate = secondCalls.find(c => /^UPDATE relay_outbox/i.test(c.sql))
    expect(secondUpdate?.sql).toMatch(/status = 'sent'/)
    expect(publishMock).toHaveBeenCalledTimes(2)
  })
})
