import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleDoor } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { poundsToPence, tagList } from '../../src/modernhaus/actions/writing'
import { londonToInstant, wallFromBoxes, londonWall } from '../../src/modernhaus/london-time'
import { outcomeFromQuery } from '../../src/modernhaus/outcomes'
import { composeGET, writeGET, writeDraftGET, previewGET, draftsGET, threadGET } from '../../src/modernhaus/routes'
import { quoteTargetFromPost } from '../../src/lib/post/quote-target'
import { PAYWALL_GATE_MARKER } from '../../src/lib/gate-marker'
import { PAYWALL_EMPTY, PAYWALL_PRICE_REQUIRED } from '../../src/lib/publish-validation'
import type { Post } from '../../src/lib/post/types'
import { TOKEN, post } from './fixtures'

// =============================================================================
// E4 — WRITING (MODERNHAUS-ADR §D2.3, §D2.4), through the real door, the real
// registry and the real page pipeline. Each case asserts what the GATEWAY was
// sent — or that it was sent NOTHING — and where the member was sent, never a
// status alone (testing.md). The checks that guard the relay (an empty or
// over-long note) are asserted by the signature NOT happening: the relay takes
// a signed event whatever the index says afterwards.
// =============================================================================

const ORIGIN = 'http://localhost:3010'
const ME = { id: 'me-1', username: 'viv', displayName: 'Viv', ageDeclaredAt: '2026-01-01T00:00:00Z', pubkey: 'pk-me', canWrite: true }
const DRAFT_ID = '11111111-1111-4111-8111-111111111111'
const PICTURE = 'https://all.haus/media/' + 'a'.repeat(64) + '.webp'

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

function post_(action: string, form: Record<string, string | string[] | File>) {
  const fd = new FormData()
  fd.set('_csrf', TOKEN)
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x))
    else fd.set(k, v)
  }
  return handleDoor(
    new Request(`${ORIGIN}/modernhaus/do/${action}`, { method: 'POST', headers: { cookie: `mh_csrf=${TOKEN}` }, body: fd }),
    action,
    REGISTRY,
  )
}

const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { cookie: `mh_csrf=${TOKEN}` } })
const where = (res: Response) => res.headers.get('location')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const THEIRS: Post = post({
  id: 'n'.repeat(64),
  version: 'ev-note',
  origin: { protocol: 'nostr', uri: 'ev-note', webUrl: null, sourceName: null, publication: null },
  author: { id: 'acc-bea', accountId: 'acc-bea', displayName: 'Bea', handle: 'bea', handleUri: null, pubkey: 'pk-bea', pipStatus: 'unknown' },
  body: { text: 'what Bea said' } as Post['body'],
})
const thread = (p: Post) => ({ status: 200, body: { focalId: p.id, posts: [p] } })

const PNG = () => new File([new Uint8Array([137, 80, 78, 71])], 'p.png', { type: 'image/png' })

// ---------------------------------------------------------------------------
// A note.
// ---------------------------------------------------------------------------

describe('note', () => {
  it('signs the kind-1 event and indexes it, as publishNote does', async () => {
    const f = gateway({
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-new' } },
      'POST /notes': { status: 201, body: { noteId: 'x' } },
    })
    const res = await post_('note', { content: 'hello', return: '/modernhaus/feed/f1' })
    expect(where(res)).toBe('/modernhaus/feed/f1?done=posted')
    expect(sent(f, 'POST /sign-and-publish')).toEqual({ kind: 1, content: 'hello', tags: [] })
    expect(sent(f, 'POST /notes')).toEqual({ nostrEventId: 'ev-new', content: 'hello' })
  })

  it('a picture is uploaded first, rebuilt as the one file part, and its address joins the words', async () => {
    const f = gateway({
      'POST /media/upload': { status: 201, body: { url: PICTURE, sha256: 'a'.repeat(64) } },
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-new' } },
      'POST /notes': { status: 201 },
    })
    await post_('note', { content: 'look', picture: PNG() })
    expect(keys(f)).toEqual(['POST /media/upload', 'POST /sign-and-publish', 'POST /notes'])
    const upload = sent(f, 'POST /media/upload') as FormData
    expect(upload).toBeInstanceOf(FormData)
    expect([...upload.keys()]).toEqual(['file'])
    expect(sent(f, 'POST /notes')).toMatchObject({ content: `look\n${PICTURE}` })
  })

  it('an empty note is refused BEFORE anything is signed, and says so', async () => {
    const f = gateway({})
    const res = await post_('note', { content: '   ' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Write something, or add a picture, before posting.')
    expect(keys(f).filter((k) => k.startsWith('POST'))).toEqual([])
  })

  it('an over-long note is refused before signing, the external quote URL counted', async () => {
    const ext = post({ id: 'ext-1', origin: { protocol: 'atproto', uri: 'at://x', webUrl: 'https://bsky.app/x/1', sourceName: 'Bluesky', publication: null } })
    const f = gateway({ 'GET /thread/ext-1': thread(ext) })
    const reserve = 'https://bsky.app/x/1'.length + 2
    const res = await post_('note', { content: 'a'.repeat(1000 - reserve + 1), quote: 'ext-1' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('this one is 1,001')
    expect(keys(f)).not.toContain('POST /sign-and-publish')
    // CONTROL: one character fewer is exactly at the limit, and is signed.
    const g = gateway({
      'GET /thread/ext-1': thread(ext),
      'POST /sign-and-publish': { status: 200, body: { id: 'ev' } },
      'POST /notes': { status: 201 },
    })
    const atLimit = await post_('note', { content: 'a'.repeat(1000 - reserve), quote: 'ext-1' })
    expect(where(atLimit)).toBe('/modernhaus?done=posted')
    expect((sent(g, 'POST /notes') as { content: string }).content).toHaveLength(1000)
  })

  it('a quote re-reads the post and builds the full site’s target (q tag + snapshot)', async () => {
    const f = gateway({
      [`GET /thread/${THEIRS.id}`]: thread(THEIRS),
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-q' } },
      'POST /notes': { status: 201 },
    })
    await post_('note', { content: 'agreed', quote: THEIRS.id, crossPost: ['la-1'] })
    const target = quoteTargetFromPost(THEIRS)
    expect(sent(f, 'POST /sign-and-publish')).toEqual({ kind: 1, content: 'agreed', tags: [['q', 'ev-note', '', 'pk-bea']] })
    expect(sent(f, 'POST /notes')).toEqual({
      nostrEventId: 'ev-q',
      content: 'agreed',
      isQuoteComment: true,
      quotedEventId: target.eventId,
      quotedEventKind: 1,
      quotedExcerpt: 'what Bea said',
      quotedAuthor: 'Bea',
    })
  })

  it('a locked or vanished post cannot be quoted, and nothing is signed', async () => {
    const f = gateway({ [`GET /thread/${THEIRS.id}`]: thread({ ...THEIRS, rootLocked: true }) })
    const res = await post_('note', { content: 'x', quote: THEIRS.id, return: '/modernhaus/feed/f1' })
    expect(where(res)).toBe('/modernhaus/feed/f1?error=not_found')
    expect(keys(f)).toEqual([`GET /thread/${THEIRS.id}`])
  })

  it('a plain note carries the ticked cross-posts; a quote carries none', async () => {
    const f = gateway({ 'POST /sign-and-publish': { status: 200, body: { id: 'ev' } }, 'POST /notes': { status: 201 } })
    await post_('note', { content: 'hi', crossPost: ['la-1', 'la-2'] })
    expect(sent(f, 'POST /notes')).toMatchObject({
      crossPosts: [
        { linkedAccountId: 'la-1', actionType: 'original' },
        { linkedAccountId: 'la-2', actionType: 'original' },
      ],
    })
  })

  it('an upload the route refuses re-renders the form with its words and signs nothing', async () => {
    const f = gateway({
      'POST /media/upload': { status: 400, body: { error: "We can't use that kind of file (text/plain). Please upload a JPEG, PNG, GIF or WebP image." } },
      'GET /linked-accounts': { status: 200, body: { accounts: [] } },
    })
    const res = await post_('note', { content: 'kept words', picture: PNG() })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('use that kind of file')
    expect(html).toContain('kept words')
    expect(keys(f)).not.toContain('POST /sign-and-publish')
  })

  it('a picture kept from a refused press is used, not asked for again', async () => {
    const f = gateway({ 'POST /sign-and-publish': { status: 200, body: { id: 'ev' } }, 'POST /notes': { status: 201 } })
    await post_('note', { content: 'again', pictureUrl: PICTURE })
    expect(keys(f)).not.toContain('POST /media/upload')
    expect(sent(f, 'POST /notes')).toMatchObject({ content: `again\n${PICTURE}` })
  })
})

describe('a reply carries a picture now', () => {
  it('uploads first, then signs the words and the address together', async () => {
    const f = gateway({
      'POST /media/upload': { status: 201, body: { url: PICTURE } },
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-r' } },
      'POST /replies': { status: 201 },
    })
    await post_('reply', { content: 'see', picture: PNG(), eventId: 'ev-note', eventKind: '1', authorPubkey: 'pk-bea' })
    expect(keys(f)).toEqual(['POST /media/upload', 'POST /sign-and-publish', 'POST /replies'])
    expect(sent(f, 'POST /replies')).toMatchObject({ content: `see\n${PICTURE}` })
  })

  it('an empty reply is refused before signing', async () => {
    const f = gateway({})
    const res = await post_('reply', { content: ' ', eventId: 'ev-note', eventKind: '1', authorPubkey: 'pk-bea' })
    expect(res.status).toBe(400)
    expect(keys(f).filter((k) => k.startsWith('POST'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// An article.
// ---------------------------------------------------------------------------

const PIECE = { title: 'A piece', dek: 'Its dek', content: 'The words.', price: '', commentsEnabled: 'on' }

describe('draft_save', () => {
  it('a new piece gets a row of its own (newDraft), never the route’s guess', async () => {
    const f = gateway({ 'POST /drafts': { status: 201, body: { draftId: DRAFT_ID } } })
    const res = await post_('draft_save', PIECE)
    expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?done=draft_saved`)
    expect(sent(f, 'POST /drafts')).toEqual({
      title: 'A piece',
      dek: 'Its dek',
      content: 'The words.',
      pricePence: 0,
      gatePositionPct: 50,
      commentsEnabled: true,
      newDraft: true,
    })
  })

  it('a saved draft is targeted by its id; an edit by its d-tag; neither guesses', async () => {
    const f = gateway({ 'POST /drafts': { status: 200, body: { draftId: DRAFT_ID } } })
    await post_('draft_save', { ...PIECE, draftId: DRAFT_ID })
    expect(sent(f, 'POST /drafts')).toMatchObject({ draftId: DRAFT_ID })
    expect(sent(f, 'POST /drafts')).not.toHaveProperty('newDraft')
    const g = gateway({ 'POST /drafts': { status: 200, body: { draftId: DRAFT_ID } } })
    await post_('draft_save', { ...PIECE, dTag: 'a-piece-x' })
    expect(sent(g, 'POST /drafts')).toMatchObject({ dTag: 'a-piece-x' })
    expect(sent(g, 'POST /drafts')).not.toHaveProperty('newDraft')
  })

  it('a paywalled piece saves the editor’s gate position and the price in pence', async () => {
    const f = gateway({ 'POST /drafts': { status: 201, body: { draftId: DRAFT_ID } } })
    await post_('draft_save', { ...PIECE, content: `aaaa\n\n${PAYWALL_GATE_MARKER}\n\naaaa`, price: '£0.4' })
    expect(sent(f, 'POST /drafts')).toMatchObject({ pricePence: 40, gatePositionPct: 50 })
  })

  it('a price that is not money re-renders the form with the typing, and saves nothing', async () => {
    const f = gateway({})
    const res = await post_('draft_save', { ...PIECE, content: '"><script>x</script>', price: 'forty' })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('Write the price in pounds and pence')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(keys(f).filter((k) => k.startsWith('POST'))).toEqual([])
  })
})

describe('publish_now', () => {
  const ok = {
    'POST /drafts': { status: 201, body: { draftId: DRAFT_ID } },
    [`POST /drafts/${DRAFT_ID}/publish`]: { status: 201, body: { articleId: 'art-1', dTag: 'a-piece-x', eventId: 'e' } },
  }

  it('saves, publishes through the one door, sets the tags, and lands on the piece', async () => {
    const f = gateway({ ...ok, 'PUT /articles/art-1/tags': { status: 200 } })
    const res = await post_('publish_now', { ...PIECE, tags: 'books, , essays', emailOffered: '1', sendEmail: 'on' })
    expect(keys(f)).toEqual(['POST /drafts', `POST /drafts/${DRAFT_ID}/publish`, 'PUT /articles/art-1/tags'])
    expect(sent(f, `POST /drafts/${DRAFT_ID}/publish`)).toEqual({ sendEmail: true })
    expect(sent(f, 'PUT /articles/art-1/tags')).toEqual({ tags: ['books', 'essays'] })
    expect(where(res)).toBe('/modernhaus/article/a-piece-x?done=published')
  })

  it('an unticked email is said as false; a form that did not offer it says nothing', async () => {
    const f = gateway(ok)
    await post_('publish_now', { ...PIECE, emailOffered: '1' })
    expect(sent(f, `POST /drafts/${DRAFT_ID}/publish`)).toEqual({ sendEmail: false })
    const g = gateway(ok)
    await post_('publish_now', { ...PIECE, dTag: 'a-piece-x' })
    expect(sent(g, `POST /drafts/${DRAFT_ID}/publish`)).toEqual({})
  })

  it('a gate with no price: saved, then refused with the EDITOR’s sentence — never published', async () => {
    const f = gateway(ok)
    const res = await post_('publish_now', { ...PIECE, content: `free\n\n${PAYWALL_GATE_MARKER}\n\npaid` })
    expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?error=paywall_price`)
    expect(keys(f)).toEqual(['POST /drafts'])
    expect(outcomeFromQuery(new URLSearchParams('error=paywall_price'))?.sentence).toBe(PAYWALL_PRICE_REQUIRED)
    const g = gateway(ok)
    const empty = await post_('publish_now', { ...PIECE, content: `free\n\n${PAYWALL_GATE_MARKER}\n\n`, price: '1' })
    expect(where(empty)).toBe(`/modernhaus/write/${DRAFT_ID}?error=paywall_empty`)
    expect(keys(g)).toEqual(['POST /drafts'])
    expect(outcomeFromQuery(new URLSearchParams('error=paywall_empty'))?.sentence).toBe(PAYWALL_EMPTY)
  })

  it('the route’s own refusal comes back to the draft’s page as its code, naming the press', async () => {
    gateway({
      ...ok,
      [`POST /drafts/${DRAFT_ID}/publish`]: { status: 403, body: { error: 'writer_terms_required', message: 'x' } },
    })
    const res = await post_('publish_now', { ...PIECE, content: `free\n\n${PAYWALL_GATE_MARKER}\n\npaid`, price: '0.40' })
    // `press` is what lets the consent stand in for the button that met it (E5).
    expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?press=publish&error=writer_terms_required`)
  })

  it('a tags refusal after the publish is SAID, and does not un-publish', async () => {
    gateway({ ...ok, 'PUT /articles/art-1/tags': { status: 400 } })
    const res = await post_('publish_now', { ...PIECE, tags: 'books' })
    expect(where(res)).toBe('/modernhaus/article/a-piece-x?done=published_untagged')
  })

  it('a fault on the publish is the fault page, never a success', async () => {
    gateway({ ...ok, [`POST /drafts/${DRAFT_ID}/publish`]: { status: 500 } })
    const res = await post_('publish_now', PIECE)
    expect(res.status).toBe(500)
  })
})

describe('schedule', () => {
  const ok = {
    'POST /drafts': { status: 201, body: { draftId: DRAFT_ID } },
    [`POST /drafts/${DRAFT_ID}/schedule`]: { status: 200, body: { ok: true } },
  }
  const when = (d: string, m: string, y: string, h: string, min: string) => ({
    schedule_day: d, schedule_month: m, schedule_year: y, schedule_hour: h, schedule_minute: min,
  })

  it('reads the boxes as LONDON time — BST in summer, GMT in winter', async () => {
    const f = gateway(ok)
    const res = await post_('schedule', { ...PIECE, ...when('1', '7', '2099', '9', '30') })
    expect(sent(f, `POST /drafts/${DRAFT_ID}/schedule`)).toEqual({ scheduledAt: '2099-07-01T08:30:00.000Z' })
    expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?done=scheduled`)
    const g = gateway(ok)
    await post_('schedule', { ...PIECE, ...when('1', '12', '2099', '9', '30') })
    expect(sent(g, `POST /drafts/${DRAFT_ID}/schedule`)).toEqual({ scheduledAt: '2099-12-01T09:30:00.000Z' })
  })

  it('a time that has passed, or that is no time at all, is refused — saved, never scheduled', async () => {
    for (const [boxes, code] of [
      [when('1', '1', '2020', '9', '0'), 'schedule_past'],
      [when('30', '2', '2099', '9', '0'), 'schedule_invalid'],
      [when('', '2', '2099', '9', '0'), 'schedule_invalid'],
    ] as const) {
      const f = gateway(ok)
      const res = await post_('schedule', { ...PIECE, ...boxes })
      expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?error=${code}`)
      expect(keys(f)).toEqual(['POST /drafts'])
    }
  })
})

describe('london-time', () => {
  it('refuses the spring-forward gap and takes the earlier of the autumn repeat', () => {
    expect(londonToInstant({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 })).toBeNull()
    expect(londonToInstant({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 })?.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(londonToInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 })?.toISOString()).toBe('2026-10-25T02:30:00.000Z')
  })

  it('round-trips any instant on a minute boundary, bar the repeated hour’s second pass', () => {
    for (const iso of ['2026-01-15T12:00:00Z', '2026-06-15T23:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T02:00:00Z']) {
      const at = new Date(iso)
      expect(londonToInstant(londonWall(at))?.toISOString()).toBe(at.toISOString())
    }
    // 01:00 GMT on the autumn Sunday reads 01:00 — which London also showed an
    // hour earlier, in BST. The earlier is the one taken, by design.
    expect(londonToInstant(londonWall(new Date('2026-10-25T01:00:00Z')))?.toISOString()).toBe('2026-10-25T00:00:00.000Z')
  })

  it('five boxes of whole numbers, or nothing', () => {
    expect(wallFromBoxes({ day: '1', month: '7', year: '2099', hour: '09', minute: '05' })).toEqual({ day: 1, month: 7, year: 2099, hour: 9, minute: 5 })
    expect(wallFromBoxes({ day: '1', month: 'July', year: '2099', hour: '9', minute: '0' })).toBeNull()
  })
})

describe('the small parsers', () => {
  it('pounds to pence', () => {
    expect(poundsToPence('')).toBe(0)
    expect(poundsToPence('0.4')).toBe(40)
    expect(poundsToPence('£3')).toBe(300)
    expect(poundsToPence('1.05')).toBe(105)
    expect(poundsToPence('1.005')).toBeNull()
    expect(poundsToPence('-1')).toBeNull()
  })
  it('a tag list', () => {
    expect(tagList(' a, b ,,c,d,e,f')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('draft_delete and unschedule', () => {
  it('delete is its own confirm page first, then one DELETE', async () => {
    const f = gateway({ [`DELETE /drafts/${DRAFT_ID}`]: { status: 200, body: { ok: true } } })
    const res = await post_('draft_delete', { draftId: DRAFT_ID, return: '/modernhaus/write/drafts' })
    expect(keys(f)).toEqual([`DELETE /drafts/${DRAFT_ID}`])
    expect(where(res)).toBe('/modernhaus/write/drafts?done=deleted')
  })
  it('unschedule', async () => {
    const f = gateway({ [`DELETE /drafts/${DRAFT_ID}/schedule`]: { status: 200 } })
    const res = await post_('unschedule', { draftId: DRAFT_ID, return: `/modernhaus/write/${DRAFT_ID}` })
    expect(keys(f)).toEqual([`DELETE /drafts/${DRAFT_ID}/schedule`])
    expect(where(res)).toBe(`/modernhaus/write/${DRAFT_ID}?done=unscheduled`)
  })
})

describe('upload', () => {
  it('renders the gateway’s own address and the line to paste', async () => {
    gateway({ 'POST /media/upload': { status: 201, body: { url: PICTURE } } })
    const res = await post_('upload', { file: PNG() })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`value="![](${PICTURE})"`)
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
  })
  it('no file is said, and nothing is sent', async () => {
    const f = gateway({})
    const res = await post_('upload', {})
    expect(res.status).toBe(400)
    expect(keys(f).filter((k) => k.startsWith('POST'))).toEqual([])
  })
  it('an address the gateway answers that is not http(s) is a fault, never a link', async () => {
    gateway({ 'POST /media/upload': { status: 201, body: { url: 'javascript:alert(1)' } } })
    const res = await post_('upload', { file: PNG() })
    expect(res.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// The pages.
// ---------------------------------------------------------------------------

describe('the writing pages', () => {
  it('compose: a locked post cannot be quoted (404), a plain note lists the cross-post accounts', async () => {
    gateway({ [`GET /thread/${THEIRS.id}`]: thread({ ...THEIRS, rootLocked: true }) })
    const locked = await composeGET(get(`/modernhaus/compose?quote=${THEIRS.id}`), { params: {} })
    expect(locked.status).toBe(404)

    gateway({
      'GET /linked-accounts': {
        status: 200,
        body: {
          accounts: [
            { id: 'la-1', protocol: 'atproto', externalHandle: 'viv.bsky.social', isValid: true, crossPostDefault: true },
            { id: 'la-2', protocol: 'rss', externalHandle: 'x', isValid: true, crossPostDefault: true },
            { id: 'la-3', protocol: 'activitypub', externalHandle: '@v@m', isValid: false, crossPostDefault: true },
          ],
        },
      },
    })
    const html = await (await composeGET(get('/modernhaus/compose'), { params: {} })).text()
    // Matched per attribute, never by order (web-modernhaus.md).
    const box = html.match(/<input[^>]*value="la-1"[^>]*>/)?.[0] ?? ''
    expect(box).toContain('checked=""')
    expect(html).not.toContain('la-2')
    expect(html).not.toContain('la-3')
  })

  it('compose: linked accounts that could not be read are SAID, never shown as none', async () => {
    gateway({ 'GET /linked-accounts': 'throw' })
    const html = await (await composeGET(get('/modernhaus/compose'), { params: {} })).text()
    expect(html).toContain('couldn’t load your other networks just now')
  })

  it('edit: a paid piece whose paid half cannot be read offers NO form (it would publish free)', async () => {
    gateway({
      'GET /articles/my-piece': { status: 200, body: { id: 'a1', dTag: 'my-piece', nostrEventId: 'ev-a', writer: { id: ME.id }, withdrawn: false } },
      'GET /articles/by-event/ev-a': { status: 200, body: { id: 'a1', title: 'T', contentFree: 'free', contentPaywall: null, isPaywalled: true } },
    })
    const res = await writeGET(get('/modernhaus/write?edit=my-piece'), { params: {} })
    const html = await res.text()
    expect(html).toContain('The paid part of this piece couldn’t be loaded')
    expect(html).not.toContain('/modernhaus/do/draft_save')
  })

  it('edit: the piece reassembled at its gate, its tags shown, and no email offered', async () => {
    gateway({
      'GET /articles/my-piece': { status: 200, body: { id: 'a1', dTag: 'my-piece', nostrEventId: 'ev-a', writer: { id: ME.id }, withdrawn: false } },
      'GET /articles/by-event/ev-a': { status: 200, body: { id: 'a1', title: 'T', summary: 'D', contentFree: 'free', contentPaywall: 'paid', isPaywalled: true, pricePence: 40, commentsEnabled: true } },
      'GET /articles/a1/tags': { status: 200, body: { tags: ['books'] } },
    })
    const html = await (await writeGET(get('/modernhaus/write?edit=my-piece'), { params: {} })).text()
    expect(html).toContain(`free\n\n${PAYWALL_GATE_MARKER.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\npaid`)
    expect(html).toContain('value="0.40"')
    expect(html).toContain('value="books"')
    expect(html).toMatch(/<input[^>]*name="dTag"[^>]*value="my-piece"|<input[^>]*value="my-piece"[^>]*name="dTag"/)
    expect(html).not.toContain('name="sendEmail"')
  })

  it('edit: somebody else’s piece is not found', async () => {
    gateway({ 'GET /articles/their-piece': { status: 200, body: { id: 'a2', dTag: 'their-piece', nostrEventId: 'ev', writer: { id: 'other' } } } })
    const res = await writeGET(get('/modernhaus/write?edit=their-piece'), { params: {} })
    expect(res.status).toBe(404)
  })

  it('a scheduled draft offers no Publish now or Schedule, and says how to unschedule', async () => {
    gateway({
      [`GET /drafts/${DRAFT_ID}`]: { status: 200, body: { draftId: DRAFT_ID, title: 'T', content: 'x', dTag: null, publicationId: null, commentsEnabled: true, autoSavedAt: '2026-09-01T10:00:00Z', scheduledAt: '2099-07-01T08:30:00Z', pricePence: null } },
    })
    const html = await (await writeDraftGET(get(`/modernhaus/write/${DRAFT_ID}`), { params: { draftId: DRAFT_ID } })).text()
    expect(html).toContain('09:30') // London time, BST
    expect(html).not.toContain('/modernhaus/do/publish_now')
    expect(html).not.toContain('/modernhaus/do/schedule"')
    expect(html).toContain('/modernhaus/do/unschedule')
  })

  it('preview splits where publish splits, and renders both halves without ornament', async () => {
    gateway({
      [`GET /drafts/${DRAFT_ID}`]: { status: 200, body: { draftId: DRAFT_ID, title: 'T', content: `Free **bit**\n\n${PAYWALL_GATE_MARKER}\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`, pricePence: 40, autoSavedAt: '2026-09-01T10:00:00Z', scheduledAt: null } },
    })
    const html = await (await previewGET(get(`/modernhaus/preview/${DRAFT_ID}`), { params: { draftId: DRAFT_ID } })).text()
    expect(html).toContain('<strong>bit</strong>')
    expect(html).toContain('readers pay 40p to read on')
    expect(html).not.toMatch(/<iframe/)
  })

  it('the drafts list and every writing page wall a signed-out visitor to sign in', async () => {
    gateway({ 'GET /auth/me': { status: 401 } })
    for (const [handler, path] of [
      [draftsGET, '/modernhaus/write/drafts'],
      [composeGET, '/modernhaus/compose'],
      [writeGET, '/modernhaus/write'],
    ] as const) {
      const res = await handler(get(path), { params: {} })
      expect(res.status).toBe(303)
      expect(where(res)).toBe(`/modernhaus/signin?return=${encodeURIComponent(path)}`)
    }
  })

  it('Quote is offered on an open conversation, not on a locked one', async () => {
    gateway({ [`GET /thread/${THEIRS.id}`]: { status: 200, body: { focalId: THEIRS.id, posts: [THEIRS], totalDescendants: 0 } }, 'GET /votes/tally': { status: 200, body: { tallies: {} } }, 'GET /votes/mine': { status: 200, body: { voteCounts: {} } } })
    const open = await (await threadGET(get(`/modernhaus/thread/${THEIRS.id}`), { params: { postId: THEIRS.id } })).text()
    expect(open).toContain(`/modernhaus/compose?quote=${THEIRS.id}`)
    gateway({ [`GET /thread/${THEIRS.id}`]: { status: 200, body: { focalId: THEIRS.id, posts: [{ ...THEIRS, rootLocked: true }], totalDescendants: 0 } }, 'GET /votes/tally': { status: 200, body: { tallies: {} } }, 'GET /votes/mine': { status: 200, body: { voteCounts: {} } } })
    const locked = await (await threadGET(get(`/modernhaus/thread/${THEIRS.id}`), { params: { postId: THEIRS.id } })).text()
    expect(locked).not.toContain('/modernhaus/compose?quote=')
  })
})

// =============================================================================
// A READER (READER-WRITER-SPLIT-ADR §6.3). Every writing page is the one
// explanation and the one press a reader can make; the gateway is asked for
// nothing a writer's page would load, and no writing link is offered.
// =============================================================================

describe('a reader', () => {
  const READER = { ...ME, canWrite: false, writerApplication: null }

  it('meets the explanation on /write, and nothing is loaded for a piece', async () => {
    const f = gateway({ 'GET /auth/me': { status: 200, body: READER } })
    const html = await (await writeGET(get('/modernhaus/write'), { params: {} })).text()
    expect(html).toContain('open to members we have admitted as writers')
    expect(html).toMatch(/action="\/modernhaus\/do\/writer_apply"/)
    expect(html).not.toContain('/modernhaus/do/draft_save')
    expect(html).not.toContain('href="/modernhaus/dashboard"')
    expect(keys(f).filter((k) => k !== 'GET /auth/me' && k !== 'GET /unread-counts')).toEqual([])
  })

  it('a draft address and the drafts list are the same explanation', async () => {
    gateway({ 'GET /auth/me': { status: 200, body: READER } })
    for (const html of [
      await (await writeDraftGET(get(`/modernhaus/write/${DRAFT_ID}`), { params: { draftId: DRAFT_ID } })).text(),
      await (await draftsGET(get('/modernhaus/write/drafts'), { params: {} })).text(),
    ]) {
      expect(html).toMatch(/action="\/modernhaus\/do\/writer_apply"/)
    }
  })

  it('an application already sent is dated, and not offered again', async () => {
    gateway({ 'GET /auth/me': { status: 200, body: { ...READER, writerApplication: { appliedAt: '2026-09-30T12:00:00Z' } } } })
    const html = await (await writeGET(get('/modernhaus/write'), { params: {} })).text()
    expect(html).toContain('Application sent on 30 September 2026.')
    expect(html).not.toContain('writer_apply')
  })

  it('the compose page offers no article', async () => {
    gateway({ 'GET /auth/me': { status: 200, body: READER }, 'GET /linked-accounts': { status: 200, body: { accounts: [] } } })
    const html = await (await composeGET(get('/modernhaus/compose'), { params: {} })).text()
    expect(html).not.toContain('Write an article instead')
    expect(html).toContain('Upload a picture')
  })

  it('writer_apply posts to the route and comes back to the page with a sentence', async () => {
    const f = gateway({ 'POST /writer-applications': { status: 200, body: { appliedAt: '2026-09-30T12:00:00Z' } } })
    const res = await post_('writer_apply', { return: '/modernhaus/write' })
    expect(keys(f)).toContain('POST /writer-applications')
    expect(where(res)).toBe('/modernhaus/write?done=writer_applied')
    expect(outcomeFromQuery(new URLSearchParams('done=writer_applied'))).toMatchObject({ sentence: 'Application sent.' })
  })

  it('a writer pressing it is told so in the route’s own words', async () => {
    gateway({ 'POST /writer-applications': { status: 409, body: { error: 'already_writer', message: 'You can already publish articles.' } } })
    const res = await post_('writer_apply', { return: '/modernhaus/write' })
    expect(where(res)).toBe('/modernhaus/write?error=already_writer')
    expect(outcomeFromQuery(new URLSearchParams('error=already_writer'))).toMatchObject({ sentence: 'You can already publish articles.' })
  })
})
