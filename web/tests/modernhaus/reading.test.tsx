import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleDoor } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { movedOrder } from '../../src/modernhaus/actions/feeds'
import { CONFIRMS } from '../../src/modernhaus/confirms'
import { modernhausDest } from '../../src/modernhaus/pages/member'
import { LOCKED_CONVERSATION } from '../../src/modernhaus/pages/conversation'
import { outcomeFromQuery } from '../../src/modernhaus/outcomes'
import { replyTargetFromPost } from '../../src/lib/post/reply-target'
import { reportReceipt } from '../../src/content/report'
import { homeGET, threadGET, confirmGET, followGET, feedGET, articleGET } from '../../src/modernhaus/routes'
import type { Post } from '../../src/lib/post/types'
import { deleteHref } from '../../src/modernhaus/post'
import { TOKEN, post } from './fixtures'

// =============================================================================
// E3 — READING (MODERNHAUS-ADR §D2.3, §D2.4), through the real door, the real
// registry and the real page pipeline. Each case asserts what the GATEWAY was
// sent — or that it was sent NOTHING — and where the member was sent, never a
// status alone (testing.md).
// =============================================================================

const ORIGIN = 'http://localhost:3010'
const ME = { id: 'me-1', username: 'viv', displayName: 'Viv', ageDeclaredAt: '2026-01-01T00:00:00Z', pubkey: 'pk-me' }

type Answer = { status: number; body?: unknown } | 'throw'

/** A gateway that answers by `METHOD /path` (query ignored); anything unlisted is a test failure. */
function gateway(answers: Record<string, Answer>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}`
    const a = answers[key] ?? (key === 'GET /unread-counts' ? { status: 200, body: { notificationCount: 0, dmCount: 0 } } : undefined)
    if (a === undefined) throw new Error(`unexpected gateway call ${key}`)
    if (a === 'throw') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const keys = (f: ReturnType<typeof gateway>) =>
  f.mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${new URL(u).pathname.replace(/^\/api\/v1/, '')}`)

function sent(f: ReturnType<typeof gateway>, key: string): unknown {
  const c = f.mock.calls.find(([u, i]) => `${i?.method ?? 'GET'} ${new URL(u).pathname.replace(/^\/api\/v1/, '')}` === key)
  return c ? JSON.parse(c[1]!.body as string) : undefined
}

function post_(action: string, form: Array<[string, string]> | Record<string, string>) {
  const body = new URLSearchParams(Array.isArray(form) ? [['_csrf', TOKEN], ...form] : { _csrf: TOKEN, ...form })
  return handleDoor(
    new Request(`${ORIGIN}/modernhaus/do/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `mh_csrf=${TOKEN}` },
      body: body.toString(),
    }),
    action,
    REGISTRY,
  )
}

const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { cookie: `mh_csrf=${TOKEN}` } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const NATIVE: Post = post({
  id: 'n'.repeat(64),
  version: 'ev-note',
  origin: { protocol: 'nostr', uri: 'ev-note', webUrl: null, sourceName: null, publication: null },
  author: { id: 'acc-bea', accountId: 'acc-bea', displayName: 'Bea', handle: 'bea', handleUri: null, pubkey: 'pk-bea', pipStatus: 'unknown' },
})

const COMMENT: Post = {
  ...NATIVE,
  id: 'c'.repeat(64),
  version: 'ev-comment',
  inReplyTo: NATIVE.id,
  conversation: { rootEventId: 'ev-note', rootKind: 1, commentId: '11111111-1111-4111-8111-111111111111' },
}

// ---------------------------------------------------------------------------

describe('vote', () => {
  it('sends the target as the full site does, and says a capped repeat changed nothing', async () => {
    const gw = gateway({ 'POST /votes': { status: 200, body: { ok: true, counted: false } } })
    const res = await post_('vote', { targetEventId: 'ev-note', targetKind: '1', direction: 'up', return: '/modernhaus/feed/f1' })
    expect(sent(gw, 'POST /votes')).toEqual({ targetEventId: 'ev-note', targetKind: 1, direction: 'up' })
    expect(res.headers.get('location')).toBe('/modernhaus/feed/f1?done=vote_capped')
    gateway({ 'POST /votes': { status: 200, body: { ok: true, counted: true } } })
    const ok = await post_('vote', { targetEventId: 'ev-note', targetKind: '1', direction: 'up', return: '/modernhaus/feed/f1' })
    expect(ok.headers.get('location')).toBe('/modernhaus/feed/f1?done=voted')
  })
})

describe('reply — publishReply, on the server', () => {
  const target = replyTargetFromPost(COMMENT)!

  it('signs the event with the root, p and reply tags, then indexes it against the ROOT with the comment as parent', async () => {
    const gw = gateway({
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-new' } },
      'POST /replies': { status: 201, body: { commentId: 'x' } },
    })
    const res = await post_('reply', {
      content: ' hello ',
      eventId: target.eventId,
      eventKind: String(target.eventKind),
      authorPubkey: target.authorPubkey,
      parentCommentId: target.parentCommentId!,
      parentCommentEventId: target.parentCommentEventId!,
      return: '/modernhaus/thread/abc',
    })
    expect(keys(gw)).toEqual(['POST /sign-and-publish', 'POST /replies'])
    expect(sent(gw, 'POST /sign-and-publish')).toEqual({
      kind: 1,
      content: 'hello',
      tags: [
        ['e', 'ev-note', '', 'root'],
        ['p', 'pk-bea'],
        ['e', 'ev-comment', '', 'reply'],
      ],
    })
    expect(sent(gw, 'POST /replies')).toEqual({
      nostrEventId: 'ev-new',
      targetEventId: 'ev-note',
      targetKind: 1,
      parentCommentId: '11111111-1111-4111-8111-111111111111',
      content: 'hello',
    })
    expect(res.headers.get('location')).toBe('/modernhaus/thread/abc?done=replied')
  })

  it('a refused index re-renders the form with what was typed and the route’s sentence — no redirect', async () => {
    gateway({
      'POST /sign-and-publish': { status: 200, body: { id: 'ev-new' } },
      'POST /replies': { status: 403, body: { error: 'Replies are turned off for this post.' } },
      'GET /auth/me': { status: 200, body: ME },
    })
    const res = await post_('reply', { content: 'my <long> reply', eventId: 'ev-note', eventKind: '1', authorPubkey: 'pk-bea', return: '/modernhaus/thread/abc' })
    const html = await res.text()
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    expect(html).toContain('<p role="status">Replies are turned off for this post.</p>')
    expect(html).toContain('my &lt;long&gt; reply</textarea>')
    expect(html).toContain('href="/modernhaus/thread/abc"')
  })

  it('signed out at the signing step goes to sign-in, and nothing is indexed', async () => {
    const gw = gateway({ 'POST /sign-and-publish': { status: 401 } })
    const res = await post_('reply', { content: 'x', eventId: 'ev-note', eventKind: '1', authorPubkey: 'pk-bea', return: '/modernhaus/thread/abc' })
    expect(keys(gw)).toEqual(['POST /sign-and-publish'])
    expect(res.headers.get('location')).toMatch(/^\/modernhaus\/signin\?return=/)
  })

  it('a fault at the signing step is the fault page, and nothing is indexed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const gw = gateway({ 'POST /sign-and-publish': { status: 500 } })
    const res = await post_('reply', { content: 'x', eventId: 'ev-note', eventKind: '1', authorPubkey: 'pk-bea' })
    expect(res.status).toBe(500)
    expect(keys(gw)).toEqual(['POST /sign-and-publish'])
  })

  it('a form with no target signs nothing', async () => {
    const gw = gateway({})
    const res = await post_('reply', { content: 'x', return: '/modernhaus/thread/abc' })
    expect(gw).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('/modernhaus/thread/abc?error=invalid')
  })
})

describe('external reply', () => {
  it('a reply that never reached its network says so', async () => {
    const gw = gateway({ 'POST /external-items/item-1/reply': { status: 201, body: { crossPost: 'not_sent' } } })
    const res = await post_('external_reply', { itemId: 'item-1', linkedAccountId: 'la-1', content: 'hi', return: '/modernhaus/thread/t' })
    expect(sent(gw, 'POST /external-items/item-1/reply')).toEqual({ linkedAccountId: 'la-1', content: 'hi' })
    expect(res.headers.get('location')).toBe('/modernhaus/thread/t?done=replied_not_sent')
    expect(outcomeFromQuery(new URLSearchParams('done=replied_not_sent'))?.sentence).toMatch(/couldn’t send it/)
  })
})

describe('report', () => {
  it('sends what names the target, and the promise is the priority the SERVER derived', async () => {
    const gw = gateway({ 'POST /reports': { status: 201, body: { priority: 'P0', triageDeadline: 'x' } } })
    const res = await post_('report', { targetPostId: 'p1', targetNostrEventId: 'ev', category: 'csam', notes: '', return: '/modernhaus/feed/f' })
    expect(sent(gw, 'POST /reports')).toEqual({ targetPostId: 'p1', targetNostrEventId: 'ev', category: 'csam' })
    expect(res.headers.get('location')).toBe('/modernhaus/feed/f?done=reported_p0')
    expect(outcomeFromQuery(new URLSearchParams('done=reported_p0'))?.sentence).toBe(reportReceipt('P0'))
  })
})

describe('feed order', () => {
  it('moves one step in the order AS RENDERED, and refuses a move that is no move', () => {
    expect(movedOrder(['a', 'b', 'c'], 'b', 'up')).toEqual(['b', 'a', 'c'])
    expect(movedOrder(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b'])
    expect(movedOrder(['a', 'b', 'c'], 'a', 'up')).toBeNull()
    expect(movedOrder(['a', 'b', 'c'], 'z', 'up')).toBeNull()
    expect(movedOrder(['a', 'a', 'c'], 'c', 'up')).toBeNull()
  })

  it('sends the whole order; a stale list is said, and a bad move sends nothing', async () => {
    const gw = gateway({ 'PUT /workspace/feeds/order': { status: 409, body: { error: 'Your channels have changed somewhere else. Please refresh the page and try again.' } } })
    const res = await post_('feed_move', [['feedId', 'b'], ['direction', 'up'], ['order', 'a'], ['order', 'b'], ['order', 'c']])
    expect(sent(gw, 'PUT /workspace/feeds/order')).toEqual({ feedIds: ['b', 'a', 'c'] })
    expect(res.headers.get('location')).toBe('/modernhaus?error=stale_order')
    const none = gateway({})
    await post_('feed_move', [['feedId', 'a'], ['direction', 'up'], ['order', 'a'], ['order', 'b']])
    expect(none).not.toHaveBeenCalled()
  })

  it('mark-seen sends the server’s token back verbatim', async () => {
    const gw = gateway({ 'POST /workspace/feeds/f1/seen': { status: 200, body: {} } })
    await post_('feed_mark_seen', { feedId: 'f1', asOf: '2026-09-29 07:01:02.123456+00' })
    expect(sent(gw, 'POST /workspace/feeds/f1/seen')).toEqual({ asOf: '2026-09-29 07:01:02.123456+00' })
  })
})

describe('follow — a chosen source, written by the route', () => {
  const WRITER = { id: 'acc-bea', username: 'bea', displayName: 'Bea' }

  it('re-reads the target and adds the account source the browser would; it never writes /follows', async () => {
    const gw = gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /writers/bea': { status: 200, body: WRITER },
      'POST /workspace/feeds/f1/sources': { status: 201, body: { source: { id: 's' }, following: true } },
    })
    const res = await post_('follow', { writer: 'bea', feedId: 'f1', return: '/modernhaus/u/bea' })
    expect(sent(gw, 'POST /workspace/feeds/f1/sources')).toEqual({ sourceType: 'account', accountId: 'acc-bea' })
    expect(keys(gw).some((k) => k.includes('/follows'))).toBe(false)
    expect(res.headers.get('location')).toBe('/modernhaus/u/bea?done=followed')
  })

  it('"a new feed" makes the feed first, named, then adds to it', async () => {
    const gw = gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /writers/bea': { status: 200, body: WRITER },
      'POST /workspace/feeds': { status: 201, body: { feed: { id: 'f-new' } } },
      'POST /workspace/feeds/f-new/sources': { status: 201, body: { source: { id: 's' } } },
    })
    await post_('follow', { writer: 'bea', feedId: 'new', newFeedName: 'Essays' })
    expect(keys(gw).filter((k) => k.startsWith('POST'))).toEqual(['POST /workspace/feeds', 'POST /workspace/feeds/f-new/sources'])
    expect(sent(gw, 'POST /workspace/feeds')).toEqual({ name: 'Essays' })
  })

  it('yourself is nobody to follow: no feed is touched', async () => {
    const gw = gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /writers/viv': { status: 200, body: { id: 'me-1', username: 'viv', displayName: 'Viv' } },
    })
    const res = await post_('follow', { writer: 'viv', feedId: 'f1' })
    expect(keys(gw).some((k) => k.includes('/workspace'))).toBe(false)
    expect(res.headers.get('location')).toBe('/modernhaus?error=not_found')
  })

  it('the route’s refusal travels as its own code', async () => {
    gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /author/xa/profile': {
        status: 200,
        body: { tier: 'A', displayName: 'X', followTarget: { type: 'source', id: 'xa', isFollowing: false, protocol: 'rss', sourceUri: 'https://x.example/feed' } },
      },
      'POST /workspace/feeds/f1/sources': { status: 403, body: { error: 'source_blocked', message: 'no' } },
    })
    const res = await post_('follow', { author: 'xa', feedId: 'f1' })
    expect(res.headers.get('location')).toBe('/modernhaus?error=source_blocked')
  })
})

describe('unfollow everywhere — a partial outcome is not a total one', () => {
  it('one feed failing neither stops the others nor vanishes', async () => {
    const gw = gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /writers/bea': { status: 200, body: { id: 'acc-bea', username: 'bea', displayName: 'Bea' } },
      'GET /workspace/feeds': { status: 200, body: { feeds: [{ id: 'f1' }, { id: 'f2' }] } },
      'GET /workspace/feeds/f1/sources': 'throw',
      'GET /workspace/feeds/f2/sources': { status: 200, body: { sources: [{ id: 'row-2', sourceType: 'account', accountId: 'acc-bea' }] } },
      'DELETE /workspace/feeds/f2/sources/row-2': { status: 200, body: { ok: true } },
      'DELETE /follows/acc-bea': { status: 200, body: { ok: true } },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post_('unfollow_everywhere', { writer: 'bea', return: '/modernhaus/u/bea' })
    expect(keys(gw)).toContain('DELETE /workspace/feeds/f2/sources/row-2')
    expect(keys(gw)).toContain('DELETE /follows/acc-bea')
    expect(res.headers.get('location')).toBe('/modernhaus/u/bea?done=unfollowed_partly')
  })
})

describe('the pages', () => {
  it('the signed-in home is the feed index, and an unknown new-count is said, not zeroed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /workspace/feeds': {
        status: 200,
        body: { feeds: [{ id: 'f2', name: '', sortRank: 2, hidden: false }, { id: 'f1', name: 'Essays', sortRank: 1, hidden: true }] },
      },
      'GET /workspace/feeds/f1/seen': { status: 200, body: { items: [{ id: 'a', isNew: true }, { id: 'b', isNew: false }] } },
      'GET /workspace/feeds/f2/seen': { status: 503 },
    })
    const html = await (await homeGET(get('/modernhaus'), { params: {} })).text()
    expect(html).toContain('>Essays</a> (hidden) — 1 new')
    // The unnamed feed is numbered among the VISIBLE feeds.
    expect(html).toContain('>Channel 1</a> — couldn’t count new posts')
    expect(html.indexOf('Essays')).toBeLessThan(html.indexOf('Channel 1'))
  })

  it('a feed page marks what is new and carries the page’s asOf to mark-seen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /workspace/feeds/f1/items': { status: 200, body: { feed: { id: 'f1', name: 'Essays', hidden: false }, items: [NATIVE], asOf: 'AS-OF-TOKEN' } },
      'GET /workspace/feeds/f1/seen': { status: 200, body: { items: [{ id: NATIVE.id, isNew: true }] } },
      'GET /votes/tally': { status: 200, body: { tallies: { 'ev-note': { upvoteCount: 3, downvoteCount: 1 } } } },
      'GET /votes/mine': { status: 200, body: { voteCounts: { 'ev-note': { upCount: 1, downCount: 0 } } } },
    })
    const html = await (await feedGET(get('/modernhaus/feed/f1'), { params: { feedId: 'f1' } })).text()
    expect(html).toContain(' · new')
    expect(html).toContain('name="asOf" value="AS-OF-TOKEN"')
    // A direction already used is text, not a button.
    expect(html).toContain('Up — yours 3')
    expect(html).toMatch(/<button[^>]*value="down"[^>]*>Down<\/button> 1/)
  })

  it('the thread’s reply form carries replyTargetFromPost’s own fields', async () => {
    gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /thread/c': { status: 200, body: { focalId: COMMENT.id, posts: [NATIVE, COMMENT], totalDescendants: 0 } },
      'GET /votes/tally': { status: 200, body: { tallies: {} } },
      'GET /votes/mine': { status: 200, body: { voteCounts: {} } },
    })
    const html = await (await threadGET(get('/modernhaus/thread/c'), { params: { postId: 'c' } })).text()
    const t = replyTargetFromPost(COMMENT)!
    expect(html).toContain(`name="eventId" value="${t.eventId}"`)
    expect(html).toContain(`name="parentCommentId" value="${t.parentCommentId}"`)
    expect(html).toContain(`name="parentCommentEventId" value="${t.parentCommentEventId}"`)
    expect((html.match(/do\/reply"/g) ?? []).length).toBe(1)
  })

  it('a locked conversation is readable and offers no reply form', async () => {
    gateway({
      'GET /auth/me': { status: 200, body: ME },
      'GET /thread/c': { status: 200, body: { focalId: COMMENT.id, posts: [{ ...COMMENT, rootLocked: true }], totalDescendants: 0 } },
      'GET /votes/tally': { status: 200, body: { tallies: {} } },
      'GET /votes/mine': { status: 200, body: { voteCounts: {} } },
    })
    const html = await (await threadGET(get('/modernhaus/thread/c'), { params: { postId: 'c' } })).text()
    expect(html).toContain(LOCKED_CONVERSATION)
    expect(html).not.toContain('do/reply"')
    expect(html).not.toContain('value="up"')
  })

  it('a paywalled article LOCKED to this viewer shows nothing below its gate (E5: the viewer-scoped answer decides)', async () => {
    const gw = gateway({
      'GET /auth/me': { status: 401 },
      'GET /auth/open': { status: 404 },
      'GET /articles/my-piece': {
        status: 200,
        body: {
          id: 'a1', postId: 'p'.repeat(64), nostrEventId: 'ev-a', dTag: 'my-piece', title: 'T', summary: null, contentFree: '',
          isPaywalled: true, pricePence: 40, publishedAt: null, withdrawn: false,
          writer: { id: 'w1', username: 'bea', displayName: 'Bea', avatar: null, pubkey: 'pk-bea' },
        },
      },
      'GET /replies/ev-a': { status: 200, body: { comments: [], paywallLocked: true, repliesEnabled: true } },
      ['GET /thread/' + 'p'.repeat(64) + '/top']: {
        status: 200,
        body: { posts: [{ ...COMMENT, id: 'r-hidden', body: { ...COMMENT.body, text: 'hidden-reply-text' } }], topLevel: [{ id: 'r-hidden', count: 0, previewIds: [] }], totalReplies: 1 },
      },
    })
    const html = await (await articleGET(get('/modernhaus/article/my-piece'), { params: { dTag: 'my-piece' } })).text()
    expect(keys(gw)).toContain('GET /replies/ev-a')
    // Neither the reply nor the foot's own furniture: nothing below the gate.
    expect(html).not.toContain('hidden-reply-text')
    expect(html).not.toContain('to leave a reply')
  })

  it('a confirm page for an unknown action, or with nothing to confirm, is not found', async () => {
    gateway({ 'GET /auth/me': { status: 200, body: ME } })
    expect((await confirmGET(get('/modernhaus/confirm/account_delete?x=1'), { params: { action: 'account_delete' } })).status).toBe(404)
    gateway({ 'GET /auth/me': { status: 200, body: ME } })
    expect((await confirmGET(get('/modernhaus/confirm/note_delete'), { params: { action: 'note_delete' } })).status).toBe(404)
    gateway({ 'GET /auth/me': { status: 200, body: ME } })
    const ok = await confirmGET(get('/modernhaus/confirm/note_delete?eventId=ev&junk=1&return=/modernhaus/feed/f'), {
      params: { action: 'note_delete' },
    })
    const html = await ok.text()
    expect(html).toContain('name="eventId" value="ev"')
    expect(html).not.toContain('junk')
  })

  it('a delete pressed on the post\'s own page returns home, because that page is gone (E7 smoke)', () => {
    const note = post({ id: 'p/1', version: 'ev1', origin: { protocol: 'nostr', uri: '', webUrl: null, sourceName: null, publication: null } })
    const own = `/modernhaus/thread/${encodeURIComponent('p/1')}`
    const back = (href: string | null) => new URL(href!, 'http://x').searchParams.get('return')
    expect(back(deleteHref(note, own))).toBe('/modernhaus')
    expect(back(deleteHref(note, `${own}?done=voted`))).toBe('/modernhaus')
    // Anywhere else, the delete comes back to where it was pressed.
    expect(back(deleteHref(note, '/modernhaus/thread/p%2F0'))).toBe('/modernhaus/thread/p%2F0')
    expect(back(deleteHref(note, '/modernhaus/feed/f'))).toBe('/modernhaus/feed/f')
  })

  it('the follow page, signed out, is the sign-in wall', async () => {
    gateway({ 'GET /auth/me': { status: 401 } })
    const res = await followGET(get('/modernhaus/follow?writer=bea'), { params: {} })
    expect(res.headers.get('location')).toBe(`/modernhaus/signin?return=${encodeURIComponent('/modernhaus/follow?writer=bea')}`)
  })
})

describe('the confirm registry', () => {
  it('every confirm names a registered action', () => {
    expect(Object.keys(CONFIRMS).length).toBeGreaterThan(0)
    for (const name of Object.keys(CONFIRMS)) expect(REGISTRY[name], name).toBeDefined()
  })
})

describe('where a notification leads, in this register', () => {
  it('maps the full site’s destinations onto modernhaus pages, and the rest to the full site', () => {
    expect(modernhausDest({ kind: 'profile', href: '/bea', focus: null })).toEqual({ href: '/modernhaus/u/bea', fullSite: false })
    expect(modernhausDest({ kind: 'profile', href: '/bea', focus: { postId: 'p1', view: 'posts' } })).toEqual({
      href: '/modernhaus/thread/p1',
      fullSite: false,
    })
    expect(modernhausDest({ kind: 'profile', href: '/author/xa', focus: null })).toEqual({ href: '/modernhaus/author/xa', fullSite: false })
    expect(modernhausDest({ kind: 'url', href: '/article/my-piece#reply-abc-1' })).toEqual({
      href: '/modernhaus/article/my-piece?focus=abc-1#reply-abc-1',
      fullSite: false,
    })
    // E6: the overlays are pages here now.
    expect(modernhausDest({ kind: 'url', href: '/reader?overlay=messages' })).toEqual({ href: '/modernhaus/messages', fullSite: false })
    expect(modernhausDest({ kind: 'url', href: '/reader?overlay=messages&conversation=0f0e-1' })).toEqual({
      href: '/modernhaus/messages/0f0e-1',
      fullSite: false,
    })
    expect(modernhausDest({ kind: 'url', href: '/reader?overlay=dashboard&tab=proposals' })).toEqual({ href: '/modernhaus/dashboard/offers', fullSite: false })
    expect(modernhausDest({ kind: 'url', href: '/subscribe/CODE' })).toEqual({ href: '/modernhaus/subscribe/CODE', fullSite: false })
    // Anything this register does not have still goes to the full site.
    expect(modernhausDest({ kind: 'url', href: '/reader?overlay=vouches' })).toEqual({ href: '/reader?overlay=vouches', fullSite: true })
    expect(modernhausDest({ kind: 'url', href: '//evil.example' })).toBeNull()
    expect(modernhausDest({ kind: 'none' })).toBeNull()
  })
})
