import type { GatewayAnswer } from '../gateway'
import { sentenceForStatus } from '../outcomes'
import type { ActionContext, ActionOutcome, Input } from '../door'
import { baseHeaders } from '../respond'
import { safeHttpUrl } from '../../lib/external-links'

// =============================================================================
// modernhaus — the few helpers every action file needs.
// =============================================================================

export const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')

export const ok = (a: GatewayAnswer): boolean => a.status >= 200 && a.status < 300

/** A refusal made here, shaped as the route would answer it, for the door to map. */
export const refused = (status: number): ActionOutcome => ({
  kind: 'answer',
  answer: { status, body: null, setCookies: [] },
})

/** A refusal the door must handle itself: signed out, or the age step. */
export function doorOwns(answer: GatewayAnswer): boolean {
  if (answer.status === 401) return true
  const e = answer.body && typeof answer.body === 'object' ? (answer.body as { error?: unknown }).error : undefined
  return answer.status === 403 && e === 'age_required'
}

/** The gateway's own words for a refusal, escaped by React on the page (§D2.5.3). */
export function refusalSentence(answer: GatewayAnswer): string {
  const b = answer.body && typeof answer.body === 'object' ? (answer.body as { message?: unknown; error?: unknown }) : {}
  if (typeof b.message === 'string' && b.message.trim() !== '') return b.message
  // A snake_case code is a machine's word, not a sentence.
  if (typeof b.error === 'string' && /\s/.test(b.error)) return b.error
  return sentenceForStatus(answer.status)
}

/**
 * The off-site 303 (§D2.5.2): to a URL out of the gateway's OWN answer, https
 * only, never off the form. Null when the answer carried nothing usable.
 */
export function offSite(ctx: ActionContext, candidate: unknown): ActionOutcome | null {
  const url = typeof candidate === 'string' ? safeHttpUrl(candidate) : undefined
  if (!url || !url.startsWith('https://')) return null
  const h = baseHeaders()
  for (const c of ctx.gw.setCookies) h.append('Set-Cookie', c)
  h.set('Location', url)
  return { kind: 'response', response: new Response(null, { status: 303, headers: h }) }
}
