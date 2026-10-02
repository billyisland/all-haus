import type { ArticleMetadata } from '../lib/api/articles'
import type { UnlockErrorView } from '../lib/unlock-errors'
import {
  paywallGateCopy,
  paywallCardLink,
  paywallSubscribeOffer,
  PAYWALL_ACCEPT_AND_CONTINUE,
  PAYWALL_SUBSCRIBE,
  PAYWALL_LOG_IN,
  PAYWALL_SIGN_UP,
  PAYWALL_WAITLIST,
  ALLOWANCE_SPENT_LEAD,
  ALLOWANCE_SPENT_NEXT,
} from '../content/paywall'
import { TERMS_PURPOSE } from '../content/terms-consent'
import { SUBSCRIBE_ACCEPT } from '../content/ledger'
import { call, path, query, GatewayFault, type GatewayContext } from './gateway'
import { loadArticle } from './loaders'
import { loadArticleConversation, type ArticleConversation } from './member-loaders'
import { deliverPaidHalf, type GatePassBody } from './unlock'
import { ArticlePage } from './pages/reading'
import { ArticleFoot } from './pages/conversation'
import { TermsConsentBox } from './consent'
import { PostForm, Hidden, Unavailable, type Viewer } from './html'

// =============================================================================
// modernhaus — an article, whole (§D2.3, §D2.6), assembled ONCE for its two
// ways of being drawn: the GET, and the unlock's POST, which renders the page
// directly with the paid half in place (§D1.3 — never a redirect, because
// re-reading it on a GET would re-run the gate pass on a page load).
//
// What sits under the free half is one of:
//   - nothing, for a free piece;
//   - the paid half, rendered, when a press (or the arrival landing) opened it;
//   - the gate: for a member, one form whose press is the unlock, in the full
//     site's words (`paywallGateCopy`), with a refusal said in place through
//     `mapUnlockError` — its `needsTerms` REPLACES the button with the consent,
//     its `needsCard` links to the full site's settings (Decision 2); for the
//     signed-out, the ways in.
//
// THE CONVERSATION IS THE VIEWER'S. `GET /replies`'s `paywallLocked` answers
// for THIS viewer (it runs `checkArticleAccess`), so a reader who has paid, a
// subscriber and the writer see the conversation, and everybody else sees
// nothing below the gate (ARTICLE-HEADED-CONVERSATIONS-ADR §6a). The same
// answer tells the gate a member can already read the piece, and the button
// then says the re-read is free rather than asking them to buy it again.
// =============================================================================

/** What stands under the free half. */
export type PaidState =
  | { kind: 'locked' }
  | { kind: 'open'; html: string; allowanceSpent: boolean }
  /** The gate pass refused, before any money moved. */
  | { kind: 'refused'; view: UnlockErrorView }
  /** The read is recorded; its body could not be handed over. Retrying is free. */
  | { kind: 'undelivered'; sentence: string }
  /** The acceptance the press carried was refused (the text moved, or it failed). */
  | { kind: 'terms_refused'; sentence: string }

export interface SignupOffer {
  freeAllowancePence: number
  arrivalGiftCapPence: number
}

export interface ArticleView {
  article: ArticleMetadata
  freeHtml: string
  paid: PaidState
  convo: ArticleConversation
  /** Signed out: what a new account comes with, or null for "none can be made". */
  signupOffer: SignupOffer | null
  /** A member's subscription to the writer: true, false, or null for unknown. */
  subscribed: boolean | null
}

/**
 * Can an account be made, and what does it come with? `GET /auth/open` answers
 * 200 with the figures or 404; anything else is "we could not find out", which
 * is null — the full site's rule: the one thing worse than not making the offer
 * is making it and then refusing the reader who accepted it.
 */
async function loadSignupOffer(gw: GatewayContext): Promise<SignupOffer | null> {
  try {
    const a = await call<{ freeAllowancePence?: unknown; arrivalGiftCapPence?: unknown }>(gw, 'GET', '/auth/open')
    if (a.status !== 200 || !a.body) return null
    const free = Number(a.body.freeAllowancePence)
    const cap = Number(a.body.arrivalGiftCapPence)
    return Number.isFinite(free) && Number.isFinite(cap) ? { freeAllowancePence: free, arrivalGiftCapPence: cap } : null
  } catch (err) {
    console.warn('[modernhaus] /auth/open unreadable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

async function loadSubscribed(gw: GatewayContext, writerId: string): Promise<boolean | null> {
  try {
    const a = await call<{ subscribed?: unknown }>(gw, 'GET', path`/subscriptions/check/${writerId}`)
    return a.status === 200 && typeof a.body?.subscribed === 'boolean' ? a.body.subscribed : null
  } catch (err) {
    console.warn('[modernhaus] subscription check unavailable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

/**
 * THE ARRIVAL LANDING (PAYWALL-ARRIVAL §3, §11.4), as the full site's reader
 * mount makes it: asked for any member on a paywalled piece that is not their
 * own; the server answers `arrival: false` for everyone who did not create
 * their account from THIS piece, and performs a gate pass only when the read
 * costs the reader nothing. Its failure is "not an arrival" — the gate stands
 * with its ordinary button — never a fault.
 */
async function landArrival(gw: GatewayContext, dTag: string): Promise<GatePassBody | null> {
  try {
    const a = await call<{ arrival?: unknown; gatePass?: unknown }>(gw, 'POST', path`/articles/${dTag}/arrival`, { json: {} })
    if (a.status !== 200 || a.body?.arrival !== true || !a.body.gatePass || typeof a.body.gatePass !== 'object') return null
    return a.body.gatePass as GatePassBody
  } catch (err) {
    console.warn('[modernhaus] arrival unreadable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

/**
 * Everything the article page reads. Null is "no piece this viewer may read at
 * that address" (the route's 404); a fault throws.
 *
 * `press` is the unlock's result, when this is the unlock's own response; a GET
 * passes none, and then — for a member — the arrival landing runs, as it does
 * on the full site's mount. `log` is the reading-log record, which belongs to
 * the open (the GET), never to the unlock (posts.md: one writer, the mount).
 */
export async function loadArticleView(
  gw: GatewayContext,
  viewer: Viewer | null,
  dTag: string,
  opts: { offset: number; focus: string | null; press?: PaidState; log: boolean },
): Promise<ArticleView | null> {
  const loaded = await loadArticle(gw, opts.log ? viewer : null, dTag)
  if (!loaded) return null
  const { article, freeHtml } = loaded

  let paid: PaidState = opts.press ?? { kind: 'locked' }
  const own = !!viewer && viewer.id === article.writer.id
  if (!opts.press && viewer && article.isPaywalled && !own) {
    const pass = await landArrival(gw, article.dTag)
    if (pass) {
      const delivered = await deliverPaidHalf(gw, pass)
      // An arrival whose delivery failed leaves the gate standing with its
      // ordinary button, as the full site does: retrying is free.
      if (delivered.kind === 'open') paid = { kind: 'open', html: delivered.html, allowanceSpent: false }
    }
  }

  const [convo, signupOffer, subscribed] = await Promise.all([
    loadArticleConversation(gw, viewer, article.nostrEventId, article.postId, opts.offset, opts.focus),
    viewer || !article.isPaywalled ? Promise.resolve(null) : loadSignupOffer(gw),
    viewer && article.isPaywalled && !own ? loadSubscribed(gw, article.writer.id) : Promise.resolve(null),
  ])
  return { article, freeHtml, paid, convo, signupOffer, subscribed }
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

/** The member already holds access (the conversation's own answer said so). */
export const PAYWALL_ALREADY_YOURS = 'You can already read this piece, so reading the rest costs nothing.'
export const PAYWALL_READ_THE_REST = 'Read the rest'

function pounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`
}

/** The full site's settings, where a card is added (Decision 2: card entry links out). */
const CARD_HOME = '/settings'

function CardLink(props: { hasCard: boolean }) {
  return (
    <p>
      <a href={CARD_HOME}>{paywallCardLink(props.hasCard)}</a>
      {' — on the full site, which takes the card.'}
    </p>
  )
}

function SignedOutGate(props: { article: ArticleMetadata; offer: SignupOffer | null; self: string }) {
  const copy = paywallGateCopy({
    isLoggedIn: false,
    signupOffer: props.offer,
    hasPaymentMethod: false,
    freeAllowanceRemaining: 0,
    pricePence: props.article.pricePence,
  })
  const back = query({ return: props.self })
  return (
    <section>
      <h2>{copy.heading}</h2>
      <p>{copy.subtext}</p>
      <ul>
        <li>
          <a href={`/modernhaus/signin${back}`}>{PAYWALL_LOG_IN}</a>
        </li>
        <li>
          {props.offer ? (
            <a href={`/modernhaus/signup${back}`}>{PAYWALL_SIGN_UP}</a>
          ) : (
            <a href="/modernhaus/waitlist">{PAYWALL_WAITLIST}</a>
          )}
        </li>
      </ul>
    </section>
  )
}

function MemberGate(props: {
  view: ArticleView
  viewer: Viewer
  csrf: string
  self: string
  hasAccess: boolean | null
}) {
  const { article, paid } = props.view
  const money = props.viewer.money
  const refusal = paid.kind === 'refused' ? paid.view : null
  const needsTerms = refusal?.needsTerms ?? false
  const terms = props.viewer.terms?.reader

  // Unknown money facts are said, never guessed: the gate's sentence depends
  // on a card and an allowance this page could not read, so it names only
  // the price and still offers the press, whose refusal will say the rest.
  const copy = money
    ? paywallGateCopy({
        isLoggedIn: true,
        signupOffer: null,
        hasPaymentMethod: money.hasPaymentMethod,
        freeAllowanceRemaining: money.freeAllowanceRemainingPence,
        pricePence: article.pricePence,
        writerName: article.writer.displayName ?? article.writer.username,
      })
    : null
  const sentence =
    props.hasAccess === true
      ? PAYWALL_ALREADY_YOURS
      : copy
        ? copy.subtext
        : `The rest of this piece costs ${article.pricePence !== null ? pounds(article.pricePence) : 'a price we could not read'}.`
  const cardFix = !!refusal?.needsCard || (money && !money.hasPaymentMethod && copy?.suggestCard && props.hasAccess !== true)

  return (
    <PostForm action="unlock" csrf={props.csrf}>
      <Hidden values={{ dTag: article.dTag }} />
      <fieldset>
        <legend>{copy?.heading ?? 'Keep reading'}</legend>
        <p>{sentence}</p>
        {copy?.showPrice && props.hasAccess !== true && article.pricePence !== null && <p>{pounds(article.pricePence)}</p>}
        {refusal && <p role="alert">{refusal.message}</p>}
        {paid.kind === 'undelivered' && <p role="alert">{paid.sentence}</p>}
        {paid.kind === 'terms_refused' && <p role="alert">{paid.sentence}</p>}
        {needsTerms || paid.kind === 'terms_refused' ? (
          terms ? (
            // THE CONSENT REPLACES THE BUTTON; accepting IS continuing.
            <>
              <TermsConsentBox kind="reader" purpose={TERMS_PURPOSE.read} state={terms} />
              <p>
                <button>{PAYWALL_ACCEPT_AND_CONTINUE}</button>
              </p>
            </>
          ) : (
            <p>
              <a href={`/article/${encodeURIComponent(article.dTag)}`}>Accept the Reader Terms on the full site</a>
              {', then come back and press again.'}
            </p>
          )
        ) : (
          <p>
            <button>{props.hasAccess === true ? PAYWALL_READ_THE_REST : (copy?.buttonLabel ?? 'Continue reading')}</button>
          </p>
        )}
        {cardFix && <CardLink hasCard={money?.hasPaymentMethod ?? false} />}
      </fieldset>
    </PostForm>
  )
}

/** "Or subscribe to …" under the gate — its own form, and its consent in place of its button. */
function SubscribeUnderGate(props: { view: ArticleView; viewer: Viewer; csrf: string; self: string; askTerms: boolean }) {
  const { article } = props.view
  const price = article.writer.subscriptionPricePence ?? 0
  if (props.view.subscribed !== false || price <= 0 || article.publication !== null) return null
  const offer = paywallSubscribeOffer(article.writer.displayName ?? article.writer.username, price)
  const terms = props.viewer.terms?.reader
  return (
    <PostForm action="subscribe" csrf={props.csrf}>
      <Hidden values={{ writerId: article.writer.id, period: 'monthly', return: props.self }} />
      <p>
        {offer.before}
        <strong>{offer.price}</strong>
        {offer.after}
      </p>
      {props.askTerms && terms ? (
        <>
          <TermsConsentBox kind="reader" purpose={TERMS_PURPOSE.subscribe} state={terms} />
          <p>
            <button>{SUBSCRIBE_ACCEPT}</button>
          </p>
        </>
      ) : (
        <p>
          <button>{PAYWALL_SUBSCRIBE}</button>
        </p>
      )}
    </PostForm>
  )
}

export function ArticleViewPage(props: {
  view: ArticleView
  viewer: Viewer | null
  csrf: string
  /** This page's own address, the return every press on it comes back to. */
  self: string
  /** `?error=subscribe_terms` came back from the subscribe under the gate. */
  askSubscribeTerms: boolean
  /** The last subscribe press was refused for want of a working card. */
  cardFix?: boolean
}) {
  const { view, viewer } = props
  const { article, paid, convo } = view
  const isOwnPiece = !!viewer && viewer.id === article.writer.id
  // For a paywalled piece the conversation's answer is the viewer's access.
  const hasAccess = !article.isPaywalled ? true : convo.kind === 'open' ? true : convo.kind === 'locked' ? false : null
  const target =
    article.nostrEventId && article.writer.pubkey
      ? {
          eventId: article.nostrEventId,
          eventKind: 30023,
          authorPubkey: article.writer.pubkey,
          authorName: article.writer.displayName ?? article.writer.username,
        }
      : null

  let below = null
  if (article.isPaywalled) {
    if (paid.kind === 'open') {
      below = (
        <>
          <div dangerouslySetInnerHTML={{ __html: paid.html }} />
          {paid.allowanceSpent && (
            <section>
              <p>{ALLOWANCE_SPENT_LEAD}</p>
              <p>{ALLOWANCE_SPENT_NEXT}</p>
              {!viewer?.money?.hasPaymentMethod && <CardLink hasCard={false} />}
            </section>
          )}
        </>
      )
    } else if (!viewer) {
      below = <SignedOutGate article={article} offer={view.signupOffer} self={props.self} />
    } else {
      below = (
        <>
          <MemberGate view={view} viewer={viewer} csrf={props.csrf} self={props.self} hasAccess={hasAccess} />
          {props.cardFix && <CardLink hasCard={viewer.money?.hasPaymentMethod ?? false} />}
          {!isOwnPiece && hasAccess !== true && (
            <SubscribeUnderGate view={view} viewer={viewer} csrf={props.csrf} self={props.self} askTerms={props.askSubscribeTerms} />
          )}
        </>
      )
    }
  }

  return (
    <>
      <ArticlePage article={article} freeHtml={view.freeHtml} below={below} />
      {viewer && !isOwnPiece && article.nostrEventId && (
        <p>
          <a href={`/modernhaus/report${query({ target: `event:${article.nostrEventId}`, return: props.self })}`}>Report this piece</a>
        </p>
      )}
      {isOwnPiece && !article.withdrawn && (
        <p>
          <a href={`/modernhaus/write${query({ edit: article.dTag })}`}>Edit this piece</a>
        </p>
      )}
      {convo.kind === 'unavailable' && <Unavailable what="The conversation" />}
      {convo.kind === 'open' && (
        <ArticleFoot
          target={target}
          self={props.self}
          viewer={viewer}
          csrf={props.csrf}
          repliesEnabled={convo.repliesEnabled}
          posts={convo.posts}
          topLevel={convo.topLevel}
          totalReplies={convo.totalReplies}
          next={
            convo.nextOffset !== null
              ? `/modernhaus/article/${encodeURIComponent(article.dTag)}${query({ replies: convo.nextOffset })}`
              : null
          }
          votes={convo.votes}
        />
      )}
    </>
  )
}
