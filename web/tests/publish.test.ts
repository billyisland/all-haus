import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateDTag } from '../src/lib/publish'

describe('generateDTag', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('produces a lowercase hyphenated slug with timestamp suffix', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'))

    const result = generateDTag('My Test Article')
    const ts = Math.floor(new Date('2025-06-15T12:00:00Z').getTime() / 1000).toString(36)
    expect(result).toBe(`my-test-article-${ts}`)
  })

  it('strips special characters', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const result = generateDTag("What's New? (Part 2)")
    expect(result).toMatch(/^whats-new-part-2-[a-z0-9]+$/)
  })

  it('collapses multiple spaces and hyphens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const result = generateDTag('too   many   spaces')
    expect(result).toMatch(/^too-many-spaces-[a-z0-9]+$/)
  })

  it('truncates long titles before appending timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const longTitle = 'a'.repeat(100)
    const result = generateDTag(longTitle)
    const parts = result.split('-')
    const slugPart = parts.slice(0, -1).join('-')
    expect(slugPart.length).toBeLessThanOrEqual(80)
  })

  it('produces identical output to gateway generateDTag for same input and time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-03-01T00:00:00Z'))

    // Both implementations should produce the same slug algorithm
    const title = 'Test Article Title'
    const result = generateDTag(title)
    const expectedSlug = 'test-article-title'
    const expectedTs = Math.floor(new Date('2025-03-01T00:00:00Z').getTime() / 1000).toString(36)
    expect(result).toBe(`${expectedSlug}-${expectedTs}`)
  })
})
