import type { LinkedAccount } from './api/linked-accounts'
import { quoteSnapshot } from './post/quote-preview'

// =============================================================================
// A NOTE, as data — the pure half of publishing one.
//
// Everything a short-form note is before any I/O happens: its ceiling, the
// networks that can receive a cross-post of it, how its pictures join its
// text, and the event and index body a quote or a plain note becomes. Lifted
// out of `useNoteComposer` (a hook) and `publishNote` (which fetches), so the
// two compose surfaces and the plain-HTML register at `/modernhaus` build a
// note ONE way (web-modernhaus.md: logic is lifted, never re-implemented).
// `publishNote` and the hooks import from here and re-export what they gave up.
// =============================================================================

/**
 * A note's ceiling. A SECOND COPY of `gateway/src/routes/notes.ts`'s
 * `NOTE_CHAR_LIMIT` — the workspaces share no module path — held to it by
 * `web/tests/note-limit-parity.test.ts`.
 */
export const NOTE_CHAR_LIMIT = 1000

// The linked networks that can RECEIVE an original cross-post. `nostr_external`
// and `rss` are linked for reading and identity; neither is somewhere a note
// can be published as a new post.
export const CROSS_POST_PROTOCOLS: ReadonlySet<LinkedAccount['protocol']> = new Set([
  'atproto',
  'activitypub',
])

export const CROSS_POST_LABELS: Record<string, string> = {
  atproto: 'BLUESKY',
  activitypub: 'MASTODON',
}

/** The linked accounts a note may be cross-posted through. */
export function crossPostAccounts(accounts: readonly LinkedAccount[]): LinkedAccount[] {
  return accounts.filter((a) => a.isValid && CROSS_POST_PROTOCOLS.has(a.protocol))
}

/**
 * The text a note or reply ships: its words, then each attached picture's URL
 * on a line of its own. The count a surface shows is of THIS string, because
 * it is what the index route measures.
 */
export function joinTextAndImages(text: string, imageUrls: readonly string[]): string {
  return [text.trim(), ...imageUrls].filter(Boolean).join('\n')
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
  // An external NOSTR post's own event (hex id + author pubkey): the quote is
  // still external — snapshot, post id, URL — AND q-tags it, so the note is a
  // real NIP-18 quote on the relays the gateway replays it to (CA-I13).
  nostrEvent?: { id: string; pubkey: string }
  quotedPostId?: string
  quotedUrl?: string
  quotedSource?: string
}

export interface CrossPostTarget {
  linkedAccountId: string
  // Required for quote (external_items.id); omitted for top-level 'original'.
  // No 'reply': POST /notes refuses it — a reply to an external post goes
  // through POST /external-items/:id/reply, which records its parent.
  sourceItemId?: string
  actionType: 'quote' | 'original'
}

/**
 * The characters an external quote appends to the body (`"\n\n" + url`). A
 * surface counts them against the limit, or a body within it in the box
 * produces an over-limit note: the relay takes the signed event and the index
 * refuses it, orphaning the event.
 */
export function quoteUrlReserve(quoteTarget: QuoteTarget | null | undefined): number {
  return quoteTarget?.isExternal && quoteTarget.quotedUrl ? quoteTarget.quotedUrl.length + 2 : 0
}

export interface NoteEventParts {
  /** The event's content — the body, plus an external quote's URL. */
  content: string
  tags: string[][]
  /** `POST /notes`'s body, once the signed event's id is known. `signature`
   *  is what `/sign-and-publish` answered; a quote of an external Nostr post
   *  sends the whole signed event with it, for the gateway to replay onto that
   *  post's relays (CA-I13). */
  indexBody: (eventId: string, signature?: NoteSignature) => Record<string, unknown>
}

/** The fields `/sign-and-publish` adds to the template. */
export interface NoteSignature {
  id: string
  pubkey: string
  sig: string
  created_at: number
}

/** The kind-1 event and the index body a note (or a quote) becomes. */
export function noteEventParts(
  content: string,
  quoteTarget?: QuoteTarget,
  crossPosts?: CrossPostTarget[],
): NoteEventParts {
  const tags: string[][] = []

  // External quote: no nostr event to q-tag, so reference the origin by URL in the
  // body (portable to any relay). The rich in-app mini renders from the stored
  // quoted_* columns; the URL gives external clients a usable link.
  let body = content
  if (quoteTarget?.isExternal) {
    if (quoteTarget.quotedUrl) body = `${content}\n\n${quoteTarget.quotedUrl}`
    if (quoteTarget.nostrEvent) {
      tags.push(['q', quoteTarget.nostrEvent.id, '', quoteTarget.nostrEvent.pubkey])
    }
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

  return {
    content: body,
    tags,
    indexBody: (eventId, signature) => ({
      nostrEventId: eventId,
      content: body,
      ...(quoteTarget?.nostrEvent &&
        signature && {
          signedEvent: { kind: 1, content: body, tags, ...signature },
        }),
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
            quotedExcerpt: quoteSnapshot(quoteTarget.highlightedText ?? quoteTarget.previewContent),
            quotedTitle: quoteTarget.previewTitle,
            quotedAuthor: quoteTarget.previewAuthorName,
          }),
      ...(crossPosts && crossPosts.length > 0 && { crossPosts }),
    }),
  }
}
