import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAYWALL_GATE_MARKER, splitAtGateMarker, gatePositionPct } from '../src/lib/gate-marker'
import { PAYWALL_GATE_MARKER as NODE_MARKER } from '../src/components/editor/PaywallGateNode'

// =============================================================================
// Where the paywall gate falls — one home, three readers (the editor's publish,
// the draft preview, and the plain-HTML register's write page).
// =============================================================================

describe('the gate marker', () => {
  it('is the string the gateway splits on, and the node re-exports the same one', () => {
    const gw = readFileSync(join(__dirname, '../../gateway/src/services/article-publisher.ts'), 'utf8')
    const m = gw.match(/PAYWALL_GATE_MARKER\s*=\s*"([^"]+)"/)
    expect(m, 'gateway PAYWALL_GATE_MARKER not found — was it renamed?').toBeTruthy()
    expect(m![1]).toBe(PAYWALL_GATE_MARKER)
    expect(NODE_MARKER).toBe(PAYWALL_GATE_MARKER)
  })

  it('splits at the marker, and a piece with none is all free', () => {
    expect(splitAtGateMarker(`Free\n\n${PAYWALL_GATE_MARKER}\n\nPaid`)).toEqual({ free: 'Free', paywall: 'Paid' })
    expect(splitAtGateMarker('Just words')).toEqual({ free: 'Just words', paywall: '' })
  })
})

describe('gatePositionPct', () => {
  it('is the free share of the text, bounded to the validators’ 1..99', () => {
    expect(gatePositionPct('aaaa', 'aaaa')).toBe(50)
    expect(gatePositionPct('', 'paid only')).toBe(1)
    expect(gatePositionPct('free only', '')).toBe(99)
    expect(gatePositionPct('', '')).toBe(50)
  })
})
