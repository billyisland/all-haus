'use client'

import type { TermsState } from '../../lib/api/auth'
import {
  TERMS_DOC,
  TERMS_ACCEPT_BEFORE,
  termsLinkText,
  termsAcceptAfter,
  termsRenewalSentence,
  type TermsKind,
} from '../../content/terms-consent'

// =============================================================================
// The consent control — one construction, five surfaces
//
// A member accepts a legal text in five places, and they must be the same
// gesture in all of them: card registration (`CardSetup`), the paywall gate for
// a reader who registered a card before the text existed (`PaywallGate`), the
// first paywalled publish (`ArticleEditor`), and — since §0z item 5 — the two
// places a subscription is bought, the profile pane's subscribe row
// (`NativeProfileBody`) and the offer page (`/subscribe/:code`). Hand-rolled
// checkboxes would drift in what they say, which is the one thing a consent
// record cannot afford — the stored version names a text, and the sentence
// beside the box is what the member actually read before ticking it.
//
// THE OFFER PAGE IS IN THE PUBLIC REGISTER, whose cards can be dark under a
// light page, so the neutral grey slugs and `.btn-text` would go muddy there.
// The register's difference is passed in as a SEAM (`tone`: the two colours
// the caller's palette already resolves), never a second component.
//
// THE DOCUMENT OPENS IN A NEW TAB, and for the same reason the Settings legal
// links do: every one of these three surfaces is a Glasshouse or an overlay,
// and a same-tab navigation out of one is the escape the overlay rules exist to
// stop. It is also what you want of a document you are checking something
// against — the form is still there when you come back.
//
// THE BOX IS NEVER PRE-TICKED. A pre-ticked consent is not a consent, and a
// default that "helps" here is the one that makes the record worthless.
//
// It renders the control and nothing else: the caller owns the button, the
// in-flight state and what happens on accept, because those differ (a card
// submit, a gate retry, a publish).
// =============================================================================

// The words are `content/terms-consent.ts`'s, which the plain register
// (`/modernhaus`) reads too, so the two consents cannot say different things.
export type { TermsKind }

interface TermsConsentProps {
  kind: TermsKind
  checked: boolean
  onChange: (checked: boolean) => void
  /** What the member is agreeing IN ORDER to do — one of `TERMS_PURPOSE`. */
  purpose: string
  /** The member's current state, so a re-prompt can say it is a NEW text. */
  state?: TermsState | null
  disabled?: boolean
  /**
   * The public register's seam: the sentence and link colours off the caller's
   * `usePublicPalette()`. Absent, the control wears the app's own tokens.
   */
  tone?: { text: string; link: string }
}

export function TermsConsent({
  kind,
  checked,
  onChange,
  purpose,
  state,
  disabled,
  tone,
}: TermsConsentProps) {
  const doc = TERMS_DOC[kind]
  // "Accepted an older text" and "accepted nothing" are different facts about a
  // person, and the sentence is different too: one is being asked again, the
  // other for the first time. Never a boolean — the server sends both halves.
  const isRenewal = !!state?.version && !state.isCurrent

  return (
    <div className="mb-4">
      {isRenewal && (
        <p
          className={tone ? 'text-ui-xs mb-2' : 'text-ui-xs text-grey-400 mb-2'}
          style={tone ? { color: tone.text } : undefined}
        >
          {termsRenewalSentence(kind)}
        </p>
      )}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-[3px]"
        />
        <span
          className={tone ? 'text-ui-xs' : 'text-ui-xs text-grey-600'}
          style={tone ? { color: tone.text } : undefined}
        >
          {TERMS_ACCEPT_BEFORE}
          <a
            href={doc.href}
            target="_blank"
            rel="noopener noreferrer"
            className={
              tone
                ? 'underline underline-offset-4 hover:opacity-70 transition-opacity'
                : 'btn-text'
            }
            style={tone ? { color: tone.link } : undefined}
            // The link must not toggle the box on its way out.
            onClick={(e) => e.stopPropagation()}
          >
            {termsLinkText(kind)}
          </a>
          {termsAcceptAfter(purpose)}
        </span>
      </label>
    </div>
  )
}
