// Pure (dependency-free) helpers for reconstructing a Nostr conversation from
// raw relay events, used by the Nostr branch of hydrateExternalThreadContext
// (external-items.ts). Kept out of that route module so the load-bearing bits —
// the relay-free identity encoding and the NIP-10 tag walk — can be unit-tested
// in isolation without the DB / WebSocket import chain.
import { nip19 } from "nostr-tools";

// The fields we read off a raw relay EVENT payload.
export interface RawNostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

// A hydrated context node, structurally identical to external-items.ts's
// HydratedNode (persistHydratedThreadNodes consumes it).
export interface NostrThreadNode {
  sourceItemUri: string;
  sourceReplyUri: string | null;
  sourceQuoteUri: string | null;
  authorName: string;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  media: unknown[];
  interactionData: Record<string, unknown>;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  publishedAt: Date;
}

export interface NostrProfile {
  name: string | null;
  picture: string | null;
  nip05: string | null;
  // Richer kind-0 fields surfaced in the hover bio modal (thread nodes ignore
  // them). `about` is the free-text bio; `website` the self-declared homepage;
  // `lud16` the lightning address (the zap target).
  about: string | null;
  website: string | null;
  lud16: string | null;
}

// NIP-01 parameterized-replaceable range (kind 30023 long-form lives here): keyed
// on (pubkey, kind, d-tag) under an naddr, not on event id.
export function isParameterizedReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

// Relay-FREE nostr identity — MUST match feed-ingest-nostr.ts exactly, or a
// hydrated node mints a different post_id than the ingested one and the thread
// fails to connect (UNIVERSAL-POST §2.1, C1). Relay hints never enter the id.
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

// Decode whatever we stored (a bare hex id or a relay-free nevent/note) back to
// the 64-char hex event id a NIP-01 `ids` filter expects.
export function decodeNostrEventId(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "nevent") return decoded.data.id;
    if (decoded.type === "note") return decoded.data;
  } catch {
    // not a nip-19 string — fall through
  }
  return null;
}

// NIP-10: the thread root is the `e` tag marked "root", else the first `e` tag
// (positional convention), else the event is itself a root.
export function nostrRootId(event: RawNostrEvent): string {
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  const rootTag = eTags.find((t) => t[3] === "root") ?? eTags[0];
  return rootTag?.[1] ?? event.id;
}

// NIP-10: the event's immediate reply parent — the `e` tag marked "reply", else
// the last `e` tag (positional convention), else null (a root). Returns the raw
// hex id (not an nevent) so it can drive an `ids` filter for the ancestor walk.
// This is the SAME selection `normaliseNostrThreadNode` encodes into
// `sourceReplyUri`, so the walked chain and the stored linkage agree.
export function nostrReplyTargetId(event: RawNostrEvent): string | null {
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  const replyTag =
    eTags.find((t) => t[3] === "reply") ??
    (eTags.length > 0 ? eTags[eTags.length - 1] : null);
  return replyTag ? replyTag[1] : null;
}

// Parse a kind-0 profile into the display fields a byline + hover bio render.
export function parseNostrProfile(content: string): NostrProfile {
  try {
    const p = JSON.parse(content) as Record<string, unknown>;
    const name =
      (typeof p.display_name === "string" && p.display_name.trim()) ||
      (typeof p.name === "string" && p.name.trim()) ||
      null;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    return {
      name: name || null,
      picture: typeof p.picture === "string" ? p.picture : null,
      nip05: typeof p.nip05 === "string" ? p.nip05 : null,
      about: str(p.about),
      website: str(p.website),
      lud16: str(p.lud16),
    };
  } catch {
    return {
      name: null,
      picture: null,
      nip05: null,
      about: null,
      website: null,
      lud16: null,
    };
  }
}

// Normalise a raw relay event into a hydrated context node, using the SAME
// relay-free encoding the ingest path uses so a reply's source_reply_uri equals
// its parent's source_item_uri (assembleExternalThread's DB walk connects them).
export function normaliseNostrThreadNode(
  event: RawNostrEvent,
  relays: string[],
  profile: NostrProfile,
): NostrThreadNode {
  let sourceItemUri: string;
  if (isParameterizedReplaceable(event.kind)) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    sourceItemUri = nostrAddrUri(event.kind, event.pubkey, dTag);
  } else {
    sourceItemUri = nostrEventUri(event.id);
  }

  // NIP-10 reply target: explicit "reply" marker, else the last `e` tag.
  const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
  const replyTag =
    eTags.find((t) => t[3] === "reply") ??
    (eTags.length > 0 ? eTags[eTags.length - 1] : null);
  const sourceReplyUri = replyTag ? nostrEventUri(replyTag[1]) : null;

  let title: string | null = null;
  if (event.kind === 30023) {
    title = event.tags.find((t) => t[0] === "title")?.[1] ?? null;
  }

  const npub = nip19.npubEncode(event.pubkey);
  return {
    sourceItemUri,
    sourceReplyUri,
    // Nostr quote (NIP-18 `q`) linkage isn't reconstructed here — quotes are
    // resolved on demand by the quote endpoint, as on the fediverse path.
    sourceQuoteUri: null,
    authorName: profile.name ?? title ?? `${npub.slice(0, 12)}…`,
    authorHandle: profile.nip05 ?? npub,
    authorAvatarUrl: profile.picture,
    authorUri: `https://njump.me/${npub}`,
    contentText: event.content,
    contentHtml: null,
    media: [],
    interactionData: { id: event.id, pubkey: event.pubkey, relays },
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    publishedAt: new Date(event.created_at * 1000),
  };
}
