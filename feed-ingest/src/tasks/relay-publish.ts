import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { publishNostrToRelaysDetailed, type NostrSignedEvent } from '../adapters/nostr-outbound.js'
import { runOutboundJob } from '../lib/outbound-retry.js'

// Discovery events (kind 0/3/10002) must reach the public mesh, not just the
// in-house relay. For these entity types a row is only 'sent' if at least one
// *public fan-out* relay accepted; an in-house-only ACK is retried (D6).
const DISCOVERY_ENTITY_TYPES = new Set(['profile', 'follow_list', 'relay_list'])

// =============================================================================
// relay_publish — publish a queued signed Nostr event to one or more relays.
//
// Payload: { outboxId: UUID }
//
// Claim + serialisation: SELECT FOR UPDATE SKIP LOCKED claims the row, and a
// transaction-scoped advisory lock keyed on (entity_type, entity_id)
// serialises concurrent workers operating on the same entity (e.g.
// subscription cancel → reactivate race). The publish and status UPDATE all
// run inside the same transaction so the row lock + advisory lock persist
// for the duration of the relay round-trip.
//
// Retry semantics live on relay_outbox (attempts / next_attempt_at /
// max_attempts). The graphile-worker job is scheduled with max_attempts := 1
// so Graphile's own retry loop doesn't race ours. On failure we schedule a
// fresh job with a versioned job_key.
//
// Partial success (some relays accept, some reject) is treated as sent per
// the §71 one-accepts rule; publishNostrToRelaysDetailed logs per-relay
// rejections. Exception: discovery rows (kind 0/3/10002) require at least one
// *public* fan-out relay to accept — an in-house-only ACK is retried (D6).
// =============================================================================

interface RelayOutboxRow {
  id: string
  entity_type: string
  entity_id: string | null
  signed_event: NostrSignedEvent
  target_relay_urls: string[]
  status: string
  attempts: number
  max_attempts: number
}

export const relayPublish: Task = async (payload, helpers) => {
  const { outboxId } = payload as { outboxId: string }

  // The worker owns the client: a dedicated connection whose single
  // transaction holds the row lock + per-entity advisory lock across the relay
  // round-trip. `txnOpen` lets cleanup roll back an unexpected mid-flight
  // throw without a spurious "no transaction" warning on the committed paths.
  const client = await pool.connect()
  let txnOpen = false

  await runOutboundJob<RelayOutboxRow>({
    taskName: 'relay_publish',
    payload: { outboxId },
    rowId: outboxId,
    helpers,
    attemptsOf: (row) => row.attempts,
    maxOf: (row) => row.max_attempts,
    computeBackoff,

    claim: async () => {
      await client.query('BEGIN')
      txnOpen = true

      const { rows } = await client.query<RelayOutboxRow>(
        `SELECT id, entity_type, entity_id, signed_event, target_relay_urls,
                status, attempts, max_attempts
           FROM relay_outbox
           WHERE id = $1
           FOR UPDATE SKIP LOCKED`,
        [outboxId],
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        txnOpen = false
        return null
      }
      const row = rows[0]
      if (row.status !== 'pending' && row.status !== 'failed') {
        await client.query('ROLLBACK')
        txnOpen = false
        return null
      }

      if (row.entity_id) {
        const lockKey = `${row.entity_type}:${row.entity_id}`
        const { rows: lockRows } = await client.query<{ got: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got`,
          [lockKey],
        )
        if (!lockRows[0]?.got) {
          await client.query('ROLLBACK')
          txnOpen = false
          logger.debug({ outboxId, lockKey }, 'relay_publish: entity locked by peer — redrive will retry')
          return null
        }
      }

      return row
    },

    attempt: async (row) => {
      const relayUrls = row.target_relay_urls.length > 0
        ? row.target_relay_urls
        : defaultRelayUrls()

      if (relayUrls.length === 0) {
        throw new Error('No target relay URLs and PLATFORM_RELAY_WS_URL not set')
      }

      const result = await publishNostrToRelaysDetailed(row.signed_event, relayUrls)

      // Discovery rows: require public-mesh delivery before marking sent. If
      // public fan-out relays were targeted but none accepted (only the
      // in-house relay did), retry rather than silently declaring success —
      // otherwise public delivery never happens once PUBLIC_FANOUT_RELAY_URLS
      // is configured (D6). Re-publishing a replaceable discovery event to the
      // relays that already accepted is idempotent.
      if (DISCOVERY_ENTITY_TYPES.has(row.entity_type)) {
        const platformUrl = process.env.PLATFORM_RELAY_WS_URL
        const publicTargets = relayUrls.filter((u) => u !== platformUrl)
        const publicAccepted = publicTargets.some((u) => result.succeeded.includes(u))
        if (publicTargets.length > 0 && !publicAccepted) {
          throw new Error(
            `Discovery event reached in-house relay only; all ${publicTargets.length} public fan-out relay(s) rejected`,
          )
        }
      }

      await client.query(
        `UPDATE relay_outbox
           SET status = 'sent',
               sent_at = now(),
               last_attempt_at = now(),
               attempts = attempts + 1,
               last_error = NULL
           WHERE id = $1`,
        [row.id],
      )
      await client.query('COMMIT')
      txnOpen = false
      logger.info(
        { outboxId: row.id, entityType: row.entity_type, eventId: row.signed_event.id },
        'relay_publish: sent',
      )
    },

    onRetry: async (row, nextAttempt, nextAt, msg) => {
      await client.query(
        `UPDATE relay_outbox
           SET status = 'failed',
               attempts = $2,
               last_attempt_at = now(),
               next_attempt_at = $3,
               last_error = $4
           WHERE id = $1`,
        [row.id, nextAttempt, nextAt, msg],
      )
      await client.query('COMMIT')
      txnOpen = false
      logger.info(
        { outboxId: row.id, attempts: nextAttempt, nextAt, err: msg },
        'relay_publish: retrying',
      )
    },

    onAbandon: async (row, nextAttempt, msg) => {
      await client.query(
        `UPDATE relay_outbox
           SET status = 'abandoned',
               attempts = $2,
               last_attempt_at = now(),
               last_error = $3
           WHERE id = $1`,
        [row.id, nextAttempt, msg],
      )
      await client.query('COMMIT')
      txnOpen = false
      logger.warn(
        { outboxId: row.id, entityType: row.entity_type, attempts: nextAttempt, err: msg },
        'relay_publish: abandoned after max_attempts',
      )
    },

    cleanup: async () => {
      if (txnOpen) await client.query('ROLLBACK').catch(() => {})
      client.release()
    },
  })
}

function defaultRelayUrls(): string[] {
  const url = process.env.PLATFORM_RELAY_WS_URL
  return url ? [url] : []
}

export function computeBackoff(attempts: number): Date {
  // min(2^attempts minutes, 1 hour) with ±10% jitter.
  const baseMs = Math.min(Math.pow(2, attempts) * 60_000, 3_600_000)
  const jitter = baseMs * (Math.random() * 0.2 - 0.1)
  return new Date(Date.now() + baseMs + jitter)
}
