import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Task } from 'graphile-worker'

const mockPool = { query: vi.fn() }
const publishNostrMock = vi.fn()

vi.mock('@platform-pub/shared/db/client.js', () => ({ pool: mockPool }))
vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('@platform-pub/shared/lib/crypto.js', () => ({ decryptJson: vi.fn() }))
vi.mock('../adapters/activitypub-outbound.js', () => ({
  postMastodonStatus: vi.fn(),
  favouriteMastodonStatus: vi.fn(),
  reblogMastodonStatus: vi.fn(),
  voteMastodonPoll: vi.fn(),
}))
vi.mock('../adapters/nostr-outbound.js', () => ({
  publishNostrToRelays: publishNostrMock,
}))
vi.mock('../adapters/atproto-outbound.js', () => ({
  postBlueskyRecord: vi.fn(),
  likeBlueskyRecord: vi.fn(),
  repostBlueskyRecord: vi.fn(),
}))

const { outboundCrossPost } = await import('./outbound-cross-post.js')

const ID = '00000000-0000-0000-0000-0000000000aa'

// A nostr_external row — the one delivery path that needs no decrypted creds,
// so failure/success is driven purely by the publishNostrToRelays mock.
function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    account_id: '00000000-0000-0000-0000-0000000000bb',
    linked_account_id: null,
    protocol: 'nostr_external',
    nostr_event_id: 'evt',
    action_type: 'original',
    source_item_id: null,
    body_text: null,
    signed_event: { id: 'sig' },
    status: 'pending',
    retry_count: 0,
    max_retries: 3,
    author_username: 'alice',
    la_external_id: null,
    la_instance_url: null,
    la_credentials_enc: null,
    la_is_valid: null,
    la_lifecycle_state: null,
    ei_source_item_uri: null,
    ei_interaction_data: null,
    ei_source_relay_urls: ['wss://relay.test'],
    ...overrides,
  }
}

type TestHelpers = Parameters<Task>[1] & { addJob: ReturnType<typeof vi.fn> }
function makeHelpers(): TestHelpers {
  return { addJob: vi.fn() } as unknown as TestHelpers
}

// Script the pool: the outbound_posts SELECT returns `selectRow`; the
// platform_config SELECT returns a fixed retry config; UPDATEs pass through.
function scriptPool(selectRow: unknown) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  mockPool.query.mockReset()
  mockPool.query.mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (/FROM outbound_posts op/i.test(sql)) {
      return Promise.resolve({ rows: selectRow ? [selectRow] : [] })
    }
    if (/FROM platform_config/i.test(sql)) {
      return Promise.resolve({
        rows: [
          { key: 'outbound_max_retries', value: '3' },
          { key: 'outbound_retry_delay_seconds', value: '30' },
        ],
      })
    }
    return Promise.resolve({ rows: [] })
  })
  return calls
}

describe('outboundCrossPost', () => {
  beforeEach(() => {
    publishNostrMock.mockReset()
  })

  it('sends successfully → UPDATE status=sent', async () => {
    const calls = scriptPool(baseRow())
    publishNostrMock.mockResolvedValueOnce('nostr://posted/123')

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(publishNostrMock).toHaveBeenCalledOnce()
    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'sent'/)
    expect(updates[0].params).toEqual([ID, 'nostr://posted/123'])
  })

  it('on failure → UPDATE status=retrying + schedules a versioned retry', async () => {
    const calls = scriptPool(baseRow({ retry_count: 1 }))
    publishNostrMock.mockRejectedValueOnce(new Error('relay down'))
    const helpers = makeHelpers()

    await outboundCrossPost({ outboundPostId: ID }, helpers)

    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'retrying'/)
    expect(updates[0].params[1]).toBe(2) // retry_count = 1 + 1
    expect(updates[0].params[2]).toBe('relay down')

    expect(helpers.addJob).toHaveBeenCalledOnce()
    const [taskName, payload, opts] = helpers.addJob.mock.calls[0]
    expect(taskName).toBe('outbound_cross_post')
    expect(payload).toEqual({ outboundPostId: ID })
    expect(opts?.jobKey).toBe(`outbound_cross_post_${ID}_r2`)
    expect(opts?.maxAttempts).toBe(1)
    expect(opts?.runAt).toBeInstanceOf(Date)
  })

  it('at max_retries → UPDATE status=failed, no retry scheduled', async () => {
    const calls = scriptPool(baseRow({ retry_count: 2, max_retries: 3 }))
    publishNostrMock.mockRejectedValueOnce(new Error('permanent'))
    const helpers = makeHelpers()

    await outboundCrossPost({ outboundPostId: ID }, helpers)

    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'failed'/)
    expect(updates[0].params).toEqual([ID, 'permanent'])
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  it('is a no-op when the row is already sent', async () => {
    const calls = scriptPool(baseRow({ status: 'sent' }))

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(publishNostrMock).not.toHaveBeenCalled()
    expect(calls.filter((c) => /^\s*UPDATE/i.test(c.sql))).toHaveLength(0)
  })

  it('marks an OAuth row failed when the linked account is invalid', async () => {
    const calls = scriptPool(
      baseRow({ protocol: 'atproto', la_is_valid: false, la_lifecycle_state: 'active' }),
    )
    const helpers = makeHelpers()

    await outboundCrossPost({ outboundPostId: ID }, helpers)

    expect(publishNostrMock).not.toHaveBeenCalled()
    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'failed'/)
    expect(helpers.addJob).not.toHaveBeenCalled()
  })
})
