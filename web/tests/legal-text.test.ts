import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LEGAL_DOCS } from '../src/content/legal/generated'
import { buildDocs, renderModule, LEGAL_DIR } from '../scripts/gen-legal-texts'

// =============================================================================
// The legal texts: what publishes, and what must never publish with them.
//
// These four documents are the only pages on the site whose words a member can
// be held to; two of them (the Reader Terms and the Writer Agreement) are also
// ACCEPTED by version. Three different things can go wrong with them and none
// is visible from reading the page:
//
//   1. The committed HTML drifts from the markdown somebody edited, so the page
//      shows the old text under the new version.
//   2. Drafting apparatus ships — a draft banner, a bracketed figure nobody
//      resolved. This file checks the shapes that are SAFE TO NAME HERE.
//      The narrative class itself (the phrases root CLAUDE.md bars from a
//      shipped path) is checked by scripts/check-mirror-disclosure.sh, which
//      stages the whole web/src/content/legal/ directory as a named class (so
//      a new document is covered the day it is written): its table is where
//      those patterns can be written down, because scripts/ does not ship and
//      web/tests/ does. Writing them here published them — this file's first
//      draft tripped that guard, which is the guard working.
//   3. The version on the page disagrees with the version the server stamps,
//      which makes an acceptance a record of something else.
// =============================================================================

const SHARED_VERSIONS = join(
  __dirname,
  '../../shared/src/lib/terms-versions.ts',
)

describe('legal texts — the generated module is not stale', () => {
  it('matches what the generator produces from the markdown right now', async () => {
    // A pure function of two committed files, so the check is exact: re-run the
    // whole conversion in memory and compare. The network-fetching generators
    // in this repo cannot do this; this one can, which is why it must.
    const fresh = renderModule(await buildDocs())
    const committed = readFileSync(
      join(LEGAL_DIR, 'generated.ts'),
      'utf8',
    )
    expect(
      fresh,
      'generated.ts is stale — run `npm run gen:legal` in web/',
    ).toBe(committed)
  })

  it('publishes every markdown file in the directory', () => {
    const files = readdirSync(LEGAL_DIR).filter((f) => f.endsWith('.md'))
    // Assert we actually FOUND some: an empty directory would otherwise make
    // every assertion in this file vacuous.
    expect(files.length).toBeGreaterThan(1)
    expect(LEGAL_DOCS).toHaveLength(files.length)
  })
})

describe('legal texts — no drafting apparatus reaches a page', () => {
  const sources = readdirSync(LEGAL_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, text: readFileSync(join(LEGAL_DIR, f), 'utf8') }))

  it('carries no draft banner', () => {
    // The two shapes the drafts actually opened with. The wider narrative
    // class — advice status, an adviser's name, an advice citation — is
    // check-mirror-disclosure.sh's table, which stages this whole directory.
    for (const { file, text } of sources) {
      expect(text, `${file}: draft banner`).not.toMatch(/Draft for review/i)
      expect(text, `${file}: draft banner`).not.toMatch(/\bDRAFT\b/)
    }
  })

  it('leaves no figure or period unresolved', () => {
    // `[...]` in this text only ever marked a decision. Markdown links would
    // also match, and there are none in any of the four — the Terms and the
    // Privacy Policy name other documents and other pages in words rather than
    // as links, deliberately, so this check keeps its reach. If a link is ever
    // added, this assertion is the thing that says so, and it should be
    // narrowed to exclude `](` rather than deleted.
    for (const { file, text } of sources) {
      const brackets = text.match(/\[[^\]]{1,120}\]/g) ?? []
      expect(brackets, `${file}: unresolved brackets`).toEqual([])
    }
  })

  it('and none of it survives into the rendered HTML either', () => {
    // The source check above is the real one; this is the same question asked
    // at the other end, because the two could only disagree if the generated
    // module were stale — which is a different failure with the same symptom.
    for (const doc of LEGAL_DOCS) {
      expect(doc.html, `${doc.slug}`).not.toMatch(/Draft for review/i)
      expect(doc.html, `${doc.slug}`).not.toMatch(/\[[^\]]{1,120}\]/)
    }
  })
})

describe('legal texts — the version on the page is the version the server stamps', () => {
  // No module path between the workspaces, so the pin READS THE FILE — the
  // same shape and the same reason as admin-report-wire.test.ts.
  const shared = readFileSync(SHARED_VERSIONS, 'utf8')

  const constant = (name: string): string => {
    const m = new RegExp(`export const ${name} = '([^']+)'`).exec(shared)
    // Assert the match was FOUND: a renamed constant would otherwise make this
    // suite pass by testing nothing.
    expect(m, `${name} not found in shared/src/lib/terms-versions.ts`).toBeTruthy()
    return m![1]
  }

  it('reader-terms matches READER_TERMS_VERSION', () => {
    const doc = LEGAL_DOCS.find((d) => d.slug === 'reader-terms')
    expect(doc, 'reader-terms is not published').toBeTruthy()
    expect(doc!.version).toBe(constant('READER_TERMS_VERSION'))
  })

  it('writer-agreement matches WRITER_TERMS_VERSION', () => {
    const doc = LEGAL_DOCS.find((d) => d.slug === 'writer-agreement')
    expect(doc, 'writer-agreement is not published').toBeTruthy()
    expect(doc!.version).toBe(constant('WRITER_TERMS_VERSION'))
  })

  it('every published document has a version and a title', () => {
    expect(LEGAL_DOCS.length).toBeGreaterThan(1)
    for (const doc of LEGAL_DOCS) {
      expect(doc.version, `${doc.slug}: version`).toMatch(/^\d+(\.\d+)?$/)
      expect(doc.title.length, `${doc.slug}: title`).toBeGreaterThan(0)
      expect(doc.html.length, `${doc.slug}: html`).toBeGreaterThan(1000)
    }
  })
})
