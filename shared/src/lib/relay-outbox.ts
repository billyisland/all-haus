import type { PoolClient } from 'pg'

// =============================================================================
// relay_outbox enqueue helper
//
// Called by every site that used to `await publishToRelay(signed)`. The caller
// passes their in-flight transaction client; this helper inserts the row and
// schedules a graphile-worker job. On ID collision (double-enqueue after a
// crash between sign-and-insert) returns the existing row without scheduling.
//
// The worker (`feed-ingest/src/tasks/relay-publish.ts`) owns retry semantics
// via the `attempts` / `next_attempt_at` / `max_attempts` columns; the
// graphile-worker job is scheduled with max_attempts := 1 so Graphile's own
// retry doesn't race ours.
// =============================================================================

export type RelayOutboxEntityType =
  | 'article'
  | 'article_deletion'
  | 'note'
  | 'note_deletion'
  | 'subscription'
  | 'receipt'
  | 'drive'
  | 'drive_deletion'
  | 'signing_passthrough'
  | 'conversation_pulse'
  | 'account_deletion'
  // Nostr outbound interop — replaceable discovery events (NOSTR-OUTBOUND-INTEROP-ADR)
  | 'profile'       // kind 0  — profile metadata
  | 'follow_list'   // kind 3  — NIP-02 contact list
  | 'relay_list'    // kind 10002 — NIP-65 relay list
  // Upstream Edges — addressable citation/dispute claims (UPSTREAM-EDGES-ADR)
  | 'citation'      // kind 30100 — a faithfulness claim pinned to a source
  | 'dispute'       // kind 30101 — a counter-claim against a citation (+ kind 5 retraction)

export interface SignedNostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface EnqueueRelayPublishInput {
  entityType: RelayOutboxEntityType
  entityId?: string | null
  signedEvent: SignedNostrEvent
  targetRelayUrls?: string[]
  maxAttempts?: number
}

export interface EnqueueRelayPublishResult {
  id: string
  existed: boolean
}

export async function enqueueRelayPublish(
  client: PoolClient,
  input: EnqueueRelayPublishInput,
): Promise<EnqueueRelayPublishResult> {
  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO relay_outbox (
       entity_type, entity_id, signed_event, target_relay_urls, max_attempts
     ) VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT ((signed_event->>'id')) DO NOTHING
     RETURNING id`,
    [
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.signedEvent),
      input.targetRelayUrls ?? [],
      input.maxAttempts ?? 10,
    ],
  )

  if (inserted.length > 0) {
    const id = inserted[0].id
    // Schedule the graphile-worker job inside the same transaction so it's
    // rolled back on error. job_key dedups against concurrent retries.
    await client.query(
      `SELECT graphile_worker.add_job(
         'relay_publish',
         json_build_object('outboxId', $1::text)::json,
         job_key := 'relay_publish_' || $1::text,
         max_attempts := 1
       )`,
      [id],
    )
    return { id, existed: false }
  }

  // Conflict: the event was already enqueued. Return the existing row's id.
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM relay_outbox WHERE signed_event->>'id' = $1`,
    [input.signedEvent.id],
  )
  if (existing.length === 0) {
    throw new Error('relay_outbox ON CONFLICT without matching row')
  }
  return { id: existing[0].id, existed: true }
}
