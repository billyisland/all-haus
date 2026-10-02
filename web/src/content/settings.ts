// =============================================================================
// Settings — the words, in one home for both registers.
//
// The full site's settings sheet is a stack of client components —
// `SettingsPanel`, `ProfileSection`, `UsernameChange`, `EmailChange`,
// `DangerZone`, `ExportModal`, `BlockList`, `MuteList`,
// `NotificationPreferences` and `ReadingPreferences` — and modernhaus's
// settings pages say the same things in bare HTML. They live here because
// modernhaus cannot import a `'use client'` file. The reasoning behind the
// words is in those components' comments — above all `DangerZone`'s, on why the
// delete list is a promise that must match the route.
// =============================================================================

// ---- Shared across the sheet -----------------------------------------------

export const SETTINGS_TITLE = 'Settings'
export const SETTINGS_SAVE = 'Save'
export const SETTINGS_SAVING = 'Saving…'
export const SETTINGS_CANCEL = 'Cancel'
export const SETTINGS_CHANGE = 'Change'
export const SETTINGS_RETRY = 'Retry'
export const SETTINGS_ON = 'On'
export const SETTINGS_OFF = 'Off'

// ---- SettingsPanel: groups and sections ------------------------------------

export const SETTINGS_GROUP_ACCOUNT = 'Account'
export const SETTINGS_PROFILE_LABEL = 'Profile'
export const SETTINGS_EMAIL_LABEL = 'Email'
export const SETTINGS_PAYMENT_LABEL = 'Payment & payouts'
/** A reader has no payouts to set up (READER-WRITER-SPLIT-ADR §6.2). */
export const SETTINGS_PAYMENT_LABEL_READER = 'Payment'
export const SETTINGS_REACH_LABEL = 'Reach other networks'
export const SETTINGS_REACH_DESCRIPTION =
  'Your all.haus account is basically an identity on a messaging system called Nostr, but it can also operate your accounts on other networks. Either link one you have already or get all.haus to set one up for you.'

export const SETTINGS_GROUP_PREFERENCES = 'Preferences'
export const SETTINGS_NOTIFICATIONS_LABEL = 'Notifications'
export const SETTINGS_NOTIFICATIONS_DESCRIPTION = 'Choose what kinds of notifications you want, if any.'
export const SETTINGS_BLOCKED_LABEL = 'Blocked accounts'
export const SETTINGS_MUTED_LABEL = 'Muted accounts'
export const SETTINGS_READING_LABEL = 'Reading'

export const SETTINGS_GROUP_DATA = 'Your data'
export const SETTINGS_EXPORT_LABEL = 'Export my data'
export const SETTINGS_EXPORT_DESCRIPTION = 'Download your data, receipts, and content keys.'
export const SETTINGS_EXPORT_BUTTON = 'Export'

export const SETTINGS_GROUP_LEGAL = 'Legal'
export const SETTINGS_LEGAL_READ = 'Read'
export const LEGAL_TERMS_LABEL = 'Terms of Service'
export const LEGAL_TERMS_DESCRIPTION = 'Apply to everything you do here.'
export const LEGAL_PRIVACY_LABEL = 'Privacy Policy'
export const LEGAL_PRIVACY_DESCRIPTION = 'What we hold about you, and what we do with it.'
export const LEGAL_READER_TERMS_LABEL = 'Reader Terms'
export const LEGAL_READER_TERMS_DESCRIPTION = 'Apply when you register a card to read paid content.'
export const LEGAL_WRITER_AGREEMENT_LABEL = 'Writer Agreement'
export const LEGAL_WRITER_AGREEMENT_DESCRIPTION = 'Applies when you sell paid access to your writing.'

// ---- SettingsPanel: the connect banner (OAuth callback flag) ---------------

export const CONNECT_BANNER_MASTODON = 'Mastodon account connected.'
export const CONNECT_BANNER_BLUESKY = 'Bluesky account connected.'
export const CONNECT_BANNER_ALREADY_LINKED =
  'That account is already connected to another all.haus profile.'
export const CONNECT_BANNER_ERROR = 'Couldn’t connect that account. Please try again.'

export type ConnectBanner = { kind: 'ok' | 'error'; msg: string }

/** The banner for the `linked` callback flag, or null for any other value. */
export function connectBannerFor(linked: string | null): ConnectBanner | null {
  if (linked === 'mastodon') return { kind: 'ok', msg: CONNECT_BANNER_MASTODON }
  if (linked === 'bluesky') return { kind: 'ok', msg: CONNECT_BANNER_BLUESKY }
  if (linked === 'already-linked') return { kind: 'error', msg: CONNECT_BANNER_ALREADY_LINKED }
  if (linked === 'error') return { kind: 'error', msg: CONNECT_BANNER_ERROR }
  return null
}

// ---- ProfileSection --------------------------------------------------------

export const PROFILE_PHOTO_LABEL = 'Photo'
export const PROFILE_UPLOAD_PHOTO = 'Upload photo'
export const PROFILE_UPLOADING = 'Uploading…'
export const PROFILE_REMOVE_PHOTO = 'Remove'
export const PROFILE_DISPLAY_NAME_LABEL = 'Display name'
export const PROFILE_BIO_LABEL = 'Bio'
export const PROFILE_BIO_PLACEHOLDER = 'A few words about yourself'
export const PROFILE_SAVE = 'Save changes'
export const PROFILE_SAVED = 'Saved'
export const PROFILE_PUBLIC_KEY_LABEL = 'Public key'
export const PROFILE_UPLOAD_FAILED = 'Couldn’t upload that photo. Please try again.'
export const PROFILE_SAVE_FAILED = 'Couldn’t save your profile. Please try again.'

// ---- UsernameChange --------------------------------------------------------

export const USERNAME_LABEL = 'Username'
export const USERNAME_PLACEHOLDER = 'newusername'
export const USERNAME_CHECKING = 'Checking availability…'
export const USERNAME_AVAILABLE = 'Available'
export const USERNAME_TAKEN = 'Already taken'
// `GET /auth/check-username` answers `reason: "Reserved"` for a name that is
// the address of a page (shared/src/auth/reserved-usernames.ts).
export const USERNAME_RESERVED = 'That name belongs to one of all.haus’s own pages.'
export const USERNAME_INVALID = 'Use 3 to 30 lowercase letters, numbers or hyphens, not starting or ending with a hyphen.'
export const USERNAME_REDIRECT_NOTE = 'Links to your old profile address will keep working for 90 days.'
export const USERNAME_UPDATED = 'Username updated.'
export const USERNAME_CHANGE_FAILED = 'Couldn’t change your username. Please try again.'

/** `date` arrives already formatted (the component formats it en-GB). */
export function usernameCooldownSentence(date: string): string {
  return `You can change your username again on ${date}.`
}

// ---- EmailChange -----------------------------------------------------------

export const EMAIL_PLACEHOLDER = 'new@example.com'
export const EMAIL_NONE = '(no email)'
export const EMAIL_CHANGE_FAILED = 'Couldn’t send the confirmation email. Please try again.'

export function emailVerificationSentSentence(sentTo: string): string {
  return `We’ve sent a link to ${sentTo}. Press it to confirm your new address.`
}

// ---- DangerZone ------------------------------------------------------------

export const DANGER_HEADING = 'Close your account'

export const DEACTIVATE_LABEL = 'Deactivate'
export const DEACTIVATE_HELP =
  'Your profile and everything you’ve posted will be hidden until you log back in.'
export const DEACTIVATE_BUTTON = 'Deactivate account'
export const DEACTIVATE_CONFIRM_TITLE = 'Deactivate your account?'
export const DEACTIVATE_CONFIRM_BODY =
  'Your profile and content are hidden until you sign back in, which reactivates everything as it was.'
export const DEACTIVATE_CONFIRM_LABEL = 'Deactivate'
export const DEACTIVATE_FAILED = 'Couldn’t deactivate your account. Please try again.'

export const DELETE_LABEL = 'Delete permanently'
export const DELETE_HELP =
  'Your content will be removed and your account data erased. This cannot be undone.'
export const DELETE_BUTTON = 'Delete account'
export const DELETE_CONFIRM_TITLE = 'Delete your account?'
export const DELETE_CONFIRM_LABEL = 'Delete my account'
export const DELETE_CONSEQUENCES_INTRO = 'This will:'
/** THIS LIST IS A PROMISE AND MUST MATCH THE ROUTE — see DangerZone. */
export const DELETE_CONSEQUENCES: readonly string[] = [
  'Charge your card for anything outstanding on your reading tab',
  'Cancel all active subscriptions, yours and your subscribers’',
  'Remove your published articles and notes',
  'Publish Nostr deletion events for them',
  'Disconnect any linked accounts',
]
// "It does <strong>not</strong> send any unpaid earnings — …": the sentence
// around its emphasis, in three pieces so the markup stays where it is.
export const DELETE_EARNINGS_BEFORE = 'It does '
export const DELETE_EARNINGS_EMPHASIS = 'not'
export const DELETE_EARNINGS_AFTER =
  ' send any unpaid earnings — those stay held. Withdraw what you are owed first; afterwards there is no account left to do it from.'
export const DELETE_EMAIL_CONFIRM_LABEL = 'Enter your email to confirm:'
export const DELETE_FAILED = 'Couldn’t delete your account. Please try again.'

// ---- ExportModal -----------------------------------------------------------

export const EXPORT_INTRO =
  'Download your data from all.haus. Receipt tokens are portable across Nostr.'
export const EXPORT_RECEIPTS_TITLE = 'Portable receipts'
export const EXPORT_RECEIPTS_DESCRIPTION = 'Cryptographic proof of your paid reads.'
export const EXPORT_ACCOUNT_TITLE = 'Full account export'
export const EXPORT_ACCOUNT_DESCRIPTION =
  'Keys, receipts, articles — everything you need to migrate.'
export const EXPORT_DOWNLOADED = '✓ Downloaded'
/** Not an error: the account bundle's normal path is a mailed confirmation. */
export const EXPORT_STEP_UP_SENT =
  'Check your email. This file holds the key that is your identity, so we ask you to confirm by email before we hand it over. The link works once, for fifteen minutes.'
export const EXPORT_EXPORTING = 'Exporting…'
export const EXPORT_FAILED = 'Couldn’t export your data. Please try again.'

export function exportFailedStatus(status: number): string {
  return `Couldn’t export your data (${status}). Please try again.`
}

// ---- BlockList / MuteList --------------------------------------------------

export const BLOCKS_LOAD_FAILED = 'Couldn’t load your blocked accounts. Please try again.'
export const BLOCKS_EMPTY = 'No blocked accounts.'
export const BLOCKS_UNBLOCK = 'Unblock'
export const BLOCKS_UNBLOCK_FAILED = 'Couldn’t unblock them. Please try again.'

export const MUTES_LOAD_FAILED = 'Couldn’t load your muted accounts. Please try again.'
export const MUTES_EMPTY = 'No muted accounts.'
export const MUTES_UNMUTE = 'Unmute'
export const MUTES_UNMUTE_FAILED = 'Couldn’t unmute them. Please try again.'

// ---- NotificationPreferences -----------------------------------------------

/** The gateway's notification-preference category ids, in display order. */
export type NotificationCategory =
  | 'new_follower'
  | 'new_reply'
  | 'new_mention'
  | 'new_quote'
  | 'commission_request'
  | 'pub_events'
  | 'subscription_activity'

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'new_follower',
  'new_reply',
  'new_mention',
  'new_quote',
  'commission_request',
  'pub_events',
  'subscription_activity',
]

/** Offered only while the parked pledge-drives feature is on (`pledgesEnabled()`). */
export const NOTIFICATION_PLEDGES_ONLY: NotificationCategory = 'commission_request'

export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, string> = {
  new_follower: 'New followers',
  new_reply: 'Replies to your posts and comments',
  new_mention: 'Mentions',
  new_quote: 'Quotes of your posts',
  commission_request: 'Commission requests',
  pub_events: 'Publication events',
  subscription_activity: 'Subscription activity',
}

/** A failed load is UNKNOWN: the chips stay unset and disabled (CA-E10). */
export const NOTIFICATION_PREFS_LOAD_FAILED = 'Couldn’t load your notification settings. Please try again.'
export const NOTIFICATION_PREF_SAVE_FAILED = 'Couldn’t save that change, so the setting is as it was. Please try again.'

// ---- ReadingPreferences (the log toggle and the clear) ---------------------

export const READING_LOG_TITLE = 'Keep a record of what you read'

/**
 * The log's window, named from the dial — and when the figure is absent, no
 * figure: "a short while" cannot drift, a literal week did.
 */
export function readingWindowPhrase(retentionDays: number | null): string {
  return retentionDays === null
    ? 'for a short while'
    : retentionDays === 7
      ? 'for a week'
      : retentionDays === 1
        ? 'for a day'
        : `for ${retentionDays} days`
}

export function readingLogSentence(windowPhrase: string): string {
  return `Recent reading lists everything you open in a reader ${windowPhrase}, then forgets it. Nobody else can see it — not the writers you read, not us.`
}

export const READING_CLEAR_TITLE = 'Clear Recent reading'
export const READING_CLEAR_BEFORE =
  'Empties the list now. It cannot be undone, and it does not affect your library.'
export const READING_CLEAR_NOTHING = 'There was nothing to clear.'
export const READING_CLEAR_BUTTON = 'Clear'
export const READING_CLEAR_CONFIRM = 'Clear it'
export const READING_CLEARING = 'Clearing…'
export const READING_CLEAR_FAILED = 'Couldn’t clear Recent reading. Nothing was removed, so please try again.'

export function readingClearedSentence(n: number): string {
  return `Cleared ${n} ${n === 1 ? 'piece' : 'pieces'}.`
}
