import { nip19, verifyEvent } from "nostr-tools";
import { CONTEXT_INTERACTION_MERGE_SQL } from "@platform-pub/shared/lib/context-persist.js";
import { recordServed } from "./item-membership.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { type PinnedWebSocketOptions } from "@platform-pub/shared/lib/http-client.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { relayReq } from "@platform-pub/shared/lib/nostr-relay-req.js";
import type { DetectedRepost } from "./repost-edge.js";

// =============================================================================
// Shared external-Nostr ingest machinery (EXTERNAL-AUTHOR-HISTORY-ADR §4.3).
//
// Factored out of tasks/feed-ingest-nostr.ts so the steady-state poll job and
// the subscribe-time backfill task (feed-ingest-nostr-backfill.ts) share ONE
// writer — identity encoding (C1: relay-free nevent/naddr), ratchet semantics,
// and the §4.2 context-row promotion cannot drift between them.
//
// The task files are orchestration only: load source, cursor math, relay loop,
// source bookkeeping.
// =============================================================================

// Reject events claiming timestamps more than this far in the future — prevents
// a hostile relay from poisoning the cursor into year 2100.
export const FUTURE_DRIFT_WINDOW_SECONDS = 10 * 60; // 10 minutes

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Minimal queryable so the writer/applier work under a pool OR an open
// transaction client (tests roll back; the tasks pass a withTransaction client).
export interface Queryable {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
}

// NIP-01 replaceable-event ranges. Parameterized replaceable events
// (30000-39999, including kind 30023 long-form) key on (pubkey, kind, d-tag)
// rather than event id — a new revision with the same d-tag supersedes the
// old one. Store these under naddr so republishes upsert into one row.
export function isParameterizedReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

// Relay-FREE nostr THING identity (UNIVERSAL-POST §2.1, C1 fix).
//
// feed_items.post_id is derived from external_items.source_item_uri (the 098
// trigger), and source_item_uri is also the (protocol, source_item_uri) upsert
// dedup key. Relay hints therefore MUST NOT enter this encoding: if they did,
//   (a) the same event from two relay sources would mint two different post_ids
//       (and two THING rows), defeating §5 dedup-to-one, and
//   (b) a boost — which only knows the target's id/coordinate, never the relay
//       hints the THING happened to be fetched with — could never reconstruct
//       the THING's key, so nostr boosts would never re-float or attribute.
// Relay hints survive in external_items.interaction_data for fetch/links; they
// are deliberately excluded from identity. Used by BOTH the THING path and
// detectNostrRepost so the two encodings cannot drift (the original C1 hazard).
export function nostrEventUri(id: string): string {
  return nip19.neventEncode({ id });
}
export function nostrAddrUri(
  kind: number,
  pubkey: string,
  identifier: string,
): string {
  return nip19.naddrEncode({ kind, pubkey, identifier });
}

// THE DECODING IS ONE RULE TOO, AND IT WAS SPELT TWICE. An `a` tag is
// `<kind>:<pubkey>:<d-identifier>`, and NIP-01 puts no character class on the
// d-identifier — a colon in it is ordinary and this platform's own d-tags are
// slugs that can carry one. `const [kind, pubkey, dTag] = coord.split(":")`
// therefore silently truncates the identifier at the next colon, and both
// readers of an `a` tag had their own copy of the parse: `detectNostrRepost`
// spread the rest and rejoined it, the kind-5 deletion handler did not. So a
// deletion request naming `30023:<pk>:on-writing:part-two` built the naddr for
// `on-writing`, matched no row, and the author's retraction was dropped with
// nothing logged — the article stayed live and the system reported success.
//
// One home, beside the encoder, for the same reason the encoder is one home:
// two spellings of an identity rule disagree silently, and the disagreement
// surfaces somewhere else entirely. Returns null rather than a partial coord,
// so a caller cannot act on half a parse.
export interface NostrAddrCoord {
  kind: number;
  pubkey: string;
  identifier: string;
}

export function parseNostrAddrCoord(coord: string): NostrAddrCoord | null {
  const [kindStr, pubkey, ...rest] = coord.split(":");
  const kind = parseInt(kindStr ?? "", 10);
  if (!Number.isFinite(kind) || !pubkey) return null;
  // `rest` is empty for a non-parameterized replaceable coord (`0:<pk>:` or
  // `10002:<pk>`), where the empty identifier is the correct answer.
  return { kind, pubkey, identifier: rest.join(":") };
}

// =============================================================================
// Normalise a Nostr event into external_items fields
// =============================================================================

export interface NormalisedNostrItem {
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  contentText: string;
  title: string | null;
  sourceReplyUri: string | null;
  interactionData: { id: string; pubkey: string; relays: string[] };
}

export function normaliseNostrEvent(
  event: NostrEvent,
  relayUrls: string[],
): NormalisedNostrItem {
  // Key parameterized-replaceable events (kind 30023 long-form, etc.) under
  // naddr so successive revisions of the same (pubkey, kind, d-tag) upsert
  // into one row. Everything else is keyed on event id via nevent.
  // Relay-free identity (see nostrEventUri/nostrAddrUri). post_id + the upsert
  // dedup key + reply-threading all key off these, so they must be relay-stable.
  let sourceItemUri: string;
  if (isParameterizedReplaceable(event.kind)) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    sourceItemUri = nostrAddrUri(event.kind, event.pubkey, dTag);
  } else {
    sourceItemUri = nostrEventUri(event.id);
  }

  // Extract reply target (NIP-10: last 'e' tag with 'reply' marker, or last 'e' tag)
  let sourceReplyUri: string | null = null;
  const eTags = event.tags.filter((t) => t[0] === "e");
  const replyTag =
    eTags.find((t) => t[3] === "reply") ??
    (eTags.length > 0 ? eTags[eTags.length - 1] : null);
  if (replyTag) {
    // Relay-free so a reply's parent ref matches the parent THING's source_item_uri.
    sourceReplyUri = nostrEventUri(replyTag[1]);
  }

  // For kind 30023 (long-form), extract title from tags
  let title: string | null = null;
  if (event.kind === 30023) {
    const titleTag = event.tags.find((t) => t[0] === "title");
    title = titleTag ? titleTag[1] : null;
  }

  return {
    sourceItemUri,
    authorName: null, // Populated from source display_name
    authorHandle: null,
    contentText: event.content,
    title,
    sourceReplyUri,
    interactionData: {
      id: event.id,
      pubkey: event.pubkey,
      relays: relayUrls,
    },
  };
}

// =============================================================================
// Detect a NIP-18 repost (kind 6) / generic repost (kind 16) into an edge.
//
// The boosted THING is identified by the 'e' tag (event id, for note reposts)
// or the 'a' tag ("kind:pubkey:d-tag" addressable coordinate). The booster is
// the event pubkey; the kind-6/16 event id is the boost's own origin id.
//
// targetHandle is the boosted THING's RELAY-FREE source_item_uri, produced by
// the SAME nostrEventUri/nostrAddrUri helpers the THING path uses (C1 fix). An
// addressable target (long-form, stored under naddr) is referenced by the 'a'
// tag and so takes precedence; a regular note (stored under nevent) by the 'e'
// tag. Because both sides share the encoders, the edge's target_post_id now
// equals the boosted THING's feed_items.post_id, so the boost re-floats and
// attributes its THING (and two sources boosting one event still dedup to one
// target_post_id, since the encoding carries no relay hints).
// =============================================================================
export function detectNostrRepost(event: NostrEvent): DetectedRepost | null {
  if (event.kind !== 6 && event.kind !== 16) return null;
  const aTag = event.tags.find((t) => t[0] === "a" && t[1]);
  const eTag = event.tags.find((t) => t[0] === "e" && t[1]);

  let targetHandle: string | null = null;
  if (aTag) {
    const coord = parseNostrAddrCoord(aTag[1]);
    if (coord) {
      targetHandle = nostrAddrUri(coord.kind, coord.pubkey, coord.identifier);
    }
  }
  if (!targetHandle && eTag) {
    targetHandle = nostrEventUri(eTag[1]);
  }
  if (!targetHandle) return null;

  return {
    protocol: "nostr_external",
    targetProtocol: "nostr_external",
    targetHandle,
    actorHandle: event.pubkey,
    boostedAt: new Date(event.created_at * 1000),
    originUri: event.id,
  };
}

// =============================================================================
// Per-event validation — future-drift window, pubkey match, Schnorr verify
// =============================================================================

// Validate a batch of raw relay events concurrently. A hostile relay can ship
// events claiming any pubkey; Schnorr verify is CPU-bound but running the map
// through Promise.all lets the event loop interleave other IO between verifies
// rather than pinning it for the full batch. Returns null slots for rejected
// events; `logCtx` (sourceId/relayUrl/…) is merged into rejection logs.
export async function validateNostrEvents(
  rawEvents: NostrEvent[],
  expectedPubkey: string,
  logCtx: Record<string, unknown> = {},
): Promise<(NostrEvent | null)[]> {
  const expected = expectedPubkey.toLowerCase();
  const maxCreatedAt =
    Math.floor(Date.now() / 1000) + FUTURE_DRIFT_WINDOW_SECONDS;
  return Promise.all(
    rawEvents.map(async (event) => {
      if (event.created_at > maxCreatedAt) {
        logger.warn(
          { ...logCtx, eventId: event.id, createdAt: event.created_at },
          "Rejecting Nostr event with future timestamp",
        );
        return null;
      }
      if (event.pubkey?.toLowerCase() !== expected) {
        logger.warn(
          { ...logCtx, eventId: event.id, eventPubkey: event.pubkey },
          "Rejecting Nostr event: pubkey mismatch",
        );
        return null;
      }
      if (!verifyEvent(event as any)) {
        logger.warn(
          { ...logCtx, eventId: event.id },
          "Rejecting Nostr event: invalid signature",
        );
        return null;
      }
      return event;
    }),
  );
}

// =============================================================================
// The per-event writer — external_items ratchet upsert + feed_items dual-write
// =============================================================================

export interface NostrIngestSource {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export type NostrInsertOutcome = "inserted" | "updated" | "skipped";

// Upsert one validated non-deletion, non-repost event. Runs inside the
// caller's transaction (pass a withTransaction client).
//
// Ratchet upsert: keyed on (protocol, source_item_uri). For regular kinds the
// URI is an nevent so a re-fetch of the same event has equal published_at and
// the WHERE blocks the update. For parameterized replaceable kinds (30023) the
// URI is an naddr — same for every revision — so a newer created_at wins and
// older revisions are dropped silently.
//
// §4.2 promotion: a row first persisted context-only (thread/profile
// hydration) IS updated even at equal published_at — is_context_only /
// is_profile_hydrated clear and source_id re-homes to the author's own source.
// The re-home is load-bearing, not hygiene: context rows carry the hydrating
// focal item's source_id, and kind-5 deletion application matches on
// source_id, so an un-re-homed promoted row would dodge its author's deletions
// forever. Unconditional assignment is safe: only the author's own source ever
// polls their events, so EXCLUDED.source_id differs from the stored value only
// in the promotion case.
export async function insertNostrItem(
  client: Queryable,
  source: NostrIngestSource,
  event: NostrEvent,
  opts: { relays: string[]; sourceNip05: string | null },
): Promise<NostrInsertOutcome> {
  const normalised = normaliseNostrEvent(event, opts.relays);

  // Resolve the author's name ONCE and write the SAME value to both columns
  // (MIRROR-AUDIT §3, S17; the shape insertAtprotoItem already uses). One nostr
  // source is one pubkey is one author, and the source's display_name is that
  // pubkey's own kind-0 name — ratcheted by this very task — so resolving
  // through it names the author, not the source. What was wrong was writing the
  // resolved value to external_items and the UNRESOLVED one to feed_items:
  // feed_items_author_refresh repairs feed_items from NULLIF(ei.author_name,'')
  // every night and the next re-ingest of a replaceable kind put it back, so
  // the two disagreed on a nightly cycle for ever. `?? "Unknown"` went with it
  // — migration 184 names that placeholder as the thing the column must not
  // hold; NULL is absent, and the protocol label is the FRONTEND's last resort.
  const authorName = normalised.authorName ?? source.display_name ?? null;

  const { rowCount, rows } = await client.query(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri, author_name, author_handle,
      content_text, title,
      media, published_at,
      source_reply_uri, interaction_data
    ) VALUES (
      $1, 'nostr_external', 'tier2',
      $2, $3, $4,
      $5, $6,
      '[]', to_timestamp($7),
      $8, $9
    )
    ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
      content_text = EXCLUDED.content_text,
      title = EXCLUDED.title,
      published_at = EXCLUDED.published_at,
      source_reply_uri = EXCLUDED.source_reply_uri,
      -- MERGED, newcomer last (CA-C8): a context write's relay hints and
      -- thread keys survive a promotion, and a revision's keys win.
      ${CONTEXT_INTERACTION_MERGE_SQL},
      author_name = EXCLUDED.author_name,
      author_handle = COALESCE(EXCLUDED.author_handle, external_items.author_handle),
      is_context_only = FALSE,
      is_profile_hydrated = FALSE,
      source_id = EXCLUDED.source_id,
      deleted_at = NULL
    WHERE external_items.published_at < EXCLUDED.published_at
       OR external_items.is_context_only IS TRUE
    RETURNING id, (xmax = 0) AS was_insert
  `,
    [
      source.id,
      normalised.sourceItemUri,
      authorName,
      normalised.authorHandle ?? opts.sourceNip05,
      normalised.contentText,
      normalised.title,
      event.created_at,
      normalised.sourceReplyUri,
      JSON.stringify(normalised.interactionData),
    ],
  );

  // This source served it, whether the row is new, promoted, revised or
  // already real under another source (CA-C4) — and it is seen now (CA-G10b).
  await recordServed(client, source.id, "nostr_external", [normalised.sourceItemUri]);

  if (!rowCount || rowCount === 0) return "skipped";

  // Dual-write feed_items. On insert, create the row; on a replaceable-kind
  // revision update OR a §4.2 promotion, refresh the denormalised fields so
  // the feed shows the newest title/preview without waiting for reconcile.
  // source_id rides along because kind-5 deletions and the provenance line
  // read it — a promoted post left on the hydrating focal's source would dodge
  // its author's deletions and name the wrong source. (Feed membership is the
  // item's SERVING sources, external_item_sources — CA-C4.)
  await client.query(
    `
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      published_at,
      source_protocol, source_item_uri, source_id, media,
      is_reply
    ) VALUES (
      'external', $1,
      $2, $3,
      $4, $5,
      to_timestamp($6),
      'nostr_external', $7, $8, '[]'::jsonb,
      $9
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title,
      content_preview = EXCLUDED.content_preview,
      published_at = EXCLUDED.published_at,
      source_item_uri = EXCLUDED.source_item_uri,
      source_id = EXCLUDED.source_id,
      author_name = EXCLUDED.author_name,
      is_reply = EXCLUDED.is_reply,
      deleted_at = NULL
  `,
    [
      rows[0].id,
      // The same resolved value external_items got, byte for byte (S17): a
      // nostr source is one pubkey, so the chain above names the author. The
      // display name the card shows still comes from external_authors, keyed on
      // the pubkey, not from this column.
      authorName,
      source.avatar_url,
      normalised.title,
      truncatePreview(normalised.contentText),
      event.created_at,
      normalised.sourceItemUri,
      source.id,
      normalised.sourceReplyUri != null,
    ],
  );

  return rows[0].was_insert ? "inserted" : "updated";
}

// =============================================================================
// Kind-5 deletion applier
// =============================================================================

// Apply kind 5 deletions. Pubkey + signature must already be verified by the
// caller (validateNostrEvents), so delEvent.pubkey === the source pubkey.
//
// NIP-09 supports two targeting forms:
//   • 'e' tag: event id — matches a specific nevent-keyed row via
//     interaction_data.id (source_item_uri bakes in relay_urls at insert
//     time, so URI-based matching can silently break after a relay-list
//     change).
//   • 'a' tag (replaceable events, "kind:pubkey:d_tag") — matches the
//     naddr-keyed row directly. For parameterized-replaceable items we
//     only keep the latest revision under one naddr, so 'a' is the only
//     form that reliably hits the row after a revision.
export async function applyNostrDeletions(
  db: Queryable,
  sourceId: string,
  deletions: NostrEvent[],
  expectedPubkey: string,
): Promise<void> {
  const expected = expectedPubkey.toLowerCase();
  for (const delEvent of deletions) {
    const eTagIds = delEvent.tags
      .filter((t) => t[0] === "e" && t[1])
      .map((t) => t[1]);
    const aTagAddrs = delEvent.tags
      .filter((t) => t[0] === "a" && t[1])
      .map((t) => t[1]);

    for (const deletedId of eTagIds) {
      await db.query(
        `UPDATE external_items SET deleted_at = now()
         WHERE source_id = $1 AND protocol = 'nostr_external'
           AND interaction_data->>'id' = $2
           AND deleted_at IS NULL`,
        [sourceId, deletedId],
      );
      await db.query(
        `UPDATE feed_items SET deleted_at = now()
         WHERE external_item_id IN (
           SELECT id FROM external_items
           WHERE source_id = $1 AND protocol = 'nostr_external'
             AND interaction_data->>'id' = $2
         ) AND deleted_at IS NULL`,
        [sourceId, deletedId],
      );
    }

    for (const aAddr of aTagAddrs) {
      const coord = parseNostrAddrCoord(aAddr);
      if (!coord) continue;
      const { kind, pubkey: aPubkey, identifier: dTag } = coord;
      // Only act on addresses the source actually owns — a hostile signer
      // can't forge the pubkey, but a mis-authored kind-5 could still
      // carry a foreign 'a' tag. Also gate to replaceable kinds.
      if (aPubkey.toLowerCase() !== expected) continue;
      if (
        !isParameterizedReplaceable(kind) &&
        !(kind >= 10000 && kind < 20000)
      )
        continue;

      // Relay-free, to match the THING's relay-free source_item_uri.
      const naddr = nostrAddrUri(kind, aPubkey, dTag);

      await db.query(
        `UPDATE external_items SET deleted_at = now()
         WHERE source_id = $1 AND protocol = 'nostr_external'
           AND source_item_uri = $2
           AND deleted_at IS NULL`,
        [sourceId, naddr],
      );
      await db.query(
        `UPDATE feed_items SET deleted_at = now()
         WHERE external_item_id IN (
           SELECT id FROM external_items
           WHERE source_id = $1 AND protocol = 'nostr_external'
             AND source_item_uri = $2
         ) AND deleted_at IS NULL`,
        [sourceId, naddr],
      );
    }
  }
}

// =============================================================================
// Kind-0 source metadata — nip05 + the newest-wins profile ratchet
// =============================================================================

// nip05 (NIP-05 verified handle) from the latest kind-0, if any. Persisted as
// the external_items author_handle so the feed_items identity trigger
// propagates it to external_authors.handle — that's what the card byline and
// hover bio render as the verified @handle (Nostr has no handle@host).
export function nostrNip05(profileEvent: NostrEvent | null): string | null {
  if (!profileEvent) return null;
  try {
    const p = JSON.parse(profileEvent.content);
    if (typeof p?.nip05 === "string" && p.nip05.trim()) {
      return p.nip05.trim();
    }
  } catch {
    // Malformed profile — ignore (the metadata ratchet ignores it too).
  }
  return null;
}

export interface NostrProfileUpdate {
  profileName: string | null;
  profileAvatar: string | null;
  profileCreatedAt: number | null;
  /** Author-level deletion signal (RESOLVER-DISCOVERY-ADR §8.3): the kind-0
   *  carried `deleted: true` (the community wipe convention). `true` stamps
   *  the external_authors tombstone, `false` (a newer kind-0 without the
   *  flag) clears it — the account came back. `null` = nothing newer to say. */
  profileDeleted: boolean | null;
}

// Apply a kind-0 profile update only if strictly newer than the last one we
// accepted (external_sources.metadata_updated_at). Guards against a
// cached/stale kind-0 from a misbehaving relay clobbering fresher metadata we
// already saw elsewhere. Returns nulls when there is nothing newer to apply —
// the caller's COALESCE write then leaves the stored metadata untouched.
export function nostrProfileUpdate(
  profileEvent: NostrEvent | null,
  metadataUpdatedAt: Date | null,
): NostrProfileUpdate {
  const none: NostrProfileUpdate = {
    profileName: null,
    profileAvatar: null,
    profileCreatedAt: null,
    profileDeleted: null,
  };
  if (!profileEvent) return none;
  const storedAtSec = metadataUpdatedAt
    ? Math.floor(metadataUpdatedAt.getTime() / 1000)
    : 0;
  if (profileEvent.created_at <= storedAtSec) return none;
  try {
    const profile = JSON.parse(profileEvent.content);
    const profileName =
      typeof profile?.display_name === "string"
        ? profile.display_name
        : typeof profile?.name === "string"
          ? profile.name
          : null;
    const profileAvatar =
      typeof profile?.picture === "string" ? profile.picture : null;
    return {
      profileName,
      profileAvatar,
      profileCreatedAt: profileEvent.created_at,
      profileDeleted: profile?.deleted === true,
    };
  } catch {
    return none; // Malformed profile — ignore
  }
}

// =============================================================================
// Generic single-relay REQ runner
// =============================================================================

// Open one REQ with arbitrary filters against one relay, collect EVENTs until
// EOSE or timeout (returning whatever arrived on timeout). Generalised from
// the poll job's author-hardwired fetchFromRelay: the poll passes its two
// steady-state filters verbatim, the backfill passes the `until` pager.
//
// A thin binding of the shared REQ primitive (STRUCTURAL-SIMPLIFICATION-ADR
// §9) to feed-ingest's event type and its ingest-path error contract: a socket
// error REJECTS here, unlike every read-side caller. That is deliberate — on
// an ingest poll a broken relay must reach the job, because "resolve with what
// arrived" would report a relay outage as "this author posted nothing", and
// the job would ratchet its cursor past the gap and never look again.
export function fetchNostrRelayEvents(
  relayUrl: string,
  filters: Record<string, unknown>[],
  wsOpts: PinnedWebSocketOptions,
  timeoutMs = 10_000,
): Promise<NostrEvent[]> {
  return relayReq<NostrEvent>(relayUrl, filters, {
    wsOpts,
    timeoutMs,
    subIdPrefix: "fi",
    onSocketError: "reject",
  });
}

// =============================================================================
// NIP-65 write-relay discovery
//
// Was a full second copy of the gateway's wrapper — same cap, same timeout,
// same filter, same fallback semantics, differing only in which local REQ
// runner it reached for. One home now, beside the parser it feeds
// (STRUCTURAL-SIMPLIFICATION-ADR §9).
// =============================================================================
export { fetchNostrWriteRelays } from "@platform-pub/shared/lib/nostr-relay-req.js";
