import type { Post } from '../../src/lib/post/types'

// Fixtures for the modernhaus page sweep. Bodies are HOSTILE where they can be:
// a `javascript:` URL, inline styles and classes, a real provider embed — so the
// sweep is proved on the inputs that need it (MODERNHAUS-ADR §D2.7.1).

export const TOKEN = 'a'.repeat(43)

export function post(over: Partial<Post> & { id: string }): Post {
  const base: Post = {
    id: over.id,
    version: null,
    origin: { protocol: 'rss', uri: 'https://example.com/p', webUrl: 'https://example.com/p', sourceName: 'Example Blog', publication: null },
    author: {
      id: 'author-1',
      accountId: null,
      memberUsername: null,
      displayName: 'Ada',
      handle: 'ada@example.com',
      handleUri: null,
      pubkey: null,
      pipStatus: 'unknown',
    },
    type: 'note',
    accessMode: 'free',
    body: { text: 'plain text https://example.com/x.', html: null, title: null, summary: null, media: [], contentWarning: null, poll: null },
    inReplyTo: null,
    quotes: null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: 'A',
    publishedAt: 1790000000,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: null,
    externalItemId: null,
  }
  return { ...base, ...over, body: { ...base.body, ...(over.body ?? {}) } }
}

export const HOSTILE_HTML =
  '<p style="color:red" class="x">Hello <a href="https://example.com/a" class="y">there</a></p>' +
  '<div class="embed" style="position:relative"><iframe src="https://www.youtube-nocookie.com/embed/abc" style="border:0"></iframe></div>' +
  '<p><iframe src="javascript:alert(1)"></iframe></p>'

export const POSTS: Post[] = [
  post({ id: 'ext-note', body: { html: HOSTILE_HTML } as Post['body'] }),
  post({
    id: 'native-article',
    type: 'article',
    accessMode: 'gated',
    pricePence: 40,
    dTag: 'my-piece',
    origin: { protocol: 'nostr', uri: 'e1', webUrl: null, sourceName: null, publication: null },
    author: {
      id: 'acc-1',
      accountId: 'acc-1',
      displayName: 'Bea',
      handle: 'bea',
      handleUri: null,
      pubkey: 'pk',
      pipStatus: 'unknown',
    },
    body: { title: 'A piece', summary: 'Its summary.' } as Post['body'],
  }),
  post({
    id: 'media',
    body: {
      text: 'look',
      media: [
        { type: 'image', url: 'https://example.com/i.png', alt: 'an image' },
        { type: 'video', url: 'https://example.com/v.mp4' },
        { type: 'image', url: 'javascript:alert(1)' },
        { type: 'link', url: 'data:text/html,hi' },
      ],
      contentWarning: 'spiders',
      poll: { options: [{ title: 'Yes', votesCount: 1 }, { title: 'No', votesCount: 2 }], multiple: false, expiresAt: null, closed: true },
    } as Post['body'],
    quotedPreview: { author: 'Cy', excerpt: 'quoted', url: 'javascript:alert(2)' },
    origin: { protocol: 'atproto', uri: 'at://x', webUrl: 'javascript:alert(3)', sourceName: 'Bluesky', publication: null },
  }),
  post({ id: 'ext-article', type: 'article', body: { title: 'Elsewhere', summary: 'From a blog.' } as Post['body'] }),
  post({ id: 'deleted', isDeleted: true }),
  post({ id: 'muted', isMuted: true }),
]
