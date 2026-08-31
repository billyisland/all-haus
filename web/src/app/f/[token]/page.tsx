'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../stores/auth'
import {
  formulas as formulasApi,
  formulaSourceKind,
  type FeedLink,
  type RedeemResult,
} from '../../../lib/api/formulas'
import { ApiError } from '../../../lib/api/client'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  PublicButton,
  PublicLink,
  FormError,
  IndeterminateSlab,
} from '../../../components/public/Field'
import { usePublicPalette } from '../../../components/public/palette'

// =============================================================================
// /f/:token — a shared feed, as its recipient meets it (FEED-FORMULAS-ADR §3,
// §7; FEED-SHARE-LIVE-LINKS-ADR L1/L7/L10).
//
// THE PAGE SHOWS THE FEED AS IT IS NOW. The link is a pointer, not a snapshot,
// so the name, the source list and the excluded count are all projected when
// this page is opened — and a copy freezes only when somebody presses Add. An
// author who adds a source after sending the link has shared that source; that
// is L1's recorded, accepted cost, and Stop is what revokes it.
//
// A COMPOSITION, NEVER CONTENT. Nobody's items appear here and nothing on this
// page fetches any: a formula is the list of things a feed is made of, and
// showing a sample of what those sources happen to be posting today would make
// it a feed — a public one, on a platform that has no public feeds and whose
// D2 defers even a directory. `GET /formulas/:token` carries no items for the
// same reason, so this is a property of the wire and not just of the render.
//
// THE PAGE IS THE SAME FOR BOTH AUDIENCES; ONLY THE LAST CARD DIFFERS. A
// logged-out visitor sees the whole composition and is offered the waiting
// list; a member is offered "Add to my workspace". Hiding the sources behind a
// login would make the link unshareable, which is the one thing a formula is
// for.
//
// A WITHDRAWN LINK SHOWS NOTHING BUT THE REFUSAL, and so does one whose feed is
// GONE. The row survives revocation (it is a flag, not a delete — D10) and
// survives the feed's deletion (L7: deleting the row would erase the provenance
// of every feed already redeemed from it), so the server projects no
// composition in either state and both branches return early, above the list.
// Rendering a retracted source list would publish exactly what the author
// withdrew.
//
// A REFUSAL IS NOT AN ABSENCE. A feed that is currently empty or over the cap
// yields a page that names the author and says nobody can add it yet — rather
// than a 404, which would claim the link is wrong when it is the feed that is
// not ready. It starts working when the author adds a source.
//
// A SEED'S TOKEN IS A 404 (L10) and reaches the unknown-token branch below with
// nothing to distinguish it, which is correct: the designated seed is a frozen
// composition with no address, and serving its token would project the
// operator's live feed from a URL that means something else.
//
// 404 IS DELIBERATELY AMBIGUOUS and must stay that way in the copy: a bad
// token, a token from another instance, and the whole feature being dark behind
// FEED_FORMULAS_ENABLED are indistinguishable from out here, by design. "This
// link doesn't lead anywhere" is true of all three; "no such formula" would be
// a claim the page cannot support.
//
// PARTIAL REDEEM IS A REAL OUTCOME (§6) and is REPORTED. Redemption is N
// addSource calls, not one transaction, so a formula naming a source that has
// rotted lands a feed holding the rest. Saying "added to your workspace" and
// nothing else would present the author's composition minus four sources as the
// author's composition.
// =============================================================================

// Keyed on the server's own `error` code, not on the message: the copy here is
// the recipient's voice and the message is the operator's.
const REDEEM_REFUSALS: Record<string, string> = {
  formula_revoked: 'The author has withdrawn this link.',
  source_feed_gone: 'The feed this link pointed at no longer exists.',
  formula_empty: 'There is nothing in this feed to add yet.',
  formula_too_large: 'This feed is too large to share right now.',
}

function Frame({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>{title}</PublicTitle>
          <div style={{ marginTop: 10 }}>{children}</div>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}

export default function FormulaPage() {
  const { token } = useParams<{ token: string }>()
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const palette = usePublicPalette()

  const [formula, setFormula] = useState<FeedLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [result, setResult] = useState<RedeemResult | null>(null)

  useEffect(() => {
    if (!token) return
    formulasApi
      .get(token)
      .then(setFormula)
      .catch(() => setMissing(true))
      .finally(() => setLoading(false))
  }, [token])

  const handleRedeem = useCallback(async () => {
    if (redeeming) return
    setRedeeming(true)
    setError(null)
    try {
      setResult(await formulasApi.redeem(token))
    } catch (err) {
      // ONE STATUS CLASS, THREE REASONS (§7): 410 means "this link will not
      // produce a feed right now", and the error CODE says which — the author
      // withdrew it, the feed is gone, or the feed cannot be added as it
      // stands. Each is a real state rather than a fault, so each gets its own
      // sentence instead of the generic failure. All three can arrive here
      // between the page loading and the press, which is exactly why redeem
      // re-checks rather than trusting what this page was handed.
      setError(
        err instanceof ApiError && err.status === 410
          ? (REDEEM_REFUSALS[String(err.body?.error ?? '')] ??
            'This link no longer leads to a feed you can add.')
          : 'Something went wrong adding this feed. Try again in a moment.',
      )
    } finally {
      setRedeeming(false)
    }
  }, [redeeming, token])

  if (loading || authLoading) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard style={{ padding: 0 }}>
            <IndeterminateSlab label="Loading this feed" />
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (missing || !formula) {
    return (
      <Frame title="This link doesn’t lead anywhere">
        <PublicBody>
          Feed links are long and unguessable, so a missing one is usually a
          copy that lost its tail. Ask whoever sent it for the whole thing.
        </PublicBody>
      </Frame>
    )
  }

  const authorName = formula.author.displayName ?? formula.author.username

  if (formula.revoked) {
    return (
      <Frame title="This feed has been withdrawn">
        <PublicBody>
          {authorName ? `${authorName} has` : 'The author has'} taken this link
          down. Anyone who already added the feed keeps it — withdrawing a link
          stops new copies and reaches into nobody’s workspace.
        </PublicBody>
      </Frame>
    )
  }

  // L7 — the feed itself is gone (deleted, or merged into another). The link
  // row survives so that everyone who already added the feed keeps their
  // provenance; what it points at does not.
  if (formula.gone) {
    return (
      <Frame title="This feed no longer exists">
        <PublicBody>
          {authorName ? `${authorName} has` : 'The author has'} deleted the feed
          this link pointed at. Anyone who already added it keeps their copy —
          it was theirs from the moment they added it.
        </PublicBody>
      </Frame>
    )
  }

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>{formula.name ?? 'A feed'}</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {/* D7 — attribution travels, adoption counts do not. There is no
                  "added 41 times" here and there is not meant to be. */}
              A feed of {formula.sourceCount}{' '}
              {formula.sourceCount === 1 ? 'source' : 'sources'}
              {authorName ? (
                <>
                  , put together by{' '}
                  <span style={{ color: palette.cardTitle }}>{authorName}</span>
                </>
              ) : null}
              .
            </PublicBody>
          </div>
        </PublicCard>

        {/* The composition itself, in the author's own composer order (§11) —
            the sequence they arranged, not one this page re-sorts. */}
        <PublicCard>
          <div
            className="label-ui"
            style={{ color: palette.cardMeta, marginBottom: 12 }}
          >
            What’s in it
          </div>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {formula.sources.map((s) => (
              <div
                key={s.position}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  justifyContent: 'space-between',
                }}
              >
                <span
                  className="font-mono"
                  style={{
                    fontSize: 15,
                    lineHeight: 1.45,
                    color: palette.cardTitle,
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {s.label}
                </span>
                <span
                  className="label-ui"
                  style={{ color: palette.cardMeta, flexShrink: 0 }}
                >
                  {formulaSourceKind(s)}
                </span>
              </div>
            ))}
          </div>
        </PublicCard>

        {/* D5 — stated, never silent. The recipient sees this as well as the
            author, because "this is most of a feed" is information they are
            entitled to before they add it. */}
        {formula.excludedCount > 0 && (
          <PublicCard>
            <PublicBody>
              {formula.excludedCount === 1
                ? 'One source in the original feed couldn’t be shared'
                : `${formula.excludedCount} sources in the original feed couldn’t be shared`}{' '}
              — some sources can’t travel: newsletters arrive at a private
              address that belongs to one subscriber, and a source may no
              longer exist.
            </PublicBody>
          </PublicCard>
        )}

        {error && <FormError>{error}</FormError>}

        {result ? (
          <PublicCard>
            <div style={{ marginBottom: 16 }}>
              <PublicBody>
                Added to your workspace as a feed of your own — retune it,
                rename it, take things out. It’s yours now, and nothing the
                author does next will reach it.
              </PublicBody>
            </div>
            {/* Reported, never swallowed (§6): a redeem that quietly dropped
                four sources would read as the author's composition. */}
            {result.failed.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <PublicBody>
                  {result.failed.length === 1
                    ? 'One source couldn’t be reached and isn’t in your copy: '
                    : `${result.failed.length} sources couldn’t be reached and aren’t in your copy: `}
                  <span style={{ color: palette.cardTitle }}>
                    {result.failed.map((f) => f.label).join(', ')}
                  </span>
                  .
                </PublicBody>
              </div>
            )}
            <PublicButton full onClick={() => router.push('/reader')}>
              Open your workspace
            </PublicButton>
          </PublicCard>
        ) : formula.refusal ? (
          // Named, never a dead button: the feed is real and its author is
          // named above, but as it stands right now nobody can add it. It
          // starts working the moment they add a source, so the link is worth
          // keeping rather than discarding as broken.
          <PublicCard>
            <PublicBody>
              {formula.refusal === 'empty'
                ? 'There is nothing in this feed to add yet. Keep the link — it will work as soon as its author adds a source.'
                : 'This feed carries more sources than a link may. Keep the link — it will work once its author trims it.'}
            </PublicBody>
          </PublicCard>
        ) : user ? (
          <PublicCard>
            <PublicButton full disabled={redeeming} onClick={handleRedeem}>
              {redeeming ? 'Adding…' : 'Add to my workspace'}
            </PublicButton>
          </PublicCard>
        ) : (
          <>
            <PublicCard>
              <div style={{ marginBottom: 16 }}>
                <PublicBody>
                  all.haus is in closed beta. Join the waiting list and this
                  feed will be one click away when you’re in.
                </PublicBody>
              </div>
              <PublicButton full onClick={() => router.push('/waitlist')}>
                Join the waiting list
              </PublicButton>
            </PublicCard>
            <PublicCard>
              <PublicBody>
                Already on all.haus?{' '}
                <PublicLink href={`/auth?mode=login&redirect=/f/${token}`}>
                  Log in
                </PublicLink>{' '}
                to add it.
              </PublicBody>
            </PublicCard>
          </>
        )}
      </PublicVessel>
    </PublicShell>
  )
}
