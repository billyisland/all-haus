// =============================================================================
// Which external protocols carry a PUBLIC source
//
// `external_sources` is one row per `(protocol, source_uri)`, shared by every
// subscriber to it (the S7 upsert rule). Two different questions asked of such a
// row turn out to have one underlying answer, so the list lives here once:
//
//   * May this source's identity travel to a stranger in a share link?
//     (`feeds/formulas.ts` — FEED-FORMULAS-ADR D5 as amended.)
//   * May a member who is not already a subscriber address this row by its
//     uuid — read its items at `GET /sources/:id`, or add it to a feed by
//     `externalSourceId`? (MIRROR-AUDIT §3 *Security*, S16.)
//
// Both reduce to: is the thing behind this row something anyone could go and
// read at origin? For rss / nostr_external / atproto / activitypub the answer is
// yes, and our copy of it discloses nothing the origin does not. For `email` it
// is emphatically no — an email source is one member's inbox, reached through
// `external_sources.ingest_address`, a per-subscriber secret alias. Handing that
// row to another member by uuid hands them somebody's private newsletter, and in
// the `addSource` case subscribes them to it in the author's name.
//
// It FAILS CLOSED by allow-list rather than by naming `email`, because the
// `external_protocol` enum already carries `farcaster`, `matrix` and `telegram`
// with no composer path today, and two of those three are private-channel
// shapes. A protocol added next year must not become readable-by-uuid by
// default; making it public should be a line in this file, written by somebody
// who thought about it.
//
// ONE list rather than two because the two questions have never disagreed and
// cannot: both derive from "is this source public?". If a future protocol ever
// splits them — public to read, but carrying a per-subscriber secret that must
// not travel — that is the moment to fork this into two lists, and the fork
// should say which of the two each caller wants. Until then, two spellings of
// one rule is the drift the S7 upsert and the internal-binding tuple both warn
// about.
// =============================================================================

export const PUBLIC_SOURCE_PROTOCOLS = [
  "rss",
  "nostr_external",
  "atproto",
  "activitypub",
] as const;

export type PublicSourceProtocol = (typeof PUBLIC_SOURCE_PROTOCOLS)[number];

export function isPublicSourceProtocol(
  p: string | null | undefined,
): p is PublicSourceProtocol {
  return (
    p !== null &&
    p !== undefined &&
    (PUBLIC_SOURCE_PROTOCOLS as readonly string[]).includes(p)
  );
}
