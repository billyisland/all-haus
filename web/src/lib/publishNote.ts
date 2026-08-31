import { signPublishAndIndex } from './signPublishAndIndex'
import { quoteSnapshot } from './post/quote-preview'

// =============================================================================
// Note Publishing Service
//
// Publishes a short-form note (Nostr kind 1) via the gateway.
// No direct relay access needed — signing and publishing happen server-side.
// =============================================================================

interface PublishNoteResult {
  noteEventId: string
}

export interface QuoteTarget {
  eventId: string
  eventKind: number
  authorPubkey: string
  previewTitle?: string
  // The snapshot of the quoted post's text (quotePreviewContent). Stored as
  // notes.quoted_excerpt and rendered as the inset — see the field's own file
  // for why its size follows the quoted post's kind.
  previewContent?: string
  previewAuthorName?: string
  // A passage the user DELIBERATELY selected inside an article. Distinct from
  // previewContent, and only this one becomes the outbound NIP `excerpt` tag: a
  // whole-post quote has no chosen passage, and shipping a preview as an excerpt
  // would tell every other client the quoter had pulled that bit out on purpose.
  // For the local snapshot the two are interchangeable, and this wins.
  highlightedText?: string
  // External quote (migration 102): quoting a Bluesky/Mastodon/etc. post. The
  // quoted thing has no nostr event id, so eventId/authorPubkey are unused (the
  // NIP-18 `q` tag is skipped); these carry the reference instead, and the public
  // URL is appended to the note body so the quote is portable to any relay.
  isExternal?: boolean
  quotedPostId?: string
  quotedUrl?: string
  quotedSource?: string
}

export interface CrossPostTarget {
  linkedAccountId: string
  // Required for reply/quote (external_items.id); omitted for top-level 'original'.
  sourceItemId?: string
  actionType: 'reply' | 'quote' | 'original'
}

export async function publishNote(
  content: string,
  authorPubkey: string,
  quoteTarget?: QuoteTarget,
  crossPosts?: CrossPostTarget[]
): Promise<PublishNoteResult> {
  const tags: string[][] = []

  // External quote: no nostr event to q-tag, so reference the origin by URL in the
  // body (portable to any relay). The rich in-app mini renders from the stored
  // quoted_* columns; the URL gives external clients a usable link.
  let body = content
  if (quoteTarget?.isExternal) {
    if (quoteTarget.quotedUrl) body = `${content}\n\n${quoteTarget.quotedUrl}`
  } else if (quoteTarget) {
    // Native quote: NIP-18 q tag.
    tags.push(['q', quoteTarget.eventId, '', quoteTarget.authorPubkey])
    if (quoteTarget.highlightedText) {
      const words = quoteTarget.highlightedText.trim().split(/\s+/).slice(0, 80).join(' ')
      tags.push(['excerpt', words])
      if (quoteTarget.previewTitle) tags.push(['excerpt-title', quoteTarget.previewTitle])
      if (quoteTarget.previewAuthorName) tags.push(['excerpt-author', quoteTarget.previewAuthorName])
    }
  }

  const result = await signPublishAndIndex({
    content: body,
    tags,
    indexEndpoint: '/api/v1/notes',
    indexBody: (eventId) => ({
      nostrEventId: eventId,
      content: body,
      ...(quoteTarget?.isExternal
        ? {
            isQuoteComment: true,
            quotedPostId: quoteTarget.quotedPostId,
            quotedUrl: quoteTarget.quotedUrl,
            quotedSource: quoteTarget.quotedSource,
            quotedTitle: quoteTarget.previewTitle,
            quotedExcerpt: quoteSnapshot(quoteTarget.previewContent),
            quotedAuthor: quoteTarget.previewAuthorName,
          }
        : quoteTarget && {
            isQuoteComment: true,
            quotedEventId: quoteTarget.eventId,
            quotedEventKind: quoteTarget.eventKind,
            // The snapshot takes whatever text we have. Gating it on
            // highlightedText — the ARTICLE-highlight field — meant every quote
            // raised from a card stored no excerpt at all (only QuoteSelector
            // sets it; every other surface sets previewContent), so the inset
            // had nothing to render and fell back to a bare "Quoted a post →".
            // The relay `excerpt` tag above stays gated; the local snapshot must
            // not be.
            quotedExcerpt: quoteSnapshot(
              quoteTarget.highlightedText ?? quoteTarget.previewContent,
            ),
            quotedTitle: quoteTarget.previewTitle,
            quotedAuthor: quoteTarget.previewAuthorName,
          }),
      ...(crossPosts && crossPosts.length > 0 && { crossPosts }),
    }),
  })

  return { noteEventId: result.eventId }
}
