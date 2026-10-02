import type { FeedLink } from '../lib/api/formulas'

// =============================================================================
// A shared feed link (`/f/:token`) — the words, in one home for both registers.
//
// The full site's page (`app/f/[token]/page.tsx`, a client component) and
// modernhaus's (`/modernhaus/f/:token`, bare HTML) say the same things about a
// link. They live here because modernhaus cannot import a `'use client'` file,
// and two copies of a public page drift invisibly. The reasoning behind each
// sentence (D5, D7, L7, §6) is in the full site page's comments.
// =============================================================================

/** The author as the page names them, or null when the link carries neither. */
export function feedLinkAuthorName(link: Pick<FeedLink, 'author'>): string | null {
  return link.author.displayName ?? link.author.username
}

/** `|| `, not `?? `: an untitled feed arrives as `""` (see the full site page). */
export function feedLinkTitle(link: Pick<FeedLink, 'name'>): string {
  return link.name?.trim() || 'A channel'
}

export const FEED_LINK_WITHDRAWN_TITLE = 'This channel has been withdrawn'
export const FEED_LINK_GONE_TITLE = 'This channel no longer exists'

export function feedLinkWithdrawnSentence(authorName: string | null): string {
  return `${authorName ? `${authorName} has` : 'The author has'} taken this link down. Anyone who already added the channel keeps their copy: withdrawing a link only stops new ones.`
}

export function feedLinkGoneSentence(authorName: string | null): string {
  return `${authorName ? `${authorName} has` : 'The author has'} deleted the channel this link pointed at. Anyone who already added it keeps their copy — it was theirs from the moment they added it.`
}

/** "A feed of N sources", without the author, who each register draws itself. */
export function feedLinkSourceCount(n: number): string {
  return `A channel of ${n} ${n === 1 ? 'source' : 'sources'}`
}

export const FEED_LINK_CONTENTS_LABEL = 'What’s in it'

export function feedLinkExcludedSentence(n: number): string {
  return `${n === 1 ? 'One source in the original channel couldn’t be shared' : `${n} sources in the original channel couldn’t be shared`}. Newsletters can’t travel, because each one arrives at an address that belongs to a single subscriber, and a source may also have stopped existing.`
}

export function feedLinkRefusalSentence(refusal: NonNullable<FeedLink['refusal']>): string {
  return refusal === 'empty'
    ? 'There’s nothing in this channel to add yet. Keep the link: it will work as soon as its author adds a source.'
    : 'This channel has too many sources to share as a link. Keep the link: it will work once its author takes some out.'
}

// Keyed on the server's own `error` code, not on the message: the copy here is
// the recipient's voice and the message is the operator's.
export const FEED_LINK_REDEEM_REFUSALS: Record<string, string> = {
  formula_revoked: 'The author has withdrawn this link.',
  source_feed_gone: 'The channel this link pointed at no longer exists.',
  formula_empty: 'There is nothing in this channel to add yet.',
  formula_too_large: 'This channel has too many sources to share as a link.',
}

// --- The page around the link --------------------------------------------------

export const FEED_LINK_MISSING_TITLE = 'This link doesn’t lead anywhere'
/** The lookup got no answer (network, 5xx). Not a missing link — an outage,
 *  said as one, with the way to try again (CA-E1). */
export const FEED_LINK_OUTAGE_TITLE = 'Couldn’t reach all.haus'
export const FEED_LINK_OUTAGE_BODY =
  'The link is probably fine — we couldn’t load it just now. '
export const FEED_LINK_RETRY = 'Try again'
export const FEED_LINK_MISSING_BODY =
  'Channel links are long and unguessable, so a missing one is usually a copy that lost its tail. Ask whoever sent it for the whole thing.'

/**
 * The attribution after the source count: `{count}, put together by {author}.`
 * The author is drawn in the title colour, so this is the piece BEFORE the name
 * (trailing space included); the closing `.` follows the name, and is there
 * with or without it.
 */
export const FEED_LINK_BY_BEFORE = ', put together by '

/** When the redeem's 410 carries a code `FEED_LINK_REDEEM_REFUSALS` does not know. */
export const FEED_LINK_REDEEM_REFUSED_FALLBACK = 'This link no longer leads to a channel you can add.'
export const FEED_LINK_REDEEM_ERROR = 'Something went wrong adding this channel. Try again in a moment.'

export const FEED_LINK_ADDED =
  'Added to your workspace as a channel of your own. You can rename it, retune it or take things out. It’s yours now, so nothing the author changes later will affect it.'

/** Lead-in to the list of sources a redeem could not reach; the labels follow (joined `, `), then `.` */
export function feedLinkFailedLead(n: number): string {
  return n === 1
    ? 'One source couldn’t be reached and isn’t in your copy: '
    : `${n} sources couldn’t be reached and aren’t in your copy: `
}

export const FEED_LINK_OPEN_WORKSPACE = 'Open your workspace'
export const FEED_LINK_ADD = 'Add to my workspace'
export const FEED_LINK_ADDING = 'Adding…'

export const FEED_LINK_CLOSED_BETA =
  'all.haus is in closed beta. Join the waiting list and this channel will be one click away when you’re in.'
export const FEED_LINK_JOIN_WAITLIST = 'Join the waiting list'

/** `Already on all.haus? [Log in] to add it.` — three pieces, joined by single spaces, the middle one a link. */
export const FEED_LINK_LOGIN_BEFORE = 'Already on all.haus?'
export const FEED_LINK_LOGIN_LINK = 'Log in'
export const FEED_LINK_LOGIN_AFTER = 'to add it.'
