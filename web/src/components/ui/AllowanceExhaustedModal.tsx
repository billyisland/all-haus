'use client'

import { usePublicPalette } from '../public/palette'
import { PublicButton } from '../public/Field'
import { ALLOWANCE_SPENT_LEAD, ALLOWANCE_SPENT_NEXT, paywallCardLink } from '../../content/paywall'

// =============================================================================
// AllowanceExhaustedModal — the bookend to the arrival welcome.
//
// PAYWALL-ARRIVAL-ADR D8. These two modals are seen by the same reader a few
// articles apart — one when the gift begins, one when it runs out — so they are
// written together or they are written badly. They share the public register's
// chassis and the same plain scrim.
//
// WHAT WAS HERE BEFORE was placeholder text, in full: "In real life this is
// when we would ask for your payment details, but this is just a game so you
// can keep spending imaginary money." That is not a joke that survives contact
// with a real reader who has just spent their last free penny, and it was set
// to go live on the day the site opened, to exactly the person this whole flow
// exists to impress. The 1px border went with it (the  hairline-ok (prose: names the border this file REMOVED)
// sitewide hairline ban, `scripts/check-hairlines.sh`), and so did  hairline-ok (prose: names the guard, not a rule)
// `backdrop-blur-sm` — D4's presentation rule is a plain scrim, and the
// argument for it is the same on both ends of the gift.
//
// IT ASKS FOR A CARD WITHOUT PRETENDING THE GIFT IS OWED BACK. The free
// allowance is a gift: charged to nobody, earning nobody, ever. Running out of
// it is not a debt and must not be worded as one — what changed is only that
// the next piece is one the reader pays for.
// =============================================================================

interface AllowanceExhaustedModalProps {
  onClose: () => void
}

export function AllowanceExhaustedModal({ onClose }: AllowanceExhaustedModalProps) {
  const palette = usePublicPalette()

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center px-4"
      // Clears the nav band for the same reason its twin does — see
      // ArrivalWelcome. D8's whole argument is that the two modals are written
      // together, and a scrim is part of how one reads.
      style={{ top: 'var(--ah-bar-band, 0px)', background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Your free reading allowance"
    >
      <div
        className="w-full max-w-md"
        style={{ background: palette.interior, padding: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ background: palette.cardBg, padding: '22px 24px' }}>
          <p
            className="font-serif"
            style={{
              fontSize: 19,
              lineHeight: 1.5,
              color: palette.cardTitle,
              margin: 0,
            }}
          >
            {ALLOWANCE_SPENT_LEAD}
          </p>
        </div>

        <div
          style={{ background: palette.cardBg, padding: '22px 24px', marginTop: 12 }}
        >
          <p
            className="font-mono"
            style={{
              fontSize: '0.9375rem',
              lineHeight: 1.65,
              color: palette.cardStandfirst,
              margin: 0,
            }}
          >
            {ALLOWANCE_SPENT_NEXT}
          </p>
        </div>

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PublicButton full href="/reader?overlay=settings">
            {paywallCardLink(false)}
          </PublicButton>
          <PublicButton variant="outline" full onClick={onClose}>
            Not now
          </PublicButton>
        </div>
      </div>
    </div>
  )
}
