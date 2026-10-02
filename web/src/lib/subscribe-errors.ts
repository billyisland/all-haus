// =============================================================================
// Subscribe refusal mapping — `POST /subscriptions/:writerId` failures → copy.
//
// ONE home for the four surfaces that press subscribe: the profile pane's
// subscribe row, the Following list on your own profile, the offer page, and
// the paywall's Subscribe (CA-E6 — it read only the status, so a declined
// card-holder was told to add a card and a Terms refusal said "Failed to
// subscribe"). modernhaus maps through here too. Every web press goes through
// the one client, `lib/api/subscriptions.ts`, whose refusals are `ApiError`s
// in exactly the shape this reads. They each used to spell the refusals
// themselves, and drifted (walkthrough A9): the Following list swallowed every refusal in an empty catch, and the
// profile and the offer page read ANY 402 as "add a card" — but a 402 is two
// refusals, and `card_action_required` reaches only readers who HAVE a card
// (the one on file declined), so "add a card" pointed them at a step they
// finished long ago. Neither 402 carries a `message`, which is why
// `apiErrorMessage` alone is not enough here.
//
// Pure, so it is unit-testable; the codes are pinned against the gateway route
// by `web/tests/subscribe-errors-wire.test.ts`.
// =============================================================================

import { READER_TERMS_REQUIRED_CODE } from './unlock-errors'

export interface SubscribeErrorView {
  message: string
  /** Accepting the Reader Terms is the fix — the consent replaces the control
   *  where the surface has one; elsewhere, send the member where it lives. */
  needsTerms: boolean
}

const GENERIC = 'Subscription failed — nothing has been charged. Try again.'

export function mapSubscribeError(err: unknown): SubscribeErrorView {
  const e = (err ?? {}) as { status?: unknown; body?: unknown }
  const status = typeof e.status === 'number' ? e.status : undefined
  const b = (e.body ?? {}) as { error?: unknown; message?: unknown }
  const code = typeof b.error === 'string' ? b.error : null
  const serverMessage = typeof b.message === 'string' && b.message ? b.message : null

  if (code === READER_TERMS_REQUIRED_CODE) {
    return {
      message: serverMessage ?? 'Before subscribing, please accept the all.haus Reader Terms.',
      needsTerms: true,
    }
  }
  if (code === 'card_action_required') {
    return {
      message:
        'The card on file was declined, so new charges are paused. Replace it in Settings to subscribe — nothing has been charged.',
      needsTerms: false,
    }
  }
  if (code === 'card_required' || status === 402) {
    return {
      message: 'Add a payment card in Settings to subscribe. Nothing has been charged.',
      needsTerms: false,
    }
  }
  if (code === 'not_for_sale') {
    return {
      message:
        serverMessage ??
        "This writer's paid access isn't available at the moment. Nothing has been charged.",
      needsTerms: false,
    }
  }
  if (serverMessage) return { message: serverMessage, needsTerms: false }
  // The route's other refusals are sentences in `error` ("Already subscribed",
  // "This offer has expired"); a snake_case code is not one and is not shown.
  if (code && /\s/.test(code)) return { message: code, needsTerms: false }
  return { message: GENERIC, needsTerms: false }
}
