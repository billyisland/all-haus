// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// The index is retried with the SIGNED event, never re-signed (CA-B11,
// 2026-09-29).
//
// `signPublishAndIndex` signs once (which also enqueues the event to the
// relay) and then POSTs the index; a failure there used to throw at once,
// and the next press signed a NEW event — two copies on the relay for one
// post. The index routes are idempotent on `nostr_event_id`, so a fault of
// ours (5xx, a dropped connection) is asked again with the same body; a 4xx
// is the route's answer and final. The assertion is on how many times the
// signer ran and what the index was sent.
// =============================================================================

const signAndPublish = vi.fn(async () => ({ id: 'e'.repeat(64) }))
vi.mock('@/lib/sign', () => ({ signAndPublish: (...a: unknown[]) => signAndPublish(...(a as [])) }))
vi.mock('@/lib/ndk', () => ({ KIND_NOTE: 1 }))

import { signPublishAndIndex, INDEX_RETRIES } from '@/lib/signPublishAndIndex'
import { ApiError, failureSentence } from '@/lib/api/client'

type Answer = { status: number; body?: unknown } | 'network'
const answers: Answer[] = []
const calls: Array<{ url: string; body: string }> = []

beforeEach(() => {
  vi.useFakeTimers()
  answers.length = 0
  calls.length = 0
  signAndPublish.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) })
    const next = answers.shift()
    if (!next || next === 'network') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const params = {
  content: 'hello',
  tags: [] as string[][],
  indexEndpoint: '/api/v1/notes',
  indexBody: (eventId: string) => ({ nostrEventId: eventId, content: 'hello' }),
}

async function run() {
  const p = signPublishAndIndex(params)
  // The caller observes the rejection; this keeps a refusal that lands while
  // the timers are being advanced from surfacing as an unhandled one.
  p.catch(() => {})
  // Let the retry delays elapse.
  await vi.runAllTimersAsync()
  return p
}

describe('signPublishAndIndex', () => {
  it('a 5xx on the index is asked again with the SAME signed event, never a new signature', async () => {
    answers.push({ status: 502 }, { status: 201, body: { noteId: 'n1' } })
    const out = await run()
    expect(out.eventId).toBe('e'.repeat(64))
    expect(signAndPublish).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(calls[0].body).toBe(calls[1].body)
    expect(JSON.parse(calls[1].body).nostrEventId).toBe('e'.repeat(64))
  })

  it('a dropped connection is retried the same way', async () => {
    answers.push('network', { status: 201, body: {} })
    await run()
    expect(signAndPublish).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
  })

  it("a 4xx is the route's answer: one call, and its sentence", async () => {
    answers.push({ status: 409, body: { error: 'event_id_taken', message: 'That event id already belongs to other content.' } })
    const err = await run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(failureSentence(err, 'FALLBACK')).toBe('That event id already belongs to other content.')
    expect(calls).toHaveLength(1)
    expect(signAndPublish).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retries, still having signed only once', async () => {
    for (let i = 0; i <= INDEX_RETRIES; i++) answers.push({ status: 503 })
    const err = await run().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(503)
    expect(calls).toHaveLength(INDEX_RETRIES + 1)
    expect(signAndPublish).toHaveBeenCalledTimes(1)
  })
})
