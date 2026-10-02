import {
  TERMS_DOC,
  TERMS_ACCEPT_BEFORE,
  termsLinkText,
  termsAcceptAfter,
  termsRenewalSentence,
  type TermsKind,
} from '../content/terms-consent'
import type { ViewerTerms } from './html'

// =============================================================================
// modernhaus — the consent to a legal text (web-foundations.md, *A consent is
// ONE construction*), in this register.
//
// The same words as the full site's `TermsConsent` (`content/terms-consent.ts`),
// and the same four parts: never pre-ticked; it REPLACES the action it gates
// (the caller renders it in place of that button, with one button of its own);
// accepting RESUMES the press (the box rides the same form, and the action runs
// `POST /auth/accept-terms` before the act); and the document opens in a new
// tab, so the form is still standing when the member comes back.
//
// The box's VALUE is the version the server offered when this page was drawn
// (`terms.<kind>.current` off `/auth/me`), never a literal: the action sends it
// back, and the gateway refuses a stale one rather than coercing it.
// =============================================================================

/** The form field the box posts, and the only one an action reads for it. */
export const ACCEPT_TERMS_FIELD = 'acceptTerms'

export function TermsConsentBox(props: { kind: TermsKind; purpose: string; state: ViewerTerms }) {
  const doc = TERMS_DOC[props.kind]
  const isRenewal = !!props.state.version && !props.state.isCurrent
  return (
    <>
      {isRenewal && <p>{termsRenewalSentence(props.kind)}</p>}
      <p>
        <label>
          <input type="checkbox" name={ACCEPT_TERMS_FIELD} value={props.state.current} required />{' '}
          {TERMS_ACCEPT_BEFORE}
          <a href={`/modernhaus${doc.href}`} target="_blank" rel="noopener noreferrer">
            {termsLinkText(props.kind)}
          </a>
          {termsAcceptAfter(props.purpose)}
        </label>
      </p>
    </>
  )
}
