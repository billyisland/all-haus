import { describe, it, expect } from 'vitest'
import { mapUnlockError } from '../src/lib/unlock-errors'

describe('mapUnlockError', () => {
  it('maps free_allowance_exhausted to an add-card message', () => {
    const view = mapUnlockError(402, { error: 'free_allowance_exhausted', message: 'Payment required.' })
    expect(view.needsCard).toBe(true)
    expect(view.message).toMatch(/free reading credit/i)
    expect(view.message).toMatch(/card/i)
  })

  it('maps a generic 402 to a card prompt', () => {
    const view = mapUnlockError(402, { error: 'payment_required', message: 'Payment required.' })
    expect(view.needsCard).toBe(true)
  })

  it('maps article_misconfigured to the server message, no card prompt', () => {
    const view = mapUnlockError(409, {
      error: 'article_misconfigured',
      message: 'This article can’t be unlocked right now.',
    })
    expect(view.needsCard).toBe(false)
    expect(view.message).toMatch(/can’t be unlocked/)
  })

  it('tells the reader a paid-but-keyless retry is free (502 with readEventId)', () => {
    const view = mapUnlockError(502, { error: 'Key issuance failed', readEventId: 'abc' })
    expect(view.message).toMatch(/won’t be charged twice/i)
    expect(view.needsCard).toBe(false)
  })

  it('maps a plain 502 to a transient-outage message', () => {
    const view = mapUnlockError(502, { error: 'Payment or key service unreachable' })
    expect(view.message).toMatch(/temporarily/i)
  })

  it('never renders [object Object] for an object error body', () => {
    const view = mapUnlockError(400, { error: { fieldErrors: { amountPence: ['bad'] } } })
    expect(view.message).not.toContain('[object Object]')
    expect(typeof view.message).toBe('string')
  })

  it('survives a null body', () => {
    const view = mapUnlockError(undefined, null)
    expect(view.message.length).toBeGreaterThan(0)
  })
})
