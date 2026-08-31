import { describe, it, expect } from 'vitest'
import { formatPounds, formatDate, paragraph, button, emailHtml } from '../src/lib/subscription-emails.js'

describe('formatPounds', () => {
  it('formats zero pence', () => {
    expect(formatPounds(0)).toBe('£0.00')
  })

  it('formats pence under a pound', () => {
    expect(formatPounds(50)).toBe('£0.50')
    expect(formatPounds(99)).toBe('£0.99')
  })

  it('formats exact pounds', () => {
    expect(formatPounds(100)).toBe('£1.00')
    expect(formatPounds(500)).toBe('£5.00')
  })

  it('formats pounds with pence', () => {
    expect(formatPounds(150)).toBe('£1.50')
    expect(formatPounds(1099)).toBe('£10.99')
  })
})

describe('formatDate', () => {
  it('formats a date in en-GB long format', () => {
    const result = formatDate(new Date('2025-12-25T00:00:00Z'))
    expect(result).toBe('25 December 2025')
  })

  it('formats single-digit days', () => {
    const result = formatDate(new Date('2025-01-05T00:00:00Z'))
    expect(result).toBe('5 January 2025')
  })
})

describe('paragraph', () => {
  it('wraps text in a styled p tag', () => {
    const result = paragraph('Hello world')
    expect(result).toContain('<p')
    expect(result).toContain('Hello world</p>')
    expect(result).toContain('style=')
  })
})

describe('button', () => {
  it('creates a styled link', () => {
    const result = button('https://example.com', 'Click me')
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain('Click me</a>')
    expect(result).toContain('style=')
    expect(result).toContain('display: inline-block')
  })
})

describe('emailHtml', () => {
  it('includes the heading', () => {
    const result = emailHtml('Test Heading', '<p>body</p>')
    expect(result).toContain('Test Heading')
    expect(result).toContain('<h2')
  })

  it('includes the body content', () => {
    const result = emailHtml('Heading', '<p>My content</p>')
    expect(result).toContain('<p>My content</p>')
  })

  it('includes the footer tagline', () => {
    const result = emailHtml('H', '<p>b</p>')
    expect(result).toContain('all.haus')
  })
})
