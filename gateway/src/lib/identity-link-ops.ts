import type { ClientBase } from "pg";

// =============================================================================
// Slice 8 — identity-link mutations (assert / unlink), extracted from
// routes/identity-links.ts so the integration test exercises the EXACT SQL the
// route runs (the dedup-sql.ts pattern — no second copy to drift).
//
// Both operations are LAST-WRITE-WINS on the viewer's single owner-scoped slot
// per pair (`uq_idlink_owned`, unique on `(source_a_id, source_b_id, owner_id)`):
//   • assertIdentityLink → the slot becomes 'user_asserted'  (overrides a prior
//     'user_unlinked' tombstone, so re-linking after an unlink actually re-links).
//   • unlinkIdentityPair → the slot becomes 'user_unlinked' when a GLOBAL link
//     merges the pair for everyone (a fact the viewer cannot delete), ELSE the
//     viewer's own 'user_asserted' row is hard-deleted (nothing else merges it).
//
// The rule is CONVERGE-TO-INTENDED-STATE: clicking "Link to…" always ends merged;
// clicking "Unlink"/"Stop merging" always ends un-merged — neither is a silent
// no-op when the OTHER kind of link also touches the pair. (The prior code left
// one alive: unlinking a detected pair you'd also asserted kept the assertion, so
// the merge survived and "Stop merging this source" did nothing.)
//
// Typed as ClientBase so both a pooled `PoolClient` (route, via withTransaction)
// and a plain `Client` (the integration test) satisfy it.
// =============================================================================

/**
 * Insert the viewer's owner-scoped assertion for an (unordered) pair; returns the
 * link row id. Ordered LEAST/GREATEST to satisfy the table's `source_a_id <
 * source_b_id` CHECK. Authoritative on conflict: a re-assert — including one that
 * reverses the viewer's own `user_unlinked` tombstone — always lands the slot on
 * 'user_asserted'.
 */
export async function assertIdentityLink(
  client: ClientBase,
  sourceXId: string,
  sourceYId: string,
  ownerId: string,
): Promise<string> {
  const {
    rows: [link],
  } = await client.query<{ id: string }>(
    // ::uuid so LEAST/GREATEST order by uuid (the CHECK's comparison), not text.
    `INSERT INTO external_identity_links
       (source_a_id, source_b_id, link_type, confidence, owner_id)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid),
             'user_asserted', 1.0, $3)
     ON CONFLICT (source_a_id, source_b_id, owner_id) WHERE owner_id IS NOT NULL
       DO UPDATE SET link_type = 'user_asserted', confidence = EXCLUDED.confidence
     RETURNING id`,
    [sourceXId, sourceYId, ownerId],
  );
  return link.id;
}

/**
 * Converge the viewer's view of an ALREADY-ORDERED pair (`source_a_id <
 * source_b_id` — pass the values straight off a link row, which is stored ordered)
 * to "not merged".
 *
 *   • A global link (owner NULL) merges the pair for everyone and the viewer can't
 *     delete it, so write/overwrite their owner-scoped slot with a 'user_unlinked'
 *     tombstone — this both subtracts the global on the read path AND replaces any
 *     own 'user_asserted' row that would otherwise keep the merge alive.
 *   • No global link → the only thing merging the pair is the viewer's own
 *     assertion → hard-delete it (no tombstone needed; nothing else to suppress,
 *     and a clean delete lets a later re-assert behave as a fresh link).
 */
export async function unlinkIdentityPair(
  client: ClientBase,
  sourceAId: string,
  sourceBId: string,
  ownerId: string,
): Promise<void> {
  const {
    rows: [global],
  } = await client.query(
    `SELECT 1 FROM external_identity_links
      WHERE source_a_id = $1 AND source_b_id = $2
        AND owner_id IS NULL AND link_type <> 'user_unlinked'
      LIMIT 1`,
    [sourceAId, sourceBId],
  );
  if (global) {
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES ($1, $2, 'user_unlinked', 1.0, $3)
       ON CONFLICT (source_a_id, source_b_id, owner_id) WHERE owner_id IS NOT NULL
         DO UPDATE SET link_type = 'user_unlinked', confidence = 1.0`,
      [sourceAId, sourceBId, ownerId],
    );
  } else {
    await client.query(
      `DELETE FROM external_identity_links
        WHERE source_a_id = $1 AND source_b_id = $2
          AND owner_id = $3 AND link_type = 'user_asserted'`,
      [sourceAId, sourceBId, ownerId],
    );
  }
}
