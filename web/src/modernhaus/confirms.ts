import { DELETE_REPLY_TITLE, DELETE_REPLY_BODY, DELETE_LABEL } from '../content/conversation'
import { SUBSCRIPTION_CANCEL_TITLE, SUBSCRIPTION_CANCEL_BODY, SUBSCRIPTION_CANCEL_CONFIRM } from '../content/ledger'
import { CARD_REMOVE_CONSEQUENCE, CARD_REMOVE_CONFIRM } from '../content/money-settings'
import { blockConfirmTitle, BLOCK_CONFIRM_LABEL, BLOCK_CONSEQUENCES } from '../content/social'
import {
  DEACTIVATE_CONFIRM_TITLE,
  DEACTIVATE_CONFIRM_BODY,
  DEACTIVATE_CONFIRM_LABEL,
  READING_CLEAR_TITLE,
  READING_CLEAR_BEFORE,
  READING_CLEAR_CONFIRM,
} from '../content/settings'
import { networkDisconnectTitle, NETWORK_DISCONNECT_BODY, NETWORK_DISCONNECT_CONFIRM } from '../content/networks'
import {
  DELETE_ARTICLE_CONFIRM_TITLE,
  DELETE_ARTICLE_CONFIRM_BODY,
  DELETE_ARTICLE_CONFIRM_LABEL,
  UNPUBLISH_CONFIRM_TITLE,
  UNPUBLISH_CONFIRM_BODY,
  UNPUBLISH_CONFIRM_LABEL,
  GIFT_LINK_REVOKE_CONFIRM_TITLE,
  GIFT_LINK_REVOKE_CONFIRM_BODY,
  GIFT_LINK_REVOKE_CONFIRM_LABEL,
  OFFER_REVOKE_CONFIRM_TITLE,
  OFFER_REVOKE_CONFIRM_BODY,
  OFFER_REVOKE_CONFIRM_LABEL,
} from '../content/dashboard'
import {
  FEED_DELETE_CONFIRM,
  FEED_DELETE,
  FEED_SHARE_LINK_WILL_STOP,
  FEED_MERGE_ARIA,
  FEED_MERGE,
  FEED_MERGE_BEFORE,
  FEED_MERGE_INTO,
  FEED_MERGE_COMBINED,
  FEED_MERGE_DELETED,
} from '../content/feed-settings'
import { call, path, GatewayFault, type GatewayContext } from './gateway'
import type { WriterProfile } from '../lib/api/writers'
import type { LinkedAccount } from '../lib/api/linked-accounts'
import { loadFeeds, loadFormulaState } from './feed-settings-loaders'
import { feedLabel } from './pages/feeds'

// =============================================================================
// modernhaus — the "are you sure?" pages (§D2.3 `/modernhaus/confirm/<action>`).
//
// An irreversible press is its own page with one POST button, never a dialog
// (there is no script). Each entry names the action it confirms — which must
// be in the registry, and a test holds it there — the question, the
// consequence, the button, and the query fields it carries into the form as
// hidden inputs. Nothing else from the URL reaches the form, and every value is
// a hidden input the gateway judges; the page only asks.
// =============================================================================

export interface ConfirmSpec {
  question: string
  /** One paragraph, or several (a block names three things it ends). */
  consequence: string | readonly string[]
  button: string
  /** The query fields carried into the form, by name. */
  fields: readonly string[]
  /**
   * Where the page must NAME its subject, the name is read from the gateway,
   * never from the address — a crafted URL must not put words on the page.
   * Returns the words to show and the values the form carries (which replace
   * the query's), or null when the subject is not there to act on (404).
   */
  resolve?: (gw: GatewayContext, values: Record<string, string>) => Promise<ResolvedConfirm | null>
}

export interface ResolvedConfirm {
  question?: string
  consequence?: string | readonly string[]
  values: Record<string, string>
}

/** A block names the person, as the full site's does — from their profile. */
async function resolveBlock(gw: GatewayContext, values: Record<string, string>): Promise<ResolvedConfirm | null> {
  const a = await call<WriterProfile>(gw, 'GET', path`/writers/${values.username ?? ''}`)
  if (a.status !== 200 || !a.body || typeof a.body.id !== 'string') {
    if (a.status >= 500) throw new GatewayFault(`writers ${a.status}`)
    return null
  }
  return {
    question: blockConfirmTitle(a.body.displayName?.trim() || a.body.username),
    values: { userId: a.body.id },
  }
}

const NETWORK_LABEL: Record<string, string> = { atproto: 'Bluesky', activitypub: 'Mastodon' }

async function resolveNetwork(gw: GatewayContext, values: Record<string, string>): Promise<ResolvedConfirm | null> {
  const a = await call<{ accounts?: LinkedAccount[] }>(gw, 'GET', '/linked-accounts')
  if (a.status >= 500) throw new GatewayFault(`linked-accounts ${a.status}`)
  const acc = a.body?.accounts?.find((x) => x.id === values.id)
  if (!acc) return null
  return { question: networkDisconnectTitle(NETWORK_LABEL[acc.protocol] ?? acc.protocol), values: { id: acc.id } }
}

/** The full site says the share link stops, where one is live (FeedComposer, MergeFeedConfirm). */
async function shareAddendum(gw: GatewayContext, feedId: string): Promise<string> {
  const f = await loadFormulaState(gw, feedId)
  return f.kind === 'status' && f.status.link && !f.status.link.revoked ? FEED_SHARE_LINK_WILL_STOP : ''
}

async function resolveFeedDelete(gw: GatewayContext, values: Record<string, string>): Promise<ResolvedConfirm | null> {
  const feeds = await loadFeeds(gw)
  if (!feeds.some((f) => f.id === values.feedId)) return null
  const addendum = (await shareAddendum(gw, values.feedId)).trim()
  return { consequence: addendum ? [addendum] : [], values: { feedId: values.feedId } }
}

async function resolveFeedMerge(gw: GatewayContext, values: Record<string, string>): Promise<ResolvedConfirm | null> {
  const feeds = await loadFeeds(gw)
  const target = feeds.find((f) => f.id === values.feedId)
  const source = feeds.find((f) => f.id === values.sourceFeedId)
  if (!target || !source || target.id === source.id) return null
  const s = feedLabel(source, null)
  const t = feedLabel(target, null)
  const sentence = `${FEED_MERGE_BEFORE}${s}${FEED_MERGE_INTO}${t}${FEED_MERGE_COMBINED}${s}${FEED_MERGE_DELETED}${await shareAddendum(gw, source.id)}`
  return { consequence: sentence, values: { feedId: target.id, sourceFeedId: source.id } }
}

export const CONFIRMS: Readonly<Record<string, ConfirmSpec>> = {
  reply_delete: {
    question: DELETE_REPLY_TITLE,
    consequence: DELETE_REPLY_BODY,
    button: DELETE_LABEL,
    fields: ['replyId'],
  },
  // No full-site twin: the full site offers no delete on a note card.
  note_delete: {
    question: 'Delete this note?',
    consequence:
      'It will disappear from all.haus for everyone, and we’ll ask the other Nostr relays that carry it to delete it too. Any replies to it will stay where they are.',
    button: DELETE_LABEL,
    fields: ['eventId'],
  },
  // No full-site twin a writer reaches from a list: the dashboard's delete is
  // an article's. A draft is only ever the writer's own, and nothing else
  // holds its text.
  draft_delete: {
    question: 'Delete this draft?',
    consequence: 'Its text is deleted for good. If it held changes to a published piece, that piece stays published as it is.',
    button: DELETE_LABEL,
    fields: ['draftId'],
  },
  // The full site's "Unfollow" on the Following list does the same whole act.
  unfollow_everywhere: {
    question: 'Unfollow, everywhere?',
    consequence: 'They are taken out of every one of your channels, hidden ones included, and you stop following them.',
    button: 'Unfollow',
    fields: ['writer', 'author', 'source'],
  },
  // The full site's own "are you sure?" (SubscriptionsSection), in its words.
  subscription_cancel: {
    question: SUBSCRIPTION_CANCEL_TITLE,
    consequence: SUBSCRIPTION_CANCEL_BODY,
    button: SUBSCRIPTION_CANCEL_CONFIRM,
    fields: ['writerId'],
  },
  // Reader Terms 2.4, in PaymentSection's words: removing the card does NOT
  // clear what is owed. The action takes nothing from the form; `confirm` is
  // the one field, so the page has something to carry (a confirm page with
  // nothing to confirm is a link that cannot do its job).
  card_remove: {
    question: 'Remove your card?',
    consequence: CARD_REMOVE_CONSEQUENCE,
    button: CARD_REMOVE_CONFIRM,
    fields: ['confirm'],
  },
  // E6. Each is the full site's own "are you sure?", in its words.
  block: {
    question: 'Block?',
    consequence: BLOCK_CONSEQUENCES,
    button: BLOCK_CONFIRM_LABEL,
    fields: ['username'],
    resolve: resolveBlock,
  },
  deactivate: {
    question: DEACTIVATE_CONFIRM_TITLE,
    consequence: DEACTIVATE_CONFIRM_BODY,
    button: DEACTIVATE_CONFIRM_LABEL,
    fields: ['confirm'],
  },
  network_unlink: {
    question: 'Disconnect?',
    consequence: NETWORK_DISCONNECT_BODY,
    button: NETWORK_DISCONNECT_CONFIRM,
    fields: ['id'],
    resolve: resolveNetwork,
  },
  // The full site confirms in place (ReadingPreferences): the title, the
  // sentence before, and "Clear it".
  reading_log_clear: {
    question: `${READING_CLEAR_TITLE}?`,
    consequence: READING_CLEAR_BEFORE,
    button: READING_CLEAR_CONFIRM,
    fields: ['confirm'],
  },
  article_unpublish: {
    question: UNPUBLISH_CONFIRM_TITLE,
    consequence: UNPUBLISH_CONFIRM_BODY,
    button: UNPUBLISH_CONFIRM_LABEL,
    fields: ['articleId'],
  },
  article_delete: {
    question: DELETE_ARTICLE_CONFIRM_TITLE,
    consequence: DELETE_ARTICLE_CONFIRM_BODY,
    button: DELETE_ARTICLE_CONFIRM_LABEL,
    fields: ['articleId'],
  },
  gift_link_revoke: {
    question: GIFT_LINK_REVOKE_CONFIRM_TITLE,
    consequence: GIFT_LINK_REVOKE_CONFIRM_BODY,
    button: GIFT_LINK_REVOKE_CONFIRM_LABEL,
    fields: ['articleId', 'linkId'],
  },
  offer_revoke: {
    question: OFFER_REVOKE_CONFIRM_TITLE,
    consequence: OFFER_REVOKE_CONFIRM_BODY,
    button: OFFER_REVOKE_CONFIRM_LABEL,
    fields: ['offerId'],
  },
  // FeedComposer's own confirmation is one sentence, question and consequence
  // together; the live share link's addendum follows it where one exists.
  feed_delete: {
    question: FEED_DELETE_CONFIRM,
    consequence: [],
    button: FEED_DELETE,
    fields: ['feedId'],
    resolve: resolveFeedDelete,
  },
  feed_merge: {
    question: FEED_MERGE_ARIA,
    consequence: '',
    button: FEED_MERGE,
    fields: ['feedId', 'sourceFeedId'],
    resolve: resolveFeedMerge,
  },
}
