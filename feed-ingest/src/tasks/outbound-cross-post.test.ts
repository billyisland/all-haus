import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Task } from 'graphile-worker'

const mockPool = { query: vi.fn() }
// withTransaction hands its callback a DIFFERENT object from the pool, whose
// queries land in the same call log tagged `tx`. What markFailed writes inside
// the transaction is then distinguishable from what it would write outside it.
const txClient = {
  query: (sql: string, params: unknown[] = []) => {
    txQueries.push({ sql, params })
    return mockPool.query(sql, params)
  },
}
let txQueries: Array<{ sql: string; params: unknown[] }> = []
const publishNostrMock = vi.fn()
const resolveRootMock = vi.fn()

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: mockPool,
  withTransaction: (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient),
}))
vi.mock('../lib/atproto-reply-root.js', () => ({
  resolveBlueskyReplyRoot: resolveRootMock,
}))
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
const postBlueskyMock = vi.fn()
const likeBlueskyMock = vi.fn()
const repostBlueskyMock = vi.fn()
vi.mock('../adapters/atproto-outbound.js', () => ({
  postBlueskyRecord: postBlueskyMock,
  likeBlueskyRecord: likeBlueskyMock,
  repostBlueskyRecord: repostBlueskyMock,
}))

const { outboundCrossPost } = await import('./outbound-cross-post.js')
// The real marker and the real derivation — not local copies, so a rename in
// either breaks this suite rather than leaving it agreeing with itself.
const { TerminalDeliveryError } = await import('../lib/outbound-errors.js')
const { deriveRecordKey, TID_RE } = await import('../lib/atproto-tid.js')

const ID = '00000000-0000-0000-0000-0000000000aa'
const CREATED = new Date('2026-09-10T09:08:07.006Z')

// An atproto row with a live presence — the delivery path whose record key and
// createdAt must come off the row rather than off the attempt.
function atprotoRow(overrides: Record<string, unknown> = {}) {
  return baseRow({
    protocol: 'atproto',
    action_type: 'original',
    body_text: 'hello bluesky',
    la_external_id: 'did:plc:alice',
    la_is_valid: true,
    la_lifecycle_state: 'active',
    ...overrides,
  })
}

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
    created_at: CREATED,
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
  txQueries = []
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
          { key: 'outbound_bluesky_max_graphemes', value: '300' },
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
    postBlueskyMock.mockReset()
    likeBlueskyMock.mockReset()
    repostBlueskyMock.mockReset()
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

// =============================================================================
// The delivery identity is the ROW's, not the attempt's (audit §2.16). Before
// this, every attempt let the PDS mint a fresh rkey and stamped `createdAt` at
// `new Date()`, so a lost response on a timeout posted the member's words
// twice with no way to tell afterwards which record was the duplicate.
// =============================================================================
describe('outboundCrossPost — atproto delivery identity', () => {
  beforeEach(() => {
    postBlueskyMock.mockReset()
    likeBlueskyMock.mockReset()
    repostBlueskyMock.mockReset()
  })

  it('addresses the write to a row-derived TID and stamps the row time', async () => {
    scriptPool(atprotoRow())
    postBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/y/z', cid: 'cid1' })

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(postBlueskyMock).toHaveBeenCalledOnce()
    const input = postBlueskyMock.mock.calls[0][0]
    expect(input.rkey).toBe(deriveRecordKey(ID, CREATED))
    expect(input.rkey).toMatch(TID_RE)
    // Not `new Date()` — the row's own enqueue time, so the record's bytes are
    // the same on attempt 1 and attempt 3.
    expect(input.createdAt).toBe(CREATED.toISOString())
  })

  it('sends byte-identical identity on a later attempt of the same row', async () => {
    // The property that makes retrying an ambiguous failure safe: putRecord on
    // the same path with the same content is a no-op, not a second post. Two
    // runs of the worker on one row, at different points in its retry budget
    // and at different wall-clock times.
    scriptPool(atprotoRow({ retry_count: 0 }))
    postBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/y/z', cid: 'c' })
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    await new Promise((r) => setTimeout(r, 5))

    scriptPool(atprotoRow({ retry_count: 2, status: 'retrying' }))
    postBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/y/z', cid: 'c' })
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    const first = postBlueskyMock.mock.calls[0][0]
    const second = postBlueskyMock.mock.calls[1][0]
    expect(second.rkey).toBe(first.rkey)
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('gives like and repost the same row-derived identity', async () => {
    // A duplicate like is repo litter rather than a visible double post, but it
    // is the same defect and the same fix, so both carry the identity too.
    const interaction = { uri: 'at://did:plc:bob/app.bsky.feed.post/1', cid: 'c1' }
    scriptPool(atprotoRow({ action_type: 'like', ei_interaction_data: interaction }))
    likeBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/like/1' })
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    scriptPool(atprotoRow({ action_type: 'repost', ei_interaction_data: interaction }))
    repostBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/repost/1' })
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    const expected = { rkey: deriveRecordKey(ID, CREATED), createdAt: CREATED.toISOString() }
    expect(likeBlueskyMock.mock.calls[0][2]).toEqual(expected)
    expect(repostBlueskyMock.mock.calls[0][2]).toEqual(expected)
  })
})

// =============================================================================
// Terminal vs ambiguous. Both cases below sit at retry_count 0 of 3, so the
// status is decided by the CLASSIFICATION and not by the retry budget — which
// is the difference the fix makes. A test that only ran a row at its last
// attempt would pass against a worker with no split at all.
// =============================================================================
describe('outboundCrossPost — terminal vs ambiguous', () => {
  beforeEach(() => {
    postBlueskyMock.mockReset()
  })

  it('marks failed at once when the PDS refuses (4xx)', async () => {
    const calls = scriptPool(atprotoRow({ retry_count: 0, max_retries: 3 }))
    postBlueskyMock.mockRejectedValueOnce(
      new TerminalDeliveryError('Bluesky post HTTP 400: InvalidRequest'),
    )
    const helpers = makeHelpers()

    await outboundCrossPost({ outboundPostId: ID }, helpers)

    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'failed'/)
    expect(helpers.addJob).not.toHaveBeenCalled()
  })

  // C4: a credential the far end refused invalidates the PRESENCE, so the next
  // cross-post is stopped at the claim instead of spending its own retries on
  // the same 401. Asserted by the statement and its target, because "the row
  // failed" is what an un-invalidated presence produces too.
  it('a refused credential invalidates the presence; a refused post does not', async () => {
    const PRESENCE = '00000000-0000-0000-0000-0000000000cc'
    const presenceUpdates = (calls: Array<{ sql: string; params: unknown[] }>) =>
      calls.filter((c) => /UPDATE network_presences\s+SET is_valid = FALSE/i.test(c.sql))

    let calls = scriptPool(atprotoRow({ linked_account_id: PRESENCE }))
    const revoked = new Error('session revoked')
    revoked.name = 'TokenRevokedError'
    postBlueskyMock.mockRejectedValueOnce(revoked)
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())
    expect(presenceUpdates(calls).map((c) => c.params[0])).toEqual([PRESENCE])

    calls = scriptPool(atprotoRow({ linked_account_id: PRESENCE }))
    postBlueskyMock.mockRejectedValueOnce(
      new TerminalDeliveryError('Bluesky post HTTP 400: InvalidRequest'),
    )
    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())
    expect(presenceUpdates(calls)).toEqual([])
  })

  it('retries the same row at the same attempt count when the failure is ambiguous', async () => {
    const calls = scriptPool(atprotoRow({ retry_count: 0, max_retries: 3 }))
    postBlueskyMock.mockRejectedValueOnce(new Error('Bluesky post HTTP 503: upstream'))
    const helpers = makeHelpers()

    await outboundCrossPost({ outboundPostId: ID }, helpers)

    const updates = calls.filter((c) => /^\s*UPDATE outbound_posts/i.test(c.sql))
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/status = 'retrying'/)
    expect(helpers.addJob).toHaveBeenCalledOnce()
  })
})

// =============================================================================
// CROSS-NETWORK-ROUNDTRIP-ADR rung A, the worker half.
// =============================================================================
const { postMastodonStatus } = await import('../adapters/activitypub-outbound.js')
const { CROSS_POST_FAILED_NOTIFICATION_SQL } = await import('./outbound-cross-post.js')
const { decryptJson } = await import('@platform-pub/shared/lib/crypto.js')

describe('outboundCrossPost — a reply names its thread root (A8)', () => {
  beforeEach(() => {
    postBlueskyMock.mockReset()
    resolveRootMock.mockReset()
  })

  it('asks for the root, never assuming the parent is it', async () => {
    // A context row stored before A8: {uri, cid} and no root. The parent is
    // itself a reply, so `root = parent` would be the malformed thread ref.
    const parent = { uri: 'at://did:plc:bob/app.bsky.feed.post/2', cid: 'c2' }
    const root = { uri: 'at://did:plc:carol/app.bsky.feed.post/1', cid: 'c1' }
    scriptPool(atprotoRow({ action_type: 'reply', ei_interaction_data: parent }))
    resolveRootMock.mockResolvedValueOnce(root)
    postBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/y/z', cid: 'c' })

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(resolveRootMock).toHaveBeenCalledWith({
      uri: parent.uri,
      cid: parent.cid,
      rootUri: undefined,
      rootCid: undefined,
    })
    expect(postBlueskyMock.mock.calls[0][0].reply).toEqual({ root, parent })
  })

  it('passes a stored root through to the resolver', async () => {
    const stored = {
      uri: 'at://did:plc:bob/app.bsky.feed.post/2',
      cid: 'c2',
      rootUri: 'at://did:plc:carol/app.bsky.feed.post/1',
      rootCid: 'c1',
    }
    scriptPool(atprotoRow({ action_type: 'reply', ei_interaction_data: stored }))
    resolveRootMock.mockResolvedValueOnce({ uri: stored.rootUri, cid: stored.rootCid })
    postBlueskyMock.mockResolvedValueOnce({ externalPostUri: 'at://x/y/z', cid: 'c' })

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(resolveRootMock.mock.calls[0][0]).toMatchObject({
      rootUri: stored.rootUri,
      rootCid: stored.rootCid,
    })
  })
})

describe('outboundCrossPost — the Mastodon reply knows who is replying (A5)', () => {
  it("hands the adapter the member's own account id and handle", async () => {
    vi.mocked(postMastodonStatus).mockReset()
    vi.mocked(decryptJson).mockReturnValue({ accessToken: 't', scope: 'read write' })
    scriptPool(
      baseRow({
        protocol: 'activitypub',
        action_type: 'reply',
        body_text: 'hi',
        la_external_id: '109999',
        la_handle: 'alice@mastodon.example',
        la_instance_url: 'https://mastodon.example',
        la_credentials_enc: 'enc',
        la_is_valid: true,
        la_lifecycle_state: 'active',
        ei_source_item_uri: 'https://other.example/users/bob/statuses/1',
      }),
    )
    vi.mocked(postMastodonStatus).mockResolvedValueOnce({ externalPostUri: 'https://m/1' })

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    const input = vi.mocked(postMastodonStatus).mock.calls[0][0]
    expect(input.replyToStatusUri).toBe('https://other.example/users/bob/statuses/1')
    expect(input.self).toEqual({ accountId: '109999', handle: 'alice@mastodon.example' })
  })
})

describe('outboundCrossPost — a failure is told to the member (A7)', () => {
  beforeEach(() => {
    postBlueskyMock.mockReset()
  })

  it('writes the notification in the SAME transaction as the failed status', async () => {
    scriptPool(atprotoRow({ retry_count: 0, max_retries: 3 }))
    postBlueskyMock.mockRejectedValueOnce(
      new TerminalDeliveryError('Bluesky post HTTP 400: InvalidRequest'),
    )

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    // Both statements went through the transaction's client, in order.
    expect(txQueries).toHaveLength(2)
    expect(txQueries[0].sql).toMatch(/UPDATE outbound_posts[\s\S]*status = 'failed'/)
    expect(txQueries[1].sql).toBe(CROSS_POST_FAILED_NOTIFICATION_SQL)
    expect(txQueries[1].params).toEqual([ID])
  })

  it('notifies on the claim-time failure too (invalid presence)', async () => {
    scriptPool(baseRow({ protocol: 'atproto', la_is_valid: false, la_lifecycle_state: 'active' }))

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(txQueries.map((q) => q.sql)).toContain(CROSS_POST_FAILED_NOTIFICATION_SQL)
  })

  it('does not notify on a retry', async () => {
    scriptPool(atprotoRow({ retry_count: 0, max_retries: 3 }))
    postBlueskyMock.mockRejectedValueOnce(new Error('Bluesky post HTTP 503'))

    await outboundCrossPost({ outboundPostId: ID }, makeHelpers())

    expect(txQueries).toHaveLength(0)
  })

  // A STRUCTURAL pin (testing rule part 2): which rows notify, and that one
  // note collapses, is only Postgres's to evaluate — the DB-backed
  // cross-post-failed-notification.test.ts runs this same exported SQL.
  it('binds the note, the member as actor, and speech actions only', () => {
    expect(CROSS_POST_FAILED_NOTIFICATION_SQL).toMatch(/SELECT op\.account_id, op\.account_id, 'cross_post_failed', n\.id/)
    expect(CROSS_POST_FAILED_NOTIFICATION_SQL).toMatch(/action_type IN \('reply', 'quote', 'original'\)/)
    expect(CROSS_POST_FAILED_NOTIFICATION_SQL).toMatch(/ON CONFLICT DO NOTHING/)
  })
})
