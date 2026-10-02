// =============================================================================
// A native article's standing sentences, in one home for both registers.
//
// The full site's reader (`components/article/`, client components) and
// modernhaus's article page (bare HTML) say the same things about a withdrawn
// or missing piece. modernhaus cannot import a `'use client'` file, and two
// copies of the same promise drift apart invisibly.
// =============================================================================

/** Shown above a piece the writer withdrew, to a reader who paid for it (Writer 3.4). */
export const ARTICLE_WITHDRAWN_NOTICE =
  'The writer has withdrawn this piece. You paid for it, so it stays yours to read (Writer Agreement 3.4); it is no longer on sale and no longer linked from anywhere.'

/** An address that resolves to no piece this viewer may read. */
export const ARTICLE_NOT_HERE_TITLE = 'This piece isn’t here.'
export const ARTICLE_NOT_HERE_BODY =
  'It may have been withdrawn by its writer, or the address may be wrong. If you paid for it, log in and it will open for you.'

/** We could not ask whether this viewer may read it — an outage, not an absence. */
export const ARTICLE_UNREACHABLE_TITLE = 'This piece couldn’t be loaded.'
export const ARTICLE_UNREACHABLE_BODY = 'Something went wrong on our side.'
