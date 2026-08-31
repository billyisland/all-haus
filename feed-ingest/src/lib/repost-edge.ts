import type { PoolClient } from "pg";

// =============================================================================
// Phase 0c — repost/boost edges (UNIVERSAL-POST-ADR §2.2/§5/§0.2).
//
// A bare repost/boost has no body, so it is NOT a Post (THING): it is an EDGE
// from a booster to the THING it re-surfaces. Per-adapter DETECTION lives in the
// adapters as pure functions (each returns a DetectedRepost | null); RECORDING
// lives here, owning the single repost_edges write.
//
// target_post_id is derived by the SQL function feed_items_derive_post_id — the
// SAME function migration 098 uses to mint feed_items.post_id — so an edge joins
// its THING by post_id and two sources boosting one THING share a target_post_id
// (the §5 cross-source dedup). One hash definition, no TS↔SQL parity hazard.
//
// Known limitation (cross-protocol-native targets): for external content the 098
// trigger keys post_id on (source_protocol, source_item_uri), so a boost of
// external content derives a matching target_post_id. A boost of NATIVE all.haus
// content (post_id minted under protocol 'nostr', not the source protocol) would
// derive a non-matching target_post_id and not join the native THING. The edge is
// still recorded correctly and dedups among boosts; binding to native targets is a
// later refinement ("mint eagerly, bind lazily", §2.1).
// =============================================================================

export type RepostProtocol = "nostr_external" | "atproto" | "activitypub";

export interface DetectedRepost {
  /** The booster's protocol (the subscription/source protocol). */
  protocol: RepostProtocol;
  /**
   * (protocol, handle) under which the boosted THING's post_id was minted by the
   * 098 trigger. For external content that is (source_protocol, source_item_uri),
   * so targetProtocol normally equals `protocol` and targetHandle is the THING's
   * source uri / addressable coordinate.
   */
  targetProtocol: string;
  targetHandle: string;
  /** The booster's stable origin handle (nostr pubkey / atproto DID / AP actor URI). */
  actorHandle: string;
  /** The boost time (drives §5 recency + re-float) — NOT the original's publish time. */
  boostedAt: Date;
  /** The boost object's own origin id where the protocol exposes it (idempotency key). */
  originUri: string | null;
}

/**
 * Record a detected boost as a repost_edge. Never creates an external_items /
 * feed_items THING. Returns true if a new edge row was inserted, false if it was
 * a no-op (idempotent re-ingest of the same boost). Runs inside the caller's
 * transaction.
 */
export async function recordRepostEdge(
  client: PoolClient,
  edge: DetectedRepost,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO repost_edges (
      protocol, target_post_id, actor_handle,
      actor_external_author_id, boosted_at, origin_uri
    )
    SELECT
      $1::external_protocol,
      feed_items_derive_post_id($2, $3),
      $4,
      (SELECT id FROM external_authors
         WHERE protocol = $1::external_protocol AND stable_handle = $4),
      $5,
      $6
    ON CONFLICT DO NOTHING
    RETURNING id
    `,
    [
      edge.protocol,
      edge.targetProtocol,
      edge.targetHandle,
      edge.actorHandle,
      edge.boostedAt,
      edge.originUri,
    ],
  );
  return result.rows.length > 0;
}
