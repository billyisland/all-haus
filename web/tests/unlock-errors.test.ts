import { describe, it, expect } from 'vitest'
import { mapUnlockError } from '../src/lib/unlock-errors'

describe('mapUnlockError', () => {
  it('maps free_allowance_exhausted to an add-card message', () => {
    const view = mapUnlockError(402, { error: 'free_allowance_exhausted', message: 'Payment required.' })
    expect(view.needsCard).toBe(true)
    expect(view.message).toMatch(/free reading allowance/i)
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

describe('the Reader Terms refusal', () => {
  it('asks for the terms, not for a card', () => {
    // The refusal reaches ONLY readers who already have a card, so offering
    // "add a payment card" would point at a step they finished months ago —
    // which is what a 402-shaped branch here would have done.
    const view = mapUnlockError(403, {
      error: 'reader_terms_required',
      message: 'Before your next paid read, please accept the all.haus Reader Terms.',
    })
    expect(view.needsTerms).toBe(true)
    expect(view.needsCard).toBe(false)
    expect(view.message).toContain('Reader Terms')
  })

  it('keeps its own copy when the server sends none', () => {
    const view = mapUnlockError(403, { error: 'reader_terms_required' })
    expect(view.needsTerms).toBe(true)
    expect(view.message).not.toBe('reader_terms_required')
  })

  it('no other refusal claims it', () => {
    // The control. A flag defaulted true somewhere would put a legal box in
    // front of a reader whose real problem is an exhausted allowance.
    expect(mapUnlockError(402, { error: 'free_allowance_exhausted' }).needsTerms).toBe(false)
    expect(mapUnlockError(409, { error: 'article_misconfigured' }).needsTerms).toBe(false)
    expect(mapUnlockError(502, { readEventId: 're-1' }).needsTerms).toBe(false)
    expect(mapUnlockError(500, {}).needsTerms).toBe(false)
  })
})

describe('the two refusals the tab itself makes', () => {
  // Both arrive as 402, which is the generic "add a payment card" branch — and
  // that copy is wrong for each of them in opposite directions. One reader has
  // a card that no longer works; the other has a card that works perfectly and
  // a tab at its cap. A refusal whose suggested fix does not apply is worse
  // than none: the reader does the suggested thing and nothing moves.

  it('sends a declined card-holder to REPLACE the card, not to add a first one', () => {
    const view = mapUnlockError(402, { error: 'card_action_required' })
    expect(view.needsCard).toBe(true)
    expect(view.message).toMatch(/card on file was declined/i)
    expect(view.message).toMatch(/paused/i)
    // And it says the tab is not lost — the reader's first question.
    expect(view.message).toMatch(/already on your tab/i)
  })

  it('tells a capped reader to wait, and asks for no card at all', () => {
    const view = mapUnlockError(402, { error: 'tab_ceiling', balancePence: 795, ceilingPence: 800 })
    expect(view.needsCard).toBe(false)
    expect(view.needsTerms).toBe(false)
    expect(view.message).toMatch(/limit/i)
    // The charge is already running, so the honest instruction is "try again".
    expect(view.message).toMatch(/try again|moment/i)
    // And nothing has been charged for THIS piece, which is the fear.
    expect(view.message).toMatch(/nothing has been charged/i)
  })

  it('does not confuse the two with each other, or with the allowance', () => {
    // The control: three 402s, three different fixes. Collapsing any pair sends
    // a reader to a remedy that cannot work.
    const ceiling = mapUnlockError(402, { error: 'tab_ceiling' })
    const declined = mapUnlockError(402, { error: 'card_action_required' })
    const allowance = mapUnlockError(402, { error: 'free_allowance_exhausted' })
    const messages = new Set([ceiling.message, declined.message, allowance.message])
    expect(messages.size).toBe(3)
    expect(ceiling.needsCard).toBe(false)
    expect(declined.needsCard).toBe(true)
    expect(allowance.needsCard).toBe(true)
  })
})
