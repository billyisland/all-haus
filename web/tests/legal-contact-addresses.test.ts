import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// An address a published document promises is a commitment.
//
// The Reader Terms send members to `support@all.haus` for a refund (8.3) and
// for a complaint answered within five working days (14.1). Until 2026-09-17 no
// mailbox appeared anywhere in shipped code at all — the addresses existed only
// inside the two legal `.md` files, where a typo would ship to the live site and
// nothing anywhere could see it.
//
// The register is `shared/src/lib/contact-addresses.ts`. The texts keep their
// own literal wording — a legal document says exactly what it says and is never
// templated — so what is checked is that the two AGREE: every address the
// published texts name is one the house knows about.
//
// Reads the shared source rather than importing it (no module path between the
// workspaces) and asserts the match was FOUND, so a renamed constant fails
// rather than passing by testing nothing.
// =============================================================================

const SHARED = join(__dirname, '../../shared/src/lib/contact-addresses.ts')
const LEGAL_DIR = join(__dirname, '../src/content/legal')

// DERIVED, NEVER HAND-KEPT. This list was two hand-written filenames until the
// Terms of Service and the Privacy Policy published (L8.1 / L8.7), and a
// hand-kept list is a check that silently stops covering the document it was
// not updated for — the Privacy Policy names FIVE mailboxes, more than both
// original texts together. Reading the directory means a new published text is
// covered by existing.
const TEXTS = readdirSync(LEGAL_DIR).filter((f) => f.endsWith('.md'))

function registeredAddresses(): string[] {
  const src = readFileSync(SHARED, 'utf8')
  const block = src.match(/export const CONTACT_ADDRESSES = \{([\s\S]*?)\} as const;/)
  expect(
    block,
    'CONTACT_ADDRESSES not found in shared/src/lib/contact-addresses.ts — was it renamed?',
  ).toBeTruthy()
  const found = [...block![1].matchAll(/"([^"]+@[^"]+)"/g)].map((m) => m[1])
  expect(found.length, 'CONTACT_ADDRESSES has no addresses in it').toBeGreaterThan(0)
  return found
}

describe('the published texts and the house mailboxes agree', () => {
  it('found the published texts at all', () => {
    // The list is derived, so an empty or moved directory would make every
    // assertion below vacuous rather than red.
    expect(TEXTS.length, `no .md under ${LEGAL_DIR}`).toBeGreaterThan(1)
  })

  it('names only addresses the house knows about', () => {
    const registered = registeredAddresses()
    for (const file of TEXTS) {
      const text = readFileSync(join(LEGAL_DIR, file), 'utf8')
      const named = [...text.matchAll(/[a-z0-9._%+-]+@all\.haus/gi)].map((m) => m[0])
      for (const address of named) {
        expect(
          registered,
          `${file} names ${address}, which is not in CONTACT_ADDRESSES`,
        ).toContain(address)
      }
    }
  })

  it('has at least one text actually naming one — a pin over nothing is not a pin', () => {
    const named = TEXTS.flatMap((f) =>
      [...readFileSync(join(LEGAL_DIR, f), 'utf8').matchAll(/[a-z0-9._%+-]+@all\.haus/gi)].map(
        (m) => m[0],
      ),
    )
    expect(named.length).toBeGreaterThan(0)
  })

  it('every address is at the house domain', () => {
    for (const address of registeredAddresses()) {
      expect(address).toMatch(/@all\.haus$/)
    }
  })
})
