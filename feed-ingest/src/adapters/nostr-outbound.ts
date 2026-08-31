import { WebSocket } from 'ws'
import logger from '@platform-pub/shared/lib/logger.js'
import { pinnedWebSocketOptions } from '@platform-pub/shared/lib/http-client.js'

// =============================================================================
// External Nostr outbound adapter
//
// The user's signed event was already produced gateway-side (by key-custody,
// using the user's custodial private key) and stored in outbound_posts.signed_event.
// The job's only responsibility is to push that event onto the source's relay
// URLs. Returns the original event id on success; throws if every relay rejects
// or times out.
// =============================================================================

export interface NostrSignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const RELAY_TIMEOUT_MS = 5_000

export interface RelayPublishResult {
  eventId: string
  /** Relay URLs that ACKed the event with OK,true. */
  succeeded: string[]
  /** Relay URLs that rejected, errored, or timed out. */
  failed: string[]
}

// Detailed variant: returns which relays accepted vs. rejected so callers can
// apply per-target delivery policy (e.g. discovery rows must reach the public
// mesh, not just the in-house relay — see relay-publish.ts D6). Throws only
// when *every* relay rejects, preserving the all-fail contract below.
export async function publishNostrToRelaysDetailed(
  event: NostrSignedEvent,
  relayUrls: string[]
): Promise<RelayPublishResult> {
  if (relayUrls.length === 0) throw new Error('No relay URLs to publish to')

  const results = await Promise.allSettled(
    relayUrls.map(url => publishOne(url, event))
  )

  const succeeded: string[] = []
  const failed: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      succeeded.push(relayUrls[i])
    } else {
      failed.push(relayUrls[i])
      logger.warn(
        { relayUrl: relayUrls[i], eventId: event.id, err: r.reason?.message ?? String(r.reason) },
        'Outbound Nostr relay publish failed'
      )
    }
  }

  if (succeeded.length === 0) throw new Error('All relays rejected or timed out')
  if (failed.length > 0) {
    logger.warn(
      { eventId: event.id, succeeded: succeeded.length, total: relayUrls.length },
      'Outbound Nostr publish partially succeeded — some relays rejected or timed out'
    )
  }
  return { eventId: event.id, succeeded, failed }
}

// Back-compat wrapper: returns the event id on any non-total-failure (the
// "one accepts" contract used by outbound-cross-post.ts).
export async function publishNostrToRelays(
  event: NostrSignedEvent,
  relayUrls: string[]
): Promise<string> {
  const { eventId } = await publishNostrToRelaysDetailed(event, relayUrls)
  return eventId
}

// The in-house relay (PLATFORM_RELAY_WS_URL, e.g. ws://strfry:7777) resolves to
// a private compose address, which the SSRF pin rejects by default — so without
// this exemption every native publish (articles, notes, kind-5 tombstones,
// discovery events) fails the pin on claim and eventually abandons. The value is
// operator-controlled config, never user input; external cross-post relays get
// no exemption (their host won't match).
function platformRelayHosts(): string[] {
  const url = process.env.PLATFORM_RELAY_WS_URL
  if (!url) return []
  try {
    return [new URL(url).hostname]
  } catch {
    return []
  }
}

async function publishOne(relayUrl: string, event: NostrSignedEvent): Promise<void> {
  const wsOpts = await pinnedWebSocketOptions(relayUrl, { allowHosts: platformRelayHosts() })
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl, wsOpts)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Relay publish timeout'))
    }, RELAY_TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]))
    })
    ws.on('message', (data) => {
      try {
        const [type, , success, message] = JSON.parse(data.toString())
        if (type === 'OK') {
          clearTimeout(timeout)
          ws.close()
          if (success) resolve()
          else reject(new Error(`Relay rejected event: ${message}`))
        }
      } catch { /* ignore non-OK frames */ }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
