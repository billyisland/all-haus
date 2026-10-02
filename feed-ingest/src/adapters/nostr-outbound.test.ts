import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// A relay's `OK: false` is three different facts wearing one shape (NIP-01),
// and the worker used to treat all three as "retry": a `blocked:` pubkey burned
// all ten attempts on an answer that could not change, and a `duplicate:` —
// the relay telling us it ALREADY HAS the event — was recorded as a failure.
//
// These drive the REAL publishNostrToRelaysDetailed against a fake socket,
// because the load-bearing part is the AGGREGATION across relays, not the
// prefix match: a helper test agrees with itself about which relays refused.
// =============================================================================

type Scripted =
  | { kind: 'accept' }
  | { kind: 'reject'; message: string }
  | { kind: 'socket-error' }

const SCRIPT = new Map<string, Scripted>()

class FakeWebSocket {
  private handlers = new Map<string, (arg?: unknown) => void>()

  constructor(private url: string) {
    // Fire after the caller has registered its handlers (publishOne registers
    // them synchronously right after construction).
    setTimeout(() => this.run(), 0)
  }

  on(event: string, cb: (arg?: unknown) => void): this {
    this.handlers.set(event, cb)
    return this
  }

  send(): void {}
  close(): void {}

  private run(): void {
    const s = SCRIPT.get(this.url)
    if (!s) return
    if (s.kind === 'socket-error') {
      this.handlers.get('error')?.(new Error('connection reset'))
      return
    }
    this.handlers.get('open')?.()
    const frame = JSON.stringify([
      'OK',
      'evt',
      s.kind === 'accept',
      s.kind === 'reject' ? s.message : '',
    ])
    this.handlers.get('message')?.(Buffer.from(frame))
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }))
vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('@platform-pub/shared/lib/http-client.js', () => ({
  pinnedWebSocketOptions: vi.fn(async () => ({})),
}))

const { publishNostrToRelaysDetailed, isDuplicateRejection, isTerminalRejection } =
  await import('./nostr-outbound.js')
const { isTerminalDeliveryError } = await import('../lib/outbound-errors.js')

const EVENT = {
  id: 'aa'.repeat(32),
  pubkey: 'bb'.repeat(32),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [],
  content: 'hello',
  sig: 'cc'.repeat(64),
}

const A = 'wss://a.test'
const B = 'wss://b.test'

describe('NIP-01 rejection prefixes', () => {
  it('reads duplicate: as the relay already holding the event', () => {
    expect(isDuplicateRejection('duplicate: have this event')).toBe(true)
    expect(isDuplicateRejection('DUPLICATE: have this event')).toBe(true)
    expect(isDuplicateRejection('invalid: bad sig')).toBe(false)
  })

  it('reads invalid/blocked/restricted as terminal and the rest as transient', () => {
    for (const m of ['invalid: bad signature', 'blocked: pubkey not allowed', 'restricted: paid relay']) {
      expect(isTerminalRejection(m)).toBe(true)
    }
    // `pow:` and `error:` can both clear on their own, and a bare message is an
    // unrecognised answer — the safe direction for those is to try again.
    for (const m of ['rate-limited: slow down', 'pow: need more work', 'error: internal', 'nope']) {
      expect(isTerminalRejection(m)).toBe(false)
    }
  })
})

describe('publishNostrToRelaysDetailed', () => {
  beforeEach(() => SCRIPT.clear())

  it('counts duplicate: as delivered, not as a failure', async () => {
    SCRIPT.set(A, { kind: 'reject', message: 'duplicate: have aa…' })
    const result = await publishNostrToRelaysDetailed(EVENT, [A])
    expect(result.succeeded).toEqual([A])
    expect(result.failed).toEqual([])
  })

  it('is TERMINAL when every relay refused deterministically', async () => {
    SCRIPT.set(A, { kind: 'reject', message: 'blocked: pubkey not allowed' })
    SCRIPT.set(B, { kind: 'reject', message: 'invalid: created_at too old' })

    const err = await publishNostrToRelaysDetailed(EVENT, [A, B]).catch((e) => e)
    expect(isTerminalDeliveryError(err)).toBe(true)
    // The row's status comes from this, so the reasons have to reach it.
    expect(err.message).toMatch(/blocked: pubkey not allowed/)
    expect(err.message).toMatch(/invalid: created_at too old/)
  })

  it('is AMBIGUOUS when one refusal among them was not deterministic', async () => {
    // The rule that matters: a relay that never answered may yet accept, so the
    // whole attempt is retryable even though the other relay gave a flat no.
    // Republishing the same signed event is idempotent by event id.
    SCRIPT.set(A, { kind: 'reject', message: 'invalid: created_at too old' })
    SCRIPT.set(B, { kind: 'socket-error' })

    const err = await publishNostrToRelaysDetailed(EVENT, [A, B]).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isTerminalDeliveryError(err)).toBe(false)
  })

  it('is AMBIGUOUS on a rate limit, however many relays said it', async () => {
    SCRIPT.set(A, { kind: 'reject', message: 'rate-limited: slow down' })
    const err = await publishNostrToRelaysDetailed(EVENT, [A]).catch((e) => e)
    expect(isTerminalDeliveryError(err)).toBe(false)
  })

  it('still treats one acceptance as delivery, whatever the others said', async () => {
    SCRIPT.set(A, { kind: 'accept' })
    SCRIPT.set(B, { kind: 'reject', message: 'blocked: pubkey not allowed' })

    const result = await publishNostrToRelaysDetailed(EVENT, [A, B])
    expect(result.succeeded).toEqual([A])
    expect(result.failed).toEqual([B])
  })
})
