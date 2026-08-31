import { KIND_NOTE } from './ndk'
import { signAndPublish } from './sign'

// =============================================================================
// Shared sign → publish → index helper
//
// Used by comments, replies, and notes to avoid duplicating the common pattern
// of signing a Nostr event, publishing to a relay, and indexing in the DB.
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

interface SignPublishAndIndexParams {
  content: string
  tags: string[][]
  indexEndpoint: string
  indexBody: (eventId: string) => Record<string, unknown>
}

interface SignPublishAndIndexResult {
  eventId: string
  indexData: Record<string, unknown>
}

export async function signPublishAndIndex(params: SignPublishAndIndexParams): Promise<SignPublishAndIndexResult> {
  const signed = await signAndPublish({
    kind: KIND_NOTE,
    content: params.content,
    tags: params.tags,
  })

  const res = await fetch(`${GATEWAY_URL}${params.indexEndpoint}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.indexBody(signed.id)),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(`Indexing failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const data = await res.json()
  return { eventId: signed.id, indexData: data }
}
