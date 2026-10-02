import { KIND_NOTE } from './ndk'
import { signAndPublish, type SignedNostrEvent } from './sign'
import { ApiError, request } from './api/client'

// =============================================================================
// Shared sign → publish → index helper
//
// Used by comments, replies, and notes to avoid duplicating the common pattern
// of signing a Nostr event, publishing to a relay, and indexing in the DB.
// =============================================================================

interface SignPublishAndIndexParams {
  content: string
  tags: string[][]
  /** Under `/api/v1`, as `request()` takes it — `/notes`, `/replies`. */
  indexEndpoint: string
  indexBody: (eventId: string, signature: SignedNostrEvent) => Record<string, unknown>
}

interface SignPublishAndIndexResult {
  eventId: string
  indexData: Record<string, unknown>
}

/** How many times the INDEX is asked for one signed event before giving up:
 *  the first call plus this many more, on a 5xx or a dropped connection. */
export const INDEX_RETRIES = 2
const INDEX_RETRY_DELAY_MS = 600

export async function signPublishAndIndex(params: SignPublishAndIndexParams): Promise<SignPublishAndIndexResult> {
  const signed = await signAndPublish({
    kind: KIND_NOTE,
    content: params.content,
    tags: params.tags,
  })

  // THE INDEX IS RETRIED WITH THE SIGNED EVENT, NEVER RE-SIGNED (CA-B11,
  // 2026-09-29). `sign-and-publish` has already enqueued this event to the
  // relay by the time the index is asked, so a failure here — a gateway
  // restart, a dropped connection — used to leave a relay event with no row,
  // the composer showing the raw status, and the next press signing a NEW
  // event (new created_at, new id): two copies on the relay for one post.
  // Both index routes are idempotent on `nostr_event_id`, so the same body is
  // asked again for a fault of ours; a 4xx is the route's answer and is final.
  //
  // The refusal that ends the loop is thrown AS IT CAME — an `ApiError` for
  // the route's answer, fetch's own error for a connection that never made it
  // — so the composer words it with `failureSentence` like any other press.
  const body = JSON.stringify(params.indexBody(signed.id, signed))
  let lastFailure: unknown = null
  for (let attempt = 0; attempt <= INDEX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, INDEX_RETRY_DELAY_MS * attempt))
    try {
      const data = await request<Record<string, unknown>>(params.indexEndpoint, { method: 'POST', body })
      return { eventId: signed.id, indexData: data }
    } catch (err) {
      lastFailure = err
      if (err instanceof ApiError && err.status < 500) break
    }
  }
  throw lastFailure
}
