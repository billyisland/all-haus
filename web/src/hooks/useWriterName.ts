import { useState, useEffect } from 'react'

// =============================================================================
// useWriterName — resolves a Nostr pubkey to a display name
//
// The feed fetches articles from the relay, which only has pubkeys.
// This hook calls the gateway to resolve pubkey → display name + username,
// with a client-side cache to avoid redundant lookups.
// =============================================================================

interface WriterInfo {
  id: string | null
  displayName: string
  username: string
  avatar: string | null
}

const cache = new Map<string, WriterInfo>()
const pending = new Map<string, Promise<WriterInfo | null>>()

// Synchronous read of the resolved-name cache — for non-React call sites (e.g.
// building a QuoteTarget on click) where the byline has usually already warmed
// the cache. Returns null on a cache miss; pair with resolveWriterName to fill it.
export function getCachedWriterName(pubkey: string): string | null {
  return cache.get(pubkey)?.displayName ?? null
}

// Cache-or-fetch resolver (same backing cache as the hook), for imperative call
// sites that need the name outside render. Resolves null if the lookup fails.
export async function resolveWriterName(pubkey: string): Promise<WriterInfo | null> {
  const cached = cache.get(pubkey)
  if (cached) return cached
  if (!pending.has(pubkey)) {
    const promise = fetchWriterByPubkey(pubkey)
    pending.set(pubkey, promise)
    void promise.finally(() => pending.delete(pubkey))
  }
  const result = await pending.get(pubkey)!
  if (result) cache.set(pubkey, result)
  return result
}

export function useWriterName(pubkey: string): WriterInfo | null {
  const [info, setInfo] = useState<WriterInfo | null>(cache.get(pubkey) ?? null)

  useEffect(() => {
    if (cache.has(pubkey)) {
      setInfo(cache.get(pubkey)!)
      return
    }

    let cancelled = false

    // Deduplicate in-flight requests
    if (!pending.has(pubkey)) {
      const promise = fetchWriterByPubkey(pubkey)
      pending.set(pubkey, promise)
      void promise.finally(() => pending.delete(pubkey))
    }

    void pending.get(pubkey)!.then((result) => {
      if (result) {
        cache.set(pubkey, result)
        if (!cancelled) setInfo(result)
      }
    })

    return () => { cancelled = true }
  }, [pubkey])

  return info
}

async function fetchWriterByPubkey(pubkey: string): Promise<WriterInfo | null> {
  try {
    const res = await fetch(`/api/v1/writers/by-pubkey/${pubkey}`, {
      credentials: 'include',
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      id: data.id ?? null,
      displayName: data.displayName ?? data.username ?? pubkey.slice(0, 12),
      username: data.username,
      avatar: data.avatar,
    }
  } catch {
    return null
  }
}
