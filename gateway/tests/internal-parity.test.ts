import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  classifyParityStatus,
  verifyPeerParity,
  reprobeParity,
  getParityReport,
  __resetParityState,
  PARITY_PEERS,
  type ParityPeer,
} from '../src/lib/internal-parity.js'

// =============================================================================
// The gateway's boot-time shared-secret parity check.
//
// Spec: gateway/src/lib/internal-parity.ts. Built after a drifted
// INTERNAL_SERVICE_TOKEN broke every paywalled unlock on prod, silently
// (2026-08-07).
//
// What is worth pinning here is the CLASSIFICATION, because every way this
// feature can fail is a misclassification: treat 401 as non-terminal and the
// INTERNAL_SECRET half is never checked at all; treat 404 or a timeout as
// terminal and an ordinary partial deploy crash-loops the gateway and takes the
// site down. The retry loop is driven with an injected clock so the ambiguous
// paths are exercised without the suite waiting two minutes for real backoff.
// =============================================================================

describe('classifyParityStatus', () => {
  it('treats BOTH 401 and 403 as a definitive mismatch', () => {
    // THE TRAP THIS TEST EXISTS FOR. The three peers disagree: payment-service
    // answers 403, key-service and key-custody both answer 401. A classifier
    // written for 403 alone — the status of the incident that prompted this
    // work — would never detect an INTERNAL_SECRET drift, which is the WIDER of
    // the two surfaces (publishing, key issuance, paywalled delivery). It would
    // also look correct to anyone testing only the failure they had in mind.
    expect(classifyParityStatus(403)).toBe('mismatch')
    expect(classifyParityStatus(401)).toBe('mismatch')
  })

  it('treats 200 as proof of parity', () => {
    expect(classifyParityStatus(200)).toBe('match')
  })

  it('does NOT treat a missing endpoint as a mismatch', () => {
    // A peer on an older image has no /auth-check. Calling that terminal would
    // crash-loop the gateway through any partial deploy — a routine version
    // skew becoming an outage.
    expect(classifyParityStatus(404)).toBe('no_endpoint')
  })

  it('treats a peer error as ambiguous, never terminal', () => {
    // 503 is what key-custody returns when its OWN secret is unset. That is a
    // real fault, but it is not evidence our secrets differ, and acting on it
    // would kill the gateway for someone else's misconfiguration.
    expect(classifyParityStatus(503)).toBe('unreachable')
    expect(classifyParityStatus(500)).toBe('unreachable')
    expect(classifyParityStatus(502)).toBe('unreachable')
  })
})

describe('PARITY_PEERS', () => {
  it('covers both shared secrets across all three peers', () => {
    // Building this for the payment token alone would have left INTERNAL_SECRET
    // — three services, wider blast radius — with no guard at all.
    expect(PARITY_PEERS.map((p) => p.name).sort()).toEqual([
      'key-custody',
      'key-service',
      'payment-service',
    ])
    expect(new Set(PARITY_PEERS.map((p) => p.secretEnv))).toEqual(
      new Set(['INTERNAL_SERVICE_TOKEN', 'INTERNAL_SECRET'])
    )
  })

  it('sends each peer the header that peer actually authenticates on', () => {
    // Getting this wrong yields a 401/403 from a CORRECTLY configured peer —
    // i.e. the check would refuse to start a perfectly healthy gateway.
    const byName = Object.fromEntries(PARITY_PEERS.map((p) => [p.name, p]))
    expect(byName['payment-service'].header).toBe('x-internal-token')
    expect(byName['key-custody'].header).toBe('x-internal-secret')
    expect(byName['key-service'].header).toBe('x-internal-secret')
  })
})

describe('verifyPeerParity', () => {
  const peer: ParityPeer = {
    name: 'test-peer',
    urlEnv: 'TEST_PEER_URL',
    header: 'x-internal-token',
    secretEnv: 'TEST_PEER_SECRET',
  }
  const noSleep = async () => {}

  beforeEach(() => {
    process.env.TEST_PEER_URL = 'http://peer:1234'
    process.env.TEST_PEER_SECRET = 'shared-secret'
  })
  afterEach(() => {
    delete process.env.TEST_PEER_URL
    delete process.env.TEST_PEER_SECRET
    vi.unstubAllGlobals()
  })

  const stubFetch = (...statuses: Array<number | 'throw'>) => {
    let i = 0
    const spy = vi.fn(async () => {
      const s = statuses[Math.min(i++, statuses.length - 1)]
      if (s === 'throw') throw new Error('ECONNREFUSED')
      return { status: s } as Response
    })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('returns true on 200, and sends the secret on the peer\'s own header', async () => {
    const spy = stubFetch(200)
    expect(await verifyPeerParity(peer, noSleep)).toBe(true)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://peer:1234/api/v1/auth-check')
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('shared-secret')
  })

  it('returns false IMMEDIATELY on a mismatch — no retries', async () => {
    // Retrying a definitive rejection cannot change it, and delaying the report
    // delays the only fix there is.
    const spy = stubFetch(403)
    expect(await verifyPeerParity(peer, noSleep)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries through unreachability and accepts a late-booting peer', async () => {
    // The expected case on a cold start: peers come up alongside the gateway,
    // so the first probes miss. This must NOT be reported as a mismatch.
    const spy = stubFetch('throw', 'throw', 200)
    expect(await verifyPeerParity(peer, noSleep)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('still catches a mismatch that only becomes visible after the peer boots', async () => {
    const spy = stubFetch('throw', 401)
    expect(await verifyPeerParity(peer, noSleep)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('gives up as NULL, never as true, when no definitive answer ever comes', async () => {
    // "Never verified" and "verified fine" must not collapse into one value —
    // that collapse is the exact failure this whole module exists to end, one
    // level up. Only `false` may stop the gateway; only `true` may reassure.
    stubFetch('throw')
    expect(await verifyPeerParity(peer, noSleep)).toBe(null)
    stubFetch(404)
    expect(await verifyPeerParity(peer, noSleep)).toBe(null)
  })

  it('reports NULL rather than failing when the peer is not configured', async () => {
    delete process.env.TEST_PEER_URL
    stubFetch(200)
    expect(await verifyPeerParity(peer, noSleep)).toBe(null)
  })
})

// =============================================================================
// Slice 2 — the runtime re-probe.
//
// Catches the case the boot check structurally cannot: a peer redeployed on its
// own, while this process keeps running against a secret it no longer matches.
// What is worth pinning is the STATE rule, because every way this misbehaves is
// a state bug — flap the health signal on an ordinary peer restart, or let a
// proven mismatch be erased by a peer that simply went away.
// =============================================================================

describe('reprobeParity — runtime drift', () => {
  const REAL_ENV = { ...process.env }

  beforeEach(() => {
    __resetParityState()
    for (const p of PARITY_PEERS) {
      process.env[p.urlEnv] = `http://${p.name}:1234`
      process.env[p.secretEnv] = 'shared-secret'
    }
  })
  afterEach(() => {
    process.env = { ...REAL_ENV }
    __resetParityState()
    vi.unstubAllGlobals()
  })

  /** Stub fetch with a per-peer status, keyed by the hostname in the URL. */
  const stubByPeer = (statuses: Record<string, number | 'throw'>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const peer = PARITY_PEERS.find((p) => url.includes(p.name))!
        const s = statuses[peer.name]
        if (s === 'throw') throw new Error('ECONNREFUSED')
        return { status: s } as Response
      })
    )
  }

  const allPeers = (status: number | 'throw') =>
    Object.fromEntries(PARITY_PEERS.map((p) => [p.name, status]))

  it('starts as unverified — never as ok-by-default', async () => {
    // Before any probe has run, nothing has been PROVEN. Reporting ok:true here
    // would mean a gateway that had never successfully checked anything looked
    // identical to one that had checked everything.
    const r = getParityReport()
    expect(r.unverified.sort()).toEqual(PARITY_PEERS.map((p) => p.name).sort())
  })

  it('reports ok once every peer proves a match', async () => {
    stubByPeer(allPeers(200))
    await reprobeParity()
    expect(getParityReport()).toMatchObject({ ok: true, mismatched: [], unverified: [] })
  })

  it('flags exactly the peer that drifted, and no other', async () => {
    stubByPeer({ 'payment-service': 200, 'key-custody': 401, 'key-service': 200 })
    await reprobeParity()
    const r = getParityReport()
    expect(r.ok).toBe(false)
    expect(r.mismatched).toEqual(['key-custody'])
  })

  it('an unreachable peer does NOT erase a proven match', async () => {
    // The flap guard. Peers restart routinely; if absence overwrote a proven
    // match the gateway would go unhealthy every time one bounced, and an
    // operator would learn to ignore the signal — which is how the original
    // incident stayed invisible.
    stubByPeer(allPeers(200))
    await reprobeParity()
    stubByPeer(allPeers('throw'))
    await reprobeParity()
    expect(getParityReport()).toMatchObject({ ok: true, unverified: [] })
  })

  it('an unreachable peer does NOT clear a proven mismatch either', async () => {
    // Sticky in both directions, and this is the safety-critical one: a broken
    // peer that then goes down must not read as repaired. Only a proven match
    // clears a proven mismatch.
    stubByPeer(allPeers(403))
    await reprobeParity()
    expect(getParityReport().ok).toBe(false)
    stubByPeer(allPeers('throw'))
    await reprobeParity()
    expect(getParityReport().ok).toBe(false)
  })

  it('clears once the secret is actually fixed', async () => {
    stubByPeer(allPeers(403))
    await reprobeParity()
    expect(getParityReport().ok).toBe(false)
    stubByPeer(allPeers(200))
    await reprobeParity()
    expect(getParityReport()).toMatchObject({ ok: true, mismatched: [] })
  })

  it('treats a peer with no /auth-check as ambiguous, not as a mismatch', async () => {
    // An older image is a version skew, not a drifted secret. Calling it a
    // mismatch would put the gateway permanently unhealthy through a partial
    // deploy and cry wolf about a fault that is not there.
    stubByPeer(allPeers(404))
    await reprobeParity()
    expect(getParityReport().ok).toBe(true)
  })
})
