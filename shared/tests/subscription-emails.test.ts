import { describe, it, expect } from 'vitest'
import { formatPounds, formatDate } from '../src/lib/email/format.js'
import {
  button,
  link,
  p,
  renderBlocksHtml,
  renderBlocksText,
  renderEmail,
  SIGN_OFF,
} from '../src/lib/email/layout.js'

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

describe('the layout', () => {
  it('escapes every string it is handed, including a button label', () => {
    const html = renderBlocksHtml([p('<b>x</b>'), button('https://example.com', '<img src=x>')])
    expect(html).not.toContain('<b>x</b>')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
  })

  it('renders a button as a styled link in HTML and as "label: url" in text', () => {
    const blocks = [button('https://example.com/go', 'Go')]
    expect(renderBlocksHtml(blocks)).toContain('href="https://example.com/go"')
    expect(renderBlocksHtml(blocks)).toContain('display: inline-block')
    expect(renderBlocksText(blocks)).toBe('Go: https://example.com/go')
  })

  it('refuses a non-http href — the label survives, the link does not', () => {
    const html = renderBlocksHtml([p(link('javascript:alert(1)', 'click')), button('javascript:alert(1)', 'Go')])
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click')
    expect(html).toContain('Go')
  })

  it('writes a link with a label as "label (url)" in text, and a bare one as the url', () => {
    expect(renderBlocksText([p(link('https://a.example', 'A'))])).toBe('A (https://a.example)')
    expect(renderBlocksText([p(link('https://a.example'))])).toBe('https://a.example')
  })

  it('gives both bodies the heading and the sign-off, from one description', () => {
    const out = renderEmail({ subject: 'S', heading: 'Test Heading', blocks: [p('My content')] })
    expect(out.subject).toBe('S')
    expect(out.htmlBody).toContain('<h2')
    expect(out.htmlBody).toContain('Test Heading')
    expect(out.htmlBody).toContain('My content')
    expect(out.htmlBody).toContain(SIGN_OFF)
    expect(out.textBody.startsWith('Test Heading\n\nMy content')).toBe(true)
    expect(out.textBody).toContain(SIGN_OFF)
  })
})
