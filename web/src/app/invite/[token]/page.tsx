'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../stores/auth'
import { publications as pubApi, type PublicationInvite } from '../../../lib/api'
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
import { publicationsEnabled } from '../../../lib/featureFlags'

// =============================================================================
// Publication invite acceptance — /invite/:token
//
// REDESIGNED 2026-07-25 (tranche 2) onto the public chassis. What went: the
// `animate-pulse rounded` skeleton bar (a guess at a layout, rendered at the
// one moment you can't know it, carrying a border-radius the house doesn't
// have), the `text-red-600` error line, and the single white slab of a card
// doing centred-everything.
//
// IT IS NOT CENTRED ANY MORE. The retired version centred every line, which is
// what a page does when it has one thing to say. This page has four: who is
// inviting you, to what, in what role, and what they said. Ranged left, those
// read as a sequence; centred, they read as a poster.
//
// THE PUBLICATION LOGO KEEPS ITS CIRCLE. `border-radius: 50%` on an avatar is
// not a violation of the square-corner rule — the ∀ disc is a circle too. What
// the rule forbids is softened rectangles.
//
// MIXED REGISTER: a member reaches this from their email, a visitor from a
// forwarded one. Both get the public chassis; the nav bar adapts (see
// PublicNavBar). During the closed beta a masthead can only recruit existing
// members (CLOSED-BETA-ADR §IV, §VIII open item) — a token-scoped signup
// exemption for outside writers is a deferred design call, so a logged-out
// invitee is asked to log in rather than to sign up.
// =============================================================================

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>()
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const palette = usePublicPalette()

  const [invite, setInvite] = useState<PublicationInvite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)

  useEffect(() => {
    if (!token) return
    // Publications suspended 2026-08-31 — the invite route 404s, and the catch
    // below would tell this person their invitation EXPIRED, which is untrue
    // and unactionable ("ask them for a fresh one" cannot work while the whole
    // system is dark). Skip the request and say what is actually the case.
    if (!publicationsEnabled()) {
      setLoading(false)
      return
    }
    pubApi
      .getInvite(token)
      .then(setInvite)
      .catch(() => setError('Invite not found or expired.'))
      .finally(() => setLoading(false))
  }, [token])

  async function handleAccept() {
    if (!invite || !user) return
    setAccepting(true)
    setError(null)
    try {
      // We need the publication ID — fetch it from the invite's slug.
      const pub = await pubApi.get(invite.publication_slug)
      await pubApi.acceptInvite(pub.id, token)
      setAccepted(true)
      setTimeout(() => {
        router.push(
          `/reader?overlay=dashboard&context=${invite.publication_slug}`,
        )
      }, 1500)
    } catch {
      setError('Failed to accept invite.')
    } finally {
      setAccepting(false)
    }
  }

  if (loading || authLoading) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard style={{ padding: 0 }}>
            <IndeterminateSlab label="Loading invitation" />
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (!publicationsEnabled()) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>Publications aren’t available</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                all.haus isn’t running publications at the moment, so this
                invitation can’t be accepted. Nothing has been lost — the
                invitation is still on file, and whoever sent it can tell you
                when titles are open again.
              </PublicBody>
            </div>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              <PublicLink href="/">Back to the front</PublicLink>
            </PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (error && !invite) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>This invitation isn’t valid</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                {error} Invitations expire, and they can only be accepted once —
                if someone forwarded you this link, ask them for a fresh one.
              </PublicBody>
            </div>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              <PublicLink href="/">Back to the front</PublicLink>
            </PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (!invite) return null

  const role = invite.role.replace('_', ' ')

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          {invite.publication_logo && (
            <img
              src={invite.publication_logo}
              alt=""
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                objectFit: 'cover',
                marginBottom: 16,
                display: 'block',
              }}
            />
          )}
          <PublicTitle>Join {invite.publication_name}</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {invite.inviter_name} has invited you as{' '}
              <span style={{ color: palette.cardTitle }}>{role}</span>.
            </PublicBody>
          </div>
        </PublicCard>

        {invite.message && (
          // The inviter's own words, set apart on the walls colour rather than
          // in italics on the card — the quoted-post treatment (quoteBg /
          // quoteText), which is the house's existing answer to "someone else
          // said this".
          <PublicCard
            style={{ background: palette.quoteBg, padding: '18px 20px' }}
          >
            <p
              className="font-mono"
              style={{
                fontSize: '1.0625rem',
                lineHeight: 1.65,
                color: palette.quoteText,
                margin: 0,
              }}
            >
              {invite.message}
            </p>
          </PublicCard>
        )}

        {error && <FormError>{error}</FormError>}

        {accepted ? (
          <PublicCard>
            <PublicBody>
              You’re in. Taking you to the publication’s dashboard.
            </PublicBody>
          </PublicCard>
        ) : user ? (
          <PublicCard>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <PublicButton full disabled={accepting} onClick={handleAccept}>
                {accepting ? 'Accepting…' : 'Accept the invitation'}
              </PublicButton>
              {/* Declining is not an action, it is leaving. It gets a link, not
                  a second button — two buttons of equal weight would make this
                  a decision the page is pressing for. */}
              <div style={{ textAlign: 'center' }}>
                <PublicBody>
                  <PublicLink href="/">No thanks</PublicLink>
                </PublicBody>
              </div>
            </div>
          </PublicCard>
        ) : (
          <PublicCard>
            <div style={{ marginBottom: 16 }}>
              <PublicBody>
                Log in to accept. all.haus is in closed beta, so invitations can
                only be accepted by people who already have an account.
              </PublicBody>
            </div>
            <PublicButton
              full
              href={`/auth?mode=login&redirect=/invite/${token}`}
            >
              Log in to accept
            </PublicButton>
          </PublicCard>
        )}
      </PublicVessel>
    </PublicShell>
  )
}
