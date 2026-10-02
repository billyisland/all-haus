import { WebSocket } from 'ws'
import logger from '@platform-pub/shared/lib/logger.js'
import { pinnedWebSocketOptions } from '@platform-pub/shared/lib/http-client.js'
import { TerminalDeliveryError, isTerminalDeliveryError } from '../lib/outbound-errors.js'

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

// =============================================================================
// NIP-01 gives `OK: false` a machine-readable prefix, and the three answers it
// can carry are genuinely different facts — which is why every rejection used
// to cost the row all ten of its attempts (audit §3, relay-publish):
//
//   duplicate:   the relay ALREADY HAS the event. That is delivery, not
//                failure — an event id is a hash of its content, so there is
//                nothing a retry could add. Treated as success.
//   terminal     `invalid:` (malformed / bad signature / out of the accepted
//                created_at window), `blocked:` (this pubkey may not write),
//                `restricted:` (this relay wants auth or payment). A refusal
//                the same bytes will get again in an hour.
//   transient    `rate-limited:`, `pow:`, `error:`, an unprefixed message, a
//                timeout, a socket error. Retry.
//
// Unprefixed defaults to transient: relays in the wild often answer with bare
// prose, and the safe direction for an unrecognised answer is to try again.
// =============================================================================
const TERMINAL_OK_PREFIXES = ['invalid:', 'blocked:', 'restricted:']

export function isDuplicateRejection(message: string): boolean {
  return message.trim().toLowerCase().startsWith('duplicate:')
}

export function isTerminalRejection(message: string): boolean {
  const m = message.trim().toLowerCase()
  return TERMINAL_OK_PREFIXES.some(p => m.startsWith(p))
}

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
  const reasons: string[] = []
  // A total failure is only TERMINAL if every relay refused deterministically.
  // One timeout among the refusals makes the whole attempt ambiguous — that
  // relay may yet accept, and a re-publish of the same signed event is
  // idempotent by event id, so retrying costs nothing but a round trip.
  let allTerminal = true
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled') {
      succeeded.push(relayUrls[i])
    } else {
      failed.push(relayUrls[i])
      const msg = r.reason?.message ?? String(r.reason)
      reasons.push(`${relayUrls[i]}: ${msg}`)
      if (!isTerminalDeliveryError(r.reason)) allTerminal = false
      logger.warn(
        { relayUrl: relayUrls[i], eventId: event.id, err: msg, terminal: isTerminalDeliveryError(r.reason) },
        'Outbound Nostr relay publish failed'
      )
    }
  }

  if (succeeded.length === 0) {
    const detail = `All relays rejected or timed out (${reasons.join('; ')})`
    throw allTerminal ? new TerminalDeliveryError(detail) : new Error(detail)
  }
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
          if (success) return resolve()
          const reason = typeof message === 'string' ? message : String(message ?? '')
          // The relay already holds this exact event — delivered.
          if (isDuplicateRejection(reason)) return resolve()
          const err = `Relay rejected event: ${reason}`
          reject(isTerminalRejection(reason) ? new TerminalDeliveryError(err) : new Error(err))
        }
      } catch { /* ignore non-OK frames */ }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
