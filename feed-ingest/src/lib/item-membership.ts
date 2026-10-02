// =============================================================================
// Item ↔ source membership (CA-C4, migration 269)
//
// `external_items` is one row per (protocol, source_item_uri) and its
// `source_id` names the FIRST source that wrote it. Every other source serving
// the same item hits the unique key and writes nothing — so, before this table,
// the item never reached a feed built on the second source. The feed arm now
// joins through `external_item_sources`; this is the one home that says "this
// source served these items", and it stamps `last_seen_at`, which the prune
// keys on (CA-G10b, moved here so it is exact per source for a shared item).
//
// The HOME membership is also written by the `external_items_home_membership`
// trigger, so a writer that forgets loses nothing it had before; what only a
// writer can record is serving an item some OTHER source already holds, and
// the re-stamp. Call it after the upsert, on every outcome — inserted,
// promoted, revised or refused as already real.
//
// A context-only row is never a member: nothing served it. After every real
// ingest upsert the row is real (each writer's conflict arm promotes a context
// row), so the guard only bites if that ever stops being true.
// =============================================================================

export const RECORD_SERVED_SQL = `
  INSERT INTO external_item_sources (external_item_id, source_id)
  SELECT ei.id, $1
    FROM external_items ei
   WHERE ei.protocol = $2
     AND ei.source_item_uri = ANY($3::text[])
     AND ei.is_context_only IS NOT TRUE
  ON CONFLICT (source_id, external_item_id) DO UPDATE SET last_seen_at = now()
  RETURNING (xmax = 0) AS fresh
`;

/**
 * Records that `sourceId` served the items named by `uris` (in `protocol`'s
 * id-space) and stamps them seen now. Returns how many of them are NEW to this
 * source — the RSS poll's "did anything arrive" signal, which a shared item
 * must count toward even though the external_items insert refused it.
 */
export async function recordServed(
  client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  },
  sourceId: string,
  protocol: string,
  uris: string[],
): Promise<number> {
  if (uris.length === 0) return 0;
  const { rows } = await client.query(RECORD_SERVED_SQL, [sourceId, protocol, uris]);
  return rows.filter((r: { fresh: boolean }) => r.fresh).length;
}
