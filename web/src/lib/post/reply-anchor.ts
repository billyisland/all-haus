// =============================================================================
// The `#reply-<comment id>` anchor — the address of one comment under an
// article, in ONE home.
//
// A notification about a comment links to `/article/<slug>#reply-<id>`. That
// used to be a DOM id the playscript rendered, and the browser found it — when
// the replies had loaded, which on a client-fetched section they never had.
// The article's conversation is cards now and nothing renders that id: the
// anchor is PARSED, by the page's `ReplySection` (off `location.hash`) and by
// `routeToOverlay` (off the href, because the reader pane has no hash). The
// writer and both readers go through here so the three cannot disagree.
// =============================================================================

export function replyAnchor(commentId: string): string {
  return `#reply-${commentId}`;
}

/** The comment id an href or hash points at, or null. */
export function commentIdFromAnchor(hrefOrHash: string): string | null {
  const m = /#reply-([^#?/]+)$/.exec(hrefOrHash);
  return m ? decodeURIComponent(m[1]) : null;
}
