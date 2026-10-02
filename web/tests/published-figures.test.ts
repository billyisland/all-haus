import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { aboutSections } from '../src/content/about'
import {
  PUBLISHED_FIGURES_PATH,
  allowancePounds,
  feePercent,
  parsePublishedFigures,
} from '../src/lib/published-figures'

// =============================================================================
// A dial that copy names is interpolated from the dial, never typed (A24).
//
// About named the platform's cut and the new account's allowance as "8%" and
// "£5", both `platform_config` dials. The copy now takes them from
// `GET /published-figures`. These cases pin three things: the copy follows the
// figures it is handed, the route and the web agree on the path and the field
// names (read off the gateway source, since a hand-written type checks nothing),
// and the dial defaults are not typed back into any copy module.
// =============================================================================

const text = (f: Parameters<typeof aboutSections>[0]) =>
  aboutSections(f).flatMap((s) => s.paragraphs).join('\n')

describe('About states the figures it is handed', () => {
  it('names a retuned cut and allowance, not the defaults', () => {
    const t = text({ platformFeeBps: 850, freeAllowancePence: 250 })
    expect(t).toContain('charging 8.5% of what you earn')
    expect(t).toContain('a £2.50 reading allowance')
    expect(t).not.toMatch(/\b8%|£5\b/)
  })

  it('drops the numbers, rather than guessing, when it has none', () => {
    const t = text(null)
    expect(t).toContain('charging a share of what you earn')
    expect(t).toContain('comes with a reading allowance')
    expect(t).not.toMatch(/\d%|£\d/)
  })

  it('formats the dial values as prose', () => {
    expect(feePercent(800)).toBe('8%')
    expect(feePercent(825)).toBe('8.25%')
    expect(allowancePounds(500)).toBe('£5')
    expect(allowancePounds(250)).toBe('£2.50')
  })

  it('a malformed body is no figures, never a default', () => {
    expect(parsePublishedFigures({ platformFeeBps: 800, freeAllowancePence: 500 })).toEqual({
      platformFeeBps: 800,
      freeAllowancePence: 500,
    })
    expect(parsePublishedFigures({ platformFeeBps: '800', freeAllowancePence: 500 })).toBeNull()
    expect(parsePublishedFigures({ platformFeeBps: 800 })).toBeNull()
    expect(parsePublishedFigures(null)).toBeNull()
  })
})

describe('/published-figures — parity with the gateway', () => {
  const route = readFileSync(
    join(__dirname, '../../gateway/src/routes/published-figures.ts'),
    'utf8',
  )

  it('the web asks the path the gateway registers', () => {
    const reg = route.match(/app\.get\(\s*"([^"]+)"/)
    expect(reg, 'the route registration was not found — was it rewritten?').toBeTruthy()
    expect(reg![1]).toBe(PUBLISHED_FIGURES_PATH)
  })

  it('the gateway sends the two fields the web parses', () => {
    expect(route).toMatch(/send\(\{ platformFeeBps, freeAllowancePence \}\)/)
  })
})

// The detector. Copy modules are where a typed figure would go back in; this
// walks them and refuses a string that pairs either dial's DEFAULT with the
// words that name it. It is narrow on purpose: "£5" alone is a price anywhere
// else, so it must sit next to "allowance" (or a percentage next to "earn" /
// "fee" / "cut").
const COPY_ROOTS = ['../src/content', '../src/lib/explain', '../src/lib/unlock-errors.ts']
const TYPED_DIAL = [
  /£5(?:\.00)?\b[^'"`\n]{0,40}allowance|allowance[^'"`\n]{0,40}£5(?:\.00)?\b/i,
  /\b\d+(?:\.\d+)?%[^'"`\n]{0,40}\b(?:earn|fee|cut)|\b(?:earn|fee|cut)\b[^'"`\n]{0,40}\b\d+(?:\.\d+)?%/i,
]

function files(p: string): string[] {
  const abs = join(__dirname, p)
  if (statSync(abs).isFile()) return [abs]
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !f.includes('legal/'))
    .map((f) => join(abs, f))
}

export function typedDialHits(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .filter((l) => TYPED_DIAL.some((re) => re.test(l)))
}

describe('no copy module types a dial back in', () => {
  it('the detector catches the sentence A24 found', () => {
    expect(typedDialHits(`  'Your account comes with a £5 reading allowance — a gift',`)).toHaveLength(1)
    expect(typedDialHits(`  'as your agent, charging 8% of what you earn to cover running costs.',`)).toHaveLength(1)
    expect(typedDialHits(`  'a £5 stake is held on your tab',`)).toHaveLength(0)
  })

  it('finds none in the copy modules', () => {
    const hits = COPY_ROOTS.flatMap(files).flatMap((f) =>
      typedDialHits(readFileSync(f, 'utf8')).map((l) => `${relative(join(__dirname, '..'), f)}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })
})
