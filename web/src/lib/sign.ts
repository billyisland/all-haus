// =============================================================================
// Signing Utility
//
// Signs a Nostr event template via the gateway's custodial signing service.
// Works with plain event objects — no NDK dependency required.
// =============================================================================

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? ''

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
  const res = await fetch(`${GATEWAY_URL}/api/v1/sign`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: event.kind,
      content: event.content,
      tags: event.tags,
      created_at: event.created_at,
    }),
  })

  if (!res.ok) {
    throw new Error(`Event signing failed: ${res.status}`)
  }

  const signedData = await res.json()
  return {
    ...event,
    id: signedData.id,
    sig: signedData.sig,
    pubkey: signedData.pubkey,
    created_at: signedData.created_at,
  }
}

/**
 * Sign a Nostr event and publish it to the relay in a single gateway call.
 * Eliminates the need for the client to have direct relay access.
 */
export async function signAndPublish(event: NostrEventTemplate): Promise<SignedNostrEvent> {
  const res = await fetch(`${GATEWAY_URL}/api/v1/sign-and-publish`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: event.kind,
      content: event.content,
      tags: event.tags,
      created_at: event.created_at,
    }),
  })

  if (!res.ok) {
    throw new Error(`Sign-and-publish failed: ${res.status}`)
  }

  const signedData = await res.json()
  return {
    ...event,
    id: signedData.id,
    sig: signedData.sig,
    pubkey: signedData.pubkey,
    created_at: signedData.created_at,
  }
}
