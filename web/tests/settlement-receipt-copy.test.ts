import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISCHARGE_SENTENCE } from '../src/components/account/SettlementReceipt'

// =============================================================================
// The receipt the reader OPENS and the receipt we EMAIL say the same thing.
//
// Reader Terms 5.2 promises a receipt for every charge, and 1.4 is what the
// receipt has to state: paying us discharges what the reader owed the Writer.
// The email is built in `shared/` and the page is built in `web/`, and there is
// no module path between the two workspaces — so the sentence exists twice, and
// two copies of a sentence about a legal effect are exactly the kind that drift
// until one of them is wrong.
//
// The pin therefore READS THE SOURCE, and asserts the match was FOUND: a renamed
// or deleted constant on the shared side would otherwise make this file pass by
// testing nothing, which is the failure it exists to catch.
//
// A third copy lives in the two surfaces' shared explanation of the gap between
// what was charged and what is itemised. It is checked the same way.
// =============================================================================

const SHARED = join(__dirname, '../../shared/src/lib/email/templates/receipt.ts')

function sharedSource(): string {
  return readFileSync(SHARED, 'utf8')
}

/** Pull a double-quoted or template string assigned to `name` out of the shared
 *  module, joining a multi-line literal into one line the way the source does. */
function sharedString(name: string): string | null {
  const src = sharedSource()
  const m = src.match(
    new RegExp(`${name}\\s*=\\s*\\n?\\s*"([\\s\\S]*?)";`),
  )
  return m ? m[1] : null
}

describe('the emailed receipt and the opened receipt say one thing', () => {
  it('states the discharge (Reader Terms 1.4) in exactly the same words', () => {
    const shared = sharedString('DISCHARGE_SENTENCE')
    expect(
      shared,
      'DISCHARGE_SENTENCE not found in shared/src/lib/email/templates/receipt.ts — was it renamed or moved?',
    ).toBeTruthy()
    // The web copy uses typographic apostrophes nowhere in this sentence, so the
    // two are byte-for-byte comparable.
    expect(DISCHARGE_SENTENCE).toBe(shared)
  })

  it('explains the charged/itemised gap in the same words on both surfaces', () => {
    const src = sharedSource()
    const web = readFileSync(
      join(__dirname, '../src/content/ledger.ts'),
      'utf8',
    )
    // Both say it in words rather than printing two totals and leaving the
    // reader to reconcile them — and BY SIGN (§0z item 19b): a positive gap is
    // carried balance, a negative one is reading the next charge collects.
    // The old single sentence promised a "next receipt" for a positive gap
    // that never came.
    for (const phrase of ['carried on your tab from earlier activity', 'collected with your next charge']) {
      expect(src, `the shared email no longer says "${phrase}"`).toContain(phrase)
      expect(web, `the receipt pane no longer says "${phrase}"`).toContain(phrase)
    }
    expect(src).not.toContain('itemised on your next receipt')
    expect(web).not.toContain('itemised on your next receipt')
  })

  it('names the free allowance beside a £0.00 line on both surfaces', () => {
    const src = sharedSource()
    const web = readFileSync(
      join(__dirname, '../src/content/ledger.ts'),
      'utf8',
    )
    // A bare "£0.00" on a receipt reads as something having gone wrong.
    expect(src).toContain('free allowance')
    expect(web).toContain('free allowance')
  })
})
