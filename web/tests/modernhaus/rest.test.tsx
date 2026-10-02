import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleDoor } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { outcomeFromQuery } from '../../src/modernhaus/outcomes'
import {
  messageThreadGET,
  messagesNewGET,
  confirmGET,
  settingsImportGET,
  feedSettingsGET,
  dashboardArticleGET,
  appealGET,
  exportGET,
  articleGET,
  historyGET,
  profileGET,
} from '../../src/modernhaus/routes'
import { MESSAGES_COULD_NOT_DECRYPT, messagesBlockedSentence, MESSAGES_SEND_FAILED } from '../../src/content/messages'
import { BLOCK_CONSEQUENCES, blockConfirmTitle } from '../../src/content/social'
import { PRICING_INVALID_DISCOUNT } from '../../src/content/dashboard'
import { FEED_SHARE, FEED_SHARE_STOP } from '../../src/content/feed-settings'
import { APPEAL_UNUSABLE, APPEAL_FILED_BODY, APPEAL_INCOMPLETE_BODY } from '../../src/content/appeal'
import { EXPORT_LIMITED_BODY, EXPORT_ERROR_BODY } from '../../src/content/account-export'
import { FEED_LINK_ADDED, FEED_LINK_REDEEM_REFUSALS } from '../../src/content/feed-link'
import { PREFS_SAVE_FAILED } from '../../src/content/networks'
import { TOKEN } from './fixtures'

// =============================================================================
// E6 — THE REST (MODERNHAUS-ADR §D2.3, §D2.4), through the real door, the real
// registry and the real page pipeline. Each case asserts what the GATEWAY was
// sent — or that it was sent NOTHING — and what the member was shown or where
// they were sent, never a status alone (testing.md).
// =============================================================================

const ORIGIN = 'http://localhost:3010'
const ME = {
  id: 'me-1',
  username: 'viv',
  displayName: 'Viv',
  ageDeclaredAt: '2026-01-01T00:00:00Z',
  pubkey: 'pk-me',
  canWrite: true,
  email: 'viv@example.com',
  bio: 'Hi',
  avatar: null,
  usernameChangedAt: null,
  subscriptionPricePence: 500,
  annualDiscountPct: 15,
  defaultArticlePricePence: null,
}
const CONVO = '22222222-2222-4222-8222-222222222222'
const FEED = '33333333-3333-4333-8333-333333333333'
const FEED2 = '44444444-4444-4444-8444-444444444444'
const ARTICLE = '55555555-5555-4555-8555-555555555555'

type Answer = { status: number; body?: unknown } | 'throw'

function gateway(answers: Record<string, Answer | Answer[]>) {
  const seen: Record<string, number> = {}
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}`
    let a: Answer | Answer[] | undefined =
      answers[key] ??
      (key === 'GET /unread-counts' ? { status: 200, body: { notificationCount: 0, dmCount: 0 } } : undefined) ??
      (key === 'GET /auth/me' ? { status: 200, body: ME } : undefined)
    if (Array.isArray(a)) a = a[Math.min((seen[key] = (seen[key] ?? -1) + 1), a.length - 1)]
    if (a === undefined) throw new Error(`unexpected gateway call ${key}`)
    if (a === 'throw') throw new TypeError('fetch failed')
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const keyOf = ([u, i]: [string, RequestInit | undefined]) =>
  `${i?.method ?? 'GET'} ${new URL(u).pathname.replace(/^\/api\/v1/, '')}`
const keys = (f: ReturnType<typeof gateway>) => f.mock.calls.map((c) => keyOf(c as [string, RequestInit | undefined]))
const urlsOf = (f: ReturnType<typeof gateway>) => f.mock.calls.map((c) => String(c[0]))

function sent(f: ReturnType<typeof gateway>, key: string, nth = 0): unknown {
  const c = f.mock.calls.filter((c) => keyOf(c as [string, RequestInit | undefined]) === key)[nth]
  if (!c) return undefined
  const body = (c[1] as RequestInit).body
  return typeof body === 'string' ? JSON.parse(body) : body
}

function post_(action: string, form: Record<string, string | File>) {
  const fd = new FormData()
  fd.set('_csrf', TOKEN)
  for (const [k, v] of Object.entries(form)) fd.set(k, v)
  return handleDoor(
    new Request(`${ORIGIN}/modernhaus/do/${action}`, { method: 'POST', headers: { cookie: `mh_csrf=${TOKEN}` }, body: fd }),
    action,
    REGISTRY,
  )
}

const get = (p: string) => new Request(`${ORIGIN}${p}`, { headers: { cookie: `mh_csrf=${TOKEN}` } })
const where = (res: Response) => res.headers.get('location')
const said = (res: Response) => outcomeFromQuery(new URL(where(res) ?? '/', ORIGIN).searchParams)?.sentence
/** Text as the page shows it: React escapes an apostrophe and a quote. */
const html = (t: string) => t.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Direct messages.
// ---------------------------------------------------------------------------

const INBOX = {
  status: 200,
  body: { conversations: [{ id: CONVO, lastMessageAt: null, createdAt: '2026-09-01T00:00:00Z', unreadCount: 1, members: [{ id: 'bea-1', username: 'bea', displayName: 'Bea' }] }] },
}
const MESSAGES = {
  status: 200,
  body: {
    messages: [
      { id: 'm2', senderId: 'bea-1', senderUsername: 'bea', senderDisplayName: 'Bea', counterpartyPubkey: 'a'.repeat(64), contentEnc: 'c2', replyTo: { id: 'm1', senderUsername: 'viv', contentEnc: 'c1', counterpartyPubkey: 'a'.repeat(64) }, createdAt: '2026-09-02T00:00:00Z', likeCount: 0, likedByMe: false },
      { id: 'm1', senderId: 'me-1', senderUsername: 'viv', senderDisplayName: 'Viv', counterpartyPubkey: 'a'.repeat(64), contentEnc: 'c1', replyTo: null, createdAt: '2026-09-01T00:00:00Z', likeCount: 1, likedByMe: true },
    ],
    nextCursor: null,
  },
}

describe('messages', () => {
  it('a thread decrypts with the member’s key, shows a link as TEXT, says what it could not decrypt, and marks nothing read', async () => {
    const f = gateway({
      [`GET /messages/${CONVO}`]: MESSAGES,
      'GET /messages': INBOX,
      'POST /dm/decrypt-batch': { status: 200, body: { results: [{ id: 'm2', plaintext: 'see https://evil.example/x now' }, { id: 'reply:m2', plaintext: 'earlier' }, { id: 'm1', plaintext: null }] } },
      'GET /my/relations/bea-1': { status: 200, body: { muted: false, blocked: false } },
    })
    const res = await messageThreadGET(get(`/modernhaus/messages/${CONVO}`), { params: { conversationId: CONVO } })
    const page = await res.text()
    expect(res.status).toBe(200)
    expect(sent(f, 'POST /dm/decrypt-batch')).toEqual({
      messages: [
        { id: 'm2', counterpartyPubkey: 'a'.repeat(64), ciphertext: 'c2' },
        { id: 'reply:m2', counterpartyPubkey: 'a'.repeat(64), ciphertext: 'c1' },
        { id: 'm1', counterpartyPubkey: 'a'.repeat(64), ciphertext: 'c1' },
      ],
    })
    expect(page).toContain('see https://evil.example/x now')
    // TEXT ONLY: the address is words on the page, never an href.
    expect(page).not.toMatch(/href="https:\/\/evil\.example/)
    expect(page).toContain(MESSAGES_COULD_NOT_DECRYPT)
    // Oldest first.
    expect(page.indexOf(MESSAGES_COULD_NOT_DECRYPT)).toBeLessThan(page.indexOf('see https://evil'))
    expect(keys(f)).not.toContain(`POST /messages/${CONVO}/read-all`)
  })

  it('a thread with somebody the viewer blocked offers no send box and says why', async () => {
    gateway({
      [`GET /messages/${CONVO}`]: MESSAGES,
      'GET /messages': INBOX,
      'POST /dm/decrypt-batch': { status: 200, body: { results: [] } },
      'GET /my/relations/bea-1': { status: 200, body: { muted: false, blocked: true } },
    })
    const page = await (await messageThreadGET(get(`/modernhaus/messages/${CONVO}`), { params: { conversationId: CONVO } })).text()
    expect(page).toContain(html(messagesBlockedSentence('Bea')))
    expect(page).not.toMatch(/action="\/modernhaus\/do\/message_send"/)
  })

  it('sends the words as typed, and lands back on the thread', async () => {
    const f = gateway({ [`POST /messages/${CONVO}`]: { status: 201, body: { messageIds: ['x'], skippedRecipientIds: [] } } })
    const res = await post_('message_send', { conversationId: CONVO, content: '  two\n\nlines  ' })
    expect(sent(f, `POST /messages/${CONVO}`)).toEqual({ content: '  two\n\nlines  ' })
    expect(where(res)).toBe(`/modernhaus/messages/${CONVO}?done=message_sent`)
  })

  it('a refused send re-renders the thread with what was typed and the route’s own sentence', async () => {
    gateway({
      [`POST /messages/${CONVO}`]: { status: 400, body: { error: 'dm_links_not_allowed', message: 'Direct messages cannot contain links.' } },
      [`GET /messages/${CONVO}`]: MESSAGES,
      'GET /messages': INBOX,
      'POST /dm/decrypt-batch': { status: 200, body: { results: [] } },
      'GET /my/relations/bea-1': { status: 200, body: { muted: false, blocked: false } },
    })
    const res = await post_('message_send', { conversationId: CONVO, content: 'go to https://evil.example' })
    const page = await res.text()
    expect(res.status).toBe(400)
    expect(page).toContain('Direct messages cannot contain links.')
    expect(page).toContain('go to https://evil.example</textarea>')
    expect(page).not.toMatch(/href="https:\/\/evil/)
  })

  it('an empty message is not sent', async () => {
    const f = gateway({
      [`GET /messages/${CONVO}`]: MESSAGES,
      'GET /messages': INBOX,
      'POST /dm/decrypt-batch': { status: 200, body: { results: [] } },
      'GET /my/relations/bea-1': { status: 200, body: { muted: false, blocked: false } },
    })
    const res = await post_('message_send', { conversationId: CONVO, content: '   ' })
    expect(keys(f)).not.toContain(`POST /messages/${CONVO}`)
    expect(await res.text()).toContain(MESSAGES_SEND_FAILED)
  })

  it('a new message looks the person up in the dm context and starts the conversation with them', async () => {
    const f = gateway({
      'POST /resolve': { status: 200, body: { inputType: 'username', matches: [{ type: 'native_account', confidence: 'exact', account: { id: 'bea-1', username: 'bea', displayName: 'Bea' } }] } },
      'POST /conversations': { status: 201, body: { conversationId: CONVO } },
    })
    const page = await (await messagesNewGET(get('/modernhaus/messages/new?q=bea'), { params: {} })).text()
    expect(sent(f, 'POST /resolve')).toEqual({ query: 'bea', context: 'dm', discover: true })
    expect(page).toMatch(/name="memberId"/)
    const res = await post_('conversation_start', { memberId: 'bea-1' })
    expect(sent(f, 'POST /conversations')).toEqual({ memberIds: ['bea-1'] })
    expect(where(res)).toBe(`/modernhaus/messages/${CONVO}?done=conversation_started`)
  })
})

// ---------------------------------------------------------------------------
// Block and mute.
// ---------------------------------------------------------------------------

describe('block', () => {
  it('the confirmation names the person FROM THE GATEWAY and says what a block ends; the address cannot name them', async () => {
    gateway({ 'GET /writers/bea': { status: 200, body: { id: 'bea-1', username: 'bea', displayName: 'Bea' } } })
    const res = await confirmGET(get('/modernhaus/confirm/block?username=bea&userId=someone-else&return=/modernhaus/u/bea'), {
      params: { action: 'block' },
    })
    const page = await res.text()
    expect(page).toContain(html(blockConfirmTitle('Bea')))
    for (const c of BLOCK_CONSEQUENCES) expect(page).toContain(html(c))
    expect(page).toContain('name="userId" value="bea-1"')
    expect(page).not.toContain('someone-else')
  })

  it('an unknown person is not there to block', async () => {
    gateway({ 'GET /writers/nobody': { status: 404, body: { error: 'not_found' } } })
    const res = await confirmGET(get('/modernhaus/confirm/block?username=nobody'), { params: { action: 'block' } })
    expect(res.status).toBe(404)
  })

  it('blocks, and says so', async () => {
    const f = gateway({ 'POST /my/blocks/bea-1': { status: 200, body: { ok: true, followsDropped: 1, subscriptionsEnding: [] } } })
    const res = await post_('block', { userId: 'bea-1', return: '/modernhaus/u/bea' })
    expect(keys(f)).toContain('POST /my/blocks/bea-1')
    expect(where(res)).toBe('/modernhaus/u/bea?done=blocked')
  })
})

// ---------------------------------------------------------------------------
// Settings.
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('a new photo is stored first and its address saved; no photo leaves the old one alone', async () => {
    const f = gateway({
      'POST /media/upload': { status: 200, body: { url: 'https://all.haus/media/a.webp' } },
      'PATCH /auth/profile': { status: 200, body: { ok: true } },
    })
    await post_('profile_save', { displayName: ' Viv ', bio: 'Writes.', avatar: new File(['x'], 'me.png', { type: 'image/png' }) })
    expect(keys(f).indexOf('POST /media/upload')).toBeLessThan(keys(f).indexOf('PATCH /auth/profile'))
    expect(sent(f, 'PATCH /auth/profile')).toEqual({ displayName: 'Viv', bio: 'Writes.', avatar: 'https://all.haus/media/a.webp' })

    const g = gateway({ 'PATCH /auth/profile': { status: 200, body: { ok: true } } })
    await post_('profile_save', { displayName: 'Viv', bio: '' })
    expect(sent(g, 'PATCH /auth/profile')).toEqual({ displayName: 'Viv', bio: '' })
    const h = gateway({ 'PATCH /auth/profile': { status: 200, body: { ok: true } } })
    await post_('profile_save', { displayName: 'Viv', bio: '', removeAvatar: '1' })
    expect(sent(h, 'PATCH /auth/profile')).toEqual({ displayName: 'Viv', bio: '', avatar: null })
  })

  it('a refused username keeps what was typed and says the route’s reason', async () => {
    gateway({ 'POST /auth/change-username': { status: 409, body: { error: 'That username is taken.' } } })
    const res = await post_('username_change', { newUsername: 'bea' })
    const page = await res.text()
    expect(res.status).toBe(409)
    expect(page).toContain('That username is taken.')
    expect(page).toContain('value="bea"')
  })

  it('privacy is written BY DIFFERENCE: an unchanged switch is never sent, and nothing changed sends nothing', async () => {
    const current = { status: 200, body: { discoveryEnabled: true, publishFollowGraph: true, discoverableByEmail: false } }
    const f = gateway({ 'GET /me/privacy-preferences': current, 'PUT /me/privacy-preferences': { status: 200, body: {} } })
    await post_('privacy_save', { discoveryEnabled: 'on', publishFollowGraph: 'off', discoverableByEmail: 'off' })
    expect(sent(f, 'PUT /me/privacy-preferences')).toEqual({ publishFollowGraph: false })

    const g = gateway({ 'GET /me/privacy-preferences': current })
    const res = await post_('privacy_save', { discoveryEnabled: 'on', publishFollowGraph: 'on', discoverableByEmail: 'off' })
    expect(keys(g)).not.toContain('PUT /me/privacy-preferences')
    expect(said(res)).toBe('Saved.')
  })

  it('notification preferences: every change is tried, and a partial save is said as one', async () => {
    const f = gateway({
      'GET /notifications/preferences': { status: 200, body: { preferences: { new_follower: true, new_reply: true, new_mention: true, new_quote: true, commission_request: true, pub_events: true, subscription_activity: true } } },
      'PUT /notifications/preferences/new_follower': { status: 500 },
      'PUT /notifications/preferences/new_quote': { status: 200, body: { ok: true } },
    })
    const res = await post_('notification_prefs_save', {
      new_follower: 'off', new_reply: 'on', new_mention: 'on', new_quote: 'off', pub_events: 'on', subscription_activity: 'on',
    })
    expect(keys(f).filter((k) => k.startsWith('PUT'))).toEqual(['PUT /notifications/preferences/new_follower', 'PUT /notifications/preferences/new_quote'])
    expect(sent(f, 'PUT /notifications/preferences/new_quote')).toEqual({ enabled: false })
    expect(where(res)).toContain('error=prefs_saved_partly')

    gateway({
      'GET /notifications/preferences': { status: 200, body: { preferences: { new_follower: true } } },
      'PUT /notifications/preferences/new_follower': { status: 500 },
    })
    const none = await post_('notification_prefs_save', { new_follower: 'off' })
    expect(said(none)).toBe(PREFS_SAVE_FAILED)
  })

  it('linking a network is an off-site 303 to the GATEWAY’s https address only — never to anything from the form', async () => {
    const f = gateway({
      'POST /linked-accounts/mastodon': { status: 200, body: { authorizeUrl: 'https://mastodon.example/oauth/authorize?x=1' } },
    })
    const res = await post_('network_link', { protocol: 'activitypub', identity: 'mastodon.example', return: 'https://evil.example/' })
    expect(sent(f, 'POST /linked-accounts/mastodon')).toEqual({ instanceUrl: 'mastodon.example' })
    expect(res.status).toBe(303)
    expect(where(res)).toBe('https://mastodon.example/oauth/authorize?x=1')

    gateway({ 'POST /linked-accounts/bluesky': { status: 200, body: { authorizeUrl: 'http://pds.example/authorize' } } })
    const plain = await post_('network_link', { protocol: 'atproto', identity: 'bea.bsky.social' })
    expect(where(plain)).toContain('error=network_connect_failed')
  })

  it('the two network consents travel as two separate answers, each from its own box', async () => {
    const f = gateway({ 'PATCH /linked-accounts/la-1': { status: 200, body: { ok: true } } })
    await post_('network_update', { id: 'la-1', showOnProfile: '1' })
    expect(sent(f, 'PATCH /linked-accounts/la-1')).toEqual({ crossPostDefault: false, showOnProfile: true })
  })

  it('a refused deletion says the route’s own sentence and keeps the address; a deletion lands signed out', async () => {
    gateway({
      'POST /auth/delete-account': { status: 409, body: { error: 'final_settlement_pending', message: 'We are completing the final payment for your reading tab. Please try again in a few minutes.' } },
    })
    const res = await post_('account_delete', { emailConfirmation: 'viv@example.com' })
    const page = await res.text()
    expect(res.status).toBe(409)
    expect(page).toContain('We are completing the final payment')
    expect(page).toContain('value="viv@example.com"')

    const f = gateway({ 'POST /auth/delete-account': { status: 200, body: { ok: true } } })
    const done = await post_('account_delete', { emailConfirmation: 'viv@example.com', return: '/modernhaus/settings/account/delete' })
    expect(sent(f, 'POST /auth/delete-account')).toEqual({ emailConfirmation: 'viv@example.com' })
    expect(where(done)).toBe('/modernhaus?done=deleted_account')
  })

  it('follow import is not offered while it is dark', async () => {
    gateway({ 'GET /linked-accounts': { status: 200, body: { accounts: [], capabilities: { assistedBluesky: false, assistedMastodon: false, followImportProtocols: [] } } } })
    const res = await settingsImportGET(get('/modernhaus/settings/networks/import?q=bea'), { params: {} })
    expect(res.status).toBe(404)
  })

  it('follow import runs only on the press, for the identity the resolver named', async () => {
    const f = gateway({ 'POST /follow-imports': { status: 201, body: { import: { id: 'run-1' } } } })
    const res = await post_('follow_import', { origin: 'atproto did:plc:abc' })
    expect(sent(f, 'POST /follow-imports')).toEqual({ protocol: 'atproto', originIdentity: 'did:plc:abc' })
    expect(where(res)).toBe('/modernhaus/settings/networks/imports?id=run-1&done=import_started')
  })

  it('the Recent reading switch sends only that one dial', async () => {
    const f = gateway({ 'PUT /me/reading-preferences': { status: 200, body: { ok: true } } })
    await post_('reading_log_toggle', { enabled: 'off' })
    expect(sent(f, 'PUT /me/reading-preferences')).toEqual({ readingLogEnabled: false })
  })

  it('Recent reading shows the log and its switch, and the switch that could not load asserts nothing', async () => {
    gateway({
      'GET /reading-log': { status: 200, body: { items: [], hasMore: false, retentionDays: 7 } },
      'GET /me/reading-preferences': { status: 500 },
    })
    const page = await (await historyGET(get('/modernhaus/history'), { params: {} })).text()
    expect(page).not.toMatch(/action="\/modernhaus\/do\/reading_log_toggle"/)
  })
})

// ---------------------------------------------------------------------------
// The writer's dashboard.
// ---------------------------------------------------------------------------

describe('dashboard', () => {
  it('replies on and off go to the route the dashboard calls', async () => {
    const f = gateway({ [`PATCH /articles/${ARTICLE}`]: { status: 200, body: { ok: true } } })
    const res = await post_('article_replies', { toggle: `${ARTICLE}:off` })
    expect(sent(f, `PATCH /articles/${ARTICLE}`)).toEqual({ repliesEnabled: false })
    expect(where(res)).toContain('done=replies_off')
  })

  it('tags are sent whole, so an empty field takes every tag off', async () => {
    const f = gateway({ [`PUT /articles/${ARTICLE}/tags`]: { status: 200, body: {} } })
    await post_('article_tags', { articleId: ARTICLE, tags: ' #books, poetry ,' })
    expect(sent(f, `PUT /articles/${ARTICLE}/tags`)).toEqual({ tags: ['books', 'poetry'] })
    const g = gateway({ [`PUT /articles/${ARTICLE}/tags`]: { status: 200, body: {} } })
    await post_('article_tags', { articleId: ARTICLE, tags: '' })
    expect(sent(g, `PUT /articles/${ARTICLE}/tags`)).toEqual({ tags: [] })
  })

  it('pricing is checked here with the Pricing tab’s own words before anything is asked', async () => {
    const f = gateway({ 'GET /settings/subscription-welcome': { status: 200, body: { message: null } } })
    const res = await post_('price_save', { price: '5.00', discount: '45', mode: 'auto', fixed: '' })
    expect(keys(f)).not.toContain('PATCH /settings/subscription-price')
    expect(await res.text()).toContain(PRICING_INVALID_DISCOUNT)
  })

  it('pricing saves the three figures the tab saves', async () => {
    const f = gateway({ 'PATCH /settings/subscription-price': { status: 200, body: {} } })
    await post_('price_save', { price: '4.50', discount: '10', mode: 'fixed', fixed: '0.40' })
    expect(sent(f, 'PATCH /settings/subscription-price')).toEqual({ pricePence: 450, annualDiscountPct: 10, defaultArticlePricePence: 40 })
  })

  it('a gift of a subscription is a grant offer to a named reader', async () => {
    const f = gateway({ 'POST /subscription-offers': { status: 201, body: {} } })
    const res = await post_('offer_create', { mode: 'grant', label: 'For Cy', recipientUsername: '@cy', discountPct: '100', durationMonths: '' })
    expect(sent(f, 'POST /subscription-offers')).toEqual({ label: 'For Cy', mode: 'grant', discountPct: 100, durationMonths: null, recipientUsername: 'cy' })
    expect(where(res)).toContain('done=comp_granted')
  })

  it('a gift link is shown as text, never behind a copy button', async () => {
    gateway({
      'GET /my/articles': { status: 200, body: { articles: [{ id: ARTICLE, title: 'A piece', slug: 's', dTag: 'my-piece', nostrEventId: 'e', isPaywalled: true, pricePence: 40, wordCount: 1, publishedAt: '2026-09-01T00:00:00Z', repliesEnabled: true, replyCount: 0, readCount: 0, netEarningsPence: 0 }] } },
      [`GET /articles/${ARTICLE}/gift-links`]: { status: 200, body: { giftLinks: [{ id: 'g1', token: 'tok', maxRedemptions: 5, redemptionCount: 1, revoked: false, createdAt: '2026-09-01T00:00:00Z' }] } },
      [`GET /articles/${ARTICLE}/tags`]: { status: 200, body: { tags: ['books'] } },
    })
    const page = await (await dashboardArticleGET(get(`/modernhaus/dashboard/article/${ARTICLE}`), { params: { articleId: ARTICLE } })).text()
    expect(page).toContain(`${ORIGIN}/article/my-piece?gift=tok`)
    expect(page).toContain('value="books"')
  })
})

// ---------------------------------------------------------------------------
// A feed's settings.
// ---------------------------------------------------------------------------

const SOURCE = {
  id: 'src-1', sourceType: 'account', accountId: 'bea-1', throughput: 0.6, samplingMode: 'top', hasEngagementSignal: true,
  excludeReplies: false, mutedAt: null, createdAt: '', display: { kind: 'account', label: 'Bea', sublabel: '@bea', href: '/bea' },
}
const FEEDS = { status: 200, body: { feeds: [{ id: FEED, name: 'Essays', sortRank: 1, hidden: false }, { id: FEED2, name: '', sortRank: 2, hidden: false }] } }

describe('a feed’s settings', () => {
  it('a source is written BY DIFFERENCE: mute rides `muted` alone, and an unchanged row sends nothing', async () => {
    const sources = { status: 200, body: { sources: [SOURCE] } }
    const f = gateway({ [`GET /workspace/feeds/${FEED}/sources`]: sources, [`PATCH /workspace/feeds/${FEED}/sources/src-1`]: { status: 200, body: {} } })
    await post_('source_update', { feedId: FEED, sourceId: 'src-1', step: '0', sampling: 'top' })
    expect(sent(f, `PATCH /workspace/feeds/${FEED}/sources/src-1`)).toEqual({ muted: true })

    const g = gateway({ [`GET /workspace/feeds/${FEED}/sources`]: sources })
    const res = await post_('source_update', { feedId: FEED, sourceId: 'src-1', step: '3', sampling: 'top' })
    expect(keys(g)).not.toContain(`PATCH /workspace/feeds/${FEED}/sources/src-1`)
    expect(where(res)).toContain('done=source_saved')

    const h = gateway({
      [`GET /workspace/feeds/${FEED}/sources`]: { status: 200, body: { sources: [{ ...SOURCE, mutedAt: '2026-09-01T00:00:00Z' }] } },
      [`PATCH /workspace/feeds/${FEED}/sources/src-1`]: { status: 200, body: {} },
    })
    await post_('source_update', { feedId: FEED, sourceId: 'src-1', step: '5', sampling: 'random', excludeReplies: '1' })
    expect(sent(h, `PATCH /workspace/feeds/${FEED}/sources/src-1`)).toEqual({ step: 5, muted: false, sampling: 'random', excludeReplies: true })
  })

  it('adding a source sends the composer’s own body; a mangled one sends nothing', async () => {
    const add = { sourceType: 'external_source', protocol: 'rss', sourceUri: 'https://blog.example/feed' }
    const f = gateway({ [`POST /workspace/feeds/${FEED}/sources`]: { status: 201, body: { following: 'none' } } })
    const res = await post_('source_add', { feedId: FEED, add: JSON.stringify(add) })
    expect(sent(f, `POST /workspace/feeds/${FEED}/sources`)).toEqual(add)
    expect(where(res)).toBe(`/modernhaus/feed/${FEED}/settings?done=source_added`)
    const g = gateway({})
    await post_('source_add', { feedId: FEED, add: '{not json' })
    expect(keys(g)).toEqual([])
  })

  it('offers nothing about sharing while formulas are dark, and the live link as text when there is one', async () => {
    gateway({
      'GET /workspace/feeds': FEEDS,
      [`GET /workspace/feeds/${FEED}/sources`]: { status: 200, body: { sources: [SOURCE] } },
      [`GET /workspace/feeds/${FEED}/formula`]: { status: 404, body: { error: 'Not found' } },
    })
    const dark = await (await feedSettingsGET(get(`/modernhaus/feed/${FEED}/settings`), { params: { feedId: FEED } })).text()
    expect(dark).not.toContain(FEED_SHARE)
    expect(dark).toMatch(/action="\/modernhaus\/do\/source_update"/)

    gateway({
      'GET /workspace/feeds': FEEDS,
      [`GET /workspace/feeds/${FEED}/sources`]: { status: 200, body: { sources: [SOURCE] } },
      [`GET /workspace/feeds/${FEED}/formula`]: { status: 200, body: { link: { id: 'fm-1', url: 'https://all.haus/f/tok', revoked: false }, refusal: null, excludedCount: 0, maxSources: 50, sourceCount: 1 } },
    })
    const live = await (await feedSettingsGET(get(`/modernhaus/feed/${FEED}/settings`), { params: { feedId: FEED } })).text()
    expect(live).toContain('https://all.haus/f/tok')
    expect(live).toContain(FEED_SHARE_STOP)
  })

  it('the merge confirmation names both feeds from the gateway and carries their ids from it', async () => {
    gateway({ 'GET /workspace/feeds': FEEDS, [`GET /workspace/feeds/${FEED2}/formula`]: { status: 404 } })
    const page = await (
      await confirmGET(get(`/modernhaus/confirm/feed_merge?feedId=${FEED}&sourceFeedId=${FEED2}`), { params: { action: 'feed_merge' } })
    ).text()
    expect(page).toContain('Merge Unnamed channel into Essays?')
    expect(page).toContain(`name="sourceFeedId" value="${FEED2}"`)
  })

  it('redeeming a feed link lands on the new feed; a withdrawn link says the full site’s sentence', async () => {
    const f = gateway({ 'POST /formulas/tok/redeem': { status: 201, body: { feedId: FEED, added: 2, failed: [] } } })
    const res = await post_('formula_redeem', { token: 'tok' })
    expect(keys(f)).toContain('POST /formulas/tok/redeem')
    expect(where(res)).toBe(`/modernhaus/feed/${FEED}?done=formula_redeemed`)
    expect(said(res)).toBe(FEED_LINK_ADDED)

    gateway({ 'POST /formulas/tok/redeem': { status: 410, body: { error: 'formula_revoked', message: 'This link is no longer available.' } } })
    const gone = await post_('formula_redeem', { token: 'tok' })
    expect(said(gone)).toBe(FEED_LINK_REDEEM_REFUSALS.formula_revoked)
  })
})

// ---------------------------------------------------------------------------
// An appeal, the account export, a gift link.
// ---------------------------------------------------------------------------

describe('rights and gifts', () => {
  it('an appeal page without its token says so; with one, the GET spends nothing', async () => {
    const f = gateway({ 'GET /auth/me': { status: 401 } })
    const bare = await (await appealGET(get('/modernhaus/appeal/r1'), { params: { reportId: 'r1' } })).text()
    expect(bare).toContain(html(APPEAL_INCOMPLETE_BODY))
    await appealGET(get('/modernhaus/appeal/r1?token=t'), { params: { reportId: 'r1' } })
    expect(keys(f).filter((k) => k.includes('appeal'))).toEqual([])
  })

  it('an appeal is filed on its POST, and every refusal reads alike', async () => {
    const f = gateway({ 'GET /auth/me': { status: 401 }, 'POST /moderation/appeal/r1': { status: 200, body: { ok: true } } })
    const ok = await post_('appeal', { reportId: 'r1', token: 't', text: 'You misread it.' })
    expect(sent(f, 'POST /moderation/appeal/r1')).toEqual({ token: 't', text: 'You misread it.' })
    expect(await ok.text()).toContain(APPEAL_FILED_BODY)

    gateway({ 'GET /auth/me': { status: 401 }, 'POST /moderation/appeal/r1': { status: 403, body: { error: 'appeal_not_available' } } })
    const no = await post_('appeal', { reportId: 'r1', token: 't', text: 'x' })
    expect(await no.text()).toContain(APPEAL_UNUSABLE)
  })

  it('the export page never spends the token on its GET; the press streams the file', async () => {
    const f = gateway({ 'GET /account/export': { status: 200, body: { notice: {}, account: { id: 'me-1' } } } })
    await exportGET(get('/modernhaus/export?token=t0k'), { params: {} })
    expect(keys(f)).not.toContain('GET /account/export')
    const res = await post_('export_download', { token: 't0k' })
    expect(urlsOf(f).some((u) => u.endsWith('/account/export?token=t0k'))).toBe(true)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="platform-account-export.json"')
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
  })

  it('an export refused by the rate limit says so, and is not called a fault', async () => {
    gateway({ 'GET /account/export': { status: 429, body: { error: 'rate_limited' } } })
    const limited = await post_('export_download', { token: 't0k' })
    expect(limited.status).toBe(429)
    const page = await limited.text()
    expect(page).toContain(EXPORT_LIMITED_BODY)
    expect(page).not.toContain(EXPORT_ERROR_BODY)
  })

  it('a gift link is redeemed on the article’s GET, once, and the address loses it', async () => {
    const f = gateway({
      'GET /articles/my-piece': { status: 200, body: { id: ARTICLE } },
      [`POST /articles/${ARTICLE}/redeem-gift`]: { status: 200, body: { ok: true, unlocked: true } },
    })
    const res = await articleGET(get('/modernhaus/article/my-piece?gift=tok&focus=x'), { params: { dTag: 'my-piece' } })
    expect(sent(f, `POST /articles/${ARTICLE}/redeem-gift`)).toEqual({ token: 'tok' })
    expect(where(res)).toBe('/modernhaus/article/my-piece?focus=x')
  })

  it('a profile offers message, mute and block to somebody else, from the relation the payload carries', async () => {
    gateway({
      'GET /writers/bea': { status: 200, body: { id: 'bea-1', username: 'bea', displayName: 'Bea', bio: null, articleCount: 0, noteCount: 0, followerCount: 0, followingCount: 0, subscriptionPricePence: 0, hasPaywalledArticle: false, viewer: { muted: true, blocked: false } } },
      'GET /writers/bea/articles': { status: 200, body: { articles: [] } },
    })
    const page = await (await profileGET(get('/modernhaus/u/bea'), { params: { username: 'bea' } })).text()
    expect(page).toMatch(/action="\/modernhaus\/do\/conversation_start"/)
    expect(page).toMatch(/action="\/modernhaus\/do\/unmute"/)
    expect(page).toContain('/modernhaus/confirm/block?username=bea')
  })
})
