'use client'

import { usePublicPalette } from '../public/palette'
import { PublicButton } from '../public/Field'

// =============================================================================
// ArrivalWelcome — the aside a paywall signup arrives to.
//
// PAYWALL-ARRIVAL-ADR D4. Someone who hit a paywall mid-article and made an
// account has told us exactly what they want in the most expensive currency a
// stranger has: attention already spent. This modal's only job is to not lose
// that — so it is an ASIDE ON TOP OF A WIN, not a second toll gate. Dismissing
// it is a close: no navigation, because they are already at the URL they wanted.
//
// A PLAIN SCRIM, NO BLUR (D4, Presentation). The prose stays legible behind it.
// On the unlocked variant the modal arrives at the moment the piece finally
// opened, and blurring the thing they just won would make the reward feel
// withheld a second time. On the still-gated variant there is no win to sit on
// top of, so the scrim must not obscure the gate it is standing over either.
//
// D4's TABLE HAS FOUR PATHS AND THREE VARIANTS, AND TWO OF THE THREE ARE THE
// SAME WORDS. Variants 2 and 3 differ only in what happened to the article, so
// this component takes ONE boolean and not a variant number — a three-valued
// prop whose two values render identically is a distinction the code would be
// pretending to make. The ADR keeps the three rows because the day the copy
// diverges is the day the distinction becomes real; the server already reports
// enough to rebuild it.
//
// THE BOOLEAN MOVES TWO THINGS, AND BOTH ARE CLAIMS ABOUT WHAT ALREADY
// HAPPENED. Still gated, the parenthetical "(this one's on the haus)" goes —
// it would be describing a piece the reader is still looking at a wall in
// front of. And the gift loses "And" and "a further", because both words say
// *in addition to the one you just had*, which is only true if there was one.
// The boolean is bound to whether the gate pass came back and decrypted, not
// to what was intended, so a failed unlock drops both.
//
// THE FIGURES ARE DERIVED, NEVER TYPED (D2). A hardcoded "£5" is a dial with a
// second, silent copy — exactly the failure the tuning-dials invariant exists
// to prevent — and it would be wrong for every reader granted under a different
// setting of it. `platform_fee_bps` gets the same treatment by the opposite
// route: "nearly all the money goes to them" stays deliberately unnumbered,
// because a figure in prose becomes a lie on the day it moves.
//
// THE `bugs@all.haus` PARAGRAPH WAS CUT (2026-09-04), and with it this modal's
// only rendered mention of the address. D7 stands as a decision — the account
// exists and resolves from that string in any omnivorous recipient field — but
// NOTHING NOW POINTS A NEW READER AT IT. If the way to report a problem is to
// be offered anywhere, it needs a home; this is no longer it.
// =============================================================================

export function ArrivalWelcome({
  unlocked,
  welcomeGiftPence,
  onClose,
}: {
  /** The server performed the arrival gate pass and the piece is open. False
   *  for above-cap, misconfigured, and a card at the read — where the gate is
   *  still standing behind this modal and no sentence may say otherwise. */
  unlocked: boolean
  welcomeGiftPence: number
  onClose: () => void
}) {
  const palette = usePublicPalette()
  const gift = `£${(welcomeGiftPence / 100).toFixed(2)}`

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center px-4"
      // THE SCRIM STARTS BELOW THE BAR'S OPTICAL EDGE, NOT AT THE VIEWPORT'S
      // TOP (2026-09-04). `PublicNavBar` is opaque at z-58 and this scrim is
      // z-50, so a full-viewport wash dims everything under the bar INCLUDING
      // the 8px the page reserves below it — drawing a hard seam at the band's
      // true bottom edge, which the bar's geometry is built on nobody ever
      // seeing (web/CLAUDE.md › *A dimming layer must not draw an edge the
      // design depends on not having*). Here the contrast is far starker than
      // the Explain scrim's: 255 → 153 rather than 240 → 206.
      //
      // `--ah-bar-band` is the one home for that number (`LayoutShell`,
      // NAV_BAR_H + GRID), and it is already 0 on surfaces with no bar — so
      // this is self-correcting rather than a second copy, and the fallback
      // covers a render outside the shell.
      style={{ top: 'var(--ah-bar-band, 0px)', background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to all.haus"
    >
      <div
        className="w-full max-w-lg"
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
            {/* Literata is declared `font-weight: 300 700` (a variable face),
                so this is a real weight rather than a synthesised smear. */}
            <strong style={{ fontWeight: 600 }}>Welcome to all.haus.</strong>{' '}
            Here you can pay to access paywalled articles individually rather
            than just through subscriptions
            {unlocked && <> (this one&rsquo;s on the haus)</>}.
          </p>
          <p
            className="font-serif"
            style={{
              fontSize: 19,
              lineHeight: 1.5,
              color: palette.cardTitle,
              margin: '18px 0 0',
            }}
          >
            {unlocked
              ? <>And as a thank-you for signing up, have a further {gift} of reading, free.</>
              : <>As a thank-you for signing up, have {gift} of reading, free.</>}{' '}
            Hard to predict how far that will take you: all prices are set by
            individual writers. Nearly all the money goes to them, too.
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
            {/* A TYPED ∀, not the disc — the mark renders in one form and this
                is not it. Typed glyphs are the exempt register (web/CLAUDE.md),
                and the sentence is naming a character the reader must find on
                screen, so it has to BE that character. */}
            Click the ∀ symbol in the top left to explore further.
          </p>
        </div>

        <div style={{ marginTop: 12 }}>
          <PublicButton full onClick={onClose}>
            Back to the piece
          </PublicButton>
        </div>
      </div>
    </div>
  )
}
