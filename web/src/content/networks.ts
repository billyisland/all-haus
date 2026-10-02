// =============================================================================
// Settings › Networks and follow import — the words, in one home for both
// registers.
//
// The full site's `NetworkReachPanel`, `FollowImportSection` and
// `FollowImportStatus` (client components) and the `useFollowImportRun` /
// `useOpmlImport` hooks say these sentences; modernhaus cannot import a
// `'use client'` file, so they live here. The reasoning behind them is in
// those components' comments. The ASSISTED consent copy is not here — it lives
// in `lib/api/linked-accounts.ts` beside the flow it gates.
// =============================================================================

// ---- Nostr (the root identity; "go public" is the discovery opt-in) --------

export const NOSTR_TITLE = 'Nostr'
export const NOSTR_PUBLIC =
  "Public. You've allowed all.haus to publish your profile and where to read you to the Nostr network, so people anywhere on Nostr can find and follow you."
export const NOSTR_PRIVATE =
  'Your account is a Nostr identity, but for now only all.haus knows about it. Turn this on to publish your profile to the wider Nostr network, so people there can find and follow you.'
export const NOSTR_PUBLIC_LABEL = 'Public'
export const NOSTR_PRIVATE_LABEL = 'Private'
export const NOSTR_FOLLOW_GRAPH =
  'Also publish who you follow as a public Nostr contact list. Turn off to keep your follow list private.'

export const TOGGLE_ON = 'On'
export const TOGGLE_OFF = 'Off'

// ---- Findable by email ------------------------------------------------------

export const EMAIL_FINDABLE_TITLE = 'Findable by email'
export const EMAIL_FINDABLE_ON =
  'Someone who already knows your email address can find your account by typing it in. Your address is never shown to them.'
export const EMAIL_FINDABLE_OFF =
  'Your email address is for signing in, and nothing else. Someone who types it in is told nothing — people can still find you by your name, username or Nostr key.'

// ---- Preference load / save failures ---------------------------------------

/** Followed by a space and a Retry button. */
export const PREFS_LOAD_FAILED = 'Couldn’t load this setting.'
export const PREFS_RETRY = 'Retry'
export const PREFS_SAVE_FAILED = 'Couldn’t save that change, so the setting is as it was. Please try again.'

// ---- Satellite networks -----------------------------------------------------

export const NETWORK_LABEL_BLUESKY = 'Bluesky'
export const NETWORK_LABEL_MASTODON = 'Mastodon'

export const NETWORK_INVALID = 'Needs reconnecting'
/** Followed by a space and the Reconnect button. */
export const NETWORK_RECONNECT_NOTE =
  'Please reconnect this account. Until you do, you can’t like posts, or reply to posts on other instances, from all.haus.'
export const NETWORK_RECONNECT = 'Reconnect'
export const NETWORK_REDIRECTING = 'Taking you there…'

export function networkCrossPostOffer(label: string): string {
  return `Cross-post your notes and replies to ${label}.`
}

export const NETWORK_DEFAULT_ON = 'Default on'
export const NETWORK_SHOW_ON_PROFILE = 'Show on profile'
export const NETWORK_IMPORT_FOLLOWS = 'Import follows'
export const NETWORK_DISCONNECT = 'Disconnect'
export const NETWORK_LINK_YOURS = 'Link yours'
export const NETWORK_SET_ONE_UP = 'Set one up'
export const NETWORK_SET_ONE_UP_SOON = 'Set one up · soon'

/** The `title` on the disabled "Set one up · soon" label. */
export function networkSetUpSoonTitle(label: string): string {
  return `Coming soon: all.haus will set up a ${label} account for you.`
}

export function networkAssistedAvailable(label: string): string {
  return `Don’t have a ${label} account? all.haus can help you make one. It will be an ordinary ${label} account, held by ${label}, and all.haus only connects to it.`
}

export function networkAssistedComing(label: string): string {
  return `Don’t have a ${label} account? Soon all.haus will be able to help you make one through ${label}’s own signup, so the account is yours.`
}

export function networkCreateAccount(label: string): string {
  return `Create ${label} account`
}

export const NETWORK_CONTINUE = 'Continue'
export const NETWORK_CANCEL = 'Cancel'

export const MASTODON_INSTANCE_LABEL = 'Mastodon instance'
export const MASTODON_INSTANCE_PLACEHOLDER = 'mastodon.social'
export const BLUESKY_HANDLE_LABEL = 'Bluesky handle'
export const BLUESKY_HANDLE_PLACEHOLDER = 'alice.bsky.social'

export function networkDisconnectTitle(label: string): string {
  return `Disconnect ${label}?`
}
export const NETWORK_DISCONNECT_BODY = 'Cross-posts to it stop. You can link it again later.'
export const NETWORK_DISCONNECT_CONFIRM = 'Disconnect'

// Fallbacks used when the route sent no message of its own.
export const NETWORK_LOAD_FAILED = 'Couldn’t load your linked accounts. Please try again.'
export const NETWORK_CONNECT_FAILED = 'Couldn’t start connecting that account. Please try again.'
export const NETWORK_SETUP_FAILED = 'Couldn’t start setting up the account. Please try again.'
export const NETWORK_DISCONNECT_FAILED = 'Couldn’t disconnect that account. Please try again.'
export const NETWORK_UPDATE_FAILED = 'Couldn’t save that change. Please try again.'

// ---- Follow import: paste an identity (FollowImportSection) ----------------

export const FOLLOW_IMPORT_TITLE = 'Bring your follows'
/** The intro is three pieces: START, then MASTODON only where activitypub is
 *  importable, then END (which opens with a space). */
export const FOLLOW_IMPORT_INTRO_START = 'Already follow people elsewhere? Paste a Bluesky handle,'
export const FOLLOW_IMPORT_INTRO_MASTODON = ' a Mastodon handle,'
export const FOLLOW_IMPORT_INTRO_END =
  ' an npub or a Nostr address (name@domain), and all.haus will make a new channel from everyone that account follows. Nothing changes on the other network.'

export function followImportIntro(withMastodon: boolean): string {
  return (
    FOLLOW_IMPORT_INTRO_START +
    (withMastodon ? FOLLOW_IMPORT_INTRO_MASTODON : '') +
    FOLLOW_IMPORT_INTRO_END
  )
}

export const FOLLOW_IMPORT_PLACEHOLDER_WITH_MASTODON = 'alice.bsky.social · @user@instance · npub1…'
export const FOLLOW_IMPORT_PLACEHOLDER = 'alice.bsky.social · npub1… · name@domain.com'
export const FOLLOW_IMPORT_RESOLVING = 'LOOKING IT UP…'
export const FOLLOW_IMPORT_NO_MATCH =
  'No match. Press Enter to search, or try a full handle, an npub or a Nostr address.'
export const FOLLOW_IMPORT_UNIMPORTABLE =
  'Found it, but importing follows isn’t available for that network yet.'
export const FOLLOW_IMPORT_ACTION = 'Import follows'

// ---- Follow import: OPML upload (FollowImportSection's OpmlImportBlock) ----

export const OPML_INTRO =
  'Coming from a feed reader instead? Upload its OPML export and your subscriptions arrive as channels — one per folder.'
export const OPML_UPLOAD = 'Upload an OPML file'

/** `FEEDS.OPML — 42 FEED URLS IN 3 FOLDERS` (the folder clause only when > 0). */
export function opmlFileSummary(fileName: string, entries: number, folders: number): string {
  return `${fileName.toUpperCase()} — ${entries} FEED URLS${folders > 0 ? ` IN ${folders} FOLDERS` : ''}`
}

/** `count` is the already-capped number of feeds the import can create. */
export function opmlCreatesUpTo(count: number): string {
  return `This creates up to ${count} ${count === 1 ? 'channel' : 'channels'} in your workspace.`
}

export const OPML_IMPORT = 'Import'
export const OPML_CANCEL = 'Cancel'
export const OPML_READING = 'READING FILE…'
export const OPML_DEFAULT_FEED_NAME = 'Imported feeds'

/** The lead of a per-run line: `“Name” — ` (trailing space included). */
export function opmlRunLead(name: string): string {
  return `“${name}” — `
}
export function opmlRunFailed(error?: string | null): string {
  return `FAILED${error ? ` — ${error}` : ''}`
}
export function opmlRunDone(imported: number, skipped: number, failed: number): string {
  return `${imported} IMPORTED${skipped > 0 ? ` · ${skipped} ALREADY PRESENT` : ''}${failed > 0 ? ` · ${failed} FAILED` : ''}`
}

export const OPML_DONE =
  'Your imported channels are in your workspace. You can change their sources, split them up or delete them, like any other channel.'
export const OPML_RUNNING =
  'Building your channels now. You can carry on while they fill up.'
// The trailing facts below each open with a space; they follow DONE/RUNNING.
export function opmlTruncated(totalEntries: number, remoteTotal: number): string {
  return ` Imported the first ${totalEntries} of ${remoteTotal} feed URLs. To bring in the rest, import a file with just those.`
}
export function opmlFolded(foldedFolders: number): string {
  return ` ${foldedFolders} extra folders were folded into the first channel.`
}
export function opmlInvalid(invalidEntries: number): string {
  return ` ${invalidEntries} entries were left out because they aren’t valid feed URLs.`
}
export const OPML_FAILED_ENTRIES =
  ' The ones that failed were feeds that are dead or couldn’t be reached. Everything else came through.'

export const OPML_UNREADABLE =
  'Couldn’t read that file as OPML. Please export a fresh copy from your feed reader and try again.'
export const OPML_NO_URLS = 'We couldn’t find any feed addresses in that file. Please check it’s an OPML export from your feed reader.'

// ---- Follow import: a run's status (FollowImportStatus) --------------------

export const IMPORT_READING = 'READING FOLLOW LIST…'
export function importFailed(error?: string | null): string {
  return `IMPORT FAILED${error ? ` — ${error}` : ''}`
}
export function importDone(imported: number, skipped: number, failed: number): string {
  return `IMPORTED ${imported}${skipped > 0 ? ` · ${skipped} ALREADY PRESENT` : ''}${failed > 0 ? ` · ${failed} FAILED` : ''}`
}
/** Shared by a follow-import run and an OPML run in flight. */
export function importProgress(processed: number, total: number): string {
  return `IMPORTING ${processed}/${total}…`
}
export const IMPORT_DEFAULT_FEED_NAME = 'your new channel'
export function importDoneSummary(feedName: string): string {
  return `“${feedName}” is in your workspace. You can change its sources, split it up or delete it, like any other channel.`
}
export function importRunningSummary(feedName: string): string {
  return `Building “${feedName}” now. You can carry on while it fills up.`
}
// The trailing facts below each open with a space.
export function importTruncated(total: number, remoteTotal: number): string {
  return ` Imported the ${total} most recent of ${remoteTotal} follows. The rest were left out.`
}
export function importUnresolved(unresolved: number): string {
  return ` We couldn’t find accounts for ${unresolved} of the follows, so they were left out.`
}
export const IMPORT_NOSTR_NAMES =
  ' Names fill in over the next few minutes as profiles arrive from relays.'

// ---- Hook fallbacks (useFollowImportRun / useOpmlImport) -------------------

export const FOLLOW_IMPORT_START_FAILED = 'Couldn’t read that account’s follow list. Please try again.'
export const OPML_START_FAILED = 'Couldn’t read that file. Please try again.'
