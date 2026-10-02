import { LINK_SENT_BEFORE, LINK_SENT_AFTER, VERIFY_EXPIRED, WAITLIST_JOINED_TITLE } from '../content/auth'
import { reportReceipt } from '../content/report'
import { externalReplyNotSent } from '../content/conversation'
import { PAYWALL_EMPTY, PAYWALL_PRICE_REQUIRED } from '../lib/publish-validation'
import { mapSubscribeError } from '../lib/subscribe-errors'
import { READER_TERMS_REQUIRED_CODE } from '../lib/unlock-errors'
import { termsVersionMismatch, TERMS_ACCEPT_FAILED } from '../content/terms-consent'
import { OFFER_SUBSCRIBED_TITLE } from '../content/subscribe-offer'
import { SUBSCRIPTION_CANCEL_BODY } from '../content/ledger'
import { PAYOUT_SAVED, CONNECT_FAILED } from '../content/money-settings'
import { MESSAGES_START_FAILED } from '../content/messages'
import {
  PROFILE_SAVED,
  USERNAME_UPDATED,
  emailVerificationSentSentence,
  EXPORT_STEP_UP_SENT,
  DEACTIVATE_HELP,
  READING_CLEAR_NOTHING,
} from '../content/settings'
import {
  NETWORK_CONNECT_FAILED,
  FOLLOW_IMPORT_START_FAILED,
  OPML_UNREADABLE,
  OPML_START_FAILED,
  PREFS_SAVE_FAILED,
} from '../content/networks'
import {
  UNPUBLISH_DONE,
  PRICING_UPDATED,
  WELCOME_SAVED,
  WELCOME_CLEARED,
  GIFT_LINK_CREATE_FAILED,
} from '../content/dashboard'
import { FEED_LINK_ADDED, FEED_LINK_REDEEM_REFUSALS } from '../content/feed-link'
import { WRITER_APPLY_DONE } from '../content/writer-access'

// =============================================================================
// modernhaus — the closed outcome vocabulary (MODERNHAUS-ADR §D1.7, §D2.8).
//
// After a write, the door redirects with `?done=<code>` or `?error=<code>`,
// and the page renders the code's sentence from THESE tables. The query string
// never carries free text: a code the tables do not know renders the generic
// sentence, so a crafted URL can never put words on the page.
//
// Each E step adds the codes its actions can receive (§D2.8). A route-specific
// code is pinned against the gateway file that sends it
// (`web/tests/modernhaus/structure.test.ts`): a code nobody sends is a
// sentence nobody reads, and one the gateway renamed would fall through to the
// generic sentence silently.
//
// Money copy is never written here: a subscribe refusal's sentence is
// `mapSubscribeError`'s, computed from the route's own answer; a settlement's
// is the route's own `message`, pinned against the file that sends it; the
// unlock renders in place through `mapUnlockError` and needs no code at all.
// =============================================================================

export const GENERIC_FAULT = 'Something went wrong on our side. Nothing was changed. Please try again.'

// A success that gets where it was going says nothing (the full site's verify
// page ruled that, 2026-09-04): a sign-in, a new account and an age
// declaration redirect with no code at all. Only a success whose result is not
// otherwise visible has a sentence.
const DONE: Record<string, string> = {
  // The address is not carried: the query string never holds free text.
  link_sent: `${LINK_SENT_BEFORE}that address${LINK_SENT_AFTER}`,
  waitlisted: WAITLIST_JOINED_TITLE,
  signed_out: 'You are signed out.',
  // E3 — reading. None of these has a full-site twin to lift from: the full
  // site answers a press by changing the control, which a page cannot do.
  replied: 'Your reply is posted.',
  // The network is not carried: the query string never holds free text.
  replied_not_sent: externalReplyNotSent(),
  voted: 'Your vote is counted.',
  vote_capped: 'You have already voted that way on this. Nothing changed.',
  liked: 'Liked.',
  reposted: 'Reposted.',
  poll_voted: 'Your vote is sent.',
  deleted: 'Deleted.',
  followed: 'Followed.',
  unfollowed: 'Unfollowed, from every channel.',
  unfollowed_partly: 'Unfollowed, but we couldn’t change some of your channels, so they may still include this person. Please try again to finish.',
  reported_p0: reportReceipt('P0'),
  reported_p1: reportReceipt('P1'),
  reported_p2: reportReceipt('P2'),
  read: 'Marked as read.',
  all_read: 'All marked as read.',
  feed_created: 'Channel created.',
  feed_hidden: 'Channel hidden.',
  feed_shown: 'Channel shown.',
  feed_moved: 'Channel moved.',
  seen: 'Marked as seen.',
  // E4 — writing. No full-site twin: the editor closes itself on success.
  posted: 'Your note is posted.',
  draft_saved: 'Draft saved.',
  published: 'Published.',
  published_untagged: 'Published, but we couldn’t save its tags. You can add them from your dashboard.',
  scheduled: 'Scheduled. It stays in your drafts until then.',
  unscheduled: 'Unscheduled. The draft is kept.',
  // E5 — money.
  subscribed: OFFER_SUBSCRIBED_TITLE,
  subscription_cancelled: `Subscription cancelled. ${SUBSCRIPTION_CANCEL_BODY}`,
  subscription_saved: PAYOUT_SAVED,
  payouts_saved: PAYOUT_SAVED,
  writer_applied: WRITER_APPLY_DONE,
  card_removed: 'Your card is removed. Anything already on your tab stays owed.',
  // E6 — the rest. The full site changes a control on success; a page must
  // say what happened, so most of these are new, and short. Where the full
  // site has a sentence for the outcome, it is used.
  message_sent: 'Sent.',
  unliked: 'Like removed.',
  blocked: 'Blocked.',
  unblocked: 'Unblocked.',
  muted: 'Muted.',
  unmuted: 'Unmuted.',
  profile_saved: PROFILE_SAVED,
  username_changed: USERNAME_UPDATED,
  // The address is not carried: the query string never holds free text.
  email_change_sent: emailVerificationSentSentence('that address'),
  export_requested: EXPORT_STEP_UP_SENT,
  deactivated: DEACTIVATE_HELP,
  deleted_account: 'Your account is deleted.',
  network_saved: 'Saved.',
  network_unlinked: 'Disconnected.',
  prefs_saved: 'Saved.',
  log_cleared: 'Recent reading is cleared.',
  log_empty: READING_CLEAR_NOTHING,
  replies_on: 'Replies are on.',
  replies_off: 'Replies are off.',
  unpublished: UNPUBLISH_DONE,
  tags_saved: 'Tags saved.',
  gift_link_created: 'A new gift link is in the list below.',
  gift_link_revoked: 'That gift link no longer works.',
  price_saved: PRICING_UPDATED,
  welcome_saved: WELCOME_SAVED,
  welcome_cleared: WELCOME_CLEARED,
  offer_created: 'The offer is made; its link is in the list.',
  comp_granted: 'The subscription is offered to them.',
  offer_revoked: 'That offer no longer works for new sign-ups.',
  feed_saved: 'Saved.',
  source_saved: 'Saved.',
  source_added: 'Added to the channel.',
  source_removed: 'Taken out of this channel.',
  source_moved: 'Moved.',
  feeds_merged: 'Merged.',
  feed_deleted: 'Channel deleted.',
  formula_frozen: 'Your share link is ready. It’s below.',
  sharing_stopped: 'That share link no longer works. Anyone who has already added the channel keeps it.',
  formula_redeemed: FEED_LINK_ADDED,
  formula_redeemed_partly: `${FEED_LINK_ADDED} We couldn’t reach some of its sources, so they aren’t in your copy.`,
}

/**
 * Generic refusals, by the gateway's status when it sent no code we know —
 * and the few codes the door mints itself (`stale_order`, `link_expired`).
 */
const GENERIC_ERRORS: Record<string, string> = {
  invalid: 'That wasn’t accepted. Please check what you entered and try again.',
  forbidden: 'You don’t have permission to do that.',
  not_found: 'We couldn’t find that. It may have been deleted.',
  conflict: 'Something changed while this page was open. Please reload it and try again.',
  too_large: 'That was too large.',
  rate_limited: 'That was too many requests in a short time. Please wait a minute and try again.',
  refused: 'That couldn’t be done. Nothing was changed.',
  stale_order: 'Your channels changed while this page was open, so here is the current order. Please try the move again.',
  link_expired: VERIFY_EXPIRED,
  // E4's door-minted refusals: the schedule is read on this side (london-time.ts).
  schedule_invalid: 'That isn’t a real date and time in London. Please check the day, month, year, hour and minute.',
  schedule_past: 'That time has already passed. Choose one in the future.',
  // E5 — an acceptance the press carried, refused before the act ran.
  reader_terms_moved: termsVersionMismatch('reader'),
  writer_terms_moved: termsVersionMismatch('writer'),
  terms_accept_failed: TERMS_ACCEPT_FAILED,
  connect_failed: CONNECT_FAILED,
  // E6 — the full site's own failure sentences, under door-minted codes.
  conversation_not_started: MESSAGES_START_FAILED,
  network_connect_failed: NETWORK_CONNECT_FAILED,
  follow_import_failed: FOLLOW_IMPORT_START_FAILED,
  opml_unreadable: OPML_UNREADABLE,
  opml_failed: OPML_START_FAILED,
  prefs_not_saved: PREFS_SAVE_FAILED,
  prefs_saved_partly: 'Some of those changes were saved and some were not. The page shows where each one stands now.',
  gift_link_not_created: GIFT_LINK_CREATE_FAILED,
}

/**
 * A money route's own SENTENCE, under a code this register mints: the full
 * site shows the route's `message` (or, for the subscribe route's English
 * refusals, the `error` itself), and a redirect can carry only a code. Each
 * sentence is pinned against the file named beside it
 * (`web/tests/modernhaus/structure.test.ts`), so a re-worded route fails a
 * test rather than drifting from this copy.
 */
export const ROUTE_SENTENCES: Record<string, { sentence: string; sentBy: string; kind: 'done' | 'error' }> = {
  // POST /my/tab/settle — every outcome has its own answer (the route's header).
  settled: { kind: 'done', sentence: 'Your card is being charged for what you owe.', sentBy: 'gateway/src/routes/my-account.ts' },
  settle_nothing_due: { kind: 'done', sentence: 'There is nothing on your tab to settle.', sentBy: 'gateway/src/routes/my-account.ts' },
  settle_below_minimum: {
    kind: 'done',
    sentence: 'Your tab is too small to charge — card payments start at 30p. It will settle once it grows.',
    sentBy: 'gateway/src/routes/my-account.ts',
  },
  settlement_in_flight: { kind: 'error', sentence: 'We are already settling your tab. Give it a moment.', sentBy: 'gateway/src/routes/my-account.ts' },
  settle_card_required: { kind: 'error', sentence: 'Add a payment card to settle your tab.', sentBy: 'gateway/src/routes/my-account.ts' },
  settle_card_declined: { kind: 'error', sentence: 'The card on file was declined. Add a working card to settle your tab.', sentBy: 'gateway/src/routes/my-account.ts' },
  // The charge may be live: never "nothing was changed", never "try again".
  settlement_unconfirmed: {
    kind: 'error',
    sentence: 'We could not confirm whether that payment went through. Check your tab again shortly before retrying.',
    sentBy: 'gateway/src/routes/my-account.ts',
  },
  // DELETE /auth/payment-method: every card still attached, so nothing changed.
  card_remove_failed: { kind: 'error', sentence: 'Could not remove the card. Please try again.', sentBy: 'gateway/src/routes/auth.ts' },
  // POST /subscriptions/:writerId's refusals that are sentences in `error`,
  // which `mapSubscribeError` shows as they come.
  subscribe_already: { kind: 'error', sentence: 'Already subscribed', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  subscribe_blocked: { kind: 'error', sentence: 'You cannot subscribe to this writer', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  offer_not_found: { kind: 'error', sentence: 'Offer not found or no longer available', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  offer_expired: { kind: 'error', sentence: 'This offer has expired', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  offer_redeemed: { kind: 'error', sentence: 'This offer has been fully redeemed', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  offer_not_yours: { kind: 'error', sentence: 'This offer is not available to you', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
}

/**
 * The subscribe route's coded refusals. The sentence is `mapSubscribeError`'s
 * — the ONE mapper every subscribe surface takes (web-foundations.md) —
 * applied to the route's own answer; `message` is the route's, pinned beside
 * the code.
 */
export const SUBSCRIBE_REFUSALS: Record<string, { status: number; error: string; message?: string; sentBy: string }> = {
  subscribe_terms: {
    status: 403,
    error: READER_TERMS_REQUIRED_CODE,
    message: 'Before subscribing, please accept the all.haus Reader Terms.',
    sentBy: 'gateway/src/routes/subscriptions/writer.ts',
  },
  subscribe_card_required: { status: 402, error: 'card_required', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  subscribe_card_declined: { status: 402, error: 'card_action_required', sentBy: 'gateway/src/routes/subscriptions/writer.ts' },
  subscribe_not_for_sale: {
    status: 403,
    error: 'not_for_sale',
    message: "This writer's paid access isn't available at the moment. Nothing has been charged.",
    sentBy: 'gateway/src/routes/subscriptions/writer.ts',
  },
}

function subscribeSentence(code: string): string | null {
  const r = SUBSCRIBE_REFUSALS[code]
  if (!r) return null
  return mapSubscribeError({ status: r.status, body: { error: r.error, ...(r.message ? { message: r.message } : {}) } }).message
}

/** The codes whose fix is a card, so the page can offer the full site's card link. */
export const CARD_FIX_CODES: ReadonlySet<string> = new Set([
  'subscribe_card_required',
  'subscribe_card_declined',
  'settle_card_required',
  'settle_card_declined',
])

/** The routes' own codes. Each is pinned against the gateway file named beside it. */
export const ROUTE_ERRORS: Record<string, { sentence: string; sentBy: string }> = {
  // The export waits after an email change. The route's own sentence carries
  // the two dates; a code crossing a redirect cannot, so this one says the
  // rule without them.
  export_held: {
    sentence: "Your sign-in email was changed recently, so exporting your account is paused for a few days. That gives your old address time to undo a change it didn't make.",
    sentBy: 'gateway/src/lib/email-change-hold.ts',
  },
  // The gateway's own sentence for an operator-blocked source, copied rather
  // than re-worded (the full site shows the route's `message`).
  source_blocked: {
    sentence: 'all.haus does not carry this source. If you think that is wrong, write to us.',
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  source_unreachable: {
    sentence: 'That source didn’t answer, so we couldn’t add it. It may be down for now. Please try again later.',
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  invalid_source_uri: {
    sentence: 'We can’t follow that address. Please check it’s a web address, handle or feed URL and try again.',
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  source_not_found: {
    sentence: "We couldn't find that source, so nothing was added.",
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  source_already_in_channel: {
    sentence: 'That source is already in this channel.',
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  // Also sent by `author-volume.ts`, in the same words.
  self_source: {
    sentence: "You can't add your own account to a channel.",
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  // The neutral both-ways block refusal: one sentence for either direction.
  target_blocked: {
    sentence: "You can't add this account to a channel.",
    sentBy: 'gateway/src/routes/feeds/sources.ts',
  },
  // E4 — the publish-now door (`POST /drafts/:id/publish`). The two paywall
  // sentences are the EDITOR's (`publish-validation.ts`), which this register
  // also runs before it asks. The five refusals below are `publishRefusal`'s,
  // which since 2026-09-29 (CA-A1) lives in the publisher and is asked by the
  // publish-now door, the schedule door and the publisher itself; the route's
  // own words are the two after them.
  paywall_empty: { sentence: PAYWALL_EMPTY, sentBy: 'gateway/src/services/article-publisher.ts' },
  paywall_price: { sentence: PAYWALL_PRICE_REQUIRED, sentBy: 'gateway/src/services/article-publisher.ts' },
  paywall_gate: {
    sentence: 'The paywall gate needs a position between 1 and 99 per cent.',
    sentBy: 'gateway/src/services/article-publisher.ts',
  },
  title_required: { sentence: 'Give the piece a title before publishing it.', sentBy: 'gateway/src/services/article-publisher.ts' },
  content_required: { sentence: 'There is nothing to publish yet.', sentBy: 'gateway/src/services/article-publisher.ts' },
  draft_scheduled: {
    sentence: 'This draft is scheduled. Unschedule it first to publish it now.',
    sentBy: 'gateway/src/routes/drafts.ts',
  },
  publication_draft: {
    sentence: 'This draft belongs to a publication, and cannot be published from here.',
    sentBy: 'gateway/src/routes/drafts.ts',
  },
  // DELETE /auth/payment-method when there is no card left to remove.
  no_payment_method: { sentence: 'There is no card on file to remove.', sentBy: 'gateway/src/routes/auth.ts' },
  // E6 — a feed link's redeem refusals. The sentences are the full site's
  // (`FEED_LINK_REDEEM_REFUSALS`), which it shows in place of the route's.
  formula_revoked: { sentence: FEED_LINK_REDEEM_REFUSALS.formula_revoked, sentBy: 'gateway/src/routes/feeds/formulas.ts' },
  source_feed_gone: { sentence: FEED_LINK_REDEEM_REFUSALS.source_feed_gone, sentBy: 'gateway/src/routes/feeds/formulas.ts' },
  formula_empty: { sentence: FEED_LINK_REDEEM_REFUSALS.formula_empty, sentBy: 'gateway/src/routes/feeds/formulas.ts' },
  formula_too_large: { sentence: FEED_LINK_REDEEM_REFUSALS.formula_too_large, sentBy: 'gateway/src/routes/feeds/formulas.ts' },
  default_seed_formula: {
    sentence: 'This composition seeds every new account. Designate a replacement before revoking it.',
    sentBy: 'gateway/src/routes/feeds/formulas.ts',
  },
  // The publish and schedule routes send it through the one home's constant.
  writer_terms_required: {
    sentence: 'Before publishing paid access, please accept the all.haus Writer Agreement.',
    sentBy: 'gateway/src/lib/terms-gate.ts',
  },
  // Every writer door — publish, schedule, drafts, pricing, offers, gift links
  // and Connect onboarding — refuses a reader with this (READER-WRITER-SPLIT-
  // ADR). The full site's sentence, so the two registers say one thing.
  // A writer pressing Apply (a grant landed between the page and the press).
  already_writer: {
    sentence: 'You can already publish articles.',
    sentBy: 'gateway/src/routes/writer-applications.ts',
  },
  writer_access_required: {
    sentence: 'Publishing articles is open to members admitted as writers.',
    sentBy: 'gateway/src/lib/writer-gate.ts',
  },
}

const STATUS_CODES: Record<number, string> = {
  400: 'invalid',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  // 422 is how the feeds and external-item routes say "well-formed, but no"
  // (an unreachable source, a linked account that must be reconnected).
  422: 'refused',
  429: 'rate_limited',
}

/**
 * The code a refusal travels as. A route's own snake_case `error` the table
 * knows wins; otherwise the status decides. Null for a status the door must
 * treat as a fault (5xx, or anything unmapped).
 */
export function refusalCode(status: number, body: unknown): string | null {
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : null
  if (error && error in ROUTE_ERRORS) return error
  return STATUS_CODES[status] ?? null
}

/** The generic sentence for a refusal status, for a READ that was refused in place. */
export function sentenceForStatus(status: number): string {
  const code = STATUS_CODES[status]
  return (code && GENERIC_ERRORS[code]) ?? GENERIC_FAULT
}

export type Outcome = { kind: 'done' | 'error'; sentence: string }

/** The one sentence a page shows for its `?done=` / `?error=`, if any. */
export function outcomeFromQuery(params: URLSearchParams): Outcome | null {
  const error = params.get('error')
  if (error !== null) {
    const own = ROUTE_SENTENCES[error]?.kind === 'error' ? ROUTE_SENTENCES[error].sentence : null
    const sentence =
      ROUTE_ERRORS[error]?.sentence ?? own ?? subscribeSentence(error) ?? GENERIC_ERRORS[error] ?? GENERIC_FAULT
    return { kind: 'error', sentence }
  }
  const done = params.get('done')
  if (done !== null) {
    // An unknown success code says nothing rather than claiming a success.
    const own = ROUTE_SENTENCES[done]?.kind === 'done' ? ROUTE_SENTENCES[done].sentence : null
    const sentence = DONE[done] ?? own
    return sentence ? { kind: 'done', sentence } : null
  }
  return null
}

/**
 * A `return` path the door may redirect to: a path under `/modernhaus`, with no
 * scheme, no `//`, no backslash and no control characters. Anything else is
 * null, and the door falls back to the action's own default.
 */
export function safeReturn(value: string | null | undefined): string | null {
  if (!value) return null
  if (value !== '/modernhaus' && !value.startsWith('/modernhaus/') && !value.startsWith('/modernhaus?')) {
    return null
  }
  if (value.includes('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value, 'http://modernhaus.invalid')
  } catch {
    return null
  }
  if (parsed.host !== 'modernhaus.invalid') return null
  if (parsed.pathname !== '/modernhaus' && !parsed.pathname.startsWith('/modernhaus/')) return null
  return parsed.pathname + parsed.search
}
