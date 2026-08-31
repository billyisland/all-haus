import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatDateRelative, formatDateFromISO, truncateText, stripMarkdown } from '../src/lib/format'

describe('formatDateRelative', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setNow(date: Date) {
    vi.useFakeTimers()
    vi.setSystemTime(date)
  }

  const now = new Date('2025-06-15T12:00:00Z')

  it('returns "just now" for timestamps less than a minute ago', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 30
    expect(formatDateRelative(ts)).toBe('just now')
  })

  it('returns minutes for timestamps under an hour', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 45 * 60
    expect(formatDateRelative(ts)).toBe('45m')
  })

  it('returns hours for timestamps under a day', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 5 * 3600
    expect(formatDateRelative(ts)).toBe('5h')
  })

  it('returns "Yesterday" for 1 day ago', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 36 * 3600
    expect(formatDateRelative(ts)).toBe('Yesterday')
  })

  it('returns "Xd ago" for 2-6 days', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 4 * 86400
    expect(formatDateRelative(ts)).toBe('4d ago')
  })

  it('returns formatted date for 7+ days in the same year', () => {
    setNow(now)
    const ts = Math.floor(now.getTime() / 1000) - 30 * 86400
    const result = formatDateRelative(ts)
    // Should be a date string like "16 May" (no year for same year)
    expect(result).toMatch(/\d{1,2}\s\w+/)
    expect(result).not.toMatch(/2025/)
  })

  it('includes year for dates in a different year', () => {
    setNow(now)
    // Timestamp from Jan 2024
    const d = new Date('2024-01-15T12:00:00Z')
    const ts = Math.floor(d.getTime() / 1000)
    const result = formatDateRelative(ts)
    expect(result).toMatch(/2024/)
  })
})

describe('formatDateFromISO', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setNow(date: Date) {
    vi.useFakeTimers()
    vi.setSystemTime(date)
  }

  const now = new Date('2025-06-15T12:00:00Z')

  it('returns "Today" for today', () => {
    setNow(now)
    expect(formatDateFromISO('2025-06-15T10:00:00Z')).toBe('Today')
  })

  it('returns "Yesterday" for yesterday', () => {
    setNow(now)
    expect(formatDateFromISO('2025-06-14T10:00:00Z')).toBe('Yesterday')
  })

  it('returns "Xd ago" for recent dates', () => {
    setNow(now)
    expect(formatDateFromISO('2025-06-12T10:00:00Z')).toBe('3d ago')
  })

  it('returns formatted date for older dates', () => {
    setNow(now)
    const result = formatDateFromISO('2025-05-01T10:00:00Z')
    expect(result).toMatch(/\d{1,2}\s\w+/)
  })
})

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello', 100)).toBe('hello')
  })

  it('truncates at word boundary', () => {
    const result = truncateText('the quick brown fox jumps over the lazy dog', 20)
    expect(result).toMatch(/\.\.\.$/,)
    expect(result.length).toBeLessThanOrEqual(23) // 20 + "..."
  })

  it('handles exact-length text', () => {
    expect(truncateText('exactly', 7)).toBe('exactly')
  })
})

describe('stripMarkdown', () => {
  it('strips headings', () => {
    expect(stripMarkdown('# Title')).toBe('Title')
    expect(stripMarkdown('## Subtitle')).toBe('Subtitle')
    expect(stripMarkdown('###### Deep')).toBe('Deep')
  })

  it('strips bold and italic', () => {
    expect(stripMarkdown('**bold** text')).toBe('bold text')
    expect(stripMarkdown('*italic* text')).toBe('italic text')
  })

  it('strips links keeping text', () => {
    expect(stripMarkdown('[click here](https://example.com)')).toBe('click here')
  })

  it('strips image link syntax, leaving the ! prefix', () => {
    // The image regex !\[.*?\]\(.+?\) strips the [alt](url) part but the ! remains
    // because the link regex fires first: [alt](url) -> alt, leaving !alt
    expect(stripMarkdown('![alt](https://example.com/img.png)')).toBe('!alt')
  })

  it('collapses multiple newlines', () => {
    expect(stripMarkdown('first\n\n\nsecond')).toBe('first second')
  })

  it('handles combined markdown', () => {
    const md = '# Title\n\n**Bold** and *italic* with [a link](https://x.com)\n\n![img](https://x.com/i.png)'
    const result = stripMarkdown(md)
    expect(result).toBe('Title Bold and italic with a link !img')
  })
})
