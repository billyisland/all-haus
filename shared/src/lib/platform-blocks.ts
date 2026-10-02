// =============================================================================
// PLATFORM BLOCKS — the operator's refusal, in one spelling
//
// `platform_blocks` (migration 224) is a short table with a long reach: the
// gateway refuses to ADD a blocked source, six feed-ingest tasks refuse to
// FETCH one, the Jetstream listener drops it out of its DID set, and the
// workspace feed query refuses to RENDER a blocked npub's items. Four services'
// worth of callers asking the same question.
//
// So the question is spelled once, here, and every caller parses rather than
// remembers. Two copies of a predicate disagree silently, and this one's
// failure mode is the bad direction: a mis-spelled block reads as no block, the
// source keeps polling, and the only witness is content still arriving.
//
// TWO FORMS, BECAUSE THERE ARE TWO KINDS OF CALLER. A task with a source id in
// its hand asks `isSourceBlocked` and gets a boolean; a query that must ask per
// ROW takes the SQL fragment and interpolates it into its own statement. The
// fragment is the primitive and the function is built on it, so the one that is
// harder to test cannot drift away from the one that is easy to.
//
// A HEX PUBKEY IS THE STORED FORM, always. `external_authors.stable_handle` and
// a `nostr_external` source's `source_uri` both hold 64 lowercase hex
// characters; an npub is a bech32 rendering of the same bytes. The route
// normalises (the omnivorous-input rule: take whatever the operator has), the
// table holds hex, and nothing below this line has ever seen an npub.
//
// THIS IS NOT A SUSPENSION. Nothing here writes `accounts.status`, and a block
// on a native member's pubkey would be the wrong tool — moderation.ts suspends
// a member and tombstones their events. These are identities that are not ours.
// =============================================================================

import { pool } from "../db/client.js";
import type { PoolClient } from "pg";

export const PLATFORM_BLOCK_KINDS = ["source", "npub"] as const;
export type PlatformBlockKind = (typeof PLATFORM_BLOCK_KINDS)[number];

/** 64 lowercase hex characters — the stored form of every Nostr identity here. */
export const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

interface Queryable {
  query: typeof pool.query;
}

/**
 * "Is this external_sources row blocked?", as SQL, for a statement that already
 * has the row in scope. `alias` is the `external_sources` alias in the caller's
 * query — the predicate reads BOTH of its columns, because a block is on the
 * (protocol, source_uri) pair and matching the uri alone would block the same
 * handle on every network at once.
 */
export function sourceBlockedSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM platform_blocks pb
     WHERE pb.kind = 'source'
       AND pb.protocol = ${alias}.protocol
       AND pb.target_key = ${alias}.source_uri
  )`;
}

/**
 * "Is this pubkey blocked?", as SQL. `pubkeyExpr` is an expression yielding the
 * hex pubkey — a column, or a parameter placeholder.
 *
 * Deliberately NOT keyed on the protocol column: an npub block carries
 * 'nostr_external' (the CHECK on the table says so), and a caller comparing
 * against an `external_authors` row has no protocol column of its own to offer
 * that would mean anything different.
 */
export function npubBlockedSql(pubkeyExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM platform_blocks pb
     WHERE pb.kind = 'npub'
       AND pb.target_key = ${pubkeyExpr}
  )`;
}

/**
 * "Is this feed_items row by a blocked npub?", as SQL, for a statement that
 * has the row in scope under `alias`. Joins to the author row the item was
 * attributed to, so the question is asked of the IDENTITY however the item
 * reached us — its own source, a hydrated reply in somebody else's thread, a
 * repost — which is what migration 224's "however they reach us" promised and
 * what the feed ARM alone could not keep (§0z item 15): the thread projector
 * and the author surfaces read the same rows.
 */
export function externalAuthorBlockedSql(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM external_authors bxa
      JOIN platform_blocks pb ON pb.kind = 'npub' AND pb.target_key = bxa.stable_handle
     WHERE bxa.id = ${alias}.external_author_id
       AND bxa.protocol = 'nostr_external'
  )`;
}

/**
 * The per-task guard: does this source id name a blocked source?
 *
 * Takes the ID rather than the (protocol, uri) pair because that is what a
 * graphile-worker payload carries, and because reading the pair here is one
 * indexed lookup against an HTTP fetch the caller is about to spend. A source
 * id that names no row answers FALSE — "not blocked" is the honest answer about
 * a source that does not exist, and every caller loads the row separately and
 * has its own handling for a missing one.
 */
export async function isSourceBlocked(
  sourceId: string,
  client: Queryable | PoolClient = pool,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM external_sources es
      WHERE es.id = $1 AND ${sourceBlockedSql("es")}`,
    [sourceId],
  );
  return rows.length > 0;
}

/**
 * The same question asked BEFORE the row exists — the add path, where the
 * caller holds a protocol and a canonical uri and no source row yet (and must
 * not create one to find out).
 */
export async function isSourceUriBlocked(
  protocol: string,
  sourceUri: string,
  client: Queryable | PoolClient = pool,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM platform_blocks
      WHERE kind = 'source' AND protocol = $1::external_protocol AND target_key = $2`,
    [protocol, sourceUri],
  );
  return rows.length > 0;
}
