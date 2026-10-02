import { describe, it, expect, vi, afterEach } from 'vitest'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { handleDoor } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { outcomeFromQuery } from '../../src/modernhaus/outcomes'
import { articleGET, ledgerGET, receiptGET, receiptsExportGET, offerGET, moneySettingsGET, profileGET, writeDraftGET } from '../../src/modernhaus/routes'
import { mapUnlockError } from '../../src/lib/unlock-errors'
import { mapSubscribeError } from '../../src/lib/subscribe-errors'
import { paywallGateCopy, PAYWALL_AFTER_PAYMENT, ALLOWANCE_SPENT_LEAD } from '../../src/content/paywall'
import { termsVersionMismatch, WRITER_TERMS_LEAD } from '../../src/content/terms-consent'
import { LEDGER_TAB_CLEAR, LEDGER_OWE_LABEL, LEDGER_OWED_LABEL, LEDGER_EMPTY, receiptCarriedSentence, DISCHARGE_SENTENCE } from '../../src/content/ledger'
import { PAYOUT_MALFORMED, payoutBelowFloor } from '../../src/content/money-settings'
import { PAYWALL_GATE_MARKER } from '../../src/lib/gate-marker'
import { PAYWALL_ALREADY_YOURS } from '../../src/modernhaus/article-view'
import { TOKEN } from './fixtures'

// =============================================================================
// E5 — MONEY (MODERNHAUS-ADR §D2.3, §D2.4), through the real door, the real
// registry and the real page pipeline. Each case asserts what the GATEWAY was
// sent — or that it was sent NOTHING — and what the member was shown or where
// they were sent, never a status alone (testing.md). A refusal is proved by
// the act it gates NOT being called; a consent by the acceptance running
// BEFORE the act.
// =============================================================================

const ORIGIN = 'http://localhost:3010'
const TERMS = {
  reader: { acceptedAt: null, version: null, current: '2.0', isCurrent: false },
  writer: { acceptedAt: null, version: null, current: '2.1', isCurrent: false },
}
const ME = {
  id: 'me-1',
  username: 'viv',
  displayName: 'Viv',
  ageDeclaredAt: '2026-01-01T00:00:00Z',
  pubkey: 'pk-me',
  hasPaymentMethod: true,
  cardActionRequiredAt: null,
  freeAllowanceRemainingPence: 0,
  stripeConnectKycComplete: true,
  terms: TERMS,
  canWrite: true,
}
const DRAFT_ID = '11111111-1111-4111-8111-111111111111'

type Answer = { status: number; body?: unknown } | 'throw'

function gateway(answers: Record<string, Answer | Answer[]>) {
  const seen: Record<string, number> = {}
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}`
    let a: Answer | Answer[] | undefined =
      answers[key] ??
      (key === 'GET /unread-counts' ? { status: 200, body: { notificationCount: 0, dmCount: 0 } } : undefined) ??
      (key === 'GET /auth/me' ? { status: 200, body: ME } : undefined) ??
      (key === 'POST /reading-log' ? { status: 201 } : undefined)
    if (Array.isArray(a)) a = a[Math.min((seen[key] = (seen[key] ?? -1) + 1), a.length - 1)]
    if (a === undefined) throw new Error(`unexpected gateway call ${key}`)
    if (a === 'throw') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const keyOf = ([u, i]: [string, RequestInit | undefined]) =>
  `${i?.method ?? 'GET'} ${new URL(u).pathname.replace(/^\/api\/v1/, '')}`
const keys = (f: ReturnType<typeof gateway>) => f.mock.calls.map((c) => keyOf(c as [string, RequestInit | undefined]))

function sent(f: ReturnType<typeof gateway>, key: string): unknown {
  const c = f.mock.calls.find((c) => keyOf(c as [string, RequestInit | undefined]) === key)
  if (!c) return undefined
  const body = (c[1] as RequestInit).body
  return typeof body === 'string' ? JSON.parse(body) : body
}

function post_(action: string, form: Record<string, string>) {
  const fd = new FormData()
  fd.set('_csrf', TOKEN)
  for (const [k, v] of Object.entries(form)) fd.set(k, v)
  return handleDoor(
    new Request(`${ORIGIN}/modernhaus/do/${action}`, { method: 'POST', headers: { cookie: `mh_csrf=${TOKEN}` }, body: fd }),
    action,
    REGISTRY,
  )
}

const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { cookie: `mh_csrf=${TOKEN}` } })
const where = (res: Response) => res.headers.get('location')
/** The sentence a page shows for a redirect's code. */
const said = (res: Response) => outcomeFromQuery(new URL(where(res) ?? '/', ORIGIN).searchParams)?.sentence

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// A paywalled piece, and its paid half encrypted the way the key service does.
// ---------------------------------------------------------------------------

const PAID_TEXT = 'The secret second half, which only a reader who paid may see.'
const KEY = randomBytes(32)
function encrypt(plaintext: string): string {
  const nonce = randomBytes(24)
  const body = xchacha20poly1305(KEY, nonce).encrypt(new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(24 + body.length)
  combined.set(nonce, 0)
  combined.set(body, 24)
  return Buffer.from(combined).toString('base64')
}
const CIPHERTEXT = encrypt(PAID_TEXT)
const KEY_B64 = Buffer.from(KEY).toString('base64')

const POST_ID = 'p'.repeat(64)
const ARTICLE = {
  id: 'a1',
  postId: POST_ID,
  nostrEventId: 'ev-real',
  dTag: 'my-piece',
  title: 'A piece',
  summary: null,
  contentFree: 'The free half.',
  isPaywalled: true,
  pricePence: 40,
  publishedAt: '2026-09-01T10:00:00Z',
  withdrawn: false,
  writer: { id: 'w1', username: 'bea', displayName: 'Bea', avatar: null, pubkey: 'pk-bea', subscriptionPricePence: 500 },
  publication: null,
}
const LOCKED = { status: 200, body: { comments: [], paywallLocked: true, repliesEnabled: true } }
const OPEN = { status: 200, body: { comments: [], repliesEnabled: true } }
const TOP = { status: 200, body: { posts: [], topLevel: [], totalReplies: 0 } }
const PASS = { status: 200, body: { readEventId: 'r1', encryptedKey: 'wrapped', algorithm: 'xchacha20poly1305', ciphertext: CIPHERTEXT, isReissuance: false, readState: 'accrued' } }

/** The reads the article page makes around an unlock. */
function articleReads(convo: Answer = LOCKED) {
  return {
    'GET /articles/my-piece': { status: 200, body: ARTICLE },
    'GET /replies/ev-real': convo,
    [`GET /thread/${POST_ID}/top`]: TOP,
    'GET /subscriptions/check/w1': { status: 200, body: { subscribed: false } },
  } as Record<string, Answer>
}

describe('unlock — gate pass, unwrap, decrypt, render, on the POST', () => {
  it('renders the paid half on its own POST (200, no-store), keyed on the RE-READ event id', async () => {
    const f = gateway({
      ...articleReads(OPEN),
      'POST /articles/ev-real/gate-pass': PASS,
      'POST /unwrap-key': { status: 200, body: { contentKeyBase64: KEY_B64 } },
    })
    // A crafted event id in the form is ignored: the form names the piece only.
    const res = await post_('unlock', { dTag: 'my-piece', eventId: 'ev-crafted' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
    const html = await res.text()
    expect(html).toContain(PAID_TEXT)
    expect(keys(f)).toContain('POST /articles/ev-real/gate-pass')
    expect(keys(f).some((k) => k.includes('ev-crafted'))).toBe(false)
    expect(sent(f, 'POST /unwrap-key')).toEqual({ encryptedKey: 'wrapped' })
    // The reading log belongs to the OPEN, never the unlock (posts.md).
    expect(keys(f)).not.toContain('POST /reading-log')
    // Nor does a press run the arrival landing.
    expect(keys(f)).not.toContain('POST /articles/my-piece/arrival')
  })

  it('a gate-pass refusal is said in place in mapUnlockError’s words, and nothing is unwrapped', async () => {
    const body = { error: 'free_allowance_exhausted', message: 'Payment required.' }
    const f = gateway({ ...articleReads(), 'POST /articles/ev-real/gate-pass': { status: 402, body } })
    const res = await post_('unlock', { dTag: 'my-piece' })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain(mapUnlockError(402, body).message)
    expect(keys(f)).not.toContain('POST /unwrap-key')
    // needsCard: the full site's settings take the card (Decision 2).
    expect(html).toMatch(/href="\/settings"/)
    expect(html).not.toContain(PAID_TEXT)
  })

  it('the Reader Terms refusal REPLACES the button with the consent, carrying the server’s current version', async () => {
    gateway({
      ...articleReads(),
      'POST /articles/ev-real/gate-pass': { status: 403, body: { error: 'reader_terms_required', message: 'Before your next paid read, please accept the all.haus Reader Terms.' } },
    })
    const html = await (await post_('unlock', { dTag: 'my-piece' })).text()
    expect(html).toMatch(/<input[^>]*name="acceptTerms"[^>]*>/)
    expect(html).toMatch(/<input(?=[^>]*name="acceptTerms")(?=[^>]*value="2\.0")[^>]*>/)
    expect(html).not.toMatch(/<input(?=[^>]*name="acceptTerms")(?=[^>]*checked)[^>]*>/)
    expect(html).toContain('Accept and continue')
    expect(html).not.toContain('Continue reading')
  })

  it('a ticked consent is accepted BEFORE the gate pass, and the press resumes', async () => {
    const f = gateway({
      ...articleReads(OPEN),
      'POST /auth/accept-terms': { status: 200, body: { ok: true } },
      'POST /articles/ev-real/gate-pass': PASS,
      'POST /unwrap-key': { status: 200, body: { contentKeyBase64: KEY_B64 } },
    })
    const html = await (await post_('unlock', { dTag: 'my-piece', acceptTerms: '2.0' })).text()
    expect(sent(f, 'POST /auth/accept-terms')).toEqual({ kind: 'reader', version: '2.0' })
    const k = keys(f)
    expect(k.indexOf('POST /auth/accept-terms')).toBeLessThan(k.indexOf('POST /articles/ev-real/gate-pass'))
    expect(html).toContain(PAID_TEXT)
  })

  it('a moved text refuses the acceptance and runs NO gate pass', async () => {
    const f = gateway({
      ...articleReads(),
      'POST /auth/accept-terms': { status: 400, body: { error: 'terms_version_mismatch', current: '2.1' } },
    })
    const html = await (await post_('unlock', { dTag: 'my-piece', acceptTerms: '2.0' })).text()
    expect(keys(f)).not.toContain('POST /articles/ev-real/gate-pass')
    expect(html).toContain('The Reader Terms have just been updated')
    expect(termsVersionMismatch('reader')).toContain('The Reader Terms have just been updated')
    expect(html).toMatch(/name="acceptTerms"/)
  })

  it('an unreachable gate pass is said as the reading service, never as the fault page or a success', async () => {
    const f = gateway({ ...articleReads(), 'POST /articles/ev-real/gate-pass': 'throw' })
    const res = await post_('unlock', { dTag: 'my-piece' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('The reading service is temporarily unreachable')
    expect(keys(f)).not.toContain('POST /unwrap-key')
  })

  it('a failure AFTER the gate pass says the retry is free, and logs nothing of the body or the key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    gateway({
      ...articleReads(),
      'POST /articles/ev-real/gate-pass': PASS,
      // A key that is not the key: the cipher throws.
      'POST /unwrap-key': { status: 200, body: { contentKeyBase64: Buffer.from(randomBytes(32)).toString('base64') } },
    })
    const html = await (await post_('unlock', { dTag: 'my-piece' })).text()
    expect(html).toContain(PAYWALL_AFTER_PAYMENT)
    expect(html).not.toContain(PAID_TEXT)
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).not.toContain(CIPHERTEXT.slice(0, 16))
    expect(logged).not.toContain(PAID_TEXT.slice(0, 16))
  })

  it('the press that spent the last of the allowance says so, in the modal’s words', async () => {
    gateway({
      ...articleReads(OPEN),
      'POST /articles/ev-real/gate-pass': { status: 200, body: { ...PASS.body, allowanceJustExhausted: true } },
      'POST /unwrap-key': { status: 200, body: { contentKeyBase64: KEY_B64 } },
    })
    const html = await (await post_('unlock', { dTag: 'my-piece' })).text()
    expect(html).toContain(ALLOWANCE_SPENT_LEAD.slice(0, 40))
  })

  it('a session that has gone sends the member to sign in, back to the piece, having pressed nothing', async () => {
    const f = gateway({ 'GET /auth/me': { status: 401 } })
    const res = await post_('unlock', { dTag: 'my-piece' })
    expect(where(res)).toBe(`/modernhaus/signin?return=${encodeURIComponent('/modernhaus/article/my-piece')}`)
    expect(keys(f)).toEqual(['GET /auth/me'])
  })
})

// ---------------------------------------------------------------------------
// The article's GET: the arrival landing, the gate, the conversation.
// ---------------------------------------------------------------------------

describe('the article page', () => {
  it('a member’s GET runs the arrival landing, and an arrival that opened the piece shows it with no press', async () => {
    const f = gateway({
      ...articleReads(OPEN),
      'POST /articles/my-piece/arrival': { status: 200, body: { arrival: true, unlocked: true, gatePass: PASS.body } },
      'POST /unwrap-key': { status: 200, body: { contentKeyBase64: KEY_B64 } },
    })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(html).toContain(PAID_TEXT)
    // The GET moved no money of its own: the only gate pass was the arrival's,
    // which the server bounds to a read that costs nothing.
    expect(keys(f).filter((k) => k.endsWith('/gate-pass'))).toEqual([])
    expect(keys(f)).toContain('POST /reading-log')
  })

  it('no arrival: the gate says the full site’s sentence for this viewer, and its one button is the unlock', async () => {
    const f = gateway({ ...articleReads(), 'POST /articles/my-piece/arrival': { status: 200, body: { arrival: false } } })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    const copy = paywallGateCopy({ isLoggedIn: true, signupOffer: null, hasPaymentMethod: true, freeAllowanceRemaining: 0, pricePence: 40, writerName: 'Bea' })
    expect(html).toContain(copy.subtext.slice(0, 30))
    expect(html).toMatch(/action="\/modernhaus\/do\/unlock"/)
    expect(keys(f).filter((k) => k.endsWith('/gate-pass'))).toEqual([])
  })

  it('a member who can already read it is told the re-read is free, and sees the conversation', async () => {
    gateway({ ...articleReads(OPEN), 'POST /articles/my-piece/arrival': { status: 200, body: { arrival: false } } })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(html).toContain(PAYWALL_ALREADY_YOURS)
    expect(html).toContain('Read the rest')
  })

  it('money facts /auth/me did not carry are not guessed as "no card"', async () => {
    const bare = { id: 'me-1', username: 'viv', displayName: 'Viv', ageDeclaredAt: '2026-01-01T00:00:00Z', pubkey: 'pk-me' }
    gateway({ ...articleReads(), 'GET /auth/me': { status: 200, body: bare }, 'POST /articles/my-piece/arrival': { status: 200, body: { arrival: false } } })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(html).toContain('The rest of this piece costs £0.40.')
    expect(html).not.toContain('free reading allowance')
  })

  it('signed out: no arrival, no gate pass, and the ways in carry the piece back', async () => {
    const f = gateway({
      ...articleReads(),
      'GET /auth/me': { status: 401 },
      'GET /auth/open': { status: 200, body: { open: true, freeAllowancePence: 500, arrivalGiftCapPence: 200 } },
    })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(keys(f)).not.toContain('POST /articles/my-piece/arrival')
    expect(html).toContain(`href="/modernhaus/signup?return=${encodeURIComponent('/modernhaus/article/my-piece')}"`)
    expect(html).not.toMatch(/action="\/modernhaus\/do\/unlock"/)
  })

  it('signed out while accounts are closed: the waiting list, never a signup that would be refused', async () => {
    gateway({ ...articleReads(), 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 404 } })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(html).toContain('href="/modernhaus/waitlist"')
    expect(html).not.toContain('/modernhaus/signup')
  })
})

// ---------------------------------------------------------------------------
// Subscribing.
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  it('sends the period and the offer code, and lands where the form said', async () => {
    const f = gateway({ 'POST /subscriptions/w1': { status: 201, body: { subscriptionId: 's1' } } })
    const res = await post_('subscribe', { writerId: 'w1', period: 'annual', offerCode: 'CODE', return: '/modernhaus/subscribe/CODE', after: '/modernhaus/u/bea' })
    expect(sent(f, 'POST /subscriptions/w1')).toEqual({ period: 'annual', offerCode: 'CODE' })
    expect(where(res)).toBe('/modernhaus/u/bea?done=subscribed')
  })

  it('the Reader Terms refusal comes back with the PERIOD, in mapSubscribeError’s words', async () => {
    const body = { error: 'reader_terms_required', message: 'Before subscribing, please accept the all.haus Reader Terms.' }
    gateway({ 'POST /subscriptions/w1': { status: 403, body } })
    const res = await post_('subscribe', { writerId: 'w1', period: 'annual', return: '/modernhaus/u/bea' })
    expect(where(res)).toBe('/modernhaus/u/bea?period=annual&error=subscribe_terms')
    expect(said(res)).toBe(mapSubscribeError({ status: 403, body }).message)
  })

  it('a ticked consent is accepted first, then the same subscription is bought', async () => {
    const f = gateway({ 'POST /auth/accept-terms': { status: 200 }, 'POST /subscriptions/w1': { status: 201 } })
    await post_('subscribe', { writerId: 'w1', period: 'annual', acceptTerms: '2.0', return: '/modernhaus/u/bea' })
    expect(keys(f)).toEqual(['POST /auth/accept-terms', 'POST /subscriptions/w1'])
    expect(sent(f, 'POST /subscriptions/w1')).toEqual({ period: 'annual' })
  })

  it('a card refusal is the card sentence, never the route’s bare code', async () => {
    gateway({ 'POST /subscriptions/w1': { status: 402, body: { error: 'card_required' } } })
    const res = await post_('subscribe', { writerId: 'w1', return: '/modernhaus/u/bea' })
    expect(said(res)).toBe(mapSubscribeError({ status: 402, body: { error: 'card_required' } }).message)
  })

  it('the route’s English refusals are said as they come (the mapper’s rule), under a code', async () => {
    gateway({ 'POST /subscriptions/w1': { status: 410, body: { error: 'This offer has expired' } } })
    const res = await post_('subscribe', { writerId: 'w1', offerCode: 'OLD', return: '/modernhaus/subscribe/OLD' })
    expect(where(res)).toBe('/modernhaus/subscribe/OLD?error=offer_expired')
    expect(said(res)).toBe('This offer has expired')
  })

  it('the profile row: the refusal’s consent stands in for BOTH buttons and resumes the asked period', async () => {
    gateway({
      'GET /writers/bea': { status: 200, body: { id: 'w1', username: 'bea', displayName: 'Bea', pubkey: 'pk', subscriptionPricePence: 500, annualDiscountPct: 15, hasPaywalledArticle: true, articleCount: 0, noteCount: 0, followerCount: 0, followingCount: 0 } },
      'GET /writers/bea/articles': { status: 200, body: { articles: [] } },
      'GET /subscriptions/check/w1': { status: 200, body: { subscribed: false } },
    })
    const html = await (await profileGET(get('/modernhaus/u/bea?period=annual&error=subscribe_terms'), { params: { username: 'bea' } })).text()
    expect(html).toMatch(/<input(?=[^>]*name="period")(?=[^>]*value="annual")[^>]*>/)
    expect(html).toMatch(/name="acceptTerms"/)
    expect(html).not.toMatch(/<button[^>]*value="monthly"/)
  })

  it('an unreadable subscription check is said, never offered as a fresh purchase', async () => {
    gateway({
      'GET /writers/bea': { status: 200, body: { id: 'w1', username: 'bea', displayName: 'Bea', pubkey: 'pk', subscriptionPricePence: 500, annualDiscountPct: 0, hasPaywalledArticle: true, articleCount: 0, noteCount: 0, followerCount: 0, followingCount: 0 } },
      'GET /writers/bea/articles': { status: 200, body: { articles: [] } },
      'GET /subscriptions/check/w1': 'throw',
    })
    const html = await (await profileGET(get('/modernhaus/u/bea'), { params: { username: 'bea' } })).text()
    expect(html).toContain('Your subscription couldn’t be loaded')
    expect(html).not.toMatch(/action="\/modernhaus\/do\/subscribe"/)
  })
})

// ---------------------------------------------------------------------------
// Settle now, the card, Stripe Connect, payout preferences.
// ---------------------------------------------------------------------------

describe('settle now', () => {
  it.each([
    [{ status: 200, body: { settled: true } }, 'done=settled'],
    [{ status: 200, body: { settled: false, reason: 'below_minimum' } }, 'done=settle_below_minimum'],
    [{ status: 200, body: { settled: false, reason: 'nothing_due' } }, 'done=settle_nothing_due'],
    [{ status: 409, body: { error: 'settlement_in_flight' } }, 'error=settlement_in_flight'],
    [{ status: 402, body: { error: 'card_required' } }, 'error=settle_card_required'],
    [{ status: 402, body: { error: 'card_action_required' } }, 'error=settle_card_declined'],
  ] as const)('%j → %s', async (answer, code) => {
    gateway({ 'POST /my/tab/settle': answer })
    expect(where(await post_('tab_settle', { return: '/modernhaus/ledger' }))).toBe(`/modernhaus/ledger?${code}`)
  })

  it('an ambiguous settlement (502, or an answer lost) is NEVER the fault page’s "nothing was changed"', async () => {
    for (const answer of [{ status: 502, body: { error: 'settlement_unconfirmed' } }, 'throw'] as const) {
      gateway({ 'POST /my/tab/settle': answer })
      const res = await post_('tab_settle', { return: '/modernhaus/ledger' })
      expect(where(res)).toBe('/modernhaus/ledger?error=settlement_unconfirmed')
      expect(said(res)).toContain('could not confirm whether that payment went through')
    }
  })
})

describe('the card, Stripe Connect and payouts', () => {
  it('a card Stripe would not detach is the route’s own sentence', async () => {
    gateway({ 'DELETE /auth/payment-method': { status: 502, body: { error: 'Could not remove the card. Please try again.' } } })
    expect(said(await post_('card_remove', { confirm: 'card' }))).toBe('Could not remove the card. Please try again.')
  })

  it('Stripe Connect: the ONE off-site 303, and only to an https URL the gateway answered', async () => {
    gateway({ 'POST /auth/upgrade-writer': { status: 200, body: { stripeConnectUrl: 'https://connect.stripe.com/setup/x' } } })
    expect(where(await post_('writer_upgrade', {}))).toBe('https://connect.stripe.com/setup/x')
    for (const bad of ['javascript:alert(1)', 'http://connect.stripe.com/x', '//evil.example/x']) {
      gateway({ 'POST /auth/upgrade-writer': { status: 200, body: { stripeConnectUrl: bad } } })
      expect(where(await post_('writer_upgrade', {}))).toBe('/modernhaus/settings/money?error=connect_failed')
    }
  })

  it('payout preferences: what was chosen is sent, in pence, and an empty threshold is the platform’s', async () => {
    const f = gateway({ 'PATCH /my/payout-preferences': { status: 200, body: { cadence: 'weekly', thresholdPence: 2500 } } })
    expect(where(await post_('payout_prefs_save', { cadence: 'weekly', threshold: '25' }))).toBe('/modernhaus/settings/money?done=payouts_saved')
    expect(sent(f, 'PATCH /my/payout-preferences')).toEqual({ cadence: 'weekly', thresholdPence: 2500 })
    const g = gateway({ 'PATCH /my/payout-preferences': { status: 200 } })
    await post_('payout_prefs_save', { cadence: 'daily', threshold: '' })
    expect(sent(g, 'PATCH /my/payout-preferences')).toEqual({ cadence: 'daily', thresholdPence: null })
  })

  it('a malformed amount is refused before anything is asked, with what was typed kept', async () => {
    const f = gateway({ 'GET /my/payout-preferences': { status: 200, body: { cadence: 'daily', thresholdPence: null, platformThresholdPence: 1000, lastPaidAt: null } } })
    const res = await post_('payout_prefs_save', { cadence: 'monthly', threshold: 'twenty' })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain(PAYOUT_MALFORMED)
    expect(html).toContain('value="twenty"')
    expect(keys(f)).not.toContain('PATCH /my/payout-preferences')
  })

  it('below the platform’s floor, the page says the floor the route sent', async () => {
    gateway({
      'PATCH /my/payout-preferences': { status: 400, body: { error: 'threshold_below_platform_minimum', platformThresholdPence: 1000 } },
      'GET /my/payout-preferences': { status: 200, body: { cadence: 'daily', thresholdPence: null, platformThresholdPence: 1000, lastPaidAt: null } },
    })
    const res = await post_('payout_prefs_save', { cadence: 'daily', threshold: '2' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain(payoutBelowFloor(1000))
  })
})

// ---------------------------------------------------------------------------
// The Writer Agreement at a paid publish (E4 left it a refusal with a link).
// ---------------------------------------------------------------------------

describe('publish_now with the Writer Agreement', () => {
  const PIECE = { title: 'A piece', dek: '', content: `free\n\n${PAYWALL_GATE_MARKER}\n\npaid`, price: '0.40', commentsEnabled: 'on', draftId: DRAFT_ID }
  const saved = { 'POST /drafts': { status: 200, body: { draftId: DRAFT_ID } } }

  it('a ticked agreement is accepted (as the WRITER’s) before the publish-now door is pressed', async () => {
    const f = gateway({
      ...saved,
      'POST /auth/accept-terms': { status: 200 },
      [`POST /drafts/${DRAFT_ID}/publish`]: { status: 201, body: { articleId: 'art-1', dTag: 'a-piece' } },
    })
    await post_('publish_now', { ...PIECE, acceptTerms: '2.1' })
    expect(sent(f, 'POST /auth/accept-terms')).toEqual({ kind: 'writer', version: '2.1' })
    const k = keys(f)
    expect(k.indexOf('POST /auth/accept-terms')).toBeLessThan(k.indexOf(`POST /drafts/${DRAFT_ID}/publish`))
  })

  it('the draft’s page after the refusal: the consent stands in for the press that met it, and the other is not offered', async () => {
    gateway({
      [`GET /drafts/${DRAFT_ID}`]: { status: 200, body: { draftId: DRAFT_ID, title: 'T', dek: null, content: PIECE.content, pricePence: 40, gatePositionPct: 50, scheduledAt: null, publicationId: null, dTag: null, autoSavedAt: '2026-09-01T10:00:00Z' } },
    })
    const html = await (await writeDraftGET(get(`/modernhaus/write/${DRAFT_ID}?press=schedule&error=writer_terms_required`), { params: { draftId: DRAFT_ID } })).text()
    expect(html).toContain(WRITER_TERMS_LEAD.slice(0, 20))
    expect(html).toMatch(/<input(?=[^>]*name="acceptTerms")(?=[^>]*value="2\.1")[^>]*>/)
    expect(html).toMatch(/formaction="\/modernhaus\/do\/schedule"/i)
    expect(html).not.toMatch(/formaction="\/modernhaus\/do\/publish_now"/i)
  })
})

// ---------------------------------------------------------------------------
// The Ledger, a receipt, the export, an offer, the settings page.
// ---------------------------------------------------------------------------

const TAB = { tabBalancePence: '0', refundDuePence: '0', freeAllowanceRemainingPence: 300, freeAllowanceTotalPence: 500, lastSettledAt: null, cardActionRequiredAt: null, reads: [] }

describe('the Ledger', () => {
  it('a clear tab that crossed the wire as the STRING "0" still reads as nothing owed (money.md: bigint)', async () => {
    gateway({
      'GET /my/tab': { status: 200, body: TAB },
      'GET /earnings/me-1': { status: 200, body: { pendingTransferPence: '1200', grossPence: 0, feePence: 0, allowanceCoveredPence: 0, allowanceReadCount: 0 } },
      'GET /my/account-statement': { status: 200, body: { entries: [], totalEntries: 0, hasMore: false } },
      'GET /subscriptions/mine': { status: 200, body: { subscriptions: [] } },
    })
    const html = await (await ledgerGET(get('/modernhaus/ledger'), { params: {} as never })).text()
    expect(html).toContain(LEDGER_TAB_CLEAR)
    // Two figures, never netted: owe £0.00 AND owed £12.00, each its own row.
    expect(html).toContain(LEDGER_OWE_LABEL)
    expect(html).toContain(LEDGER_OWED_LABEL)
    expect(html).toContain('£12.00')
    expect(html).toContain(LEDGER_EMPTY)
    // No card is being asked to settle nothing.
    expect(html).not.toMatch(/action="\/modernhaus\/do\/tab_settle"/)
  })

  it('an outage is an outage: a failed statement or earnings read is never "No transactions yet"', async () => {
    gateway({
      'GET /my/tab': { status: 200, body: { ...TAB, tabBalancePence: 300 } },
      'GET /earnings/me-1': 'throw',
      'GET /my/account-statement': { status: 500 },
      'GET /subscriptions/mine': { status: 200, body: { subscriptions: [] } },
    })
    const html = await (await ledgerGET(get('/modernhaus/ledger'), { params: {} as never })).text()
    expect(html).toContain('Your statement couldn’t be loaded')
    expect(html).toContain('Your earnings couldn’t be loaded')
    expect(html).not.toContain(LEDGER_EMPTY)
    expect(html).toMatch(/action="\/modernhaus\/do\/tab_settle"/)
  })

  it('a statement row links to its receipt, and its full-site links are mapped onto this register', async () => {
    gateway({
      'GET /my/tab': { status: 200, body: TAB },
      'GET /earnings/me-1': { status: 200, body: { pendingTransferPence: 0, grossPence: 0, feePence: 0, allowanceCoveredPence: 0, allowanceReadCount: 0 } },
      'GET /my/account-statement': { status: 200, body: { entries: [
        { id: 's1', date: '2026-09-01T10:00:00Z', type: 'settlement', category: 'settlement', description: 'Balance settled', amount_pence: '800', link: null, ref_id: 'set-1' },
        { id: 'r1', date: '2026-09-01T10:00:00Z', type: 'debit', category: 'article_read', description: 'A piece', amount_pence: 40, link: '/article/my-piece', ref_id: null },
      ], totalEntries: 2, hasMore: false } },
      'GET /subscriptions/mine': { status: 200, body: { subscriptions: [] } },
    })
    const html = await (await ledgerGET(get('/modernhaus/ledger'), { params: {} as never })).text()
    expect(html).toContain('href="/modernhaus/ledger/receipt/set-1"')
    expect(html).toContain('href="/modernhaus/article/my-piece"')
    expect(html).toContain('−£8.00')
  })

  it('a receipt states the charge, the gap by its sign, and the discharge', async () => {
    gateway({ 'GET /my/receipts/set-1': { status: 200, body: { settlementId: 'set-1', settledAt: '2026-09-01T10:00:00Z', amountPence: 800, triggerType: 'threshold', reversedAt: null, items: [{ kind: 'read', description: 'A piece', writerName: 'Bea', writerUsername: 'bea', pricePence: 0, link: '/article/my-piece', at: '2026-09-01' }], itemisedPence: 0, unitemisedPence: 800 } } })
    const html = await (await receiptGET(get('/modernhaus/ledger/receipt/set-1'), { params: { settlementId: 'set-1' } })).text()
    expect(html).toContain(receiptCarriedSentence(800).slice(0, 30))
    expect(html).toContain('£0.00 free allowance')
    expect(html).toContain(DISCHARGE_SENTENCE)
  })

  it('somebody else’s receipt is not found (the route answers 404, never 403)', async () => {
    gateway({ 'GET /my/receipts/not-mine': { status: 404, body: { error: 'not_found' } } })
    expect((await receiptGET(get('/modernhaus/ledger/receipt/not-mine'), { params: { settlementId: 'not-mine' } })).status).toBe(404)
  })

  it('the receipts export is the gateway’s JSON, as an attachment, never stored', async () => {
    gateway({ 'GET /receipts/export': { status: 200, body: { platformPubkey: 'pk', count: 1, skipped: 1, receipts: [{ a: 1 }] } } })
    const res = await receiptsExportGET(get('/modernhaus/receipts/export'))
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="platform-receipts.json"')
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
    expect(JSON.parse(await res.text())).toMatchObject({ count: 1, skipped: 1 })
  })

  it('an offer met signed out, when it is a gift for one account, asks them to sign in', async () => {
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /subscription-offers/redeem/GIFT': { status: 401, body: { error: 'login_required' } } })
    const html = await (await offerGET(get('/modernhaus/subscribe/GIFT'), { params: { code: 'GIFT' } })).text()
    expect(html).toContain(`/modernhaus/signin?return=${encodeURIComponent('/modernhaus/subscribe/GIFT')}`)
  })

  it('the settings page links out for a card, and offers removal only through its confirm page', async () => {
    gateway({ 'GET /my/payout-preferences': { status: 200, body: { cadence: 'weekly', thresholdPence: 2500, platformThresholdPence: 1000, lastPaidAt: null } } })
    const html = await (await moneySettingsGET(get('/modernhaus/settings/money'), { params: {} as never })).text()
    expect(html).toContain('href="/modernhaus/confirm/card_remove?confirm=card')
    expect(html).not.toMatch(/action="\/modernhaus\/do\/card_remove"/)
    expect(html).toMatch(/<input(?=[^>]*value="weekly")(?=[^>]*checked)[^>]*>/)
  })
})

// ---------------------------------------------------------------------------
// Signing up from a paywalled piece carries its arrival (E2 deferred it here).
// ---------------------------------------------------------------------------

describe('signup from a piece', () => {
  it('sends the piece as an arrival IDENTIFIER, never a path', async () => {
    const f = gateway({ 'GET /auth/me': { status: 401 }, 'POST /auth/signup': { status: 201, body: { accountId: 'x' } } })
    await post_('signup', { email: 'a@example.com', displayName: 'A', dob_day: '1', dob_month: '2', dob_year: '1990', next: '/modernhaus/article/my-piece' })
    expect(sent(f, 'POST /auth/signup')).toMatchObject({ arrivalDTag: 'my-piece' })
    const g = gateway({ 'GET /auth/me': { status: 401 }, 'POST /auth/signup': { status: 201 } })
    await post_('signup', { email: 'a@example.com', displayName: 'A', dob_day: '1', dob_month: '2', dob_year: '1990', next: '/modernhaus/tag/x' })
    expect(sent(g, 'POST /auth/signup')).not.toHaveProperty('arrivalDTag')
  })
})
