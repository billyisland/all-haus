import { createElement } from 'react'
import { call, must, path, type GatewayAnswer } from '../gateway'
import { redirectResponse } from '../respond'
import { safeReturn } from '../outcomes'
import { documentResponse, loadViewer } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import type { DateOfBirthValues } from '../html'
import { SignupPage, AgePage, type SignupValues } from '../pages/auth'
import {
  AUTH_TRY_AGAIN,
  AGE_SAVE_FAILED,
  AGE_TITLE,
  SIGNUP_TITLE,
  SIGNUP_EMAIL_TAKEN,
  SIGNUP_ACCOUNT_RACE,
} from '../../content/auth'

// =============================================================================
// modernhaus — sign in, sign up, the age step, the waiting list and sign out
// (MODERNHAUS-ADR §D2.4, E2). Each calls the route the full site calls.
//
// A SUCCESS THAT GETS WHERE IT WAS GOING SAYS NOTHING. Verify, signup and the
// age declaration redirect to their destination with no `?done=`, as the full
// site's verify page does (ruled 2026-09-04: "getting somebody where they were
// going is not an event that needs announcing").
//
// Verify handles its OWN 401: from `/auth/verify` it means a spent or expired
// link, not "you are signed out", so it must not reach the door's sign-in
// redirect — that would send the member round in a circle with no sentence.
// =============================================================================

const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')

/** An article d-tag the gateway would accept as `arrivalDTag`, or null. */
function arrivalOf(input: Input): string | null {
  const a = str(input.arrival)
  return a.length > 0 && a.length <= 200 ? a : null
}

/** Where an arrival lands: the piece, rebuilt from its identifier — never a path handed over. */
function arrivalLocation(arrival: string | null): string {
  return arrival ? `/modernhaus/article/${encodeURIComponent(arrival)}` : '/modernhaus'
}

function dobValues(input: Input): DateOfBirthValues {
  return { day: str(input.dob_day), month: str(input.dob_month), year: str(input.dob_year) }
}

/**
 * The three boxes as `YYYY-MM-DD`, padded, once all three hold something, and
 * `''` before that — the full site's `DateOfBirthField` rule. No judging here:
 * `shared/src/lib/age.ts` is the one home for that, and the route refuses in
 * its own words.
 */
export function assembleDateOfBirth(v: DateOfBirthValues): string {
  if (v.day === '' || v.month === '' || v.year === '') return ''
  return `${v.year.padStart(4, '0')}-${v.month.padStart(2, '0')}-${v.day.padStart(2, '0')}`
}

/** The gateway's own sentence for a 400, shown escaped (§D2.5.3). */
function gatewayMessage(body: unknown): string | null {
  const m = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined
  return typeof m === 'string' && m.trim() !== '' ? m : null
}

function errorCode(body: unknown): string | null {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof e === 'string' ? e : null
}

const ONE_FIELD = { email: 'string' } as const

const DOB_FIELDS = { dob_day: 'string', dob_month: 'string', dob_year: 'string' } as const

async function verify(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const token = str(input.token)
  if (token === '') {
    return { kind: 'response', response: redirectResponse('/modernhaus/auth/verify', ctx.gw.setCookies) }
  }
  const answer = must(await call(ctx.gw, 'POST', '/auth/verify', { json: { token } }), 'verify')
  if (answer.status === 200) {
    return { kind: 'response', response: redirectResponse(arrivalLocation(arrivalOf(input)), ctx.gw.setCookies) }
  }
  if (answer.status === 401) {
    return {
      kind: 'response',
      response: redirectResponse('/modernhaus/auth/verify?error=link_expired', ctx.gw.setCookies),
    }
  }
  return { kind: 'answer', answer }
}

async function signup(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const values: SignupValues = { email: str(input.email), displayName: str(input.displayName), dob: dobValues(input) }
  const next = safeReturn(str(input.next) || null)
  // THE ARRIVAL RIDES THE SIGNUP (E5; PAYWALL-ARRIVAL §5): a new account made
  // from a paywalled piece is stamped with it, as an IDENTIFIER, never a path —
  // the gateway looks the price up itself. It lands on the piece, whose GET
  // runs the arrival landing (article-view.tsx).
  const arrival = next?.match(/^\/modernhaus\/article\/([^/?]+)$/)?.[1]
  let arrivalDTag: string | null = null
  if (arrival) {
    try {
      arrivalDTag = decodeURIComponent(arrival)
    } catch {
      arrivalDTag = null
    }
  }
  const answer = must(
    await call(ctx.gw, 'POST', '/auth/signup', {
      json: {
        email: values.email,
        displayName: values.displayName,
        dateOfBirth: assembleDateOfBirth(values.dob),
        ...(arrivalDTag ? { arrivalDTag } : {}),
      },
    }),
    'signup',
  )
  if (answer.status === 201 || answer.status === 200) {
    return { kind: 'response', response: redirectResponse(next ?? '/modernhaus', ctx.gw.setCookies) }
  }
  if (answer.status === 403 && errorCode(answer.body) === 'closed_beta') {
    return { kind: 'response', response: redirectResponse('/modernhaus/waitlist?from=beta', ctx.gw.setCookies) }
  }
  // Two 409s, and only one is about this form (the full site's signup page
  // says why): `email_taken` is the reader's to fix; `account_taken` is a
  // handle race nobody typed.
  let sentence: string | null = null
  if (answer.status === 409) sentence = errorCode(answer.body) === 'email_taken' ? SIGNUP_EMAIL_TAKEN : SIGNUP_ACCOUNT_RACE
  else if (answer.status === 400) sentence = gatewayMessage(answer.body) ?? AUTH_TRY_AGAIN
  if (sentence === null) return { kind: 'answer', answer }
  return {
    kind: 'response',
    response: await documentResponse({
      title: SIGNUP_TITLE,
      viewer: null,
      csrf: ctx.csrf,
      twin: '/auth/signup',
      outcome: { kind: 'error', sentence },
      body: createElement(SignupPage, { csrf: ctx.csrf, next, values }),
      status: answer.status,
      cookies: ctx.gw.setCookies,
    }),
  }
}

async function declareAge(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const values = dobValues(input)
  const next = safeReturn(str(input.next) || null)
  const answer: GatewayAnswer = must(
    await call(ctx.gw, 'POST', '/auth/declare-age', { json: { dateOfBirth: assembleDateOfBirth(values) } }),
    'declare-age',
  )
  if (answer.status === 200) {
    return { kind: 'response', response: redirectResponse(next ?? '/modernhaus', ctx.gw.setCookies) }
  }
  if (answer.status !== 400) return { kind: 'answer', answer }
  // The refusal is the server's sentence (an under-18 date, or not a date):
  // the rule lives in `shared`, and this register keeps no copy to paraphrase.
  const viewer = await loadViewer(ctx.gw)
  return {
    kind: 'response',
    response: await documentResponse({
      title: AGE_TITLE,
      viewer,
      csrf: ctx.csrf,
      twin: null,
      outcome: { kind: 'error', sentence: gatewayMessage(answer.body) ?? AGE_SAVE_FAILED },
      body: createElement(AgePage, { csrf: ctx.csrf, next, values }),
      status: 400,
      cookies: ctx.gw.setCookies,
    }),
  }
}

export const AUTH_ACTIONS: Registry = {
  signin: {
    kind: 'simple',
    method: 'POST',
    fields: { ...ONE_FIELD, arrival: 'string' },
    path: () => path`/auth/login`,
    body: (input) => {
      const arrival = arrivalOf(input)
      return { email: str(input.email), surface: 'modernhaus', ...(arrival ? { arrivalDTag: arrival } : {}) }
    },
    done: 'link_sent',
    defaultReturn: () => '/modernhaus/signin',
  },
  verify: {
    kind: 'orchestrated',
    fields: { token: 'string', arrival: 'string' },
    run: verify,
    defaultReturn: () => '/modernhaus/signin',
  },
  signup: {
    kind: 'orchestrated',
    fields: { email: 'string', displayName: 'string', next: 'string', ...DOB_FIELDS },
    run: signup,
    defaultReturn: () => '/modernhaus/signup',
  },
  declare_age: {
    kind: 'orchestrated',
    fields: { next: 'string', ...DOB_FIELDS },
    run: declareAge,
    defaultReturn: () => '/modernhaus/age',
  },
  waitlist: {
    kind: 'simple',
    method: 'POST',
    fields: ONE_FIELD,
    path: () => path`/waitlist`,
    body: (input) => ({ email: str(input.email) }),
    done: 'waitlisted',
    defaultReturn: () => '/modernhaus/waitlist',
  },
  signout: {
    kind: 'simple',
    method: 'POST',
    fields: {},
    path: () => path`/auth/logout`,
    body: () => ({}),
    done: 'signed_out',
    defaultReturn: () => '/modernhaus',
  },
}
