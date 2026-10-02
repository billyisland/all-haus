import { describe, it, expect, beforeAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// =============================================================================
// EVERY EMAIL IS IN THE CATALOGUE, AND EVERY EMAIL IS PINNED.
//
// Three guarantees behind "the emails live in one place":
//
//   1. COMPLETENESS. Every template function exported from
//      `src/lib/email/templates/` (a name ending in `Email` or `Page`) has an
//      entry in `CATALOGUE`, so the preview page and these snapshots cannot
//      fall behind what we actually send.
//   2. SNAPSHOTS. Every catalogue entry is rendered, both bodies, into
//      `__snapshots__/email-catalogue.test.ts.snap` — a change to any email's
//      words or look is a reviewable diff. Update deliberately:
//        cd shared && npx vitest run tests/email-catalogue.test.ts -u
//   3. ONE LAYOUT. No backend source outside `src/lib/email/layout.ts` writes a
//      `style="…"` attribute, which is the shape every hand-built email had.
// =============================================================================

const ROOT = join(__dirname, '../..')

beforeAll(() => {
  process.env.APP_URL = 'https://all.haus'
})

const { CATALOGUE, TEMPLATE_MODULES } = await import('../src/lib/email/catalogue.js')
const { renderEmail, renderPage } = await import('../src/lib/email/layout.js')

describe('the email catalogue', () => {
  it('has an entry for every template function', () => {
    const listed = new Set(CATALOGUE.map((e) => e.template))
    const missing: string[] = []
    let found = 0
    for (const [family, mod] of Object.entries(TEMPLATE_MODULES)) {
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== 'function' || !/(Email|Page)$/.test(name)) continue
        found++
        if (!listed.has(value as never)) missing.push(`${family}.${name}`)
      }
    }
    // A module map that exports nothing would pass the check below vacuously.
    expect(found).toBeGreaterThan(20)
    expect(missing, `add these to src/lib/email/catalogue.ts`).toEqual([])
  })

  it('has one file per template module, each in the map', () => {
    const files = readdirSync(join(__dirname, '../src/lib/email/templates'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort()
    expect(files).toEqual(Object.keys(TEMPLATE_MODULES).sort())
  })

  it('has unique ids', () => {
    const ids = CATALOGUE.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const entry of CATALOGUE) {
    it(`renders ${entry.id}`, () => {
      const content = entry.render()
      if (entry.page) {
        expect(renderPage(content.heading, content.blocks)).toMatchSnapshot()
        return
      }
      const out = renderEmail(content as Parameters<typeof renderEmail>[0])
      // Nothing that reaches a reader should carry a placeholder or a raw
      // interpolation slot.
      for (const body of [out.subject, out.textBody, out.htmlBody]) {
        expect(body).not.toMatch(/undefined|null|NaN|\[object Object\]|\$\{/)
      }
      expect(out).toMatchSnapshot()
    })
  }
})

describe('one layout', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path, out)
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path)
    }
    return out
  }

  it('no backend source outside the layout writes an inline style', () => {
    const dirs = ['shared/src', 'gateway/src', 'payment-service/src', 'feed-ingest/src']
    const files = dirs.flatMap((d) => walk(join(ROOT, d)))
    expect(files.length).toBeGreaterThan(100)
    const offenders = files
      .filter((f) => !f.endsWith(join('lib', 'email', 'layout.ts')))
      .filter((f) => /style="|font-family/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f))
    expect(offenders, 'build the email from shared/src/lib/email/layout.ts blocks instead').toEqual([])
  })
})

// CA-D4. The one-click header pair rides the layout, never a sender, and only
// on an https URL — a mail client POSTs to it without asking anybody.
describe('List-Unsubscribe', () => {
  const base = { subject: 's', heading: 'h', blocks: [] }

  it('an email with no unsubscribe URL carries no headers', () => {
    expect(renderEmail(base).headers).toBeUndefined()
  })

  it('an https URL becomes the RFC 2369 + RFC 8058 pair', () => {
    const out = renderEmail({ ...base, listUnsubscribe: 'https://all.haus/u?t=1' })
    expect(out.headers).toEqual({
      'List-Unsubscribe': '<https://all.haus/u?t=1>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('a non-https URL is dropped rather than advertised', () => {
    expect(renderEmail({ ...base, listUnsubscribe: 'http://all.haus/u' }).headers).toBeUndefined()
    expect(renderEmail({ ...base, listUnsubscribe: 'javascript:alert(1)' }).headers).toBeUndefined()
  })
})
