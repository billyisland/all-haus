import { finalizeEvent, getPublicKey } from 'nostr-tools'
import type { SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'

// =============================================================================
// Gateway Nostr Publisher
//
// Signs events with the platform service key. All write paths flow through
// `relay_outbox` (see shared/src/lib/relay-outbox.ts) — callers sign here and
// hand the signed event to `enqueueRelayPublish` inside their own transaction;
// the feed-ingest `relay_publish` worker owns the actual websocket publish.
//
// Signing uses PLATFORM_SERVICE_PRIVKEY — the same key used by the payment
// service for kind 9901 receipt events.
// =============================================================================

function getServiceKeypair(): { privkey: Uint8Array; pubkey: string } {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  const pubkey = getPublicKey(privkey)
  return { privkey, pubkey }
}

// =============================================================================
// Subscription event — kind 7003 (provisional NIP-88)
//
// Signed on subscription create, reactivate, cancel, and renew. Attests that
// reader X has (or had) access to writer Y. Federation use: another host can
// verify this event against GET /platform-pubkey and trust that the
// subscription was valid during the stated period.
//
// NB: This kind number is provisional and will be updated when NIP-88 is
// finalised.
// =============================================================================

interface SubscriptionEventParams {
  subscriptionId: string
  readerPubkey: string
  writerPubkey: string
  status: 'active' | 'cancelled'
  pricePence: number
  periodStart: Date
  periodEnd: Date
}

export function signSubscriptionEvent(params: SubscriptionEventParams): SignedNostrEvent {
  const { privkey } = getServiceKeypair()

  const eventTemplate = {
    kind: 7003,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', params.writerPubkey],
      ['reader', params.readerPubkey],
      ['status', params.status],
      ['amount', String(params.pricePence), 'GBP'],
      ['period_start', String(Math.floor(params.periodStart.getTime() / 1000))],
      ['period_end', String(Math.floor(params.periodEnd.getTime() / 1000))],
      ['subscription', params.subscriptionId],
    ],
    content: '',
  }

  return finalizeEvent(eventTemplate, privkey) as SignedNostrEvent
}
