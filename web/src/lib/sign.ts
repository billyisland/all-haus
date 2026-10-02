// =============================================================================
// Signing Utility
//
// Signs a Nostr event template via the gateway's custodial signing service.
// Works with plain event objects — no NDK dependency required. A refusal is
// an `ApiError` from `request()` (CA-J2).
// =============================================================================

import { request } from './api/client'

interface SignedFields {
  id: string
  sig: string
  pubkey: string
  created_at: number
}

function signBody(event: NostrEventTemplate): string {
  return JSON.stringify({
    kind: event.kind,
    content: event.content,
    tags: event.tags,
    created_at: event.created_at,
  })
}

function withSignature(event: NostrEventTemplate, s: SignedFields): SignedNostrEvent {
  return { ...event, id: s.id, sig: s.sig, pubkey: s.pubkey, created_at: s.created_at }
}

export interface NostrEventTemplate {
  kind: number
  content: string
  tags: string[][]
  created_at?: number
}

export interface SignedNostrEvent extends NostrEventTemplate {
  id: string
  pubkey: string
  sig: string
  created_at: number
}

export async function signViaGateway(event: NostrEventTemplate): Promise<SignedNostrEvent> {
  const signed = await request<SignedFields>('/sign', { method: 'POST', body: signBody(event) })
  return withSignature(event, signed)
}

/**
 * Sign a Nostr event and publish it to the relay in a single gateway call.
 * Eliminates the need for the client to have direct relay access.
 */
export async function signAndPublish(event: NostrEventTemplate): Promise<SignedNostrEvent> {
  const signed = await request<SignedFields>('/sign-and-publish', { method: 'POST', body: signBody(event) })
  return withSignature(event, signed)
}
