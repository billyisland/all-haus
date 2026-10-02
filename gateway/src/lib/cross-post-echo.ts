import { pool } from "@platform-pub/shared/db/client.js";
import { externalAuthorBlockedSql } from "@platform-pub/shared/lib/platform-blocks.js";
import { POST_SELECT, POST_JOINS, feedItemToPost, type Post } from "./post-mapper.js";
import { FEED_SELECT, FEED_JOINS } from "./feed-sql.js";
import { loadHiddenAuthorIds } from "./blocks.js";
import { decodeNostrEventId, nostrEventUri } from "./nostr-thread.js";

// =============================================================================
// THE ECHO IS THE NOTE (CROSS-NETWORK-ROUNDTRIP-ADR F2 / rung B).
//
// A member's cross-post comes back into all.haus as somebody else's post.
// Opening a thread hydrates it as a context-only external row, drawn under a
// Bluesky/Mastodon byline beside the native note it copies. Replies to it hang
// off the stranger copy, and the member meets their own words twice. The worker
// has always recorded the join (`outbound_posts.external_post_uri`, written on
// `sent`), and until rung B nothing read it.
//
// This module is the ONE home for that join. The echo row is never deleted,
// because its URI is what its children's `source_reply_uri` points at. It is
// only never DRAWN: the reader substitutes the note in its slot and re-parents
// the echo's children onto the note's post_id.
//
// THE JOIN KEY IS PER PROTOCOL, and only nostr differs:
//   · atproto      external_post_uri = the at:// URI       = source_item_uri
//   · activitypub  external_post_uri = the AP id (`uri`)   = source_item_uri
//   · nostr        external_post_uri = the HEX event id; source_item_uri is its
//                  relay-free nevent (`nostrEventUri`), so the key is decoded
//
// DISCLOSURE IS A CONSENT (B-Q1, operator 2026-09-27). Drawing the note in the
// echo's slot tells every reader which all.haus account wrote the post, which
// publicly links the member's two identities. So it is gated on the
// presence's DISPLAY consent, `network_presences.show_on_profile`, which is
// never collapsed into the posting consent that let the cross-post go out.
// With the consent off, only the member themselves sees their note in the
// slot, and everybody else sees the external post exactly as before. Nostr
// needs no consent: the echo is signed by the member's own custodial key, so
// there is no second identity to link.
// =============================================================================

/** Cross-posts that are SPEECH. A like, repost or vote has no body to echo. */
const ECHO_ACTIONS = ["reply", "quote", "original"];

export interface EchoNote {
  noteId: string; // notes uuid
  notePostId: string; // the note's feed_items.post_id
  authorId: string;
  /** Display consent on the presence (always true for nostr). */
  disclosed: boolean;
}

export interface EchoCandidate {
  protocol: string; // external_items.protocol / feed_items.source_protocol
  sourceItemUri: string;
}

export function echoKey(protocol: string, sourceItemUri: string): string {
  return `${protocol}\u0000${sourceItemUri}`;
}

// The outbound side's spelling of an external row's identity, or null where
// it cannot be one (a nostr uri that does not decode to an event id).
function outboundUriFor(c: EchoCandidate): string | null {
  if (c.protocol === "nostr_external") return decodeNostrEventId(c.sourceItemUri);
  return c.sourceItemUri;
}

// The inverse: an outbound row's `external_post_uri` as the external row
// would store it.
function sourceItemUriFor(protocol: string, externalPostUri: string): string {
  return protocol === "nostr_external"
    ? nostrEventUri(externalPostUri)
    : externalPostUri;
}

// Does this viewer see the note in the echo's slot?
export function substitutes(echo: EchoNote, viewerId: string | null): boolean {
  return echo.disclosed || (viewerId !== null && echo.authorId === viewerId);
}

const DISCLOSED_SQL = `(op.protocol = 'nostr_external' OR COALESCE(np.show_on_profile, false))`;

// Which of these external rows are echoes of a member's note? Keyed by
// `echoKey`. A note that is gone (tombstoned card) is no longer anybody's
// echo, and the external post is drawn as what it is.
export async function loadEchoNotes(
  candidates: readonly EchoCandidate[],
): Promise<Map<string, EchoNote>> {
  const protocols: string[] = [];
  const uris: string[] = [];
  const keyOf = new Map<string, string>();
  for (const c of candidates) {
    const uri = outboundUriFor(c);
    if (!uri) continue;
    const k = echoKey(c.protocol, uri);
    if (keyOf.has(k)) continue;
    keyOf.set(k, echoKey(c.protocol, c.sourceItemUri));
    protocols.push(c.protocol);
    uris.push(uri);
  }
  const out = new Map<string, EchoNote>();
  if (uris.length === 0) return out;

  const { rows } = await pool.query<{
    protocol: string;
    external_post_uri: string;
    note_id: string;
    note_post_id: string;
    author_id: string;
    disclosed: boolean;
  }>(
    `SELECT op.protocol::text AS protocol, op.external_post_uri,
            n.id AS note_id, fi.post_id AS note_post_id, n.author_id,
            ${DISCLOSED_SQL} AS disclosed
       FROM unnest($1::text[], $2::text[]) AS k(protocol, uri)
       JOIN outbound_posts op
         ON op.external_post_uri = k.uri AND op.protocol::text = k.protocol
       JOIN notes n
         ON n.nostr_event_id = op.nostr_event_id AND n.author_id = op.account_id
       JOIN feed_items fi
         ON fi.note_id = n.id AND fi.item_type = 'note' AND fi.deleted_at IS NULL
       LEFT JOIN network_presences np ON np.id = op.linked_account_id
      WHERE op.status = 'sent' AND op.action_type = ANY($3::text[])`,
    [protocols, uris, ECHO_ACTIONS],
  );
  for (const r of rows) {
    const k = keyOf.get(echoKey(r.protocol, r.external_post_uri));
    if (!k || out.has(k)) continue;
    out.set(k, {
      noteId: r.note_id,
      notePostId: r.note_post_id,
      authorId: r.author_id,
      disclosed: r.disclosed,
    });
  }
  return out;
}

// The other direction: where did this note's cross-posts land? One per
// network it was sent to, as the external row would name them.
export async function loadNoteEchoUris(
  noteEventId: string,
  authorId: string,
): Promise<Array<EchoCandidate & { disclosed: boolean }>> {
  const { rows } = await pool.query<{
    protocol: string;
    external_post_uri: string;
    disclosed: boolean;
  }>(
    `SELECT op.protocol::text AS protocol, op.external_post_uri,
            ${DISCLOSED_SQL} AS disclosed
       FROM outbound_posts op
       LEFT JOIN network_presences np ON np.id = op.linked_account_id
      WHERE op.account_id = $1 AND op.nostr_event_id = $2
        AND op.status = 'sent' AND op.action_type = ANY($3::text[])
        AND op.external_post_uri IS NOT NULL
      ORDER BY op.sent_at, op.id`,
    [authorId, noteEventId, ECHO_ACTIONS],
  );
  return rows.map((r) => ({
    protocol: r.protocol,
    sourceItemUri: sourceItemUriFor(r.protocol, r.external_post_uri),
    disclosed: r.disclosed,
  }));
}

// A post's parent and quote pointers, moved off every echo onto its note.
export function reparentOntoNotes(
  posts: Post[],
  noteByEchoPostId: ReadonlyMap<string, string>,
): Post[] {
  if (noteByEchoPostId.size === 0) return posts;
  return posts.map((p) => {
    const inReplyTo = p.inReplyTo ? noteByEchoPostId.get(p.inReplyTo) : undefined;
    const quotes = p.quotes ? noteByEchoPostId.get(p.quotes) : undefined;
    if (!inReplyTo && !quotes) return p;
    return {
      ...p,
      inReplyTo: inReplyTo ?? p.inReplyTo,
      quotes: quotes ?? p.quotes,
    };
  });
}

// =============================================================================
// THE FEED ARM (B3). A member who follows their own Bluesky account met every
// cross-post twice, and anybody following both of a consenting member's
// accounts did too. The same substitution as the thread: the echo's card is
// the note's card, and where the note is already on the page the echo goes.
//
// A viewer's block follows the note wherever it is DRAWN (the arms already
// hide a blocked member's native rows), and never an echo drawn as itself —
// hiding that would tell the blocker whose account it is.
//
// It runs AFTER the cut, one card for one card, so a source's volume setting
// is still decided over what the source delivered. The reading-count window
// gets the same answer through `drawWindowEchoesAsNotes`, or the id the reader
// passes (the note's) would never clear the id the window counted (the echo's).
// =============================================================================

type EchoSlot = { kind: "note"; notePostId: string } | { kind: "hidden" };

async function echoSlots(
  viewerId: string,
  candidates: EchoCandidate[],
): Promise<Map<string, EchoSlot>> {
  const slots = new Map<string, EchoSlot>();
  if (candidates.length === 0) return slots;
  const echoes = await loadEchoNotes(candidates);
  if (echoes.size === 0) return slots;
  const hidden = await loadHiddenAuthorIds(viewerId);
  for (const [k, e] of echoes) {
    if (!substitutes(e, viewerId)) continue;
    slots.set(k, hidden.has(e.authorId) ? { kind: "hidden" } : { kind: "note", notePostId: e.notePostId });
  }
  return slots;
}

async function loadNotePosts(postIds: string[]): Promise<Map<string, Post>> {
  if (postIds.length === 0) return new Map();
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.post_id = ANY($1::text[])
        AND fi.item_type = 'note' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}`,
    [postIds],
  );
  return new Map(
    rows.map((r) => {
      const post = feedItemToPost(r);
      return [post.id, post];
    }),
  );
}

function feedCandidate(p: Post): EchoCandidate | null {
  return p.externalItemId && p.origin.uri
    ? { protocol: p.origin.protocol, sourceItemUri: p.origin.uri }
    : null;
}

export async function drawEchoesAsNotes(viewerId: string, items: Post[]): Promise<Post[]> {
  const candidates = items.map(feedCandidate).filter((c): c is EchoCandidate => c !== null);
  const slots = await echoSlots(viewerId, candidates);
  if (slots.size === 0) return items;
  const notes = await loadNotePosts(
    [...slots.values()].flatMap((s) => (s.kind === "note" ? [s.notePostId] : [])),
  );
  const present = new Set(items.map((p) => p.id));
  const out: Post[] = [];
  for (const p of items) {
    const c = feedCandidate(p);
    const slot = c ? slots.get(echoKey(c.protocol, c.sourceItemUri)) : undefined;
    if (!slot) {
      out.push(p);
    } else if (slot.kind === "note") {
      const note = notes.get(slot.notePostId);
      if (!note) out.push(p); // the note went between the two reads
      else if (!present.has(note.id)) {
        present.add(note.id);
        out.push(note);
      }
    }
  }
  return out;
}

export interface WindowEntry {
  id: string;
  publishedAt: number;
  isNew: boolean;
  protocol: string | null;
  sourceItemUri: string | null;
}

export async function drawWindowEchoesAsNotes(
  viewerId: string,
  entries: WindowEntry[],
): Promise<{ id: string; publishedAt: number; isNew: boolean }[]> {
  const bare = (e: WindowEntry) => ({ id: e.id, publishedAt: e.publishedAt, isNew: e.isNew });
  const candidate = (e: WindowEntry): EchoCandidate | null =>
    e.protocol && e.sourceItemUri ? { protocol: e.protocol, sourceItemUri: e.sourceItemUri } : null;
  const slots = await echoSlots(
    viewerId,
    entries.map(candidate).filter((c): c is EchoCandidate => c !== null),
  );
  if (slots.size === 0) return entries.map(bare);
  const notes = await loadNotePosts(
    [...slots.values()].flatMap((s) => (s.kind === "note" ? [s.notePostId] : [])),
  );
  const present = new Set(entries.map((e) => e.id));
  const out: { id: string; publishedAt: number; isNew: boolean }[] = [];
  for (const e of entries) {
    const c = candidate(e);
    const slot = c ? slots.get(echoKey(c.protocol, c.sourceItemUri)) : undefined;
    if (!slot) {
      out.push(bare(e));
    } else if (slot.kind === "note") {
      const note = notes.get(slot.notePostId);
      if (!note) out.push(bare(e));
      else if (!present.has(note.id)) {
        present.add(note.id);
        out.push({ id: note.id, publishedAt: note.publishedAt, isNew: e.isNew });
      }
    }
  }
  return out;
}
