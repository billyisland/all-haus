import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// Drives the REAL adapter against a fake PDS, because the two things the fix
// turns on are both invisible from the task side: WHICH xrpc method is called,
// and what the record body actually carries. A suite that mocks this module and
// asserts what the task handed it passes green against an adapter that stamps
// `new Date()` over the value it was given (measured — that mutation survived
// the task-level tests entirely).
// =============================================================================

const fetchHandler = vi.fn()

vi.mock('@platform-pub/shared/lib/atproto-oauth.js', () => ({
  getAtprotoClient: vi.fn(async () => ({
    restore: vi.fn(async () => ({ fetchHandler })),
  })),
}))
vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { postBlueskyRecord, likeBlueskyRecord, repostBlueskyRecord } = await import(
  './atproto-outbound.js'
)
const { isTerminalDeliveryError } = await import('../lib/outbound-errors.js')

const DID = 'did:plc:alice'
// Named TID rather than RKEY: gitleaks' generic-api-key rule reads
// `KEY = '<high-entropy string>'` as a credential, and a hit fails the
// mirror publish at the release tag rather than here (gitleaks-public.toml).
const TID = '3l4abcdefgh22'
const CREATED = '2026-09-10T09:08:07.006Z'

function accepted(uri = `at://${DID}/app.bsky.feed.post/${TID}`) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ uri, cid: 'bafycid' }),
    text: async () => '',
  }
}

function refused(status: number, body = 'nope') {
  return { ok: false, status, json: async () => ({}), text: async () => body }
}

function sentBody() {
  const [path, init] = fetchHandler.mock.calls[0]
  return { path, body: JSON.parse(init.body as string) }
}

describe('postBlueskyRecord', () => {
  beforeEach(() => fetchHandler.mockReset())

  it('writes to the caller-chosen path with putRecord', async () => {
    fetchHandler.mockResolvedValueOnce(accepted())

    await postBlueskyRecord({
      did: DID,
      text: 'hello bluesky',
      maxGraphemes: 300,
      rkey: TID,
      createdAt: CREATED,
    })

    const { path, body } = sentBody()
    // createRecord lets the PDS mint the key, which is what made every attempt
    // a new post; putRecord is the idempotent-upsert form.
    expect(path).toBe('/xrpc/com.atproto.repo.putRecord')
    expect(body.rkey).toBe(TID)
    expect(body.repo).toBe(DID)
    expect(body.collection).toBe('app.bsky.feed.post')
  })

  it("stamps the record with the caller's timestamp, never its own clock", async () => {
    fetchHandler.mockResolvedValueOnce(accepted())

    await postBlueskyRecord({
      did: DID,
      text: 'hello bluesky',
      maxGraphemes: 300,
      rkey: TID,
      createdAt: CREATED,
    })

    // Byte-identical retries are the whole mechanism: same path, same content.
    expect(sentBody().body.record.createdAt).toBe(CREATED)
  })

  it('classifies a 4xx as terminal — the write was refused and created nothing', async () => {
    fetchHandler.mockResolvedValueOnce(refused(400, 'InvalidRequest: bad record'))

    const err = await postBlueskyRecord({
      did: DID,
      text: 'x',
      maxGraphemes: 300,
      rkey: TID,
      createdAt: CREATED,
    }).catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(true)
  })

  it('classifies a 5xx as ambiguous — the record may already exist', async () => {
    fetchHandler.mockResolvedValueOnce(refused(503, 'upstream unavailable'))

    const err = await postBlueskyRecord({
      did: DID,
      text: 'x',
      maxGraphemes: 300,
      rkey: TID,
      createdAt: CREATED,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isTerminalDeliveryError(err)).toBe(false)
  })

  it('classifies a 429 as ambiguous, though it is a 4xx', async () => {
    // The far end asking us to come back later says nothing about whether an
    // earlier attempt landed, so it is the one 4xx that must be retried.
    fetchHandler.mockResolvedValueOnce(refused(429, 'RateLimitExceeded'))

    const err = await postBlueskyRecord({
      did: DID,
      text: 'x',
      maxGraphemes: 300,
      rkey: TID,
      createdAt: CREATED,
    }).catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(false)
  })
})

describe('likeBlueskyRecord / repostBlueskyRecord', () => {
  beforeEach(() => fetchHandler.mockReset())

  it('like carries the row identity into its own collection', async () => {
    fetchHandler.mockResolvedValueOnce(accepted(`at://${DID}/app.bsky.feed.like/${TID}`))

    await likeBlueskyRecord(
      DID,
      { uri: 'at://did:plc:bob/app.bsky.feed.post/1', cid: 'c1' },
      { rkey: TID, createdAt: CREATED },
    )

    const { path, body } = sentBody()
    expect(path).toBe('/xrpc/com.atproto.repo.putRecord')
    expect(body.collection).toBe('app.bsky.feed.like')
    expect(body.rkey).toBe(TID)
    expect(body.record.createdAt).toBe(CREATED)
  })

  it('repost carries the row identity into its own collection', async () => {
    fetchHandler.mockResolvedValueOnce(accepted(`at://${DID}/app.bsky.feed.repost/${TID}`))

    await repostBlueskyRecord(
      DID,
      { uri: 'at://did:plc:bob/app.bsky.feed.post/1', cid: 'c1' },
      { rkey: TID, createdAt: CREATED },
    )

    const { path, body } = sentBody()
    expect(body.collection).toBe('app.bsky.feed.repost')
    expect(body.rkey).toBe(TID)
    expect(body.record.createdAt).toBe(CREATED)
  })
})
