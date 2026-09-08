'use client'

import { useState, useEffect, useRef, type RefObject } from 'react'
import { useAuth } from '../../stores/auth'
import { PaywallGate } from './PaywallGate'
import { GiftLinkModal } from './GiftLinkModal'
import { QuoteSelector } from './QuoteSelector'
import { unwrapContentKey, decryptVaultContent } from '../../lib/vault'
import { mapUnlockError } from '../../lib/unlock-errors'
import { renderMarkdown } from '../../lib/markdown'
import { Avatar } from '../ui/Avatar'
import { ReportButton } from '../ui/ReportButton'
import { ShareButton } from '../ui/ShareButton'
import { ReplySection } from '../replies/ReplySection'
import { AllowanceExhaustedModal } from '../ui/AllowanceExhaustedModal'
import { ArrivalWelcome } from './ArrivalWelcome'
import { UpstreamEdges } from './UpstreamEdges'
import { useCitationDraft } from '../../stores/citationDraft'
import { articles as articlesApi, giftLinks, upstreamEdgesEnabled, signupOffer, type SignupOffer } from '../../lib/api'
import { useReadingPosition } from '../../hooks/useReadingPosition'
import { useReadingLog } from '../../hooks/useReadingLog'
import type { ArticleEvent } from '../../lib/ndk'

interface ArticleReaderProps {
  article: ArticleEvent
  /** The piece's `post_id` (READING-LOG-AND-LIBRARY-ADR D8) — the single key
   *  both the reading log and the scroll-position table take, resolved
   *  server-side and carried on the article payload. Absent ⇒ neither is
   *  recorded, which is the honest behaviour for a caller that cannot name the
   *  piece; never derive one here. */
  postId?: string | null
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
  nudgeShownThisMonth?: boolean
  preRenderedFreeHtml?: string
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

export function ArticleReader({ article, postId, scrollRef, articleDbId, writerName, writerUsername, writerAvatar, writerId, subscriptionPricePence, writerSpendThisMonthPence, nudgeShownThisMonth, preRenderedFreeHtml, publicationName, publicationSlug, coverImageUrl }: ArticleReaderProps) {
  const { user } = useAuth()
  const [paywallBody, setPaywallBody] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlockNeedsCard, setUnlockNeedsCard] = useState(false)
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [freeHtml, setFreeHtml] = useState<string>(preRenderedFreeHtml ?? '')
  const [paywallHtml, setPaywallHtml] = useState<string>('')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [showGiftLinkModal, setShowGiftLinkModal] = useState(false)
  const [offer, setOffer] = useState<SignupOffer | null>(null)
  const [arrival, setArrival] = useState<{ welcomeGiftPence: number; unlocked: boolean } | null>(null)
  // Viewer-derived, and NOT from this page's SSR (see the effect below).
  const [viewerNudge, setViewerNudge] = useState<{
    writerSpendThisMonthPence?: number
    nudgeShownThisMonth: boolean
  } | null>(null)
  const seamRef = useRef<HTMLDivElement>(null)

  const isOwnContent = user?.id === writerId
  const articleBodyRef = useRef<HTMLDivElement>(null)
  const setCitationDraft = useCitationDraft((s) => s.setDraft)

  useReadingPosition({ postId, enabled: !!user, scrollRef })

  // THE READING LOG'S WRITE, ON MOUNT — not on unlock (ADR §8.3). The two look
  // identical in every ordinary session and differ for exactly one reader: the
  // above-cap arrival (PAYWALL-ARRIVAL D4 Path C), who met the paywall, read
  // what sits above it, and by §8.1 has a true row and a tour beat pointing at
  // it. Recent reading is attention; the library is possession.
  useReadingLog(postId, !!user)

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
  useEffect(() => {
    if (!article.isPaywalled) return
    const cached = sessionStorage.getItem(`unlocked:${article.id}`)
    if (cached) setPaywallBody(cached)
  }, [article.id, article.isPaywalled])

  // What a new account comes with, for the LOGGED-OUT gate's copy. Asked of the
  // server rather than carried as a second copy of `CLOSED_BETA`; null means
  // "no account can be made", which is also the answer when the probe could not
  // resolve — see `signupOffer`.
  useEffect(() => {
    if (user) return
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
    if (!user || arrivalAsked.current) return
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
              const algorithm = (res.gatePass.algorithm ?? article.payloadAlgorithm ?? 'aes-256-gcm') as 'xchacha20poly1305' | 'aes-256-gcm'
              const contentKeyBase64 = await unwrapContentKey(res.gatePass.encryptedKey)
              const body = await decryptVaultContent(ciphertext, contentKeyBase64, algorithm)
              if (cancelled) return
              setPaywallBody(body)
              try { sessionStorage.setItem(`unlocked:${article.id}`, body) } catch { /* quota — cache only */ }
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

  // THE SUBSCRIPTION NUDGE IS VIEWER-DERIVED AND THIS PAGE'S SSR IS NOT.
  //
  // `/article/[dTag]` fetches the gateway anonymously behind `revalidate: 60`,
  // so `writerSpendThisMonthPence` / `nudgeShownThisMonth` arrive as the
  // ANONYMOUS projection — null and false — for everybody. That was harmless
  // while a member was bounced off this page before they could see it; D5
  // deleted the bounce, so without this a member reading a shared link would
  // silently lose the nudge. The route already does the right thing (it OMITS
  // viewer fields rather than defaulting them); what was missing is a
  // viewer-scoped read to put beside it. Cookies ride this one.
  useEffect(() => {
    if (!user || !article.isPaywalled) return
    let cancelled = false
    void articlesApi
      .getByDTag(article.dTag)
      .then((a) => {
        if (cancelled) return
        setViewerNudge({
          writerSpendThisMonthPence: a.writerSpendThisMonthPence ?? undefined,
          nudgeShownThisMonth: a.nudgeShownThisMonth,
        })
      })
      .catch(() => { /* the nudge is secondary; the gate works without it */ })
    return () => { cancelled = true }
  }, [user, article.dTag, article.isPaywalled])

  // Redeem gift token from URL query param
  useEffect(() => {
    if (!articleDbId || !user) return
    const params = new URLSearchParams(window.location.search)
    const giftToken = params.get('gift')
    if (!giftToken) return
    giftLinks.redeem(articleDbId, giftToken)
      .then(() => { window.location.replace(window.location.pathname) })
      .catch(err => console.error('Failed to redeem gift link', err))
  }, [articleDbId, user])

  // Check subscription status for paywall gate
  useEffect(() => {
    if (!user || !writerId || !article.isPaywalled) return
    fetch(`/api/v1/subscriptions/check/${writerId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { if (data.subscribed) setIsSubscribed(true) })
      .catch(err => console.error('Failed to check subscription status', err))
  }, [user, writerId, article.isPaywalled])

  async function handleSubscribe() {
    if (!user || !writerId) return
    setSubscribing(true)
    try {
      const res = await fetch(`/api/v1/subscriptions/${writerId}`, { method: 'POST', credentials: 'include' })
      if (!res.ok) {
        // 402 card_required: subscriptions charge the reading tab, which needs
        // a card on file to be collectable. (Also: never flip isSubscribed on a
        // failed response — the old unconditional flip faked a subscription.)
        setUnlockError(res.status === 402
          ? 'Add a payment card in Settings to subscribe.'
          : 'Failed to subscribe. Try again.')
        setUnlockNeedsCard(res.status === 402)
        return
      }
      setIsSubscribed(true)
      await handleUnlock()
    } catch { setUnlockError('Failed to subscribe. Try again.') }
    finally { setSubscribing(false) }
  }

  async function handleUnlock() {
    // Unreachable from the gate (a logged-out reader is served a link, not this
    // button) and kept as the belt: whichever way in exists is where it goes.
    if (!user) {
      window.location.href = offer
        ? `/auth/signup?arrival=${encodeURIComponent(article.dTag)}`
        : '/waitlist'
      return
    }
    setUnlocking(true); setUnlockError(null); setUnlockNeedsCard(false)
    try {
      let gatePassResult
      try { gatePassResult = await articlesApi.gatePass(article.id) }
      catch (err: any) {
        const view = mapUnlockError(err?.status, err?.body)
        setUnlockError(view.message)
        setUnlockNeedsCard(view.needsCard)
        return
      }

      const ciphertext: string | undefined = gatePassResult.ciphertext
        ?? article.encryptedPayload

      if (!ciphertext) {
        setUnlockError('Could not find the encrypted content. Try again — you won’t be charged twice.')
        return
      }

      const algorithm = (gatePassResult.algorithm ?? article.payloadAlgorithm ?? 'aes-256-gcm') as 'xchacha20poly1305' | 'aes-256-gcm'
      const contentKeyBase64 = await unwrapContentKey(gatePassResult.encryptedKey)
      const body = await decryptVaultContent(ciphertext, contentKeyBase64, algorithm)
      setPaywallBody(body)
      try { sessionStorage.setItem(`unlocked:${article.id}`, body) } catch { /* quota — cache only */ }
      if (gatePassResult.allowanceJustExhausted) setShowAllowanceModal(true)
      // The gate copy reads the remaining free credit off the auth store —
      // refresh it so the next paywall shows the post-unlock figure.
      void useAuth.getState().fetchMe()
    } catch (err: any) {
      // Post-payment stage (key unwrap / decrypt). The unlock row is already
      // persisted server-side, so a retry re-issues the key without charging.
      console.error('Paywall unlock failed:', err)
      setUnlockError('Unlocking failed after payment was recorded. Try again — you won’t be charged twice.')
    } finally { setUnlocking(false) }
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
  const publishDate = new Date(article.publishedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const articleUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/article/${article.dTag}`
    : `/article/${article.dTag}`

  return (
    <div className="min-h-screen bg-white">
      {showAllowanceModal && <AllowanceExhaustedModal onClose={() => setShowAllowanceModal(false)} />}

      {arrival && (
        <ArrivalWelcome
          unlocked={arrival.unlocked}
          welcomeGiftPence={arrival.welcomeGiftPence}
          onClose={() => setArrival(null)}
        />
      )}

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

      {showGiftLinkModal && articleDbId && (
        <GiftLinkModal articleDbId={articleDbId} onClose={() => setShowGiftLinkModal(false)} />
      )}

      {/* Article content */}
      <div className="mx-auto max-w-article-frame px-4 sm:px-6">
        <div className="px-5 py-6 sm:px-10 sm:py-8 md:px-[72px] md:py-10">
          {/* Hero image */}
          {heroImage && (
            <div className="-mx-5 -mt-6 sm:-mx-10 sm:-mt-8 md:-mx-[72px] md:-mt-10 mb-8">
              <img src={heroImage} alt="" className="w-full max-h-[400px] object-cover" />
            </div>
          )}

          {/* Content column — 640px centred */}
          <div className="max-w-article mx-auto">

            {/* Byline — Instrument Sans name + date */}
            <div className="mb-8 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Avatar src={writerAvatar} name={writerName} size={36} lazy={false} />
                <div>
                  <span className="font-sans text-ui-sm">
                    <a href={`/${writerUsername}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{writerName}</a>
                    {publicationSlug && publicationName && (
                      <> in <a href={`/pub/${publicationSlug}`} className="font-semibold text-black hover:opacity-70 transition-opacity">{publicationName}</a></>
                    )}
                  </span>
                  <p className="font-sans text-ui-xs text-grey-600">{publishDate}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ShareButton
                  url={articleUrl}
                  title={article.title}
                  onGiftLink={isOwnContent && article.isPaywalled ? () => setShowGiftLinkModal(true) : undefined}
                />
                <ReportButton targetNostrEventId={article.id} />
              </div>
            </div>

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
              <div ref={articleBodyRef} className="prose prose-lg prose-dropcap" dangerouslySetInnerHTML={{ __html: freeHtml }} />
              {/* The seam. Zero-height and always present, so it is the same
                  position before and after the unlock swaps the gate for the
                  body — which is exactly the property the gate itself lacks. */}
              <div ref={seamRef} aria-hidden="true" />

              {article.isPaywalled && !isUnlocked && (
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
                  writerUsername={writerUsername}
                  writerName={writerName}
                  subscriptionPricePence={subscriptionPricePence}
                  isSubscribed={isSubscribed}
                  onSubscribe={handleSubscribe}
                  subscribing={subscribing}
                  dTag={article.dTag}
                  signupOffer={offer}
                  writerSpendThisMonthPence={viewerNudge ? viewerNudge.writerSpendThisMonthPence : writerSpendThisMonthPence}
                  nudgeShownThisMonth={viewerNudge ? viewerNudge.nudgeShownThisMonth : nudgeShownThisMonth}
                  writerId={writerId}
                />
              )}

              {paywallBody && <div className="prose prose-lg mt-10" dangerouslySetInnerHTML={{ __html: paywallHtml }} />}

              {/* Upstream Edges — credit/citation apparatus at the piece foot.
                  Pass the body ref + HTML so anchored citations inject their
                  in-prose markers (re-injected when the rendered body changes). */}
              <UpstreamEdges
                articleDbId={articleDbId}
                isAuthor={isOwnContent}
                articleBodyRef={articleBodyRef}
                bodyHtml={freeHtml}
              />

              {/* Foot of the piece — whitespace alone carries the break (the ∀
                  ornament that stood here was retired 2026-07-25).

                  NOT MOUNTED WHILE THE GATE IS UP, on the same condition that
                  raises it: a locked piece shows nothing below its gate. The
                  server would say so too (ReplySection's `paywallLocked` branch
                  now renders null), but only after a round trip — and its
                  loading state draws a rule and a skeleton in the meantime, so
                  leaving it mounted would flash exactly what we are removing. */}
              {!(article.isPaywalled && !isUnlocked) && (
                <div className="mt-24">
                  <ReplySection targetEventId={article.id} targetKind={30023} targetAuthorPubkey={article.pubkey} contentAuthorId={undefined} isUnlocked={isUnlocked} />
                </div>
              )}
            </article>

          </div>
        </div>
      </div>
    </div>
  )
}
