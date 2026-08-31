import { describe, it, expect } from 'vitest'
import { SignEventSchema, UnwrapKeySchema, resolveSignerId } from '../src/routes/keypairs.js'

const validUuid = '550e8400-e29b-41d4-a716-446655440000'
const validUuid2 = '660e8400-e29b-41d4-a716-446655440000'

describe('SignEventSchema', () => {
  const validEvent = {
    kind: 30023,
    content: 'hello world',
    tags: [['d', 'test-tag']],
  }

  it('parses valid input with signerId', () => {
    const result = SignEventSchema.safeParse({
      signerId: validUuid,
      event: validEvent,
    })
    expect(result.success).toBe(true)
  })

  it('parses valid input with accountId (legacy)', () => {
    const result = SignEventSchema.safeParse({
      accountId: validUuid,
      event: validEvent,
    })
    expect(result.success).toBe(true)
  })

  it('parses valid input with both signerId and accountId', () => {
    const result = SignEventSchema.safeParse({
      signerId: validUuid,
      accountId: validUuid2,
      event: validEvent,
    })
    expect(result.success).toBe(true)
  })

  it('fails when neither signerId nor accountId is provided', () => {
    const result = SignEventSchema.safeParse({
      event: validEvent,
    })
    expect(result.success).toBe(false)
  })

  it('defaults signerType to account', () => {
    const result = SignEventSchema.safeParse({
      signerId: validUuid,
      event: validEvent,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.signerType).toBe('account')
    }
  })

  it('accepts publication signerType', () => {
    const result = SignEventSchema.safeParse({
      signerId: validUuid,
      signerType: 'publication',
      event: validEvent,
    })
    expect(result.success).toBe(true)
  })

  it('fails on missing event.kind', () => {
    const result = SignEventSchema.safeParse({
      signerId: validUuid,
      event: { content: 'hello', tags: [] },
    })
    expect(result.success).toBe(false)
  })

  it('fails on invalid UUID for signerId', () => {
    const result = SignEventSchema.safeParse({
      signerId: 'not-a-uuid',
      event: validEvent,
    })
    expect(result.success).toBe(false)
  })
})

describe('UnwrapKeySchema', () => {
  it('parses valid input', () => {
    const result = UnwrapKeySchema.safeParse({
      signerId: validUuid,
      encryptedKey: 'some-encrypted-data',
    })
    expect(result.success).toBe(true)
  })

  it('fails when encryptedKey is empty', () => {
    const result = UnwrapKeySchema.safeParse({
      signerId: validUuid,
      encryptedKey: '',
    })
    expect(result.success).toBe(false)
  })

  it('fails when neither signerId nor accountId', () => {
    const result = UnwrapKeySchema.safeParse({
      encryptedKey: 'some-data',
    })
    expect(result.success).toBe(false)
  })
})

describe('resolveSignerId', () => {
  it('returns signerId when both are present', () => {
    expect(resolveSignerId({ signerId: 'abc', accountId: 'def' })).toBe('abc')
  })

  it('falls back to accountId when signerId is absent', () => {
    expect(resolveSignerId({ accountId: 'def' })).toBe('def')
  })

  it('returns signerId when only signerId is present', () => {
    expect(resolveSignerId({ signerId: 'abc' })).toBe('abc')
  })
})
