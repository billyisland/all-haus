'use client'

import { useState, useEffect, useRef, type RefObject } from 'react'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { GiftLinkPanel } from './GiftLinkPanel'
import { QuoteSelector } from './QuoteSelector'
import { unwrapContentKey, decryptVaultContent, vaultAlgorithm } from '../../lib/vault'
import { mapUnlockError } from '../../lib/unlock-errors'
import { mapSubscribeError } from '../../lib/subscribe-errors'
import { ApiError } from '../../lib/api/client'
import { PAYWALL_NO_CIPHERTEXT, PAYWALL_AFTER_PAYMENT } from '../../content/paywall'
import { renderMarkdown } from '../../lib/markdown'
import { Avatar } from '../ui/Avatar'
import { ReportButton } from '../ui/ReportButton'
import { ShareButton } from '../ui/ShareButton'
import { ReplySection } from '../replies/ReplySection'
import { AllowanceExhaustedModal } from '../ui/AllowanceExhaustedModal'
import { ArrivalWelcome } from './ArrivalWelcome'
import { UpstreamEdges } from './UpstreamEdges'
import { useCitationDraft } from '../../stores/citationDraft'
import { DraftWatermark } from './DraftWatermark'
import { articles as articlesApi, auth as authApi, subscriptions as subscriptionsApi, giftLinks, upstreamEdgesEnabled, signupOffer, type SignupOffer } from '../../lib/api'
import { useReadingPosition } from '../../hooks/useReadingPosition'
import { useReadingLog } from '../../hooks/useReadingLog'
import { useBodyImageLightbox } from '../../hooks/useBodyImageLightbox'
import { EnlargeableImage } from '../ui/EnlargeableImage'
import type { ArticleEvent } from '../../lib/ndk'
import { ProfileLink } from '../ui/ProfileLink'
import { InwardLink } from '../ui/InwardLink'
import { formatPublishedDate } from '../../lib/format'
import { ARTICLE_WITHDRAWN_NOTICE } from '../../content/article'
import { termsVersionMismatch, TERMS_ACCEPT_FAILED } from '../../content/terms-consent'

/**
 * What the reader needs of an article, with the three fields a NEVER-PUBLISHED
 * draft cannot have made optional.
 *
 * Deliberately a local widening rather than a loosening of the shared
 * `ArticleEvent`: an `ArticleEvent` is assignable to this, so the three
 * existing callers are untouched, and every OTHER consumer of that type keeps
 * its `id`/`pubkey`/`dTag` as the strings they are. Making them optional on the
 * shared type would have made a draft's absence everybody's problem.
 *
 * The point of the widening is that `tsc` now finds every place the reader
 * spends one of the three, which is the same list the `preview` suppression
 * below has to cover. NEVER fill them with `''` to quieten it: an empty-string
 * event id reaching `ReportButton` or the unlock cache is exactly the class of
 * bug the suppression exists to prevent, and it would not throw.
 */
type ReadableArticle = Omit<ArticleEvent, 'id' | 'pubkey' | 'dTag'> & {
  id?: string
  pubkey?: string
  dTag?: string
}

interface ArticleReaderProps {
  article: ReadableArticle
  /** DRAFT PREVIEW (ARTICLE-EDITOR-PLAN slice 4). The writer looking at their
   *  own unpublished draft through the real reader, so there is one body and a
   *  seam rather than a parallel presentational component that would drift.
   *
   *  It suppresses everything that reads or writes state about a piece that
   *  does not exist yet: the reading log, the scroll-position write, the
   *  arrival and offer fetches, the viewer-nudge re-read, the gift redeem, the
   *  subscription check, subscribe / unlock / gift / report / share, the reply
   *  section, and the `sessionStorage` unlock cache — read under preview it
   *  would surface a real article's cached body, written it would cache a
   *  draft's. A paywalled draft renders a STATIC band with the gated body BELOW
   *  it: the writer must see their own whole piece, and a preview that hides
   *  half of it is the thing they were trying to check. */
  preview?: boolean
  /** Under `preview`, the markdown BELOW the gate — rendered beneath the static
   *  band. Split by `splitAtGateMarker`, the same function publish uses, so the
   *  preview cannot put the gate somewhere readers will not find it. */
  previewPaywallBody?: string | null
  /** The piece's `post_id` (READING-LOG-AND-LIBRARY-ADR D8) — the single key
   *  both the reading log and the scroll-position table take, resolved
   *  server-side and carried on the article payload. Absent ⇒ neither is
   *  recorded, which is the honest behaviour for a caller that cannot name the
   *  piece; never derive one here. */
  postId?: string | null
  /** A comment to bring into view once the conversation below has loaded — a
   *  notification's errand, carried by the reader pane. The page route reads
   *  the `#reply-<id>` hash instead. */
  focusCommentId?: string | null
  /** The element that actually scrolls. Omitted on a page (the document
   *  scrolls); ReaderOverlay passes the pane's own scrolling div, without which
   *  the resume hook measures a document that never moves and silently records
   *  nothing (D9). */
  scrollRef?: RefObject<HTMLElement | null>
  articleDbId?: string
  writerName: string
  writerUsername: string
  writerAvatar?: string
  writerId?: string
  subscriptionPricePence?: number
  writerSpendThisMonthPence?: number
  preRenderedFreeHtml?: string
  /** Writer 3.4: the writer has withdrawn this piece and the viewer paid for
   *  it, so it still opens — and the reader is told why it is here. */
  withdrawn?: boolean
  publicationName?: string
  publicationSlug?: string
  // Slice 23b: explicit cover image (NIP-23 image tag). When set, wins over
  // the legacy first-inline-image scrape and the body markdown is rendered
  // unchanged (no stripHeroImage call). Pre-23b articles fall through to
  // the scrape path below.
  coverImageUrl?: string | null
}

// Extract first image from markdown content
function extractHeroImage(content: string): string | null {
  const mdMatch = content.match(/^!\[.*?\]\((.+?)\)/m)
  if (mdMatch) return mdMatch[1]
  const urlMatch = content.match(/^(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?)$/m)
  if (urlMatch) return urlMatch[1]
  const blossomMatch = content.match(/^(https?:\/\/\S+\/[a-f0-9]{64}(?:\.webp)?)\s*$/m)
  if (blossomMatch) return blossomMatch[1]
  return null
}

// Strip the hero image from content so it's not rendered twice
function stripHeroImage(content: string, heroUrl: string): string {
  return content
    .replace(new RegExp(`!\\[.*?\\]\\(${heroUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*`), '')
    .replace(new RegExp(`^${heroUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), '')
    .trim()
}

export function ArticleReader({ article, preview = false, previewPaywallBody, postId, focusCommentId, scrollRef, articleDbId, writerName, writerUsername, writerAvatar, writerId, subscriptionPricePence, writerSpendThisMonthPence, preRenderedFreeHtml, publicationName, publicationSlug, coverImageUrl, withdrawn = false }: ArticleReaderProps) {
  const { user } = useAuth()
  // Under preview the gated body is seeded from the draft itself, so the piece
  // reads as unlocked and the static band stands in for the gate.
  const [paywallBody, setPaywallBody] = useState<string | null>(previewPaywallBody ?? null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlockNeedsCard, setUnlockNeedsCard] = useState(false)
  // The gate's third state: a reader who HAS a card but registered it before
  // the Reader Terms existed. Neither a card nor money is the fix, so this is
  // its own flag rather than a shade of `unlockNeedsCard`.
  const [unlockNeedsTerms, setUnlockNeedsTerms] = useState(false)
  const [acceptingTerms, setAcceptingTerms] = useState(false)
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [freeHtml, setFreeHtml] = useState<string>(preRenderedFreeHtml ?? '')
  const [paywallHtml, setPaywallHtml] = useState<string>('')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  // Which press the Reader Terms consent interrupted — accepting resumes it.
  const subscribeInterrupted = useRef(false)
  // The Share trigger the gift-link panel hangs off; null while it is closed.
  const [giftAnchor, setGiftAnchor] = useState<RefObject<HTMLElement | null> | null>(null)
  const [offer, setOffer] = useState<SignupOffer | null>(null)
  const [arrival, setArrival] = useState<{ welcomeGiftPence: number; unlocked: boolean } | null>(null)
  // Viewer-derived, and NOT from this page's SSR (see the effect below).
  const [viewerNudge, setViewerNudge] = useState<{
    writerSpendThisMonthPence?: number
  } | null>(null)
  const seamRef = useRef<HTMLDivElement>(null)

  const isOwnContent = user?.id === writerId
  const articleBodyRef = useRef<HTMLDivElement>(null)
  const paywallBodyRef = useRef<HTMLDivElement>(null)
  const setCitationDraft = useCitationDraft((s) => s.setDraft)

  // Both OFF under preview: a draft has no post_id, and a writer checking
  // their own layout is not reading the piece.
  useReadingPosition({ postId, enabled: !!user && !preview, scrollRef, skipRestore: !!focusCommentId })

  // THE READING LOG'S WRITE, ON MOUNT — not on unlock (ADR §8.3). The two look
  // identical in every ordinary session and differ for exactly one reader: the
  // above-cap arrival (PAYWALL-ARRIVAL D4 Path C), who met the paywall, read
  // what sits above it, and by §8.1 has a true row and a tour beat pointing at
  // it. Recent reading is attention; the library is possession.
  useReadingLog(postId, !!user && !preview)

  // Explicit cover wins over the legacy scrape; when one is set the body
  // markdown is left intact (no stripHeroImage), so the same author can put
  // an image at the top of their body without it being silently swallowed.
  const heroImage = coverImageUrl ?? extractHeroImage(article.content)
  const contentWithoutHero =
    coverImageUrl
      ? article.content
      : heroImage
        ? stripHeroImage(article.content, heroImage)
        : article.content

  useEffect(() => { if (!preRenderedFreeHtml) void renderMarkdown(contentWithoutHero).then(setFreeHtml) }, [contentWithoutHero, preRenderedFreeHtml])
  useEffect(() => { if (paywallBody) void renderMarkdown(paywallBody).then(setPaywallHtml) }, [paywallBody])
  // Body pictures open the lightbox, mouse and keyboard — the free body and
  // the unlocked one alike (the hero is an EnlargeableImage below).
  useBodyImageLightbox(articleBodyRef, freeHtml)
  useBodyImageLightbox(paywallBodyRef, paywallBody ? paywallHtml : null)
  // The decrypted paid body, cached so a reader who has already paid does not
  // re-run the gate pass on every remount. THE KEY CARRIES THE VIEWER (MIRROR-
  // AUDIT §3 *Security*, S16): it was `unlocked:<article>` alone, so the entry
  // one reader paid for was read back for whoever held the tab next — a shared
  // laptop, a session that expired and was signed into by someone else, an
  // account switch that did not go through the explicit logout that sweeps these.
  // The author earned nothing for that read and no gate pass ever ran.
  //
  // Keying on the viewer means a different reader simply finds nothing, which is
  // the correct outcome rather than a cleanup that has to fire. `logout()`'s
  // `unlocked:` sweep (stores/auth.ts) still runs and still matches this prefix;
  // it is now defence in depth rather than the only thing standing there.
  //
  // Signed out ⇒ no key at all, so the cache cannot be read or written: an
  // anonymous viewer has no paid read to remember.
  // Null under preview: read, it would surface a real article's cached body
  // against a draft; written, it would cache a draft's under an id that is not
  // one. A draft has no `article.id` at all, so the key could only be a lie.
  const unlockedKey = user && !preview && article.id ? `unlocked:${user.id}:${article.id}` : null
  const cacheUnlocked = (body: string) => {
    if (!unlockedKey) return
    try { sessionStorage.setItem(unlockedKey, body) } catch { /* quota — cache only */ }
  }
  useEffect(() => {
    if (!article.isPaywalled || !unlockedKey) return
    try {
      const cached = sessionStorage.getItem(unlockedKey)
      if (cached) setPaywallBody(cached)
    } catch { /* private mode */ }
  }, [unlockedKey, article.isPaywalled])

  // What a new account comes with, for the LOGGED-OUT gate's copy. Asked of the
  // server rather than carried as a second copy of `CLOSED_BETA`; null means
  // "no account can be made", which is also the answer when the probe could not
  // resolve — see `signupOffer`.
  useEffect(() => {
    if (user || preview) return
    let cancelled = false
    void signupOffer().then((o) => { if (!cancelled) setOffer(o) })
    return () => { cancelled = true }
  }, [user])

  // THE ARRIVAL LANDING (PAYWALL-ARRIVAL §3, §11.4). Fires once per mount for
  // any authenticated reader; the server answers `arrival: false` for everyone
  // who did not create their account from THIS piece, which is the only test
  // that can tell an arrival from a member signing in at the same gate. The
  // gate pass it may perform is bounded server-side to a read that costs
  // nothing — no money leaves a reader on a page load.
  //
  // Suppressed for the rest of the browser session once answered, so a reload
  // does not re-raise the aside. The MEMBER-side gate is `arrival_article_id`
  // and stays the load-bearing one; this is the per-device polish the invariant
  // reserves for exactly this kind of one-off (`workspace:ceremony_seen:`).
  const arrivalAsked = useRef(false)
  useEffect(() => {
    if (!user || preview || !article.dTag || arrivalAsked.current) return
    arrivalAsked.current = true
    const seenKey = `arrival_seen:${article.dTag}`
    let cancelled = false
    void articlesApi
      .arrival(article.dTag)
      .then(async (res) => {
        if (cancelled || !res.arrival) return
        if (res.gatePass) {
          // Down the ONE existing decrypt path, not a second copy of it.
          try {
            const ciphertext = res.gatePass.ciphertext ?? article.encryptedPayload
            if (ciphertext) {
              const algorithm = vaultAlgorithm(res.gatePass.algorithm ?? article.payloadAlgorithm)
              const contentKeyBase64 = await unwrapContentKey(res.gatePass.encryptedKey)
              const body = await decryptVaultContent(ciphertext, contentKeyBase64, algorithm)
              if (cancelled) return
              setPaywallBody(body)
              cacheUnlocked(body)
              void useAuth.getState().fetchMe()
            }
          } catch (err) {
            // The piece stays gated and the ordinary button still works. The
            // welcome then must not claim it opened.
            console.error('Arrival unlock failed after gate pass:', err)
          }
        }
        let seen = false
        try { seen = sessionStorage.getItem(seenKey) === '1' } catch { /* private mode */ }
        if (seen || cancelled) return
        try { sessionStorage.setItem(seenKey, '1') } catch { /* private mode */ }
        setArrival({
          welcomeGiftPence: res.welcomeGiftPence ?? 0,
          // Bound to what actually happened, not to what was intended: a
          // decrypt that failed above leaves `paywallBody` null and the gate
          // standing, and "this one's on the haus" over a still-locked piece is
          // the one thing this modal must never say.
          unlocked: !!res.gatePass,
        })
      })
      .catch(() => { /* an arrival that cannot be asked about is not an arrival */ })
    return () => { cancelled = true }
  }, [user, article.dTag, article.id, article.encryptedPayload, article.payloadAlgorithm])

  // THE SPEND NOTE IS VIEWER-DERIVED AND THIS PAGE'S SSR IS NOT.
  //
  // `/article/[dTag]` fetches the gateway anonymously behind `revalidate: 60`,
  // so `writerSpendThisMonthPence` arrives as the ANONYMOUS projection — null
  // — for everybody. That was harmless
  // while a member was bounced off this page before they could see it; D5
  // deleted the bounce, so without this a member reading a shared link would
  // silently lose the nudge. The route already does the right thing (it OMITS
  // viewer fields rather than defaulting them); what was missing is a
  // viewer-scoped read to put beside it. Cookies ride this one.
  useEffect(() => {
    if (!user || preview || !article.dTag || !article.isPaywalled) return
    const dTag = article.dTag
    let cancelled = false
    void articlesApi
      .getByDTag(dTag)
      .then((a) => {
        if (cancelled) return
        setViewerNudge({
          writerSpendThisMonthPence: a.writerSpendThisMonthPence ?? undefined,
        })
      })
      .catch(() => { /* the nudge is secondary; the gate works without it */ })
    return () => { cancelled = true }
  }, [user, article.dTag, article.isPaywalled])

  // Redeem gift token from URL query param
  useEffect(() => {
    if (!articleDbId || !user || preview) return
    const params = new URLSearchParams(window.location.search)
    const giftToken = params.get('gift')
    if (!giftToken) return
    giftLinks.redeem(articleDbId, giftToken)
      .then(() => { window.location.replace(window.location.pathname) })
      .catch(err => console.error('Failed to redeem gift link', err))
  }, [articleDbId, user])

  // Check subscription status for paywall gate
  useEffect(() => {
    if (!user || preview || !writerId || !article.isPaywalled) return
    subscriptionsApi.check(writerId)
      .then(data => { if (data.subscribed) setIsSubscribed(true) })
      .catch(err => console.error('Failed to check subscription status', err))
  }, [user, writerId, article.isPaywalled])

  async function handleSubscribe() {
    if (!user || !writerId) return
    setSubscribing(true)
    setUnlockError(null); setUnlockNeedsCard(false); setUnlockNeedsTerms(false)
    try {
      try { await subscriptionsApi.subscribe(writerId) }
      catch (err) {
        // ONE mapper for every subscribe surface (lib/subscribe-errors.ts). A
        // 402 is two refusals: `card_action_required` reaches a reader whose
        // card DECLINED, and "add a card" would send them to a step they
        // finished long ago — so the add-card link is for `card_required` (or
        // a bare 402) alone. A card-holder who has not accepted the Reader
        // Terms gets the consent, and accepting resumes THIS press, not the
        // unlock. Never flip isSubscribed on a refusal (the old unconditional
        // flip faked a subscription).
        const view = mapSubscribeError(err)
        const code = err instanceof ApiError ? err.body?.error : undefined
        subscribeInterrupted.current = view.needsTerms
        setUnlockNeedsTerms(view.needsTerms)
        setUnlockNeedsCard(
          code === 'card_required' || (err instanceof ApiError && err.status === 402 && !code),
        )
        if (!view.needsTerms) setUnlockError(view.message)
        return
      }
      setIsSubscribed(true)
      await handleUnlock()
    } finally { setSubscribing(false) }
  }

  async function handleUnlock() {
    // Under preview there is no gate to press and no article to unlock — the
    // band is static and the gated body is already on the page. A belt, not a
    // branch anyone reaches.
    if (preview || !article.id || !article.dTag) return
    const dTag = article.dTag
    // Unreachable from the gate (a logged-out reader is served a link, not this
    // button) and kept as the belt: whichever way in exists is where it goes.
    if (!user) {
      window.location.href = offer
        ? `/auth/signup?arrival=${encodeURIComponent(dTag)}`
        : '/waitlist'
      return
    }
    setUnlocking(true); setUnlockError(null); setUnlockNeedsCard(false); setUnlockNeedsTerms(false)
    subscribeInterrupted.current = false
    try {
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        const view = mapUnlockError(err?.status, err?.body)
        setUnlockError(view.message)
        setUnlockNeedsCard(view.needsCard)
        setUnlockNeedsTerms(view.needsTerms)
        return
      }

      const ciphertext: string | undefined = gatePassResult.ciphertext
        ?? article.encryptedPayload

      if (!ciphertext) {
        setUnlockError(PAYWALL_NO_CIPHERTEXT)
        return
      }

      const algorithm = vaultAlgorithm(gatePassResult.algorithm ?? article.payloadAlgorithm)
      const contentKeyBase64 = await unwrapContentKey(gatePassResult.encryptedKey)
      const body = await decryptVaultContent(ciphertext, contentKeyBase64, algorithm)
      setPaywallBody(body)
      cacheUnlocked(body)
      if (gatePassResult.allowanceJustExhausted) setShowAllowanceModal(true)
      // The gate copy reads the remaining free allowance off the auth store —
      // refresh it so the next paywall shows the post-unlock figure.
      void useAuth.getState().fetchMe()
    } catch (err: any) {
      // Post-payment stage (key unwrap / decrypt). The unlock row is already
      // persisted server-side, so a retry re-issues the key without charging.
      console.error('Paywall unlock failed:', err)
      setUnlockError(PAYWALL_AFTER_PAYMENT)
    } finally { setUnlocking(false) }
  }

  // ACCEPT, THEN RETRY THE PRESS THEY ALREADY MADE. The reader pressed
  // "Continue reading" and met a document; once they have accepted it the
  // unlock should happen without a second press, because the gesture that
  // authorises the charge was that first press and it has not been withdrawn.
  //
  // The version is the server's own `current`, refreshed from `/auth/me` before
  // the retry so the gate cannot loop on a stale session — and if the acceptance
  // itself is refused (the text moved between render and press) the refusal is
  // SHOWN rather than swallowed, and the reader is asked again.
  async function handleAcceptReaderTerms() {
    const version = user?.terms.reader.current
    if (!version) return
    setAcceptingTerms(true)
    setUnlockError(null)
    try {
      await authApi.acceptTerms('reader', version)
      await useAuth.getState().fetchMe()
      setUnlockNeedsTerms(false)
      // Resume whichever press met the consent: Subscribe or Continue reading.
      if (subscribeInterrupted.current) {
        subscribeInterrupted.current = false
        await handleSubscribe()
      } else {
        await handleUnlock()
      }
    } catch (err: any) {
      setUnlockError(
        err?.body?.error === 'terms_version_mismatch'
          ? termsVersionMismatch('reader')
          : TERMS_ACCEPT_FAILED,
      )
      await useAuth.getState().fetchMe()
    } finally {
      setAcceptingTerms(false)
    }
  }

  // SCROLL ANCHOR: THE SEAM, NOT THE GATE (D4). The gate element is destroyed
  // by the unlock, so anything holding its offset holds a stale number. The
  // join between the free run and the paywalled body is the same position, it
  // survives the swap, and it is literally where the reader stopped.
  useEffect(() => {
    if (!arrival) return
    seamRef.current?.scrollIntoView({ block: 'center' })
  }, [arrival])

  const isUnlocked = !article.isPaywalled || paywallBody !== null
  const pricePounds = article.pricePence ? (article.pricePence / 100).toFixed(2) : null
  // UTC-pinned: this component is server-rendered on /article/:dTag, and a
  // runtime-local format disagrees between the two passes (lib/format.ts).
  const publishDate = formatPublishedDate(article.publishedAt)
  const articleUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/article/${article.dTag ?? ''}`
    : `/article/${article.dTag ?? ''}`

  return (
    <div className="min-h-screen bg-white">
      {/* THE MARK. Standing, never dismissible, and FIXED — the fact is true of
          the whole piece, so a strap the writer scrolls past is a fact they
          stop being told. It replaced a crimson strap at this exact spot,
          which cost a band of the reading surface on the one page whose whole
          job is to look like the live article. Paired with `noindex` on the
          route — a preview that could be mistaken for the published piece is
          the failure mode here. */}
      {preview && <DraftWatermark />}

      {showAllowanceModal && <AllowanceExhaustedModal onClose={() => setShowAllowanceModal(false)} />}

      {arrival && (
        <ArrivalWelcome
          unlocked={arrival.unlocked}
          welcomeGiftPence={arrival.welcomeGiftPence}
          onClose={() => setArrival(null)}
        />
      )}

      {/* Quoting a draft would publish a note pointing at an event that does
          not exist. Suppressed whole under preview rather than disabled — a
          permissions/absence state must not wear a broken control. */}
      {!preview && article.id && article.pubkey && (
      <QuoteSelector
        articleBodyRef={articleBodyRef}
        articleId={article.id}
        articleTitle={article.title}
        articlePubkey={article.pubkey}
        writerName={writerName}
        isLoggedIn={!!user}
        isAuthor={isOwnContent}
        // Cite feeds the Phase-1 citation composer, so it darks with the
        // apparatus (UPSTREAM_EDGES_ENABLED — suspended 2026-08-25).
        onCite={
          upstreamEdgesEnabled()
            ? (excerpt, charStart, charEnd) => setCitationDraft({ excerpt, charStart, charEnd })
            : undefined
        }
      />
      )}

      {giftAnchor && articleDbId && !preview && (
        <GiftLinkPanel articleDbId={articleDbId} anchorRef={giftAnchor} onClose={() => setGiftAnchor(null)} />
      )}

      {/* Article content */}
      <div className="mx-auto max-w-article-frame px-4 sm:px-6">
        <div className="px-5 py-6 sm:px-10 sm:py-8 md:px-[72px] md:py-10">
          {/* Hero image */}
          {heroImage && (
            <div className="-mx-5 -mt-6 sm:-mx-10 sm:-mt-8 md:-mx-[72px] md:-mt-10 mb-8">
              <EnlargeableImage
                src={heroImage}
                loading="eager"
                wrapperClassName="w-full"
                className="w-full max-h-[400px] object-cover"
              />
            </div>
          )}

          {/* Content column — centred, and capped at the stretched measure: the
              reader's canonical 640 at rest, easing wider on the pane's own curve
              once the member stretches it (lib/workspace/measure.ts, published as
              `--ah-measure` by Glasshouse). `ArticleEditor`'s document column
              takes the SAME class, which is what keeps writing and reading one
              geometry at any given pane width. Outside a pane — the standalone
              /article/[dTag] page, where there is nothing to stretch — the class
              falls back to `maxWidth.article` and this is pixel-unchanged.

              The enclosing `max-w-article-frame` (960) less its own padding is
              the real ceiling here (~768), a shade under the curve's 780. That is
              the container bounding the column, which is correct behaviour, not a
              cap to chase: the last 12px are imperceptible and widening a
              sitewide token to recover them is not worth it. */}
          <div className="ah-measure mx-auto">

            {/* Byline — Instrument Sans name + date */}
            <div className="mb-8 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar src={writerAvatar} name={writerName} size={36} lazy={false} />
                <div>
                  <span className="font-sans text-ui-sm">
                    {/* Both go through the sitewide affordances, never a raw
                        <a>: this body renders inside the reader Glasshouse as
                        well as on the standalone page, and there a plain
                        anchor is a full-page navigation out of the overlay
                        world — the escape ban (web/CLAUDE.md). Each still
                        renders a real link, so new-tab and copy-link work. */}
                    <ProfileLink href={`/${writerUsername}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{writerName}</ProfileLink>
                    {publicationSlug && publicationName && (
                      <> in <InwardLink href={`/pub/${publicationSlug}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{publicationName}</InwardLink></>
                    )}
                  </span>
                  {/* A never-published draft has no publication date, so the
                      byline dates the LAST SAVE and says which it is — a date
                      standing bare where a publication date goes is a claim
                      this piece cannot make. */}
                  <p className="font-sans text-ui-xs text-grey-600">
                    {preview ? `Draft — saved ${publishDate}` : publishDate}
                  </p>
                </div>
              </div>
              {/* Share, gift and report all name a piece that is on the
                  site. A draft is not, so under preview there is nothing here
                  — not a disabled row. */}
              {!preview && article.id && (
              <div className="flex items-center gap-3">
                <ShareButton
                  url={articleUrl}
                  title={article.title}
                  onGiftLink={isOwnContent && article.isPaywalled ? (anchor) => setGiftAnchor(anchor) : undefined}
                />
                {/* Both ids (L6.3): the event id is what the removal path
                    resolves by, and `postId` is the key every other surface
                    reports with, so one report row is comparable with the
                    workspace's whatever it was filed from. */}
                <ReportButton
                  targetNostrEventId={article.id}
                  targetPostId={postId ?? undefined}
                />
              </div>
              )}
            </div>

            {withdrawn && (
              <p className="mb-6 px-4 py-3 text-ui-xs font-sans bg-grey-100 text-black">
                {ARTICLE_WITHDRAWN_NOTICE}
              </p>
            )}

            {/* Title — Literata roman (not italic in reader — writer's space) */}
            <h1
              className="mb-4 font-serif text-black leading-[1.1]"
              style={{
                fontSize: 'clamp(2.125rem, 4vw, 2.125rem)',
                fontWeight: 500,
                letterSpacing: '-0.025em',
              }}
            >
              {article.title}
            </h1>

            {article.summary && (
              <p className="font-serif text-xl text-grey-600 italic leading-relaxed mt-4 mb-2">
                {article.summary}
              </p>
            )}

            {/* Slab rule */}
            <div className="slab-rule-4 mb-10 mt-6" />

            {/* Article body */}
            <article>
              <div ref={articleBodyRef} className="prose prose-lg prose-dropcap ah-caption-voice" dangerouslySetInnerHTML={{ __html: freeHtml }} />
              {/* The seam. Zero-height and always present, so it is the same
                  position before and after the unlock swaps the gate for the
                  body — which is exactly the property the gate itself lacks. */}
              <div ref={seamRef} aria-hidden="true" />

              {/* THE GATE, PREVIEWED AS A BAND. Static, because there is
                  nothing to buy, and the gated body renders BELOW it: the
                  writer must see their own whole piece, and a preview that
                  hides half of it is the thing they were trying to check.
                  Where it falls is `splitAtGateMarker`'s answer — publish's own
                  function — so the preview cannot put the gate somewhere
                  readers will not find it. */}
              {preview && article.isPaywalled && (
                <div className="mt-10 bg-grey-100 px-6 py-5">
                  <p className="label-ui text-grey-600">Paywall</p>
                  {/* NO PRICE IS NOT A PRICE. A gated draft at 0p cannot
                      publish at all — the three publish-side validators all
                      insist a paywalled piece costs at least 1p — so "Readers
                      pay from here" over a price of nothing is a claim about
                      an article that does not exist yet. Say which state it is
                      in instead. */}
                  <p className="mt-2 font-sans text-ui-sm text-black">
                    {pricePounds
                      ? <>Readers pay <strong className="font-semibold">£{pricePounds}</strong> from here.</>
                      : <>No price set yet &mdash; set one before you publish.</>}
                  </p>
                  <p className="mt-1 font-sans text-ui-xs text-grey-600">
                    Everything below this band is behind the gate. You are seeing it because it is yours.
                  </p>
                </div>
              )}

              {!preview && article.isPaywalled && !isUnlocked && (
                <PaywallGate
                  pricePounds={pricePounds}
                  pricePence={article.pricePence ?? null}
                  freeAllowanceRemaining={user?.freeAllowanceRemainingPence ?? 0}
                  hasPaymentMethod={user?.hasPaymentMethod ?? false}
                  isLoggedIn={!!user}
                  onUnlock={handleUnlock}
                  unlocking={unlocking}
                  error={unlockError}
                  errorNeedsCard={unlockNeedsCard}
                  errorNeedsTerms={unlockNeedsTerms}
                  readerTerms={user?.terms.reader ?? null}
                  onAcceptTerms={handleAcceptReaderTerms}
                  acceptingTerms={acceptingTerms}
                  writerUsername={writerUsername}
                  writerName={writerName}
                  subscriptionPricePence={subscriptionPricePence}
                  isSubscribed={isSubscribed}
                  onSubscribe={handleSubscribe}
                  subscribing={subscribing}
                  dTag={article.dTag}
                  signupOffer={offer}
                  writerSpendThisMonthPence={viewerNudge ? viewerNudge.writerSpendThisMonthPence : writerSpendThisMonthPence}
                  writerId={writerId}
                />
              )}

              {paywallBody && <div ref={paywallBodyRef} className="prose prose-lg mt-10 ah-caption-voice" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

              {/* Upstream Edges — credit/citation apparatus at the piece foot.
                  Pass the body ref + HTML so anchored citations inject their
                  in-prose markers (re-injected when the rendered body changes). */}
              {!preview && (
              <UpstreamEdges
                articleDbId={articleDbId}
                isAuthor={isOwnContent}
                articleBodyRef={articleBodyRef}
                bodyHtml={freeHtml}
              />
              )}

              {/* Foot of the piece — whitespace alone carries the break (the ∀
                  ornament that stood here was retired 2026-07-25).

                  NOT MOUNTED WHILE THE GATE IS UP, on the same condition that
                  raises it: a locked piece shows nothing below its gate. The
                  server would say so too (ReplySection's `paywallLocked` branch
                  now renders null), but only after a round trip — and its
                  loading state draws a rule and a skeleton in the meantime, so
                  leaving it mounted would flash exactly what we are removing. */}
              {!preview && postId && article.id && article.pubkey && !(article.isPaywalled && !isUnlocked) && (
                <div className="mt-24">
                  <ReplySection postId={postId} targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} isUnlocked={isUnlocked} focusCommentId={focusCommentId} />
                </div>
              )}
            </article>

          </div>
        </div>
      </div>
    </div>
  )
}
