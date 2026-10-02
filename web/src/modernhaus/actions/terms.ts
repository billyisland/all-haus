import type { TermsKind } from '../../content/terms-consent'
import { call, must, type GatewayAnswer, type GatewayContext } from '../gateway'
import type { Input } from '../door'
import { ACCEPT_TERMS_FIELD } from '../consent'

// =============================================================================
// modernhaus — the acceptance a press carries (web-foundations.md, *A consent
// is ONE construction*: accepting RESUMES the press it interrupted).
//
// `unlock`, `subscribe`, `publish_now` and `schedule` each call this FIRST
// when the form carries the ticked box, then run their act. The version is the
// one the page was drawn with (`terms.<kind>.current` off `/auth/me`); the
// gateway refuses a stale one rather than coercing it, and that refusal is
// said and the box asked again.
// =============================================================================

export function errorCode(body: unknown): string | null {
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : null
}

export type TermsStep =
  | { kind: 'ok' }
  | { kind: 'refused'; code: 'reader_terms_moved' | 'writer_terms_moved' | 'terms_accept_failed' }
  | { kind: 'answer'; answer: GatewayAnswer }

/**
 * The acceptance a form carries, run BEFORE the act it gates. No box, no call.
 * A 401 or the age step is handed back for the door to map; a moved text is
 * its own code, anything else refused is `terms_accept_failed`; a 5xx is a
 * fault (the act has not run).
 */
export async function acceptCarriedTerms(gw: GatewayContext, kind: TermsKind, input: Input): Promise<TermsStep> {
  const raw = input[ACCEPT_TERMS_FIELD]
  const version = typeof raw === 'string' ? raw.trim() : ''
  if (!version) return { kind: 'ok' }
  const a = must(await call(gw, 'POST', '/auth/accept-terms', { json: { kind, version } }), 'accept-terms')
  if (a.status >= 200 && a.status < 300) return { kind: 'ok' }
  if (a.status === 401 || (a.status === 403 && errorCode(a.body) === 'age_required')) return { kind: 'answer', answer: a }
  if (a.status === 400 && errorCode(a.body) === 'terms_version_mismatch') {
    return { kind: 'refused', code: kind === 'reader' ? 'reader_terms_moved' : 'writer_terms_moved' }
  }
  return { kind: 'refused', code: 'terms_accept_failed' }
}
