import { useState, useEffect } from 'react'
import { request } from '../lib/api/client'

// =============================================================================
// useWriterName — resolves a Nostr pubkey to a display name
//
// For a surface that holds only a pubkey (the reading log). A card never needs
// it: a Post carries its native author's name and handle (CA-G7). Calls the
// gateway to resolve pubkey → display name + username, with a client-side
// cache to avoid redundant lookups.
// =============================================================================

interface WriterInfo {
  id: string | null
  displayName: string
  username: string
  avatar: string | null
}

const cache = new Map<string, WriterInfo>()
const pending = new Map<string, Promise<WriterInfo | null>>()

export function useWriterName(pubkey: string): WriterInfo | null {
  const [info, setInfo] = useState<WriterInfo | null>(cache.get(pubkey) ?? null)

  useEffect(() => {
    if (cache.has(pubkey)) {
      setInfo(cache.get(pubkey)!)
      return
    }

    // A different pubkey is a different person: the previous one's name must
    // not stand while this one resolves, nor for ever if it resolves to
    // nothing (CA-E14).
    setInfo(null)
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
    const data = await request<{ id?: string; displayName?: string; username: string; avatar: string | null }>(
      `/writers/by-pubkey/${encodeURIComponent(pubkey)}`,
    )
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
