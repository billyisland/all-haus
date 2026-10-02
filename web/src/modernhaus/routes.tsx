import { legalDoc } from '../content/legal/lookup'
import { ARTICLE_NOT_HERE_TITLE } from '../content/article'
import { FEED_LINK_GONE_TITLE, FEED_LINK_WITHDRAWN_TITLE, feedLinkTitle } from '../content/feed-link'
import { REGISTRY } from './actions'
import { handleDoor } from './door'
import { modernhausPage, notFound, gatewayContext, loadViewer, ageStepLocation, faultResponse, type PageResult } from './page'
import { call, okBody, path, query, GatewayFault } from './gateway'
import { safeReturn, CARD_FIX_CODES } from './outcomes'
import { HomePage, AboutPage, LegalPage } from './pages/public'
import { ArticleNotHerePage, ReadPage } from './pages/reading'
import { ProfilePage, AuthorPage } from './pages/people'
import { TagPage, SearchPage, FormulaPage } from './pages/finding'
import { SigninPage, VerifyPage, SignupPage, AgePage, WaitlistPage } from './pages/auth'
import { EMPTY_DOB, type Viewer } from './html'
import { FeedIndexPage, FeedPage, feedLabel } from './pages/feeds'
import { ThreadPage } from './pages/conversation'
import { FollowPage, ReportPage, ConfirmPage, NotificationsPage, SourcePage, type ReportTarget } from './pages/member'
import { CONFIRMS } from './confirms'
import {
  ComposePage,
  WritePage,
  DraftsPage,
  PreviewPage,
  UploadPage,
  PaidHalfUnavailable,
  EMPTY_SCHEDULE,
  NEW_DRAFT,
} from './pages/writing'
import { loadQuoted, loadCrossPost, loadDraft, valuesFromDraft, loadEdit, loadDrafts, loadPreview } from './writing-loaders'
import {
  loadFeedIndex,
  loadFeed,
  loadThread,
  loadNotifications,
  loadSource,
  loadMembership,
  resolveFollow,
  followSubject,
  followQuery,
} from './member-loaders'
import { SIGNIN_TITLE, LINK_SENT_TITLE, VERIFY_FAILED_TITLE, SIGNUP_TITLE, AGE_TITLE, WAITLIST_TITLE } from '../content/auth'
import { loadArticleView, ArticleViewPage } from './article-view'
import {
  loadLedger,
  loadReceipt,
  loadOffer,
  loadPayoutPrefs,
} from './money-loaders'
import {
  LedgerPage,
  ReceiptPage,
  OfferPage,
  OfferSignInPage,
  OfferUnavailablePage,
  MoneySettingsPage,
  SubscribeRow,
  OFFER_FOR_YOU_TITLE,
  OFFER_UNAVAILABLE_TITLE,
  type SubscriptionCheck,
} from './pages/money'
import { downloadResponse, redirectResponse } from './respond'
import { requestOrigin } from './csrf'
import type { WorkspaceFeed } from '../lib/api/feeds'
import { resolveMatches } from '../lib/workspace/resolve'
import { PUBLISHED_FIGURES_PATH, parsePublishedFigures, type PublishedFigures } from '../lib/published-figures'
import { MESSAGES_TITLE, MESSAGES_NEW_MESSAGE_TITLE } from '../content/messages'
import { LIBRARY_TITLE, LIBRARY_TAB_RECENT } from '../content/library'
import {
  SETTINGS_TITLE,
  SETTINGS_GROUP_ACCOUNT,
  SETTINGS_REACH_LABEL,
  SETTINGS_NOTIFICATIONS_LABEL,
  DELETE_CONFIRM_TITLE,
} from '../content/settings'
import { FOLLOW_IMPORT_TITLE } from '../content/networks'
import { FEED_ADD_SOURCE_LABEL } from '../content/feed-settings'
import { APPEAL_FORM_TITLE, APPEAL_INCOMPLETE_TITLE } from '../content/appeal'
import { EXPORT_WORKING_TITLE, EXPORT_USED_TITLE } from '../content/account-export'
import { loadInbox, loadMessageThread, loadRelation, lookupRecipient } from './messages-loaders'
import { InboxPage, MessageThreadPage, NewMessagePage, threadTitle } from './pages/messages'
import { ProfileSocial } from './pages/social'
import {
  loadAccountFacts,
  loadNetworks,
  loadFollowImport,
  loadPrivacy,
  loadNotificationPrefs,
  loadLibrary,
  loadHistory,
  type FollowImportRun,
} from './settings-loaders'
import {
  SettingsIndexPage,
  AccountSettingsPage,
  DeleteAccountPage,
  NetworksPage,
  FollowImportLookupPage,
  FollowImportStatusPage,
  PrivacyPage,
  NotificationPrefsPage,
} from './pages/settings'
import { LibraryPage, HistoryPage } from './pages/library'
import { loadMyArticles, loadArticleManage, loadWelcome, loadOffers, loadSubscribers } from './dashboard-loaders'
import { DashboardPage, ArticleManagePage, PricingPage, OffersPage, SubscribersPage } from './pages/dashboard'
import { loadFeedSettings, loadFeeds, lookupSource, pollSource, type SourceLookup } from './feed-settings-loaders'
import { FeedSettingsPage, ResolvePage } from './pages/feed-settings'
import { AppealPage, ExportPage } from './pages/rights'
import { WriterAccessPage } from './pages/writer-access'
import { WRITER_ACCESS_TITLE } from '../content/writer-access'
import {
  loadRead,
  loadProfile,
  loadAuthor,
  loadTag,
  loadSearch,
  loadFormula,
  parseView,
  parseOffset,
  parseSearchType,
} from './loaders'

// =============================================================================
// modernhaus — every page and the door, assembled. The files under
// `app/modernhaus/**` are one-line delegates to these (MODERNHAUS-ADR §D1.1).
//
// A page here is a loader (I/O) plus a body (pure JSX), with its title and its
// twin on the full site. Adding a page = a loader, a body, an entry here, and a
// route file that re-exports it.
// =============================================================================

const enc = encodeURIComponent

/** The refusals after which a draft's page asks for the Writer Agreement. */
const WRITER_TERMS_CODES: ReadonlySet<string> = new Set(['writer_terms_required', 'writer_terms_moved', 'terms_accept_failed'])

/** The signed-out wall on a member page (§D2.2). */
function signIn(url: URL): PageResult {
  return { kind: 'redirect', location: `/modernhaus/signin?return=${enc(safeReturn(url.pathname + url.search) ?? '/modernhaus')}` }
}

/** The page's own address, as a `return` every press on it comes back to. */
function selfPath(url: URL): string {
  const u = new URL(url.pathname + url.search, 'http://modernhaus.invalid')
  u.searchParams.delete('done')
  u.searchParams.delete('error')
  return safeReturn(u.pathname + u.search) ?? '/modernhaus'
}

// Signed in, the home IS the feed index (§D2.9 Q2).
export const homeGET = modernhausPage(async ({ gw, viewer, csrf }) => {
  if (!viewer) return { kind: 'page', title: 'Welcome', twin: '/', body: <HomePage viewer={null} /> }
  const rows = await loadFeedIndex(gw)
  return { kind: 'page', title: 'Your channels', twin: '/reader', body: <FeedIndexPage rows={rows} csrf={csrf} /> }
})

export const feedGET = modernhausPage<{ feedId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadFeed(gw, params.feedId, url.searchParams.get('cursor'))
  if (!data) return notFound
  const self = `/modernhaus/feed/${enc(data.feed.id)}`
  return {
    kind: 'page',
    title: feedLabel(data.feed, null),
    twin: '/reader',
    body: (
      <FeedPage
        feed={data.feed}
        items={data.items}
        asOf={data.asOf}
        newKnown={data.newIds !== null}
        next={data.nextCursor ? `${self}${query({ cursor: data.nextCursor })}` : null}
        actions={{ viewer, csrf, back: selfPath(url), votes: data.votes, linked: data.linked, newIds: data.newIds ?? undefined }}
      />
    ),
  }
})

export const threadGET = modernhausPage<{ postId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  const data = await loadThread(gw, viewer, params.postId, url.searchParams.get('replyCursor'))
  if (!data) return notFound
  const self = `/modernhaus/thread/${enc(data.focal.id)}`
  return {
    kind: 'page',
    title: 'Conversation',
    twin: null,
    body: (
      <ThreadPage
        ancestors={data.ancestors}
        focal={data.focal}
        replies={data.replies}
        totalDescendants={data.totalDescendants}
        hydrating={data.hydrating}
        next={data.replyCursor ? `${self}${query({ replyCursor: data.replyCursor })}` : null}
        self={selfPath(url)}
        viewer={viewer}
        csrf={csrf}
        votes={data.votes}
        linked={data.linked}
      />
    ),
  }
})

export const followGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const subject = followSubject(url.searchParams)
  if (!subject) return notFound
  const resolved = await resolveFollow(gw, viewer, subject)
  if (!resolved) return notFound
  const feeds = await loadMembership(gw, resolved.target)
  return {
    kind: 'page',
    title: `Follow ${resolved.name}`,
    twin: null,
    body: (
      <FollowPage
        csrf={csrf}
        subject={subject}
        name={resolved.name}
        home={resolved.home}
        back={safeReturn(url.searchParams.get('return')) ?? resolved.home}
        feeds={feeds}
        intoFeed={url.searchParams.get('feed')}
      />
    ),
  }
})

/** `post:<postId>` (with `event=` for a native post), `event:<eventId>`, `account:<id>`. */
function parseReportTarget(url: URL): ReportTarget | null {
  const raw = url.searchParams.get('target') ?? ''
  const at = raw.indexOf(':')
  const kind = raw.slice(0, at)
  const id = raw.slice(at + 1)
  if (at < 1 || !id) return null
  if (kind === 'post') return { kind: 'post', postId: id, eventId: url.searchParams.get('event') || null }
  if (kind === 'event') return { kind: 'event', eventId: id }
  if (kind === 'account') return { kind: 'account', accountId: id }
  return null
}

export const reportGET = modernhausPage(async ({ viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const target = parseReportTarget(url)
  if (!target) return notFound
  return {
    kind: 'page',
    title: 'Report',
    twin: null,
    body: <ReportPage csrf={csrf} target={target} back={safeReturn(url.searchParams.get('return')) ?? '/modernhaus'} />,
  }
})

export const confirmGET = modernhausPage<{ action: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const spec = Object.prototype.hasOwnProperty.call(CONFIRMS, params.action) ? CONFIRMS[params.action] : undefined
  if (!spec || !Object.prototype.hasOwnProperty.call(REGISTRY, params.action)) return notFound
  let values: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = url.searchParams.get(f)
    if (v) values[f] = v
  }
  // A confirm page with nothing to confirm is a link that cannot do its job.
  if (Object.keys(values).length === 0) return notFound
  let question = spec.question
  let consequence = spec.consequence
  if (spec.resolve) {
    const resolved = await spec.resolve(gw, values)
    if (!resolved) return notFound
    values = resolved.values
    question = resolved.question ?? question
    consequence = resolved.consequence ?? consequence
  }
  return {
    kind: 'page',
    title: question,
    twin: null,
    body: (
      <ConfirmPage
        csrf={csrf}
        action={params.action}
        spec={{ consequence, button: spec.button }}
        values={values}
        back={safeReturn(url.searchParams.get('return')) ?? '/modernhaus'}
      />
    ),
  }
})

export const notificationsGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadNotifications(gw, url.searchParams.get('cursor'))
  if (data === 'bad_cursor') return notFound
  return {
    kind: 'page',
    title: 'Notifications',
    twin: '/notifications',
    body: (
      <NotificationsPage
        csrf={csrf}
        viewer={viewer}
        notifications={data.notifications}
        self={selfPath(url)}
        next={data.nextCursor ? `/modernhaus/notifications${query({ cursor: data.nextCursor })}` : null}
      />
    ),
  }
})

export const sourceGET = modernhausPage<{ sourceId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadSource(gw, viewer, params.sourceId, url.searchParams.get('cursor'))
  if (!data) return notFound
  const self = `/modernhaus/source/${enc(params.sourceId)}`
  return {
    kind: 'page',
    title: data.source.displayName ?? data.source.sourceUri,
    twin: `/source/${enc(params.sourceId)}`,
    body: (
      <SourcePage
        source={data.source}
        sourceId={params.sourceId}
        items={data.items}
        next={data.nextCursor ? `${self}${query({ cursor: data.nextCursor })}` : null}
        actions={{ viewer, csrf, back: selfPath(url), votes: data.votes, linked: data.linked }}
      />
    ),
  }
})

// The cut and the allowance are dials, read for the copy (content/about.ts).
// A failed read renders the page with the numbers dropped rather than the
// fault page, for the reason `app/about/page.tsx` gives: the page is About,
// and the null copy says nothing false.
export const aboutGET = modernhausPage(async ({ gw }) => {
  let figures: PublishedFigures | null = null
  try {
    const answer = await call(gw, 'GET', PUBLISHED_FIGURES_PATH)
    if (answer.status === 200) figures = parsePublishedFigures(answer.body)
  } catch (err) {
    if (!(err instanceof GatewayFault)) throw err
  }
  return { kind: 'page', title: 'About', twin: '/about', body: <AboutPage figures={figures} /> }
})

/** One legal text. Resolved at MODULE scope, so a missing slug fails the build. */
function legalGET(slug: string) {
  const doc = legalDoc(slug)
  return modernhausPage(async () => ({
    kind: 'page',
    title: doc.title,
    twin: `/${slug}`,
    body: <LegalPage doc={doc} />,
  }))
}
export const termsGET = legalGET('terms')
export const privacyGET = legalGET('privacy')
export const readerTermsGET = legalGET('reader-terms')
export const writerAgreementGET = legalGET('writer-agreement')

export const articleGET = modernhausPage<{ dTag: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  // A gift link, redeemed on the GET as the full site's reader redeems it on
  // mount (§D1.2), then the address without it — the redeem is spent once,
  // and a reload must not try again. Signed out, the token stays in the
  // address, so the sign-in's return carries it back here.
  const gift = url.searchParams.get('gift')
  if (viewer && gift) {
    await redeemGift(gw, params.dTag, gift)
    const clean = new URL(url.pathname + url.search, 'http://modernhaus.invalid')
    clean.searchParams.delete('gift')
    return { kind: 'redirect', location: safeReturn(clean.pathname + clean.search) ?? '/modernhaus' }
  }
  const view = await loadArticleView(gw, viewer, params.dTag, {
    offset: parseOffset(url.searchParams.get('replies')),
    focus: url.searchParams.get('focus'),
    log: true,
  })
  if (!view) {
    return {
      kind: 'page',
      status: 404,
      title: ARTICLE_NOT_HERE_TITLE,
      twin: `/article/${enc(params.dTag)}`,
      body: <ArticleNotHerePage />,
    }
  }
  return {
    kind: 'page',
    title: view.article.title,
    heading: false,
    twin: `/article/${enc(view.article.dTag)}`,
    body: (
      <ArticleViewPage
        view={view}
        viewer={viewer}
        csrf={csrf}
        self={selfPath(url)}
        askSubscribeTerms={url.searchParams.get('error') === 'subscribe_terms'}
        cardFix={CARD_FIX_CODES.has(url.searchParams.get('error') ?? '')}
      />
    ),
  }
})

export const readGET = modernhausPage<{ postId: string }>(async ({ gw, viewer, params }) => {
  const data = await loadRead(gw, viewer, params.postId)
  if (!data) return notFound
  return {
    kind: 'page',
    title: data.post.body.title ?? 'Untitled',
    heading: false,
    twin: `/read/${enc(params.postId)}`,
    body: <ReadPage post={data.post} sourceUrl={data.sourceUrl} extracted={data.extracted} />,
  }
})

/** "Follow…" for a member looking at somebody else, else null. */
function followHref(viewer: Viewer | null, isSelf: boolean, q: Record<string, string>, back: string): string | null {
  if (!viewer || isSelf) return null
  return `/modernhaus/follow${query({ ...q, return: back })}`
}

export const profileGET = modernhausPage<{ username: string }>(async ({ gw, viewer, csrf, params, url }) => {
  const view = parseView(url.searchParams.get('view'))
  const offset = parseOffset(url.searchParams.get('offset'))
  const data = await loadProfile(gw, params.username, view, offset)
  if (!data) return notFound
  const self = `/modernhaus/u/${enc(data.writer.username)}`
  // The subscribe row (NativeProfileBody's): a member looking at a writer who
  // sells something. Its read is secondary; unknown is said, never "not
  // subscribed" (a button offered on a guess could sell the same thing twice).
  const sells = data.writer.hasPaywalledArticle && data.writer.subscriptionPricePence > 0
  const check =
    viewer && viewer.id !== data.writer.id && sells ? await loadSubscriptionCheck(gw, data.writer.id) : undefined
  const period = url.searchParams.get('period') === 'annual' ? 'annual' : 'monthly'
  const next = data.nextOffset === null ? null : `${self}${query({ view, offset: data.nextOffset })}`
  return {
    kind: 'page',
    title: data.writer.displayName ?? data.writer.username,
    twin: `/${enc(data.writer.username)}`,
    body: (
      <ProfilePage
        writer={data.writer}
        list={data.list}
        next={next}
        followHref={followHref(viewer, viewer?.id === data.writer.id, followQuery({ kind: 'writer', username: data.writer.username }), selfPath(url))}
        reportHref={
          viewer && viewer.id !== data.writer.id
            ? `/modernhaus/report${query({ target: `account:${data.writer.id}`, return: selfPath(url) })}`
            : null
        }
        social={
          viewer && viewer.id !== data.writer.id ? (
            <ProfileSocial
              userId={data.writer.id}
              username={data.writer.username}
              name={data.writer.displayName ?? data.writer.username}
              relation={data.writer.viewer ?? null}
              csrf={csrf}
              back={selfPath(url)}
            />
          ) : null
        }
        subscribe={
          viewer && check !== undefined ? (
            <SubscribeRow
              writerId={data.writer.id}
              monthlyPence={data.writer.subscriptionPricePence}
              annualDiscountPct={data.writer.annualDiscountPct ?? 0}
              check={check}
              viewer={viewer}
              csrf={csrf}
              self={selfPath(url)}
              askTerms={url.searchParams.get('error') === 'subscribe_terms'}
              period={period}
              cardFix={CARD_FIX_CODES.has(url.searchParams.get('error') ?? '')}
            />
          ) : null
        }
      />
    ),
  }
})

export const authorGET = modernhausPage<{ authorId: string }>(async ({ gw, viewer, params, url }): Promise<PageResult> => {
  const data = await loadAuthor(gw, params.authorId, url.searchParams.get('cursor'))
  if (!data) return notFound
  if (data.kind === 'native') return { kind: 'redirect', location: `/modernhaus/u/${enc(data.username)}` }
  const self = `/modernhaus/author/${enc(params.authorId)}`
  return {
    kind: 'page',
    title: data.profile.displayName ?? data.profile.handle ?? 'Author',
    twin: `/author/${enc(params.authorId)}`,
    body: (
      <AuthorPage
        authorId={params.authorId}
        profile={data.profile}
        posts={data.posts}
        hydrating={data.hydrating}
        next={data.nextCursor ? `${self}${query({ cursor: data.nextCursor })}` : null}
        followHref={
          data.profile.followTarget
            ? followHref(viewer, false, followQuery({ kind: 'author', id: params.authorId }), selfPath(url))
            : null
        }
      />
    ),
  }
})

export const tagGET = modernhausPage<{ tag: string }>(async ({ gw, params, url }) => {
  const data = await loadTag(gw, params.tag, url.searchParams.get('cursor'))
  if (!data) return notFound
  const self = `/modernhaus/tag/${enc(params.tag)}`
  return {
    kind: 'page',
    title: `#${params.tag}`,
    twin: `/tag/${enc(params.tag)}`,
    body: (
      <TagPage
        posts={data.posts}
        total={data.total}
        next={data.nextCursor ? `${self}${query({ cursor: data.nextCursor })}` : null}
      />
    ),
  }
})

export const searchGET = modernhausPage(async ({ gw, url }) => {
  const q = (url.searchParams.get('q') ?? '').trim()
  const type = parseSearchType(url.searchParams.get('type'))
  const offset = parseOffset(url.searchParams.get('offset'))
  const data = await loadSearch(gw, q, type, offset)
  return {
    kind: 'page',
    title: 'Search',
    twin: '/search',
    body: (
      <SearchPage
        q={q}
        type={type}
        results={data.results}
        tags={data.tags}
        next={data.nextOffset === null ? null : `/modernhaus/search${query({ q, type, offset: data.nextOffset })}`}
      />
    ),
  }
})

export const formulaGET = modernhausPage<{ token: string }>(async ({ gw, viewer, csrf, params }) => {
  const link = await loadFormula(gw, params.token)
  if (!link) return notFound
  const twin = `/f/${enc(params.token)}`
  const title = link.revoked ? FEED_LINK_WITHDRAWN_TITLE : link.gone ? FEED_LINK_GONE_TITLE : feedLinkTitle(link)
  return { kind: 'page', title, twin, body: <FormulaPage link={link} twin={twin} viewer={viewer} csrf={csrf} /> }
})

// ---------------------------------------------------------------------------
// Signing in (E2, §D2.3). A signed-in member who opens a door meant for the
// signed-out is sent home rather than shown a form for somebody else.
// ---------------------------------------------------------------------------

/** An article d-tag out of a `return` that names one, for the emailed link. */
function arrivalFromReturn(value: string | null): string | null {
  const back = safeReturn(value)
  const m = back?.match(/^\/modernhaus\/article\/([^/?]+)$/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/**
 * Can an account be made? `GET /auth/open` answers 200 or 404, and the status
 * IS the answer. For the sign-in page's "New here?" line this is secondary:
 * anything else is "we could not find out", which offers the waiting list —
 * the one answer that is never a promise we then break (the full site's rule).
 */
async function accountsOpen(gw: Parameters<typeof call>[0]): Promise<boolean | null> {
  try {
    const open = await call(gw, 'GET', '/auth/open')
    if (open.status === 200) return true
    if (open.status === 404) return false
    return null
  } catch (err) {
    console.warn('[modernhaus] /auth/open unreadable; offering the waiting list', err)
    return null
  }
}

export const signinGET = modernhausPage(async ({ gw, viewer, url, csrf }): Promise<PageResult> => {
  if (viewer) return { kind: 'redirect', location: safeReturn(url.searchParams.get('return')) ?? '/modernhaus' }
  const sent = url.searchParams.get('done') === 'link_sent'
  const canSignUp = sent ? false : (await accountsOpen(gw)) === true
  return {
    kind: 'page',
    title: sent ? LINK_SENT_TITLE : SIGNIN_TITLE,
    twin: '/auth',
    body: (
      <SigninPage
        csrf={csrf}
        sent={sent}
        canSignUp={canSignUp}
        arrival={arrivalFromReturn(url.searchParams.get('return'))}
      />
    ),
  }
})

export const verifyGET = modernhausPage(async ({ url, csrf }) => {
  const token = url.searchParams.get('token')
  const failed = url.searchParams.get('error') !== null
  const arrival = url.searchParams.get('arrival')
  return {
    kind: 'page',
    title: failed || !token ? VERIFY_FAILED_TITLE : SIGNIN_TITLE,
    // No twin: the full site's verify page SPENDS the token on load.
    twin: null,
    body: <VerifyPage csrf={csrf} token={failed ? null : token} arrival={arrival} failed={failed} />,
  }
})

export const signupGET = modernhausPage(async ({ gw, viewer, url, csrf }): Promise<PageResult> => {
  if (viewer) return { kind: 'redirect', location: '/modernhaus' }
  // The primary read: the form is offered only where it can work. A 404 is the
  // closed beta, which the waiting list answers; anything else is a fault.
  const open = await call(gw, 'GET', '/auth/open')
  if (open.status === 404) return { kind: 'redirect', location: '/modernhaus/waitlist?from=beta' }
  if (open.status !== 200) throw new GatewayFault(`/auth/open answered ${open.status}`)
  return {
    kind: 'page',
    title: SIGNUP_TITLE,
    twin: '/auth/signup',
    body: (
      <SignupPage
        csrf={csrf}
        next={safeReturn(url.searchParams.get('return'))}
        values={{ email: '', displayName: '', dob: EMPTY_DOB }}
      />
    ),
  }
})

export const ageGET = modernhausPage(
  async ({ viewer, url, csrf }): Promise<PageResult> => {
    const next = safeReturn(url.searchParams.get('return'))
    if (!viewer) return { kind: 'redirect', location: `/modernhaus/signin?return=${enc('/modernhaus/age')}` }
    if (viewer.ageDeclaredAt !== null) return { kind: 'redirect', location: next ?? '/modernhaus' }
    return { kind: 'page', title: AGE_TITLE, twin: null, body: <AgePage csrf={csrf} next={next} values={EMPTY_DOB} /> }
  },
  { allowUndeclared: true },
)

export const waitlistGET = modernhausPage(async ({ url, csrf }) => ({
  kind: 'page',
  title: WAITLIST_TITLE,
  twin: '/waitlist',
  body: (
    <WaitlistPage
      csrf={csrf}
      fromBeta={url.searchParams.get('from') === 'beta'}
      joined={url.searchParams.get('done') === 'waitlisted'}
    />
  ),
}))

// ---------------------------------------------------------------------------
// Writing (E4, §D2.3). Every page is the member's own; the drafts and the
// edit form are the writer's alone, and the gateway scopes each read to them.
// ---------------------------------------------------------------------------

export const composeGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const quoteId = url.searchParams.get('quote')
  const [quote, crossPost] = await Promise.all([
    quoteId ? loadQuoted(gw, quoteId) : Promise.resolve(null),
    quoteId ? Promise.resolve([]) : loadCrossPost(gw),
  ])
  if (quoteId && !quote) return notFound
  return {
    kind: 'page',
    title: quote ? 'Quote' : 'Write a note',
    twin: null,
    body: <ComposePage csrf={csrf} quote={quote} crossPost={crossPost} back={safeReturn(url.searchParams.get('return'))} canWrite={viewer.canWrite} />,
  }
})

const NEW_VALUES = {
  title: '',
  dek: '',
  content: '',
  price: '',
  commentsEnabled: true,
  tags: '',
  sendEmail: true,
  schedule: EMPTY_SCHEDULE,
}

/** A reader reaching a writing or dashboard page meets the explanation and the
 *  one press they can make, never a form the gateway would refuse
 *  (READER-WRITER-SPLIT-ADR §6.3). Null for a writer. */
function readerOnWriterPage(viewer: Viewer, csrf: string, url: URL): PageResult | null {
  if (viewer.canWrite === true) return null
  return {
    kind: 'page',
    title: WRITER_ACCESS_TITLE,
    twin: null,
    body: <WriterAccessPage viewer={viewer} csrf={csrf} back={url.pathname} />,
  }
}

/** `/modernhaus/write`: a new piece, or — with `?edit=<dTag>` — one of the viewer's published pieces. */
export const writeGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const edit = url.searchParams.get('edit')
  if (!edit) {
    return { kind: 'page', title: 'Write a piece', twin: null, body: <WritePage csrf={csrf} values={NEW_VALUES} draft={NEW_DRAFT} /> }
  }
  const loaded = await loadEdit(gw, viewer, edit)
  if (!loaded) return notFound
  if (loaded.kind === 'paid_half_unavailable') {
    return { kind: 'page', title: 'Edit a piece', twin: null, body: <PaidHalfUnavailable /> }
  }
  return {
    kind: 'page',
    title: 'Edit a piece',
    twin: null,
    body: <WritePage csrf={csrf} values={loaded.values} draft={loaded.draft} />,
  }
})

export const writeDraftGET = modernhausPage<{ draftId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const d = await loadDraft(gw, params.draftId)
  if (!d) return notFound
  const { values, draft } = valuesFromDraft(d)
  return {
    kind: 'page',
    title: d.title?.trim() || 'Untitled draft',
    twin: null,
    body: (
      <WritePage
        csrf={csrf}
        values={values}
        draft={draft}
        termsRefused={WRITER_TERMS_CODES.has(url.searchParams.get('error') ?? '')}
        refusedPress={url.searchParams.get('press') === 'schedule' ? 'schedule' : 'publish'}
        writerTerms={viewer.terms?.writer}
      />
    ),
  }
})

export const draftsGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const drafts = await loadDrafts(gw)
  return { kind: 'page', title: 'Your drafts', twin: null, body: <DraftsPage csrf={csrf} drafts={drafts} /> }
})

export const previewGET = modernhausPage<{ draftId: string }>(async ({ gw, viewer, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadPreview(gw, params.draftId)
  if (!data) return notFound
  const title = data.draft.title?.trim() || 'Untitled'
  return {
    kind: 'page',
    title,
    heading: false,
    twin: `/preview/${enc(params.draftId)}`,
    body: (
      <PreviewPage
        draftId={data.draft.draftId}
        title={title}
        dek={data.draft.dek}
        savedAt={data.draft.autoSavedAt}
        byline={viewer.displayName ?? viewer.username ?? 'You'}
        freeHtml={data.freeHtml}
        paid={data.paid}
      />
    ),
  }
})

export const uploadGET = modernhausPage(async ({ viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  return { kind: 'page', title: 'Upload a picture', twin: null, body: <UploadPage csrf={csrf} canWrite={viewer.canWrite} /> }
})

// ---------------------------------------------------------------------------
// Money (E5, §D2.3). The Ledger, a receipt, the receipts download, an offer,
// and Settings › Payment. Card entry links out to the full site (Decision 2).
// ---------------------------------------------------------------------------

/** A member's subscription to a writer, or null when the read could not say. */
async function loadSubscriptionCheck(gw: Parameters<typeof call>[0], writerId: string): Promise<SubscriptionCheck | null> {
  try {
    const a = await call<SubscriptionCheck>(gw, 'GET', path`/subscriptions/check/${writerId}`)
    return a.status === 200 && typeof a.body?.subscribed === 'boolean' ? a.body : null
  } catch (err) {
    console.warn('[modernhaus] subscription check unavailable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

export const ledgerGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadLedger(gw, viewer, parseOffset(url.searchParams.get('offset')), url.searchParams.get('free') === '1')
  return { kind: 'page', title: 'Ledger', twin: '/ledger', body: <LedgerPage data={data} viewer={viewer} csrf={csrf} /> }
})

export const receiptGET = modernhausPage<{ settlementId: string }>(async ({ gw, viewer, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const receipt = await loadReceipt(gw, params.settlementId)
  if (!receipt) return notFound
  return { kind: 'page', title: 'Receipt', twin: '/ledger', body: <ReceiptPage receipt={receipt} /> }
})

/**
 * `/modernhaus/receipts/export`: the reader's portable receipts, as the file
 * the full site builds in the browser (`platform-receipts.json`), streamed
 * with `Content-Disposition` (§D1.5). The body is the gateway's JSON, byte for
 * byte — `count` and `skipped` included, so a short export never reads as a
 * whole one.
 */
export async function receiptsExportGET(req: Request): Promise<Response> {
  const gw = gatewayContext(req)
  try {
    const viewer = await loadViewer(gw)
    const url = new URL(req.url)
    if (!viewer) return redirectResponse(`/modernhaus/signin?return=${enc('/modernhaus/ledger')}`, gw.setCookies)
    if (viewer.ageDeclaredAt === null) return redirectResponse(ageStepLocation(url), gw.setCookies)
    const a = await call(gw, 'GET', '/receipts/export')
    const body = okBody(a, 'receipts export')
    return downloadResponse(JSON.stringify(body, null, 2), 'platform-receipts.json', gw.setCookies)
  } catch (err) {
    console.error('[modernhaus] receipts export fault', err)
    return faultResponse(500, gw.setCookies)
  }
}

export const offerGET = modernhausPage<{ code: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  const self = `/modernhaus/subscribe/${enc(params.code)}`
  const twin = `/subscribe/${enc(params.code)}`
  const result = await loadOffer(gw, params.code)
  if (result.kind === 'sign_in') return { kind: 'page', title: OFFER_FOR_YOU_TITLE, twin, body: <OfferSignInPage self={self} /> }
  if (result.kind === 'unavailable') {
    return { kind: 'page', status: 404, title: OFFER_UNAVAILABLE_TITLE, twin, body: <OfferUnavailablePage sentence={result.sentence} /> }
  }
  return {
    kind: 'page',
    title: result.offer.label || 'Subscription offer',
    twin,
    body: (
      <OfferPage
        offer={result.offer}
        code={params.code}
        viewer={viewer}
        csrf={csrf}
        self={self}
        askTerms={url.searchParams.get('error') === 'subscribe_terms'}
        cardFix={CARD_FIX_CODES.has(url.searchParams.get('error') ?? '')}
      />
    ),
  }
})

export const moneySettingsGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const prefs = viewer.money?.stripeConnectKycComplete ? await loadPayoutPrefs(gw) : null
  return {
    kind: 'page',
    title: 'Card and payouts',
    twin: '/settings',
    body: <MoneySettingsPage viewer={viewer} csrf={csrf} prefs={prefs} />,
  }
})

// ---------------------------------------------------------------------------
// The rest (E6, §D2.3): messages, the two logs, Settings, the dashboard, a
// feed's settings and the source lookup, an appeal and the account export.
// ---------------------------------------------------------------------------

/**
 * A gift link, redeemed. SECONDARY: a spent or revoked link is not a fault,
 * and the full site only logs one; the gate then says what the member can read.
 */
async function redeemGift(gw: Parameters<typeof call>[0], dTag: string, token: string): Promise<void> {
  try {
    const a = await call<{ id?: string }>(gw, 'GET', path`/articles/${dTag}`)
    if (a.status !== 200 || typeof a.body?.id !== 'string') return
    const r = await call(gw, 'POST', path`/articles/${a.body.id}/redeem-gift`, { json: { token } })
    if (r.status !== 200) console.warn('[modernhaus] gift link not redeemed', r.status)
  } catch (err) {
    console.warn('[modernhaus] gift link redeem failed', err instanceof GatewayFault ? err.message : err)
  }
}

export const messagesGET = modernhausPage(async ({ gw, viewer, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const rows = await loadInbox(gw)
  return { kind: 'page', title: MESSAGES_TITLE, twin: '/messages', body: <InboxPage rows={rows} /> }
})

export const messageThreadGET = modernhausPage<{ conversationId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadMessageThread(gw, params.conversationId, url.searchParams.get('before'))
  if (!data) return notFound
  const relation = await loadRelation(gw, data)
  return {
    kind: 'page',
    title: threadTitle(data),
    twin: `/messages/${enc(params.conversationId)}`,
    body: <MessageThreadPage data={data} viewer={viewer} csrf={csrf} relation={relation} />,
  }
})

export const messagesNewGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const q = (url.searchParams.get('q') ?? '').trim()
  const lookup = q ? await lookupRecipient(gw, q) : null
  return { kind: 'page', title: MESSAGES_NEW_MESSAGE_TITLE, twin: '/messages', body: <NewMessagePage csrf={csrf} q={q} lookup={lookup} /> }
})

export const libraryGET = modernhausPage(async ({ gw, viewer, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadLibrary(gw, parseOffset(url.searchParams.get('offset')))
  return { kind: 'page', title: LIBRARY_TITLE, twin: '/library', body: <LibraryPage data={data} /> }
})

export const historyGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadHistory(gw, parseOffset(url.searchParams.get('offset')))
  return { kind: 'page', title: LIBRARY_TAB_RECENT, twin: '/history', body: <HistoryPage data={data} csrf={csrf} /> }
})

export const settingsGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const facts = await loadAccountFacts(gw)
  return { kind: 'page', title: SETTINGS_TITLE, twin: '/settings', body: <SettingsIndexPage facts={facts} csrf={csrf} /> }
})

export const settingsAccountGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const facts = await loadAccountFacts(gw)
  return {
    kind: 'page',
    title: SETTINGS_GROUP_ACCOUNT,
    twin: '/settings',
    body: <AccountSettingsPage facts={facts} csrf={csrf} now={new Date()} />,
  }
})

export const settingsDeleteGET = modernhausPage(async ({ viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  return { kind: 'page', title: DELETE_CONFIRM_TITLE, twin: '/settings', body: <DeleteAccountPage csrf={csrf} /> }
})

export const settingsNetworksGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const networks = await loadNetworks(gw)
  return { kind: 'page', title: SETTINGS_REACH_LABEL, twin: '/settings', body: <NetworksPage networks={networks} csrf={csrf} /> }
})

export const settingsImportGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const networks = await loadNetworks(gw)
  const importable = networks.capabilities.followImportProtocols ?? []
  // Dark, or no network importable: the page is not there (a button that
  // cannot do its job is not offered, and neither is its page).
  if (importable.length === 0) return notFound
  const q = (url.searchParams.get('q') ?? '').trim()
  let found: Parameters<typeof FollowImportLookupPage>[0]['found'] = null
  if (q) {
    const lookup = await lookupSource(gw, q, 'import')
    if (lookup.kind !== 'result') found = 'none'
    else {
      const options = resolveMatches(q, lookup.result.matches)
      const candidates = options.filter(
        (o) => o.add.sourceType === 'external_source' && 'sourceUri' in o.add && importable.includes(o.add.protocol),
      )
      found = options.length === 0 ? 'none' : { candidates, unimportable: candidates.length === 0 }
    }
  }
  return {
    kind: 'page',
    title: FOLLOW_IMPORT_TITLE,
    twin: '/settings',
    body: <FollowImportLookupPage csrf={csrf} q={q} importable={importable} found={found} />,
  }
})

export const settingsImportsGET = modernhausPage(async ({ gw, viewer, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const ids = url.searchParams.getAll('id').slice(0, 10)
  const runs = (await Promise.all(ids.map((id) => loadFollowImport(gw, id)))).filter((r): r is FollowImportRun => r !== null)
  if (runs.length === 0) return notFound
  return {
    kind: 'page',
    title: FOLLOW_IMPORT_TITLE,
    twin: '/settings',
    body: <FollowImportStatusPage runs={runs} self={selfPath(url)} />,
  }
})

export const settingsPrivacyGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadPrivacy(gw)
  return { kind: 'page', title: 'Privacy', twin: '/settings', body: <PrivacyPage data={data} csrf={csrf} /> }
})

export const settingsNotificationsGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const prefs = await loadNotificationPrefs(gw)
  return {
    kind: 'page',
    title: SETTINGS_NOTIFICATIONS_LABEL,
    twin: '/settings',
    body: <NotificationPrefsPage prefs={prefs} csrf={csrf} />,
  }
})

export const dashboardGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const articles = await loadMyArticles(gw)
  return { kind: 'page', title: 'Dashboard', twin: '/dashboard', body: <DashboardPage articles={articles} csrf={csrf} /> }
})

export const dashboardArticleGET = modernhausPage<{ articleId: string }>(async ({ req, gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const data = await loadArticleManage(gw, params.articleId)
  if (!data) return notFound
  return {
    kind: 'page',
    title: data.article.title?.trim() || 'Untitled',
    twin: '/dashboard',
    body: <ArticleManagePage data={data} csrf={csrf} origin={requestOrigin(req)} />,
  }
})

export const dashboardPricingGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const [facts, welcome] = await Promise.all([loadAccountFacts(gw), loadWelcome(gw)])
  return {
    kind: 'page',
    title: 'Pricing',
    twin: '/dashboard?tab=pricing',
    body: (
      <PricingPage
        facts={facts}
        welcome={welcome}
        kycComplete={viewer.money ? viewer.money.stripeConnectKycComplete : null}
        csrf={csrf}
      />
    ),
  }
})

export const dashboardOffersGET = modernhausPage(async ({ req, gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const offers = await loadOffers(gw)
  return {
    kind: 'page',
    title: 'Proposals',
    twin: '/dashboard?tab=proposals',
    body: <OffersPage offers={offers} csrf={csrf} origin={requestOrigin(req)} />,
  }
})

export const dashboardSubscribersGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const refused = readerOnWriterPage(viewer, csrf, url)
  if (refused) return refused
  const subscribers = await loadSubscribers(gw)
  return { kind: 'page', title: 'Subscribers', twin: '/dashboard?tab=subscribers', body: <SubscribersPage subscribers={subscribers} /> }
})

export const feedSettingsGET = modernhausPage<{ feedId: string }>(async ({ gw, viewer, csrf, params, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const data = await loadFeedSettings(gw, params.feedId)
  if (!data) return notFound
  return {
    kind: 'page',
    title: `${feedLabel(data.feed, null)}: settings`,
    twin: '/reader',
    body: <FeedSettingsPage data={data} csrf={csrf} />,
  }
})

async function resolvePage(
  r: { gw: Parameters<typeof call>[0]; viewer: Viewer | null; csrf: string; url: URL },
  lookup: (feed: WorkspaceFeed, q: string) => Promise<SourceLookup>,
): Promise<PageResult> {
  if (!r.viewer) return signIn(r.url)
  const feed = (await loadFeeds(r.gw)).find((f) => f.id === r.url.searchParams.get('feed'))
  if (!feed) return notFound
  const q = (r.url.searchParams.get('q') ?? '').trim()
  return {
    kind: 'page',
    title: FEED_ADD_SOURCE_LABEL,
    twin: null,
    body: <ResolvePage csrf={r.csrf} feed={feed} q={q} lookup={await lookup(feed, q)} />,
  }
}

export const resolveGET = modernhausPage(async ({ gw, viewer, csrf, url }): Promise<PageResult> => {
  const q = (url.searchParams.get('q') ?? '').trim()
  if (viewer && !q) {
    const feed = url.searchParams.get('feed')
    return { kind: 'redirect', location: feed ? `/modernhaus/feed/${enc(feed)}/settings` : '/modernhaus' }
  }
  return resolvePage({ gw, viewer, csrf, url }, (_feed, query) => lookupSource(gw, query, 'subscribe'))
})

export const resolvePollGET = modernhausPage<{ requestId: string }>(async ({ gw, viewer, csrf, params, url }) =>
  resolvePage({ gw, viewer, csrf, url }, () => pollSource(gw, params.requestId)),
)

export const appealGET = modernhausPage<{ reportId: string }>(async ({ csrf, params, url }) => {
  const token = url.searchParams.get('token')
  return {
    kind: 'page',
    title: token ? APPEAL_FORM_TITLE : APPEAL_INCOMPLETE_TITLE,
    twin: null,
    body: <AppealPage csrf={csrf} reportId={params.reportId} token={token} />,
  }
})

export const exportGET = modernhausPage(async ({ viewer, csrf, url }): Promise<PageResult> => {
  if (!viewer) return signIn(url)
  const token = url.searchParams.get('token')
  return {
    kind: 'page',
    title: token ? EXPORT_WORKING_TITLE : EXPORT_USED_TITLE,
    // No twin: the full site's export page spends the token on load.
    twin: null,
    body: <ExportPage csrf={csrf} token={token} />,
  }
})

/** Any other `/modernhaus/…` address: the register's own 404, not the full site's. */
export const notFoundGET = modernhausPage(async () => notFound)

export async function doorPOST(req: Request, args: { params: { action: string } }): Promise<Response> {
  return handleDoor(req, args.params.action, REGISTRY)
}
