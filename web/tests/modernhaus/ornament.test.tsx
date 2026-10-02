import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { renderHtml } from '../../src/modernhaus/page'
import { Document, PostForm, type Viewer } from '../../src/modernhaus/html'
import { stripOrnament } from '../../src/modernhaus/html-pass'
import { renderMarkdown } from '../../src/lib/markdown'
import { safeHttpUrl } from '../../src/lib/external-links'
import { LEGAL_DOCS } from '../../src/content/legal/generated'
import { HomePage, AboutPage, LegalPage } from '../../src/modernhaus/pages/public'
import { ArticlePage, ArticleNotHerePage, ReadPage } from '../../src/modernhaus/pages/reading'
import { ProfilePage, AuthorPage } from '../../src/modernhaus/pages/people'
import { TagPage, SearchPage, FormulaPage } from '../../src/modernhaus/pages/finding'
import { SigninPage, VerifyPage, SignupPage, AgePage, WaitlistPage } from '../../src/modernhaus/pages/auth'
import type { ArticleMetadata } from '../../src/lib/api/articles'
import type { WriterProfile } from '../../src/lib/api/writers'
import type { FeedLink } from '../../src/lib/api/formulas'
import type { Notification } from '../../src/lib/api/notifications'
import type { LinkedAccount } from '../../src/lib/api/linked-accounts'
import { FeedIndexPage, FeedPage } from '../../src/modernhaus/pages/feeds'
import { ThreadPage, ArticleFoot, ReplyAgainPage } from '../../src/modernhaus/pages/conversation'
import { FollowPage, ReportPage, ConfirmPage, NotificationsPage, SourcePage } from '../../src/modernhaus/pages/member'
import { CONFIRMS } from '../../src/modernhaus/confirms'
import {
  ComposePage,
  WritePage,
  DraftsPage,
  PreviewPage,
  UploadPage,
  PaidHalfUnavailable,
  NEW_DRAFT,
  EMPTY_SCHEDULE,
} from '../../src/modernhaus/pages/writing'
import { REGISTRY } from '../../src/modernhaus/actions'
import { ArticleViewPage, type ArticleView } from '../../src/modernhaus/article-view'
import {
  LedgerPage,
  ReceiptPage,
  OfferPage,
  OfferSignInPage,
  OfferUnavailablePage,
  MoneySettingsPage,
  SubscribeRow,
} from '../../src/modernhaus/pages/money'
import type { LedgerData } from '../../src/modernhaus/money-loaders'
import { mapUnlockError } from '../../src/lib/unlock-errors'
import type { ItemActions } from '../../src/modernhaus/post'
import type { Post } from '../../src/lib/post/types'
import { POSTS, HOSTILE_HTML, TOKEN, post } from './fixtures'
import { InboxPage, MessageThreadPage, NewMessagePage } from '../../src/modernhaus/pages/messages'
import { RelationControls, ProfileSocial } from '../../src/modernhaus/pages/social'
import {
  SettingsIndexPage,
  AccountSettingsPage,
  DeleteAccountPage,
  NetworksPage,
  FollowImportLookupPage,
  FollowImportStatusPage,
  PrivacyPage,
  NotificationPrefsPage,
} from '../../src/modernhaus/pages/settings'
import { LibraryPage, HistoryPage } from '../../src/modernhaus/pages/library'
import { DashboardPage, ArticleManagePage, PricingPage, OffersPage, SubscribersPage, EMPTY_OFFER } from '../../src/modernhaus/pages/dashboard'
import { FeedSettingsPage, ResolvePage } from '../../src/modernhaus/pages/feed-settings'
import { AppealPage, AppealFiledPage, ExportPage, ExportRefusedPage } from '../../src/modernhaus/pages/rights'
import type { AccountFacts } from '../../src/modernhaus/settings-loaders'
import { WriterAccessPage } from '../../src/modernhaus/pages/writer-access'

// =============================================================================
// ZERO ORNAMENT (MODERNHAUS-ADR §D1.9). Every page body, rendered from
// fixtures inside the real shell, and swept for everything this register must
// never emit: a script, a stylesheet, a `style` or `class` attribute, an inline
// event handler, an iframe. Every POST form carries the CSRF field, and every
// href/src is relative or an http(s) URL that passed `safeHttpUrl`.
//
// The fixtures are hostile on purpose (fixtures.tsx): a real provider embed
// rendered by `renderMarkdown`, stored HTML with styles and an iframe, and
// `javascript:` URLs in every URL-shaped field — so the sweep is proved on the
// inputs that need it, not on clean ones.
// =============================================================================

const MEMBER: Viewer = { id: 'v1', username: 'viv', displayName: 'Viv', ageDeclaredAt: '2026-01-01T00:00:00Z', pubkey: 'pk-viv' }
// E5: a member whose card declined and whose texts moved, for the money pages.
const PAYER: Viewer = {
  ...MEMBER,
  money: { hasPaymentMethod: true, cardActionRequiredAt: '2026-09-01T00:00:00Z', freeAllowanceRemainingPence: 120, stripeConnectKycComplete: true },
  terms: { reader: { version: '1.0', current: '2.0', isCurrent: false }, writer: { version: null, current: '2.1', isCurrent: false } },
  // A writer, so the Connect half of the money page renders and is swept.
  canWrite: true,
}
const NEW_READER: Viewer = {
  ...MEMBER,
  money: { hasPaymentMethod: false, cardActionRequiredAt: null, freeAllowanceRemainingPence: 0, stripeConnectKycComplete: false },
  terms: PAYER.terms,
}

// E3 fixtures: a native note by the viewer (delete, no report), one by somebody
// else (votes), a comment, and an external post the viewer can interact back
// with — its like/repost are `formaction` buttons, and its poll is open.
const OWN: Post = post({
  id: 'own',
  version: 'ev-own',
  origin: { protocol: 'nostr', uri: 'ev-own', webUrl: null, sourceName: null, publication: null },
  author: { id: 'v1', accountId: 'v1', displayName: 'Viv', handle: 'viv', handleUri: null, pubkey: 'pk-viv', pipStatus: 'unknown' },
})
const THEIRS: Post = { ...OWN, id: 'theirs', version: 'ev-theirs', author: { ...OWN.author, id: 'b1', accountId: 'b1', handle: 'bea', displayName: 'Bea', pubkey: 'pk-bea' } }
const COMMENT: Post = {
  ...THEIRS,
  id: 'comment',
  version: 'ev-c',
  inReplyTo: 'theirs',
  conversation: { rootEventId: 'ev-theirs', rootKind: 1, commentId: '11111111-1111-4111-8111-111111111111' },
}
const EXTERNAL: Post = post({
  id: 'ext',
  externalItemId: 'item-1',
  externalSourceId: 'src-1',
  origin: { protocol: 'activitypub', uri: 'https://m.example/1', webUrl: 'javascript:alert(9)', sourceName: 'Mastodon', publication: null },
  body: {
    html: HOSTILE_HTML,
    poll: { options: [{ title: '<b>Yes</b>', votesCount: 1 }, { title: 'No', votesCount: 0 }], multiple: false, expiresAt: null, closed: false },
  } as Post['body'],
})
const LINKED: LinkedAccount[] = [
  { id: 'la-1', protocol: 'activitypub', externalId: 'x', externalHandle: '@viv@m.example', instanceUrl: null, isValid: true, crossPostDefault: false, tokenExpiresAt: null, createdAt: '2026-01-01' },
]
const ACTIONS: ItemActions = {
  viewer: MEMBER,
  csrf: TOKEN,
  back: '/modernhaus/feed/f1',
  votes: { tally: { 'ev-theirs': { upvoteCount: 2, downvoteCount: 0 } }, mine: { 'ev-theirs': { upCount: 1, downCount: 0 } } },
  linked: LINKED,
  newIds: new Set(['theirs']),
}
const E3_POSTS = [OWN, THEIRS, COMMENT, EXTERNAL, ...POSTS]

const NOTIFS: Notification[] = [
  { id: 'n1', type: 'new_reply', read: false, createdAt: '2026-09-01T10:00:00Z', actor: { id: 'a', username: 'bea', displayName: '<b>Bea</b>', avatar: null } as never, article: { id: 'a1', title: 'A "piece"', slug: 'my-piece', writerUsername: 'viv' }, note: null, comment: { id: 'c1', content: 'nice <script>x</script>' }, parentComment: null, publication: null },
  { id: 'n2', type: 'new_follower', read: true, createdAt: '2026-09-01T10:00:00Z', actor: { id: 'a', username: 'bea', displayName: 'Bea', avatar: null } as never, article: null, note: null, comment: null, parentComment: null, publication: null },
  { id: 'n3', type: 'new_message', read: false, createdAt: '2026-09-01T10:00:00Z', actor: null, article: null, note: null, comment: null, parentComment: null, publication: null, conversationId: 'cv' },
  { id: 'n4', type: 'cross_post_failed', read: false, createdAt: '2026-09-01T10:00:00Z', actor: { id: 'v1', username: 'viv', displayName: 'Viv', avatar: null } as never, article: null, note: null, comment: null, parentComment: null, publication: null, crossPostFailures: [{ protocol: 'atproto', error: 'reconnect' }] },
  { id: 'n5', type: 'external_reply', read: false, createdAt: '2026-09-01T10:00:00Z', actor: null, article: null, note: null, comment: null, parentComment: null, publication: null, external: { itemId: 'i', protocol: 'atproto', authorName: 'Ext', authorHandle: null, authorAvatar: null, authorId: 'xa', excerpt: 'hello' } } as Notification,
]

const WRITER: WriterProfile = {
  id: 'w1',
  pubkey: 'pk',
  username: 'bea',
  displayName: 'Bea',
  bio: 'Writes.\n\nA lot.',
  avatar: null,
  hostingType: 'custodial',
  subscriptionPricePence: 500,
  annualDiscountPct: 0,
  showCommissionButton: false,
  articleCount: 1,
  hasPaywalledArticle: true,
  noteCount: 0,
  followerCount: 2,
  followingCount: 1,
  presences: [
    { protocol: 'atproto', handle: 'bea.bsky.social', externalUrl: 'https://bsky.app/profile/bea.bsky.social' },
    { protocol: 'activitypub', handle: 'bea@x', externalUrl: 'javascript:alert(1)' },
  ],
}

const ARTICLE: ArticleMetadata = {
  id: 'a1',
  postId: 'native-article',
  nostrEventId: 'e1',
  dTag: 'my-piece',
  title: 'A piece',
  slug: 'a-piece',
  summary: 'The dek.',
  contentFree: 'x',
  wordCount: 100,
  isPaywalled: true,
  pricePence: 40,
  gatePositionPct: 50,
  vaultEventId: null,
  coverImageUrl: null,
  publishedAt: '2026-09-01T10:00:00Z',
  writerSpendThisMonthPence: null,
  withdrawn: true,
  writer: { id: 'w1', username: 'bea', displayName: 'Bea', avatar: null, pubkey: 'pk' },
  publication: null,
}

const LINK: FeedLink = {
  id: 'l1',
  token: 'tok',
  url: 'https://all.haus/f/tok',
  createdAt: '2026-09-01T00:00:00Z',
  name: 'Reading',
  appearance: {},
  author: { displayName: 'Bea', username: 'bea' },
  sourceCount: 2,
  excludedCount: 1,
  refusal: null,
  maxSources: 50,
  revoked: false,
  isDefaultSeed: false,
  gone: false,
  sources: [
    { position: 0, kind: 'account', protocol: null, label: 'Bea', avatar: null },
    { position: 1, kind: 'external_source', protocol: 'rss', label: 'A blog', avatar: null },
  ],
}

async function pages(): Promise<Array<[string, ReactElement]>> {
  const freeHtml = stripOrnament(
    await renderMarkdown(
      'Intro paragraph.\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n![alt text](https://example.com/p.png "A caption")\n\n[bad](javascript:alert(1))',
    ),
  )
  return [
    ['home signed out', <HomePage viewer={null} />],
    ['feed index', <FeedIndexPage csrf={TOKEN} rows={[
      { feed: { id: 'f1', name: '<i>Essays</i>', sortRank: 1, hidden: false, createdAt: '', updatedAt: '', sourceCount: 1, fromStarter: false }, newCount: 2 },
      { feed: { id: 'f2', name: '', sortRank: 2, hidden: true, createdAt: '', updatedAt: '', sourceCount: 0, fromStarter: false }, newCount: null },
    ]} />],
    ['feed index, empty', <FeedIndexPage csrf={TOKEN} rows={[]} />],
    ['feed', <FeedPage feed={{ id: 'f1', name: 'Essays', sortRank: 1, hidden: false, createdAt: '', updatedAt: '', sourceCount: 1, fromStarter: false }} items={E3_POSTS} next="/modernhaus/feed/f1?cursor=c" asOf="t" newKnown={false} actions={ACTIONS} />],
    ['feed, votes unavailable', <FeedPage feed={{ id: 'f1', name: '', sortRank: 1, hidden: true, createdAt: '', updatedAt: '', sourceCount: 1, fromStarter: false }} items={E3_POSTS} next={null} asOf="t" newKnown actions={{ ...ACTIONS, votes: { tally: null, mine: null }, linked: null }} />],
    ['thread, native', <ThreadPage ancestors={[THEIRS]} focal={COMMENT} replies={[OWN, { ...THEIRS, id: 'r2', inReplyTo: 'theirs' }]} totalDescendants={2} hydrating={false} next="/modernhaus/thread/comment?replyCursor=c" self="/modernhaus/thread/comment" viewer={MEMBER} csrf={TOKEN} votes={ACTIONS.votes} linked={[]} />],
    ['thread, external', <ThreadPage ancestors={[]} focal={EXTERNAL} replies={[]} totalDescendants={0} hydrating self="/modernhaus/thread/ext" next={null} viewer={MEMBER} csrf={TOKEN} votes={{ tally: null, mine: null }} linked={LINKED} />],
    ['thread, locked', <ThreadPage ancestors={[]} focal={{ ...COMMENT, rootLocked: true }} replies={[]} totalDescendants={0} hydrating={false} self="/modernhaus/thread/c" next={null} viewer={MEMBER} csrf={TOKEN} votes={ACTIONS.votes} linked={[]} />],
    ['article foot', <ArticleFoot target={{ eventId: 'ev-a', eventKind: 30023, authorPubkey: 'pk-bea', authorName: 'Bea' }} self="/modernhaus/article/my-piece" viewer={MEMBER} csrf={TOKEN} repliesEnabled posts={new Map([[COMMENT.id, COMMENT], [OWN.id, OWN]])} topLevel={[{ id: COMMENT.id, count: 4, previewIds: [OWN.id] }]} totalReplies={5} next="/modernhaus/article/my-piece?replies=10" votes={ACTIONS.votes} />],
    ['article foot, closed', <ArticleFoot target={null} self="/modernhaus/article/my-piece" viewer={null} csrf={TOKEN} repliesEnabled={false} posts={new Map()} topLevel={[]} totalReplies={0} next={null} votes={{ tally: null, mine: null }} />],
    ['reply again', <ReplyAgainPage csrf={TOKEN} back="/modernhaus/thread/c" draft={'"><script>x</script>'} native={{ eventId: 'ev', eventKind: 1, authorPubkey: 'pk', authorName: '' }} external={{ itemId: 'i', linkedAccountId: 'la' }} />],
    ['follow', <FollowPage csrf={TOKEN} subject={{ kind: 'writer', username: 'bea' }} name="Bea" home="/modernhaus/u/bea" back="/modernhaus/u/bea" intoFeed={null} feeds={[
      { feed: { id: 'f1', name: 'Essays', sortRank: 1, hidden: false, createdAt: '', updatedAt: '', sourceCount: 1, fromStarter: false }, row: 'row-1' },
      { feed: { id: 'f2', name: '', sortRank: 2, hidden: true, createdAt: '', updatedAt: '', sourceCount: 0, fromStarter: false }, row: null },
      { feed: { id: 'f3', name: 'Later', sortRank: 3, hidden: false, createdAt: '', updatedAt: '', sourceCount: 0, fromStarter: false }, row: 'unknown' },
    ]} />],
    ['follow, into a feed', <FollowPage csrf={TOKEN} subject={{ kind: 'source', id: 's1' }} name="A blog" home="/modernhaus/source/s1" back="/modernhaus/feed/f2" intoFeed="f2" feeds={[
      { feed: { id: 'f2', name: 'Blogs', sortRank: 1, hidden: false, createdAt: '', updatedAt: '', sourceCount: 0, fromStarter: false }, row: null },
    ]} />],
    ['report', <ReportPage csrf={TOKEN} target={{ kind: 'post', postId: 'p1', eventId: 'ev' }} back="/modernhaus/feed/f1" />],
    ...Object.entries(CONFIRMS).map(([name, spec]): [string, ReactElement] => [`confirm ${name}`, <ConfirmPage csrf={TOKEN} action={name} spec={spec} values={{ [spec.fields[0]]: '"><x>' }} back="/modernhaus" />]),
    ['notifications', <NotificationsPage csrf={TOKEN} viewer={MEMBER} notifications={NOTIFS} next="/modernhaus/notifications?cursor=c" self="/modernhaus/notifications" />],
    ['notifications, none', <NotificationsPage csrf={TOKEN} viewer={MEMBER} notifications={[]} next={null} self="/modernhaus/notifications" />],
    ['source', <SourcePage source={{ id: 's1', protocol: 'rss', sourceUri: 'https://blog.example/feed', displayName: 'A blog', description: 'About <b>it</b>', followTarget: { type: 'source', id: 's1', isFollowing: false } }} sourceId="s1" items={E3_POSTS} next={null} actions={ACTIONS} />],
    ['about', <AboutPage figures={null} />],
    ...LEGAL_DOCS.map((d): [string, ReactElement] => [`legal ${d.slug}`, <LegalPage doc={d} />]),
    ['article', <ArticlePage article={ARTICLE} freeHtml={freeHtml} />],
    ['article not here', <ArticleNotHerePage />],
    ['read text', <ReadPage post={POSTS[3]} sourceUrl="https://example.com/p" extracted={{ kind: 'text', html: stripOrnament(HOSTILE_HTML) }} />],
    ['read unavailable', <ReadPage post={post({ id: 'r', type: 'article', body: { title: 'T', html: HOSTILE_HTML } as never })} sourceUrl={null} extracted={{ kind: 'unavailable' }} />],
    ['read members only', <ReadPage post={POSTS[3]} sourceUrl="https://example.com/p" extracted={{ kind: 'members_only' }} />],
    ['profile articles', <ProfilePage writer={WRITER} next="/modernhaus/u/bea?view=articles&offset=20" list={{ view: 'articles', items: [{ dTag: 'my-piece', title: 'A piece', summary: 'S', isPaywalled: true, publishedAt: '2026-09-01T10:00:00Z' }] }} />],
    ['profile notes', <ProfilePage writer={WRITER} next={null} list={{ view: 'notes', items: [{ id: 'n', content: 'a note https://example.com', publishedAt: '2026-09-01T10:00:00Z', quotedExcerpt: 'q' }] }} />],
    ['profile replies', <ProfilePage writer={WRITER} next={null} list={{ view: 'replies', items: [{ id: 'r', content: 'hi', publishedAt: '2026-09-01T10:00:00Z', isDeleted: false, articleTitle: 'A piece', parentAuthorDisplayName: 'Cy', parentAuthorUsername: 'cy' }] }} />],
    ['profile followers', <ProfilePage writer={WRITER} next={null} list={{ view: 'followers', total: 1, items: [{ id: 'p', username: 'cy', displayName: null }] }} />],
    ['author', <AuthorPage authorId="author-1" profile={{ tier: 'A', displayName: 'Ada', handle: '@ada', bio: 'b', externalUrl: 'javascript:alert(1)', website: 'https://ada.example' }} posts={POSTS} next="/modernhaus/author/author-1?cursor=c" hydrating />],
    ['tag', <TagPage posts={POSTS} total={6} next={null} />],
    ['search articles', <SearchPage q="pi" type="articles" tags={[{ name: 'books', count: 3 }]} next="/modernhaus/search?q=pi&type=articles&offset=20" results={{ kind: 'articles', hits: [{ id: 'a', dTag: 'my-piece', title: 'A piece', summary: null, isPaywalled: false, publishedAt: '2026-09-01T10:00:00Z', writer: { username: 'bea', displayName: null } }] }} />],
    ['search writers', <SearchPage q="be" type="writers" tags="unavailable" next={null} results={{ kind: 'writers', hits: [{ id: 'w', username: 'bea', displayName: 'Bea', bio: 'b' }] }} />],
    ['search refused', <SearchPage q="b" type="articles" tags={null} next={null} results={{ kind: 'refused', sentence: 'Please type at least two characters to search.' }} />],
    ['formula', <FormulaPage link={LINK} twin="/f/tok" />],
    ['formula refused', <FormulaPage link={{ ...LINK, refusal: 'too_large' }} twin="/f/tok" />],
    ['formula revoked', <FormulaPage link={{ ...LINK, revoked: true }} twin="/f/tok" />],
    ['formula gone', <FormulaPage link={{ ...LINK, gone: true }} twin="/f/tok" />],
    ['signin', <SigninPage csrf={TOKEN} arrival="my-piece" sent={false} canSignUp />],
    ['signin, waiting list only', <SigninPage csrf={TOKEN} arrival={null} sent={false} canSignUp={false} />],
    ['signin, link sent', <SigninPage csrf={TOKEN} arrival={null} sent canSignUp={false} />],
    ['verify', <VerifyPage csrf={TOKEN} token="t0k" arrival="my-piece" failed={false} />],
    ['verify, no token', <VerifyPage csrf={TOKEN} token={null} arrival={null} failed={false} />],
    ['verify, expired', <VerifyPage csrf={TOKEN} token={null} arrival={null} failed />],
    // Typed input comes back into the form on a refusal, so it is hostile here.
    ['signup', <SignupPage csrf={TOKEN} next="/modernhaus/tag/x" values={{ email: '"><script>x</script>', displayName: '<b style="x">', dob: { day: '1', month: '" onfocus="x', year: '1990' } }} />],
    ['age', <AgePage csrf={TOKEN} next={null} values={{ day: '', month: '', year: '' }} />],
    ['waitlist', <WaitlistPage csrf={TOKEN} fromBeta joined={false} />],
    ['waitlist, joined', <WaitlistPage csrf={TOKEN} fromBeta={false} joined />],
    // E4 — writing. Typed input comes back into these forms, so it is hostile.
    ['compose', <ComposePage csrf={TOKEN} quote={null} back="/modernhaus/feed/f1" crossPost={[{ ...LINKED[0], crossPostDefault: true }, { ...LINKED[0], id: 'la-2', protocol: 'atproto', externalHandle: '<b>x</b>' }]} />],
    ['compose, networks unavailable', <ComposePage csrf={TOKEN} quote={null} back={null} crossPost={null} draft={'"><script>x</script>'} pictureUrl="javascript:alert(1)" />],
    ['compose, quote', <ComposePage csrf={TOKEN} quote={THEIRS} back="/modernhaus/thread/t" crossPost={[]} pictureUrl="https://all.haus/media/a.webp" ticked={['la-1']} />],
    ['write, new', <WritePage csrf={TOKEN} values={{ title: '"><x>', dek: '<b>', content: '<!-- paywall-gate -->\n<script>x</script>', price: '" onfocus="x', commentsEnabled: true, tags: 'a, b', sendEmail: true, schedule: { ...EMPTY_SCHEDULE, day: '"><x>' } }} draft={NEW_DRAFT} />],
    ['write, a draft', <WritePage csrf={TOKEN} values={{ title: 'T', dek: '', content: 'x', price: '0.40', commentsEnabled: false, tags: '', sendEmail: false, schedule: EMPTY_SCHEDULE }} draft={{ ...NEW_DRAFT, draftId: 'd1', savedAt: '2026-09-01T10:00:00Z', cover: 'https://example.com/c.png' }} termsRefused />],
    ['write, scheduled', <WritePage csrf={TOKEN} values={{ title: 'T', dek: '', content: 'x', price: '', commentsEnabled: true, tags: '', sendEmail: true, schedule: EMPTY_SCHEDULE }} draft={{ ...NEW_DRAFT, draftId: 'd1', scheduledAt: '2099-07-01T08:30:00Z' }} />],
    ['write, an edit', <WritePage csrf={TOKEN} values={{ title: 'T', dek: '', content: 'x', price: '', commentsEnabled: true, tags: 'books', sendEmail: false, schedule: EMPTY_SCHEDULE }} draft={{ ...NEW_DRAFT, dTag: 'my-piece', isEdit: true }} />],
    ['write, a publication draft', <WritePage csrf={TOKEN} values={{ title: 'T', dek: '', content: 'x', price: '', commentsEnabled: true, tags: '', sendEmail: true, schedule: EMPTY_SCHEDULE }} draft={{ ...NEW_DRAFT, draftId: 'd1', publicationId: 'p1' }} />],
    ['drafts', <DraftsPage csrf={TOKEN} drafts={[
      { draftId: 'd1', title: '<i>T</i>', dTag: null, publicationId: null, autoSavedAt: '2026-09-01T10:00:00Z', scheduledAt: '2099-07-01T08:30:00Z' },
      { draftId: 'd2', title: null, dTag: 'my-piece', publicationId: 'p1', autoSavedAt: '2026-09-01T10:00:00Z', scheduledAt: null },
    ]} />],
    ['drafts, none', <DraftsPage csrf={TOKEN} drafts={[]} />],
    ['preview', <PreviewPage draftId="d1" title="T" dek="<b>D</b>" savedAt="2026-09-01T10:00:00Z" byline="Viv" freeHtml={freeHtml} paid={{ html: stripOrnament(HOSTILE_HTML), pricePence: 40 }} />],
    ['preview, no price yet', <PreviewPage draftId="d1" title="T" dek={null} savedAt="2026-09-01T10:00:00Z" byline="Viv" freeHtml={freeHtml} paid={{ html: '<p>paid</p>', pricePence: null }} />],
    ['upload', <UploadPage csrf={TOKEN} />],
    ['upload, done', <UploadPage csrf={TOKEN} url="https://all.haus/media/a.webp" />],
    ['upload, refused', <UploadPage csrf={TOKEN} url="javascript:alert(1)" refused="Unsupported file type" />],
    ['paid half unavailable', <PaidHalfUnavailable />],
    // E5 — money. Hostile where it can be: stored descriptions and names, a
    // `javascript:` link off the statement, and a paid half with an embed.
    ...moneyPages(freeHtml),
    // E6 — the rest. Hostile where it can be: stored names, a message body
    // carrying a link and markup, typed input coming back into forms.
    ...restPages(),
    // The one form primitive, so the CSRF sweep below has a form to find.
    ['post form', <PostForm action="noop" csrf={TOKEN}><button>Go</button></PostForm>],
  ]
}

function moneyPages(freeHtml: string): Array<[string, ReactElement]> {
  const view = (over: Partial<ArticleView>): ArticleView => ({
    article: { ...ARTICLE, withdrawn: false, writer: { ...ARTICLE.writer, subscriptionPricePence: 500 } },
    freeHtml,
    paid: { kind: 'locked' },
    convo: { kind: 'locked' },
    signupOffer: null,
    subscribed: false,
    ...over,
  })
  const self = '/modernhaus/article/my-piece'
  const ledger: LedgerData = {
    tab: { tabBalancePence: 340, refundDuePence: 120, freeAllowanceRemainingPence: 100, freeAllowanceTotalPence: 500 },
    earnings: { pendingTransferPence: 1200, grossPence: 5000, feePence: 400, allowanceCoveredPence: 80, allowanceReadCount: 2 },
    statement: {
      entries: [
        { id: 's1', date: '2026-09-01T10:00:00Z', type: 'settlement', category: 'settlement', description: '<b>Settled</b>', amount_pence: 800, link: null, ref_id: 'set-1' },
        { id: 'r1', date: '2026-09-01T10:00:00Z', type: 'debit', category: 'article_read', description: 'A "piece"', amount_pence: 40, link: '/article/my-piece', ref_id: null },
        { id: 'r2', date: 'nonsense', type: 'debit', category: 'free_read', description: 'x', amount_pence: 0, link: 'javascript:alert(1)', ref_id: null },
      ],
      totalEntries: 60,
      hasMore: true,
    },
    subscriptions: [
      { id: 'sub-1', writerId: 'w1', writerUsername: 'bea', writerDisplayName: '<i>Bea</i>', writerAvatar: null, pricePence: 500, status: 'active', autoRenew: true, currentPeriodEnd: '2026-10-01T00:00:00Z', startedAt: '', cancelledAt: null, hidden: false, notifyOnPublish: true },
      { id: 'sub-2', writerId: 'w2', writerUsername: 'cy', writerDisplayName: null, writerAvatar: null, pricePence: 300, status: 'cancelled', autoRenew: false, currentPeriodEnd: '2026-10-01T00:00:00Z', startedAt: '', cancelledAt: '', hidden: true, notifyOnPublish: false },
    ],
    offset: 0,
    freeReads: false,
  }
  const offer = { id: 'o1', label: '<b>Half off</b>', mode: 'code' as const, isComp: false, discountPct: 50, durationMonths: 3, writerId: 'w1', writerUsername: 'bea', writerDisplayName: 'Bea', standardPricePence: 500, discountedPricePence: 250 }
  const prefs = { cadence: 'weekly' as const, thresholdPence: 2500, platformThresholdPence: 1000, lastPaidAt: null }
  return [
    ['article gate, signed out', <ArticleViewPage view={view({ signupOffer: { freeAllowancePence: 500, arrivalGiftCapPence: 200 } })} viewer={null} csrf={TOKEN} self={self} askSubscribeTerms={false} />],
    ['article gate, member', <ArticleViewPage view={view({})} viewer={PAYER} csrf={TOKEN} self={self} askSubscribeTerms={false} />],
    ['article gate, no card, card refused', <ArticleViewPage view={view({ paid: { kind: 'refused', view: mapUnlockError(402, { error: 'free_allowance_exhausted' }) } })} viewer={NEW_READER} csrf={TOKEN} self={self} askSubscribeTerms={false} cardFix />],
    ['article gate, terms', <ArticleViewPage view={view({ paid: { kind: 'refused', view: mapUnlockError(403, { error: 'reader_terms_required' }) } })} viewer={PAYER} csrf={TOKEN} self={self} askSubscribeTerms />],
    ['article gate, terms unknown', <ArticleViewPage view={view({ paid: { kind: 'terms_refused', sentence: 'moved' } })} viewer={MEMBER} csrf={TOKEN} self={self} askSubscribeTerms={false} />],
    ['article gate, undelivered', <ArticleViewPage view={view({ paid: { kind: 'undelivered', sentence: 'try again' }, convo: { kind: 'unavailable' }, subscribed: null })} viewer={PAYER} csrf={TOKEN} self={self} askSubscribeTerms={false} />],
    ['article, opened', <ArticleViewPage view={view({ paid: { kind: 'open', html: stripOrnament(HOSTILE_HTML) + freeHtml, allowanceSpent: true }, convo: { kind: 'open', repliesEnabled: true, posts: new Map([[COMMENT.id, COMMENT]]), topLevel: [{ id: COMMENT.id, count: 0, previewIds: [] }], totalReplies: 1, nextOffset: 10, votes: ACTIONS.votes } })} viewer={NEW_READER} csrf={TOKEN} self={self} askSubscribeTerms={false} />],
    ['ledger', <LedgerPage data={ledger} viewer={{ ...PAYER, money: { ...PAYER.money!, cardActionRequiredAt: null } }} csrf={TOKEN} />],
    ['ledger, declined card, outages', <LedgerPage data={{ ...ledger, earnings: null, statement: null, subscriptions: null, freeReads: true }} viewer={PAYER} csrf={TOKEN} />],
    ['ledger, empty', <LedgerPage data={{ ...ledger, tab: { ...ledger.tab, tabBalancePence: 0, refundDuePence: 0 }, statement: { entries: [], totalEntries: 0, hasMore: false }, subscriptions: [] }} viewer={MEMBER} csrf={TOKEN} />],
    ['receipt', <ReceiptPage receipt={{ settlementId: 'set-1', settledAt: '2026-09-01T10:00:00Z', amountPence: 800, reversedAt: '2026-09-02T10:00:00Z', unitemisedPence: 400, items: [
      { kind: 'read', description: '<i>A piece</i>', writerName: 'Bea', writerUsername: 'bea', pricePence: 0, link: '/article/my-piece', at: '' },
      { kind: 'subscription', description: 'Sub', writerName: 'Cy', writerUsername: '', pricePence: 400, link: 'javascript:alert(1)', at: '' },
    ] }} />],
    ['receipt, short', <ReceiptPage receipt={{ settlementId: 'set-2', settledAt: '2026-09-01T10:00:00Z', amountPence: 100, reversedAt: null, unitemisedPence: -40, items: [] }} />],
    ['offer, member', <OfferPage offer={offer} code="CODE" viewer={PAYER} csrf={TOKEN} self="/modernhaus/subscribe/CODE" askTerms={false} />],
    ['offer, terms, card', <OfferPage offer={{ ...offer, isComp: true, mode: 'grant', discountedPricePence: 0 }} code="CODE" viewer={PAYER} csrf={TOKEN} self="/modernhaus/subscribe/CODE" askTerms cardFix />],
    ['offer, signed out', <OfferPage offer={offer} code="CODE" viewer={null} csrf={TOKEN} self="/modernhaus/subscribe/CODE" askTerms={false} />],
    ['offer, sign in', <OfferSignInPage self="/modernhaus/subscribe/CODE" />],
    ['offer, unavailable', <OfferUnavailablePage sentence={'<script>x</script>'} />],
    ['money settings', <MoneySettingsPage viewer={PAYER} csrf={TOKEN} prefs={prefs} />],
    ['money settings, refused save', <MoneySettingsPage viewer={PAYER} csrf={TOKEN} prefs={prefs} payoutValues={{ cadence: 'monthly', threshold: '" onfocus="x' }} payoutError="The minimum is £10.00." />],
    ['money settings, prefs unavailable', <MoneySettingsPage viewer={PAYER} csrf={TOKEN} prefs={null} />],
    ['money settings, new reader', <MoneySettingsPage viewer={NEW_READER} csrf={TOKEN} prefs={null} />],
    ['money settings, unknown', <MoneySettingsPage viewer={MEMBER} csrf={TOKEN} prefs={null} />],
    ['subscribe row', <SubscribeRow writerId="w1" monthlyPence={500} annualDiscountPct={15} check={{ subscribed: false }} viewer={PAYER} csrf={TOKEN} self="/modernhaus/u/bea" askTerms={false} period="monthly" />],
    ['subscribe row, terms, card', <SubscribeRow writerId="w1" monthlyPence={500} annualDiscountPct={15} check={{ subscribed: false }} viewer={PAYER} csrf={TOKEN} self="/modernhaus/u/bea" askTerms period="annual" cardFix />],
    ['subscribe row, subscribed', <SubscribeRow writerId="w1" monthlyPence={500} annualDiscountPct={0} check={{ subscribed: true, status: 'active' }} viewer={PAYER} csrf={TOKEN} self="/modernhaus/u/bea" askTerms={false} period="monthly" />],
    ['subscribe row, cancelled', <SubscribeRow writerId="w1" monthlyPence={500} annualDiscountPct={0} check={{ subscribed: true, status: 'cancelled', currentPeriodEnd: '2026-10-01T00:00:00Z' }} viewer={PAYER} csrf={TOKEN} self="/modernhaus/u/bea" askTerms={false} period="monthly" />],
    ['subscribe row, unknown', <SubscribeRow writerId="w1" monthlyPence={500} annualDiscountPct={0} check={null} viewer={PAYER} csrf={TOKEN} self="/modernhaus/u/bea" askTerms={false} period="monthly" />],
    ['write, the agreement', <WritePage csrf={TOKEN} values={{ title: 'T', dek: '', content: 'x', price: '0.40', commentsEnabled: true, tags: '', sendEmail: true, schedule: EMPTY_SCHEDULE }} draft={{ ...NEW_DRAFT, draftId: 'd1' }} termsRefused refusedPress="schedule" writerTerms={PAYER.terms!.writer} />],
  ]
}

function restPages(): Array<[string, ReactElement]> {
  const facts: AccountFacts = {
    email: '"><script>x</script>@example.com',
    bio: '<b>bio</b>',
    avatar: 'javascript:alert(1)',
    displayName: '<i>Viv</i>',
    username: 'viv',
    pubkey: 'pk',
    usernameChangedAt: new Date().toISOString(),
    subscriptionPricePence: 500,
    annualDiscountPct: 15,
    defaultArticlePricePence: 40,
    canWrite: true,
  }
  const members = [{ id: 'b1', username: 'bea', displayName: '<b>Bea</b>' }]
  const thread = {
    conversationId: 'c1',
    members,
    before: 'cur',
    messages: [
      { id: 'm1', senderId: 'b1', senderUsername: 'bea', senderDisplayName: 'Bea', content: 'see https://evil.example/x <script>x</script>', replyTo: { senderUsername: 'viv', content: 'earlier' }, createdAt: '2026-09-01T00:00:00Z', likeCount: 2, likedByMe: true },
      { id: 'm2', senderId: 'v1', senderUsername: 'viv', senderDisplayName: null, content: null, replyTo: { senderUsername: null, content: null }, createdAt: 'nonsense', likeCount: 0, likedByMe: false },
    ],
  }
  const networks = {
    accounts: [
      { ...LINKED[0], externalHandle: '<b>@viv</b>', needsReconnect: true, instanceUrl: 'https://m.example', isValid: false, showOnProfile: true },
    ],
    capabilities: { assistedBluesky: false, assistedMastodon: false, followImportProtocols: ['atproto', 'activitypub'], followImportOpml: true },
  }
  const run = { id: 'r1', protocol: 'atproto', originIdentity: 'did:plc:x', feedId: 'f1', kind: 'import', status: 'running', total: 10, imported: 3, skipped: 1, failed: 1, error: null }
  const source = {
    id: 's1', sourceType: 'account' as const, accountId: 'b1', throughput: 0.6, samplingMode: 'top' as const, hasEngagementSignal: false,
    excludeReplies: true, mutedAt: null, createdAt: '', display: { kind: 'account' as const, label: '<b>Bea</b>', sublabel: 'javascript:x', href: '/bea' },
  }
  const feed = { id: 'f1', name: '<i>Essays</i>', sortRank: 1, hidden: true, createdAt: '', updatedAt: '', sourceCount: 1, fromStarter: false }
  const feed2 = { ...feed, id: 'f2', name: '', hidden: false }
  const article = { id: 'a1', title: '<b>A piece</b>', slug: 's', dTag: 'my-piece', nostrEventId: 'e', isPaywalled: true, pricePence: 40, wordCount: 1, publishedAt: '2026-09-01T00:00:00Z', repliesEnabled: true, replyCount: 0, readCount: 3, netEarningsPence: 90 }
  const offer = { id: 'o1', label: '<b>Launch</b>', mode: 'code' as const, discountPct: 100, durationMonths: null, code: 'C"ODE', recipientId: null, recipientUsername: null, maxRedemptions: null, redemptionCount: 2, expiresAt: null, revoked: false, isComp: false, createdAt: '' }
  const status = { link: { ...LINK, url: 'https://all.haus/f/tok' }, sourceCount: 2, excludedCount: 1, refusal: null, maxSources: 50 }
  const resolved = {
    kind: 'result' as const,
    result: {
      inputType: 'url',
      status: 'pending' as const,
      requestId: 'req-1',
      matches: [
        { type: 'native_account' as const, confidence: 'exact' as const, account: { id: 'b1', username: 'bea', displayName: '<b>Bea</b>' } },
        { type: 'rss_feed' as const, confidence: 'speculative' as const, rssFeed: { feedUrl: 'javascript:alert(1)', title: '"><x>' } },
      ],
    },
  }
  return [
    ['inbox', <InboxPage rows={[{ id: 'c1', lastMessageAt: null, createdAt: '2026-09-01T00:00:00Z', unreadCount: 2, members }]} />],
    ['inbox, empty', <InboxPage rows={[]} />],
    ['message thread', <MessageThreadPage data={thread} viewer={MEMBER} csrf={TOKEN} relation={{ muted: false, blocked: false }} draft={'"><script>x</script>'} />],
    ['message thread, blocked', <MessageThreadPage data={thread} viewer={MEMBER} csrf={TOKEN} relation={{ muted: true, blocked: true }} />],
    ['message thread, unknown members', <MessageThreadPage data={{ ...thread, members: null, messages: [] }} viewer={MEMBER} csrf={TOKEN} relation={null} />],
    ['new message', <NewMessagePage csrf={TOKEN} q={'"><x>'} lookup={{ kind: 'matches', accounts: [{ id: 'b1', username: 'bea', displayName: '<b>Bea</b>' }] }} />],
    ['new message, none', <NewMessagePage csrf={TOKEN} q="x" lookup={{ kind: 'none' }} />],
    ['relation controls', <RelationControls userId="b1" username="bea" name="Bea" relation={{ muted: false, blocked: true }} csrf={TOKEN} back="/modernhaus/u/bea" />],
    ['relation unknown', <RelationControls userId="b1" username="bea" name="Bea" relation={null} csrf={TOKEN} back="/modernhaus/u/bea" />],
    ['profile social', <ProfileSocial userId="b1" username="bea" name="Bea" relation={{ muted: true, blocked: false }} csrf={TOKEN} back="/modernhaus/u/bea" />],
    ['settings', <SettingsIndexPage facts={facts} csrf={TOKEN} values={{ displayName: '"><x>', bio: '<script>' }} error="Save failed" />],
    ['settings, reader', <SettingsIndexPage facts={{ ...facts, canWrite: false }} csrf={TOKEN} />],
    ['writer access, reader', <WriterAccessPage viewer={NEW_READER} csrf={TOKEN} back="/modernhaus/write" />],
    ['writer access, applied', <WriterAccessPage viewer={{ ...NEW_READER, writerApplication: { appliedAt: '2026-09-30T12:00:00Z' } }} csrf={TOKEN} back="/modernhaus/dashboard" />],
    ['settings, account', <AccountSettingsPage facts={facts} csrf={TOKEN} now={new Date()} email={{ value: '"><x>', error: 'Failed' }} />],
    ['settings, account, open', <AccountSettingsPage facts={{ ...facts, usernameChangedAt: null }} csrf={TOKEN} now={new Date()} username={{ value: '"><x>', error: 'That username is taken.' }} />],
    ['settings, delete', <DeleteAccountPage csrf={TOKEN} email={'"><x>'} error="That isn't the email address on your account." />],
    ['settings, networks', <NetworksPage networks={networks} csrf={TOKEN} />],
    ['settings, networks, none', <NetworksPage networks={{ accounts: [], capabilities: { assistedBluesky: false, assistedMastodon: false } }} csrf={TOKEN} />],
    ['follow import lookup', <FollowImportLookupPage csrf={TOKEN} q={'"><x>'} importable={['atproto']} found={{ unimportable: false, candidates: [{ key: 'k', label: '<b>Bea</b>', sublabel: 'atproto', add: { sourceType: 'external_source', protocol: 'atproto', sourceUri: 'did:plc:"x' } }] }} />],
    ['follow import lookup, none', <FollowImportLookupPage csrf={TOKEN} q="x" importable={['activitypub']} found="none" />],
    ['follow import status', <FollowImportStatusPage runs={[run, { ...run, id: 'r2', status: 'failed', error: '<b>boom</b>' }]} self="/modernhaus/settings/networks/imports?id=r1" names={{ r2: '<i>Folder</i>' }} plan={{ totalEntries: 5, remoteTotal: 9, truncated: true, foldedFolders: 2, invalidEntries: 1 }} />],
    ['privacy', <PrivacyPage data={{ prefs: { discoveryEnabled: true, publishFollowGraph: false, discoverableByEmail: false }, blocks: [{ userId: 'b1', username: 'bea', displayName: '<b>Bea</b>', avatar: null, blockedAt: '' }], mutes: [] }} csrf={TOKEN} />],
    ['privacy, unavailable', <PrivacyPage data={{ prefs: null, blocks: null, mutes: null }} csrf={TOKEN} />],
    ['notification prefs', <NotificationPrefsPage prefs={{ new_follower: false, new_reply: true }} csrf={TOKEN} />],
    ['notification prefs, unavailable', <NotificationPrefsPage prefs={null} csrf={TOKEN} />],
    ['library', <LibraryPage data={{ items: [{ articleId: 'a1', acquiredAt: '2026-09-01T00:00:00Z', title: '<b>T</b>', dTag: 'my-piece', isPaywalled: true, writer: { username: 'bea', displayName: null } }, { articleId: 'a2', acquiredAt: 'x', title: null, dTag: null, isPaywalled: false, writer: { username: null, displayName: null } }], nextOffset: 50 }} />],
    ['library, empty', <LibraryPage data={{ items: [], nextOffset: null }} />],
    ['history', <HistoryPage data={{ items: E3_POSTS.map((p) => ({ openedAt: '2026-09-01T00:00:00Z', post: p })), nextOffset: 50, retentionDays: 7, logEnabled: true }} csrf={TOKEN} />],
    ['history, empty', <HistoryPage data={{ items: [], nextOffset: null, retentionDays: null, logEnabled: null }} csrf={TOKEN} />],
    ['dashboard', <DashboardPage articles={[article, { ...article, id: 'a2', publishedAt: null, isPaywalled: false, title: '' }]} csrf={TOKEN} />],
    ['dashboard, empty', <DashboardPage articles={[]} csrf={TOKEN} />],
    ['dashboard article', <ArticleManagePage data={{ article, giftLinks: [{ id: 'g1', token: 't"k', maxRedemptions: 5, redemptionCount: 1, revoked: false, createdAt: '' }, { id: 'g2', token: 'x', maxRedemptions: 1, redemptionCount: 1, revoked: true, createdAt: '' }], tags: ['books'] }} csrf={TOKEN} origin="https://all.haus" tagsValue={'"><x>'} />],
    ['dashboard article, unavailable', <ArticleManagePage data={{ article, giftLinks: null, tags: null }} csrf={TOKEN} origin="https://all.haus" />],
    ['pricing', <PricingPage facts={facts} kycComplete={false} welcome={'<b>hi</b>'} csrf={TOKEN} values={{ price: '"><x>', discount: '10', mode: 'fixed', fixed: '0.40' }} error="Enter a valid price." welcomeValue={'"><x>'} />],
    ['pricing, unknowns', <PricingPage facts={facts} kycComplete={null} welcome={null} csrf={TOKEN} />],
    ['offers', <OffersPage offers={[offer, { ...offer, id: 'o2', mode: 'grant', code: null, recipientUsername: '<b>cy</b>', revoked: true }]} csrf={TOKEN} origin="https://all.haus" values={{ ...EMPTY_OFFER('grant'), label: '"><x>' }} error="Recipient not found" />],
    ['subscribers', <SubscribersPage subscribers={[{ subscriptionId: 's1', readerId: 'r', readerUsername: 'cy', readerDisplayName: '<b>Cy</b>', readerAvatar: null, pricePence: 500, status: 'cancelled', isComp: false, autoRenew: false, subscriptionPeriod: 'annual', startedAt: '2026-01-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z', cancelledAt: null, articlesRead: 1, totalArticleValuePence: 40, gettingMoneysworth: true }]} />],
    ['subscribers, none', <SubscribersPage subscribers={[]} />],
    ['feed settings', <FeedSettingsPage data={{ feed, feeds: [feed, feed2], sources: [source, { ...source, id: 's2', mutedAt: '2026-01-01', hasEngagementSignal: true }], formula: { kind: 'status', status } }} csrf={TOKEN} />],
    ['feed settings, only feed', <FeedSettingsPage data={{ feed: feed2, feeds: [feed2], sources: [], formula: { kind: 'unavailable' } }} csrf={TOKEN} />],
    ['feed settings, not shared', <FeedSettingsPage data={{ feed: feed2, feeds: [feed2, feed], sources: [], formula: { kind: 'status', status: { ...status, link: null } } }} csrf={TOKEN} />],
    ['resolve', <ResolvePage csrf={TOKEN} feed={feed} q={'"><x>'} lookup={resolved} />],
    ['resolve, expired', <ResolvePage csrf={TOKEN} feed={feed} q="x" lookup={{ kind: 'expired' }} />],
    ['resolve, refused', <ResolvePage csrf={TOKEN} feed={feed} q="x" lookup={{ kind: 'refused', status: 400 }} />],
    ['appeal', <AppealPage csrf={TOKEN} reportId="r1" token={'t"k'} text={'"><x>'} error="No." />],
    ['appeal, no token', <AppealPage csrf={TOKEN} reportId="r1" token={null} />],
    ['appeal, filed', <AppealFiledPage />],
    ['export', <ExportPage csrf={TOKEN} token={'t"k'} />],
    ['export, refused', <ExportRefusedPage refusal="error" />],
    ['export, limited', <ExportRefusedPage refusal="limited" />],
    ['formula, member', <FormulaPage link={LINK} twin="/f/tok" viewer={MEMBER} csrf={TOKEN} />],
  ]
}

/** Elements, searched in the whole document. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['a script', /<script/i],
  ['a stylesheet', /<style|<link/i],
  ['an iframe', /<iframe/i],
]

/** Attributes, searched in the TAGS with every quoted value emptied: a form
 *  re-rendered with what somebody typed carries ` style=` as escaped TEXT in a
 *  `value`, which is not an attribute. */
const FORBIDDEN_ATTRS: Array<[string, RegExp]> = [
  ['a style attribute', /\sstyle=/i],
  ['a class attribute', /\sclass=/i],
  ['an event handler', /\son[a-z]+=/i],
]

function tags(html: string): string {
  return (html.match(/<[^>]+>/g) ?? []).map((t) => t.replace(/="[^"]*"/g, '=""')).join('')
}

/**
 * Every POST form, whatever order its attributes come in. Next's vendored
 * React writes a form's `action` BEFORE `method` (it treats `action`
 * specially), while the test runtime keeps prop order — a matcher written for
 * one order finds nothing in the other and passes by testing nothing.
 */
function postForms(html: string): string[] {
  return (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).filter((f) =>
    /^<form\b[^>]*\smethod="post"/i.test(f),
  )
}

let postFormsSeen = 0

function urls(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src|formaction)="([^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'))
}

/** Every door a form or a button can reach: a form's `action`, a button's `formaction`. */
function doors(html: string): string[] {
  return [...html.matchAll(/\s(?:action|formaction)="\/modernhaus\/do\/([^"]*)"/gi)].map((m) => m[1])
}

let doorsSeen = 0
// The one test-only form in the sweep, beside the registry.
const TEST_DOORS = new Set(['noop'])

describe('modernhaus pages carry no ornament', async () => {
  const all = await pages()

  it('rendered every page it meant to', () => {
    // A renamed page or an empty legal list must not make this sweep vacuous.
    expect(all.length).toBeGreaterThanOrEqual(140)
    expect(LEGAL_DOCS.length).toBe(4)
  })

  for (const [name, body] of all) {
    for (const viewer of [null, MEMBER]) {
      it(`${name} (${viewer ? 'member' : 'signed out'})`, async () => {
        const html = await renderHtml(
          <Document title={name} viewer={viewer} twin="/" outcome={null} csrf={TOKEN}>
            {body}
          </Document>,
        )
        expect(html.startsWith('<!doctype html><html lang="en-GB">')).toBe(true)
        for (const [what, re] of FORBIDDEN) {
          expect(re.test(html), `${name} carries ${what}`).toBe(false)
        }
        const t = tags(html)
        for (const [what, re] of FORBIDDEN_ATTRS) {
          expect(re.test(t), `${name} carries ${what}`).toBe(false)
        }
        for (const form of postForms(html)) {
          postFormsSeen++
          expect(form, 'a POST form without its CSRF field').toContain(`name="_csrf" value="${TOKEN}"`)
        }
        // A BUTTON THAT CANNOT DO ITS JOB IS NOT OFFERED: every door a form
        // or a button reaches is a registered action.
        for (const d of doors(html)) {
          doorsSeen++
          expect(TEST_DOORS.has(d) || Object.prototype.hasOwnProperty.call(REGISTRY, d), `${name}: unregistered door ${d}`).toBe(true)
        }
        for (const url of urls(html)) {
          const internal = url.startsWith('/') && !url.startsWith('//')
          expect(internal || safeHttpUrl(url) === url, `${name}: unsafe URL ${url}`).toBe(true)
        }
      })
    }
  }

  it('turns a real provider embed into a link rather than dropping it', async () => {
    const html = stripOrnament(await renderMarkdown('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
    expect(html).not.toMatch(/<iframe/)
    expect(html).toMatch(/<a href="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ[^"]*"/)
  })

  it('the attribute sweep still finds a real attribute (it is not blinded by the narrowing)', () => {
    expect(tags('<p style="x">a</p>')).toMatch(/\sstyle=/)
    expect(tags('<input value="a style=b" onclick="y">')).toMatch(/\son[a-z]+=/)
    expect(tags('<input value="a style=b">')).not.toMatch(/\sstyle=/)
  })

  it('typed input comes back escaped, never as markup', async () => {
    const html = await renderHtml(
      <SignupPage csrf={TOKEN} next={null} values={{ email: '"><script>x</script>', displayName: 'n', dob: { day: '', month: '', year: '' } }} />,
    )
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"')
  })

  it('the post form is found by the sweep (it is not vacuous)', async () => {
    const html = await renderHtml(<PostForm action="noop" csrf={TOKEN}><button>Go</button></PostForm>)
    expect(postForms(html)).toHaveLength(1)
    expect(postForms(html)[0]).toContain('action="/modernhaus/do/noop"')
    // Either attribute order is a POST form.
    expect(postForms('<form action="/x" method="post"><input name="_csrf"></form>')).toHaveLength(1)
    expect(postForms('<form method="get" action="/x"></form>')).toHaveLength(0)
  })

  it('the sweep checked the forms, the nav sign-out and every door (it is not vacuous)', () => {
    // Runs after the per-page cases: the E2 forms, the member nav's sign-out on
    // every page, and E3's action rows, reply, follow, report, confirm and
    // notification forms.
    expect(postFormsSeen).toBeGreaterThanOrEqual(260)
    expect(doorsSeen).toBeGreaterThanOrEqual(300)
  })

  it('the door sweep reads a button’s formaction as well as a form’s action', () => {
    expect(doors('<form action="/modernhaus/do/vote" method="post"><button formaction="/modernhaus/do/external_like">L</button></form>')).toEqual(['vote', 'external_like'])
  })
})
