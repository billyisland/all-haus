// =============================================================================
// A feed's settings — the composer, its share link and the merge — the words,
// in one home for both registers.
//
// The full site's `components/workspace/FeedComposer.tsx`,
// `FeedFormulaSection.tsx` and `MergeFeedConfirm.tsx` (all client components)
// and modernhaus's bare-HTML feed settings say the same things about a feed.
// They live here because modernhaus cannot import a `'use client'` file. The
// reasoning behind each sentence is in the full site component's comments.
// =============================================================================

// --- The composer: name ------------------------------------------------------

export const FEED_COMPOSER_TITLE = 'Channel composer'
export const FEED_NAME_PLACEHOLDER = 'Optional descriptive name'
export const FEED_NAME_SAVE = 'Save'
export const FEED_NAME_SAVING = 'Saving…'
export const FEED_CANCEL = 'Cancel'
export const FEED_NO_NAME = 'No name'
export const FEED_RENAME = 'Rename'
export const FEED_ADD_NAME = 'Add name'
/** A feed's name is optional; where one must be shown, this stands in. */
export const FEED_UNNAMED = 'Unnamed channel'

// --- The composer: sources ---------------------------------------------------

export const FEED_SOURCES_LABEL = 'Sources'
export const FEED_SOURCES_EMPTY =
  'No sources yet. Until you add one, this channel shows a selection of posts from across all.haus.'
export const FEED_ADD_SOURCE_LABEL = 'Add a source'
export const FEED_RESOLVER_PLACEHOLDER = 'Username, URL, npub, DID, #tag…'
export const FEED_RESOLVER_NO_MATCH =
  'No match. Press Enter to search, or try a full URL, an @username, an npub, or a #tag.'
export const FEED_RESOLVER_MATCHES = 'Matches'
export const FEED_RESOLVER_SUGGESTIONS = 'Suggestions'
export const FEED_IMPORT_FOLLOWS = '↳ or import everyone they follow as a new channel'

// --- The composer: one source's row ------------------------------------------

export const FEED_SOURCE_MUTE = 'Mute'
/** Moving a source to another of the member's feeds — the ⚙ panel's picker
 *  and modernhaus's form (WORKSPACE-QUEUE-ADR §XI.2 R2). */
export const FEED_SOURCE_MOVE = 'Move'
export const FEED_SOURCE_MOVE_TO = 'Move to'
export function feedSourceMoveTo(label: string): string {
  return `Move ${label} to another channel`
}
/** `pct` is already formatted (the composer's `stepPercent`). */
export function feedSourceVolume(pct: string): string {
  return `Volume ${pct}`
}
/** The sampling chips, keyed by mode. */
export const FEED_SOURCE_SAMPLING_LABEL = { random: 'random', top: 'top' } as const
/** The `top` chip's label on a source with no engagement signal. */
export const FEED_SOURCE_SAMPLING_RECENT = 'recent'
export const FEED_SOURCE_NO_SIGNAL_TITLE =
  'This source doesn’t tell us how popular its posts are, so “top” shows its most recent ones each week'
export const FEED_SOURCE_NO_REPLIES = 'no replies'
export const FEED_SOURCE_NO_REPLIES_TITLE = 'Hide this source’s replies and show only its standalone posts'
export function feedSourceRemove(label: string): string {
  return `Remove ${label}`
}

// --- The composer: hide and delete -------------------------------------------

export const FEED_HIDE = 'Hide channel'
export const FEED_UNHIDE = 'Show channel'
export const FEED_DELETE_BLOCKED = 'You can’t delete your only channel. Make another one first, and then you can delete this one.'
export const FEED_DELETE_CONFIRM = 'Delete this channel? Its sources go with it. Your subscriptions stay.'
/**
 * Appended (leading space included) to the delete confirmation and to the
 * merge's, when the feed being destroyed has a live share link.
 */
export const FEED_SHARE_LINK_WILL_STOP = ' Its share link will stop working too.'
export const FEED_DELETE = 'Delete'
export const FEED_DELETING = 'Deleting…'
export const FEED_DELETE_FEED = 'Delete channel'

// --- The composer: errors ----------------------------------------------------

export const FEED_ERROR_LOAD_SOURCES = 'Couldn’t load this channel’s sources.'
export const FEED_ERROR_ADD_SOURCE = 'Couldn’t add that source. Please try again.'
export const FEED_ERROR_RENAME = 'Couldn’t rename the channel. Please try again.'
export const FEED_ERROR_DELETE = 'Couldn’t delete the channel. Please try again.'
export const FEED_ERROR_REMOVE_SOURCE = 'Couldn’t remove that source. Please try again.'
export const FEED_ERROR_MOVE_SOURCE = 'Couldn’t move that source. Please try again.'
export function feedNameTooLong(limit: number): string {
  return `Name must be ${limit} characters or fewer.`
}

// --- Sharing the feed (FeedFormulaSection) -----------------------------------

export const FEED_SHARE = 'Share channel'
export const FEED_SHARE_COPIED = 'Share link copied'
export const FEED_SHARE_STOP = 'Stop sharing'
/** Refusal `empty`, when some sources were excluded. */
export const FEED_SHARE_NONE_TRAVEL = 'None of this channel’s sources can travel, so nobody can add it yet.'
/** Refusal `empty`, when nothing was excluded. */
export const FEED_SHARE_EMPTY = 'Nobody can add this channel yet, because it has no sources. Add one first.'
/** Refusal `too_large`. */
export function feedShareTooLarge(maxSources: number): string {
  return `This channel has too many sources to share. A link can carry ${maxSources}, so take some out first.`
}
/** Sources left behind by a link that is otherwise usable (n ≥ 1). */
export function feedShareExcluded(n: number): string {
  return n === 1
    ? 'One source can’t travel: a newsletter’s address is yours alone.'
    : `${n} sources can’t travel: a newsletter’s address is yours alone.`
}
export const FEED_SHARE_ERROR_MINT = 'Couldn’t make a link for this channel.'
export const FEED_SHARE_ERROR_STOP = 'Couldn’t stop sharing this channel.'

// --- Merging one feed into another (MergeFeedConfirm) -------------------------

/**
 * `Merge <strong>{source}</strong> into <strong>{target}</strong>? Sources will
 * be combined. <strong>{source}</strong> will be deleted.` — the pieces between
 * the bolded names, spaces included; `FEED_SHARE_LINK_WILL_STOP` may follow.
 */
export const FEED_MERGE_BEFORE = 'Merge '
export const FEED_MERGE_INTO = ' into '
export const FEED_MERGE_COMBINED = '? Their sources will be combined, and '
export const FEED_MERGE_DELETED = ' will be deleted.'
export const FEED_MERGE_ARIA = 'Merge channels'
export const FEED_MERGE = 'Merge'
export const FEED_MERGING = 'Merging…'
export const FEED_MERGE_FAILED = 'Couldn’t merge these channels. Please try again.'
/** The ⚙ panel's picker, which hands the chosen target to the dialog above
 *  (WORKSPACE-QUEUE-ADR §XI.2 R1). */
export const FEED_MERGE_INTO_PICK = 'Merge into'

/**
 * What a recipient would meet, in one line — or nothing.
 *
 * The refusal outranks the excluded count: an author whose link nobody can use
 * needs to hear that before they hear how many sources stayed behind.
 * (FeedFormulaSection's own rule, lifted so the plain register says the same.)
 */
export function feedShareCaveat(s: {
  refusal: 'empty' | 'too_large' | null
  excludedCount: number
  maxSources: number
}): string | null {
  if (s.refusal === 'empty') return s.excludedCount > 0 ? FEED_SHARE_NONE_TRAVEL : FEED_SHARE_EMPTY
  if (s.refusal === 'too_large') return feedShareTooLarge(s.maxSources)
  if (s.excludedCount > 0) return feedShareExcluded(s.excludedCount)
  return null
}
