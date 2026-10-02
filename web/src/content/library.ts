// =============================================================================
// The reader's two logs — *Recent reading* and the *all.haus library* — the
// words, in one home for both registers.
//
// The full site's `components/library/LibraryPanel.tsx` and
// `components/account/RecentReading.tsx` (client components) and modernhaus's
// bare-HTML library page say the same things. They live here because
// modernhaus cannot import a `'use client'` file. The reasoning behind each
// sentence is in those components' comments (and READING-LOG-AND-LIBRARY-ADR).
// The outage sentence both tabs show is `loadFailedSentence` in
// `components/ui/LoadFailed.tsx`, which is already pure.
// =============================================================================

// --- The panel (LibraryPanel) ------------------------------------------------

export const LIBRARY_TITLE = 'Library'
export const LIBRARY_TAB_RECENT = 'Recent reading'
export const LIBRARY_TAB_LIBRARY = 'all.haus library'

/** What `<LoadFailed what=…>` names on each tab. */
export const LIBRARY_LOAD_FAILED_WHAT = 'your library'
export const RECENT_READING_LOAD_FAILED_WHAT = 'your recent reading'

export const LIBRARY_EMPTY = 'There isn’t anything here yet.'
export const LIBRARY_EMPTY_HINT = 'Unlock some paywalled articles and this page will log them for your later perusal.'
/** The standalone page's way out of an empty library (never in the overlay). */
export const LIBRARY_GO_TO_WORKSPACE = 'Go to workspace'
export const LIBRARY_LOAD_MORE = 'Load more'
export const LIBRARY_UNKNOWN_WRITER = 'Unknown writer'

// --- Recent reading (RecentReading) ------------------------------------------

/**
 * The empty tab's headline. `retentionDays` is the server's window
 * (`reading_log_retention_days`), null until it has answered — the sentence
 * then falls back to a vaguer form rather than naming a figure it does not have.
 */
export function recentReadingEmpty(retentionDays: number | null): string {
  return retentionDays === null
    ? 'Nothing read recently.'
    : retentionDays === 1
      ? 'Nothing read in the last day.'
      : `Nothing read in the last ${retentionDays} days.`
}

export const RECENT_READING_EMPTY_HINT = 'Anything you open in a reader appears here.'
export const RECENT_READING_SHOW_MORE = 'Show more'
export const RECENT_READING_UNTITLED = 'Untitled'
/** Appended to the meta line of a row with no permalink to open. */
export const RECENT_READING_NO_LINK = ' · no link'
/** A native row's byline when the writer lookup has neither name. */
export const RECENT_READING_NATIVE_BYLINE_FALLBACK = 'all.haus'
