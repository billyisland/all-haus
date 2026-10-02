import type { Post } from './types'

/**
 * The id of the source surface this post's provenance line may link to, or
 * null where there is none to open. `GET /sources/:id` answers 404 for a
 * private protocol (an email newsletter) and an inactive row, and the gateway
 * says which by `origin.sourceBrowsable` — so every link to a source (the
 * card's, the reader bar's, modernhaus's) asks here rather than offering a
 * link that cannot open (MODERNHAUS-ADR §E7.3; web-foundations: a button that
 * cannot do its job is not offered). Pure: modernhaus imports it.
 */
export function sourcePageId(post: Pick<Post, 'origin' | 'externalSourceId'>): string | null {
  return post.origin.sourceBrowsable === true && post.externalSourceId ? post.externalSourceId : null
}
