import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// CROSS-NETWORK-ROUNDTRIP-ADR F6/A8 — the worker's answer to "which record is
// this reply's thread root?" where the stored row does not say. Driven against
// a routed safeFetch: the assertion that matters for the stored-root case is
// that NOTHING is fetched, and for the rest what the AppView said.
// =============================================================================

type Resp = { ok: boolean; status: number; text: string }
const calls: string[] = []
let answer: Resp

vi.mock('@platform-pub/shared/lib/http-client.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    calls.push(url)
    return answer
  }),
}))

const { resolveBlueskyReplyRoot } = await import('./atproto-reply-root.js')
const { isTerminalDeliveryError } = await import('./outbound-errors.js')

const PARENT = { uri: 'at://did:plc:bob/app.bsky.feed.post/2', cid: 'c2' }
const ROOT = { uri: 'at://did:plc:carol/app.bsky.feed.post/1', cid: 'c1' }
const posts = (p: unknown[]): Resp => ({ ok: true, status: 200, text: JSON.stringify({ posts: p }) })

beforeEach(() => {
  calls.length = 0
})

describe('resolveBlueskyReplyRoot', () => {
  it('a stored root is used as-is, with no fetch', async () => {
    const r = await resolveBlueskyReplyRoot({ ...PARENT, rootUri: ROOT.uri, rootCid: ROOT.cid })
    expect(r).toEqual(ROOT)
    expect(calls).toEqual([])
  })

  it('an unstored root is ASKED for — a parent that is a reply names its own root', async () => {
    answer = posts([{ ...PARENT, record: { reply: { root: ROOT, parent: ROOT } } }])
    expect(await resolveBlueskyReplyRoot(PARENT)).toEqual(ROOT)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(encodeURIComponent(PARENT.uri))
  })

  it('a top-level parent is its own root', async () => {
    answer = posts([{ ...PARENT, record: {} }])
    expect(await resolveBlueskyReplyRoot(PARENT)).toEqual(PARENT)
  })

  it('a post the AppView no longer has is terminal', async () => {
    answer = posts([])
    const err = await resolveBlueskyReplyRoot(PARENT).catch((e) => e)
    expect(isTerminalDeliveryError(err)).toBe(true)
  })

  it('a reply record with a malformed root is terminal, never guessed', async () => {
    answer = posts([{ ...PARENT, record: { reply: { root: { uri: ROOT.uri } } } }])
    const err = await resolveBlueskyReplyRoot(PARENT).catch((e) => e)
    expect(isTerminalDeliveryError(err)).toBe(true)
  })

  it('a 5xx or 429 is ambiguous (retried); a 400 is terminal', async () => {
    for (const [status, terminal] of [[502, false], [429, false], [400, true]] as const) {
      answer = { ok: false, status, text: 'x' }
      const err = await resolveBlueskyReplyRoot(PARENT).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(isTerminalDeliveryError(err)).toBe(terminal)
    }
  })
})
