// =============================================================================
// PostgreSQL advisory-lock IDs
//
// Centralised so that every service claiming an advisory lock picks its id
// from one place. The gateway uses these to single-instance its background
// workers; feed-ingest uses its own for the Jetstream WebSocket leader.
//
// Gap at 100003 is a relic of a removed worker — do not reuse without a
// grep to confirm nothing still thinks of it as its id.
// =============================================================================

export const ADVISORY_LOCKS = {
  // gateway workers (see gateway/src/workers/)
  SUBSCRIPTIONS: 100001,
  DRIVES: 100002,
  // 100003 intentionally skipped
  SCHEDULER: 100004,
  DISCOVERY: 100005, // Nostr discovery sweep (coalesce + backfill + self-heal)
  TRIBUTES: 100006, // Tribute lifecycle sweep (30d reminder + 60d lapse)
  FOLLOW_IMPORT: 100007, // Follow-graph import sweep (FOLLOW-GRAPH-IMPORT-ADR §6.1)
  WAITLIST_DIGEST: 100008, // Waitlist operator digest (CLOSED-BETA-ADR §XI, D8.2)

  // feed-ingest
  JETSTREAM: 0x4a455453, // "JETS" in ASCII; session-scoped leader election
} as const
