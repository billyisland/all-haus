import type { Registry } from '../door'
import { AUTH_ACTIONS } from './auth'
import { READING_ACTIONS } from './reading'
import { FEED_ACTIONS } from './feeds'
import { WRITING_ACTIONS } from './writing'
import { MONEY_ACTIONS } from './money'
import { MESSAGE_ACTIONS } from './messages'
import { SOCIAL_ACTIONS } from './social'
import { SETTINGS_ACTIONS } from './settings'
import { DASHBOARD_ACTIONS } from './dashboard'
import { FEED_SETTINGS_ACTIONS } from './feed-settings'
import { RIGHTS_ACTIONS } from './rights'

// =============================================================================
// modernhaus — the action registry (MODERNHAUS-ADR §D2.4).
//
// Every write the register can make is an entry here, reached as
// `POST /modernhaus/do/<name>`. A form whose action is not registered would be
// a button that cannot do its job, so each E step adds only its own rows:
// E2 — sign in, the emailed link, sign up, the age step, the waiting list and
// sign out; E3 — votes, replies, the external interact-backs, deletes, a
// report, notifications read, and the feed and follow writes; E4 — a note,
// an article's save / publish now / schedule, unschedule, a draft's delete
// and a picture's upload; E5 — the unlock, subscribing and its three
// settings, settle now, card removal, payout preferences and Stripe Connect;
// E6 — messages, block and mute, the Settings pages, the writer's dashboard,
// a feed's settings and its share link, an appeal and the account export.
// =============================================================================

export const REGISTRY: Registry = {
  ...AUTH_ACTIONS,
  ...READING_ACTIONS,
  ...FEED_ACTIONS,
  ...WRITING_ACTIONS,
  ...MONEY_ACTIONS,
  ...MESSAGE_ACTIONS,
  ...SOCIAL_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...DASHBOARD_ACTIONS,
  ...FEED_SETTINGS_ACTIONS,
  ...RIGHTS_ACTIONS,
}
