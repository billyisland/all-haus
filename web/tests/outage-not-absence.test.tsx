// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// =============================================================================
// AN OUTAGE IS NOT AN ABSENCE (CA-E1/E2/E3/E7/E9, 2026-09-29).
//
// Six surfaces turned "we could not ask" into "there is nothing here": the
// feed-link page rendered every failure as a bad link, two SSR pages rendered a
// gateway 5xx as the 404 page (and cached the null for a minute), and the
// ledger, the notifications inbox and the conversation list each swallowed
// their fetch and showed their empty copy. Beside them: the offer page rendered
// the raw `API error 404: {"error":…}`, `deleteDraft` never read `res.ok` so a
// refused delete "succeeded", the ledger had no sequence guard across filter
// changes, and the export modal told a rate-limited member an email was on
// its way.
//
// The pure and fetch-level pieces are driven directly; the two components are
// rendered under jsdom against a controllable `fetch`; the SSR pages and the
// remaining catches are structural pins, since a server component's fetch is
// not something this harness can run.
// =============================================================================

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { ApiError } from '@/lib/api/client'
import {
  offerLookupMessage,
  OFFER_NOT_FOUND_BODY,
  OFFER_LOAD_FAILED,
} from '@/content/subscribe-offer'
import { LEDGER_EMPTY, LEDGER_LOAD_FAILED } from '@/content/ledger'
import { EXPORT_STEP_UP_SENT } from '@/content/settings'

const SRC = (rel: string) => readFileSync(path.resolve(__dirname, '../src', rel), 'utf8')

// --- a controllable fetch ------------------------------------------------------

type Pending = { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }
const pending: Pending[] = []
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
beforeEach(() => {
  pending.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return new Promise<Response>((resolve, reject) => pending.push({ url, resolve, reject }))
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function mount(ui: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(ui)
  })
  return { host, root }
}

// --- E2: the offer page's sentence --------------------------------------------

describe('offerLookupMessage words a failed lookup by status (CA-E2)', () => {
  it('a 404 is worded here, never the raw ApiError message', () => {
    const m = offerLookupMessage(new ApiError(404, { error: 'Offer not found or no longer available' }))
    expect(m).toEqual({ body: OFFER_NOT_FOUND_BODY, outage: false })
    expect(m.body).not.toMatch(/API error/)
  })
  it('a 410 carries the route’s own sentence', () => {
    const m = offerLookupMessage(new ApiError(410, { error: 'This offer has expired' }))
    expect(m).toEqual({ body: 'This offer has expired', outage: false })
  })
  it('a 5xx or a network failure is an outage', () => {
    expect(offerLookupMessage(new ApiError(502, 'Bad Gateway'))).toEqual({ body: OFFER_LOAD_FAILED, outage: true })
    expect(offerLookupMessage(new TypeError('Failed to fetch'))).toEqual({ body: OFFER_LOAD_FAILED, outage: true })
  })
  it('the lookup encodes the code into the path', async () => {
    const { subscriptionOffers } = await import('@/lib/api/drives')
    const p = subscriptionOffers.lookup('a b/c')
    expect(pending[0].url).toContain('/subscription-offers/redeem/a%20b%2Fc')
    pending[0].resolve(json(404, { error: 'x' }))
    await expect(p).rejects.toBeInstanceOf(ApiError)
  })
})

// --- E3: deleteDraft --------------------------------------------------------------

describe('deleteDraft reads res.ok (CA-E3)', () => {
  // Through `request()` since CA-J2: a refusal is an ApiError, and what the
  // dashboard SAYS is `failureSentence` — the route's sentence, or house copy.
  it('a refused delete throws the route’s answer, worded as the route’s sentence', async () => {
    const { deleteDraft } = await import('@/lib/drafts')
    const { failureSentence } = await import('@/lib/api/client')
    const p = deleteDraft('d1')
    pending[0].resolve(json(409, { error: 'draft_locked', message: 'This draft is being published.' }))
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect(failureSentence(err, 'FALLBACK')).toBe('This draft is being published.')
  })
  it('a 5xx with no body throws too (house copy, never a status), and a 204 resolves', async () => {
    const { deleteDraft } = await import('@/lib/drafts')
    const { failureSentence } = await import('@/lib/api/client')
    const failing = deleteDraft('d1')
    pending[0].resolve(new Response(null, { status: 500 }))
    const err = await failing.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect(failureSentence(err, 'FALLBACK')).toBe('FALLBACK')
    const ok = deleteDraft('d2')
    pending[1].resolve(new Response(null, { status: 204 }))
    await expect(ok).resolves.toBeUndefined()
  })
})

// --- E1 + E7: the ledger -------------------------------------------------------------

describe('AccountLedger (CA-E1, CA-E7)', () => {
  it('a statement that could not be read says so, with a retry, never "No transactions yet"', async () => {
    const { AccountLedger } = await import('@/components/account/AccountLedger')
    const { host, root } = mount(<AccountLedger />)
    expect(pending).toHaveLength(1)
    await act(async () => {
      pending[0].resolve(new Response('oops', { status: 502 }))
    })
    await flush()
    expect(host.textContent).toContain(LEDGER_LOAD_FAILED)
    expect(host.textContent).not.toContain(LEDGER_EMPTY)

    // Retry asks again and an answer replaces the failure.
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!
    await act(async () => {
      retry.click()
    })
    expect(pending).toHaveLength(2)
    await act(async () => {
      pending[1].resolve(json(200, { entries: [], totalEntries: 0, hasMore: false }))
    })
    await flush()
    expect(host.textContent).toContain(LEDGER_EMPTY)
    expect(host.textContent).not.toContain(LEDGER_LOAD_FAILED)
    act(() => root.unmount())
  })

  it('a late answer for the OLD filter cannot overwrite the new one', async () => {
    const { AccountLedger } = await import('@/components/account/AccountLedger')
    const { host, root } = mount(<AccountLedger />)
    const all = pending[0]
    expect(all.url).toContain('filter=all')

    // Switch to Income before "all" has answered.
    const income = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Income')!
    await act(async () => {
      income.click()
    })
    const inc = pending[1]
    expect(inc.url).toContain('filter=credits')

    const row = (id: string, description: string) => ({
      id, date: '2026-09-01T00:00:00Z', type: 'credit', category: 'read', description, amount_pence: 100, link: null, ref_id: null,
    })
    // Income answers first, then the stale "all" answer arrives.
    await act(async () => {
      inc.resolve(json(200, { entries: [row('i1', 'INCOME ROW')], totalEntries: 1, hasMore: false }))
    })
    await flush()
    await act(async () => {
      all.resolve(json(200, { entries: [row('a1', 'STALE ALL ROW')], totalEntries: 1, hasMore: true }))
    })
    await flush()
    expect(host.textContent).toContain('INCOME ROW')
    expect(host.textContent).not.toContain('STALE ALL ROW')
    act(() => root.unmount())
  })
})

// --- E9: the export panel ------------------------------------------------------------

describe('ExportPanel (CA-E9)', () => {
  it('a rate-limited step-up request is not a confirmation', async () => {
    const { ExportPanel } = await import('@/components/account/ExportPanel')
    const { host, root } = mount(<ExportPanel />)
    const account = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Full account export'))!
    await act(async () => {
      account.click()
    })
    expect(pending[0].url).toContain('/account/export')
    await act(async () => {
      pending[0].resolve(json(402, { error: 'step_up_required' }))
    })
    await flush()
    expect(pending[1].url).toContain('/account/export/request')
    await act(async () => {
      pending[1].resolve(json(429, { error: 'rate_limited', message: 'Too many export requests. Try again in an hour.' }))
    })
    await flush()
    expect(host.textContent).not.toContain(EXPORT_STEP_UP_SENT)
    expect(host.textContent).toContain('Too many export requests')
    act(() => root.unmount())
  })

  it('is inline in the settings section — no scrim, no raw z, no exemption', () => {
    const settings = SRC('components/account/SettingsPanel.tsx')
    expect(settings).toContain('<ExportPanel />')
    expect(settings).not.toMatch(/ExportModal/)
    const panel = SRC('components/account/ExportPanel.tsx')
    expect(panel).not.toMatch(/fixed inset-0/)
    expect(panel).not.toMatch(/z-\[100\]/)
    expect(panel).toMatch(/if \(!sent\.ok\)/)
    const guard = readFileSync(path.resolve(__dirname, 'one-close-affordance.test.ts'), 'utf8')
    expect(guard).not.toMatch(/ExportModal/)
  })
})

// --- E1: the pages and lists this harness cannot run ----------------------------------

describe('only a 404 is an absence (CA-E1, structural)', () => {
  it('the two SSR pages return null on 404 alone and throw to error.tsx otherwise', () => {
    for (const rel of ['app/[username]/page.tsx', 'app/read/[postId]/page.tsx']) {
      const src = SRC(rel)
      expect(src, rel).toMatch(/if \(res\.status === 404\) return null/)
      expect(src, rel).toMatch(/if \(!res\.ok\) throw new Error/)
      expect(src, rel).not.toMatch(/if \(!res\.ok\) return null/)
    }
  })
  it('the feed-link page tells a 404 from an outage', () => {
    const src = SRC('app/f/[token]/page.tsx')
    expect(src).toMatch(/err instanceof ApiError && err\.status === 404\) setMissing\(true\)/)
    expect(src).toMatch(/else setOutage\(true\)/)
    expect(src).not.toMatch(/\.catch\(\(\) => setMissing\(true\)\)/)
  })
  it('the notifications inbox and the conversation list have a load-failed state', () => {
    const notifications = SRC('components/notifications/NotificationsPanel.tsx')
    expect(notifications).toMatch(/setLoadFailed\(true\)/)
    expect(notifications).toMatch(/NOTIFICATIONS_LOAD_FAILED/)
    const inbox = SRC('components/messages/MessagesInbox.tsx')
    expect(inbox).toMatch(/setConvLoadFailed\(true\)/)
    expect(inbox).not.toMatch(/catch \{\}/)
    const list = SRC('components/messages/ConversationList.tsx')
    expect(list).toMatch(/loadFailed \?/)
    expect(list).toMatch(/MESSAGES_LOAD_FAILED/)
  })
})
