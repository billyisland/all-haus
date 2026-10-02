import { signPublishAndIndex } from './signPublishAndIndex'
import { noteEventParts, type CrossPostTarget, type QuoteTarget } from './note-compose'

// =============================================================================
// Note Publishing Service
//
// Publishes a short-form note (Nostr kind 1) via the gateway.
// No direct relay access needed — signing and publishing happen server-side.
// What the event and its index body ARE lives in `note-compose.ts`, shared with
// the plain-HTML register; this file is only the I/O.
// =============================================================================

export type { CrossPostTarget, QuoteTarget } from './note-compose'

interface PublishNoteResult {
  noteEventId: string
}

export async function publishNote(
  content: string,
  authorPubkey: string,
  quoteTarget?: QuoteTarget,
  crossPosts?: CrossPostTarget[]
): Promise<PublishNoteResult> {
  const parts = noteEventParts(content, quoteTarget, crossPosts)

  const result = await signPublishAndIndex({
    content: parts.content,
    tags: parts.tags,
    indexEndpoint: '/notes',
    indexBody: (id, signed) =>
      parts.indexBody(id, {
        id: signed.id,
        pubkey: signed.pubkey,
        sig: signed.sig,
        created_at: signed.created_at,
      }),
  })

  return { noteEventId: result.eventId }
}
