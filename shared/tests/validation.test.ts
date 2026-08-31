import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { zodValidationError } from '../src/lib/validation.js'

describe('zodValidationError', () => {
  const Schema = z.object({
    pricePence: z.number().int().positive(),
    title: z.string().min(1),
  })

  it('returns a stable string code and a human message', () => {
    const parsed = Schema.safeParse({ pricePence: 0, title: 'ok' })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const body = zodValidationError(parsed.error)
    expect(body.error).toBe('validation_failed')
    expect(body.message).toMatch(/pricePence/)
    expect(body.message).toMatch(/greater than 0/)
    // the exact template-literal the web client renders must never regress
    expect(`Vault encryption failed: 400 — ${body.error}`).not.toContain('[object Object]')
  })

  it('carries the full flatten() in details', () => {
    const parsed = Schema.safeParse({ pricePence: 0, title: '' })
    if (parsed.success) throw new Error('expected failure')
    const body = zodValidationError(parsed.error)
    expect(body.details.fieldErrors.pricePence).toBeDefined()
    expect(body.details.fieldErrors.title).toBeDefined()
  })

  it('falls back to form errors when no field errors exist', () => {
    const Refined = z.object({ a: z.number() }).refine(() => false, { message: 'nope' })
    const parsed = Refined.safeParse({ a: 1 })
    if (parsed.success) throw new Error('expected failure')
    const body = zodValidationError(parsed.error)
    expect(body.message).toBe('nope')
  })
})
