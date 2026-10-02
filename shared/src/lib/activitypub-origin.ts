// =============================================================================
// ActivityPub: an object may only be authoritative for ids on the host it was
// fetched from (MIRROR-AUDIT §2.9, S9)
//
// ActivityPub documents name themselves. Nothing in the protocol stops an
// instance we follow from serving `id: https://mastodon.social/users/X` for an
// actor, or a `Create` carrying someone else's status id — and both of those
// are writes on OUR side, not reads: the actor id becomes `external_items.
// author_uri`, from which the `feed_items_post_identity` trigger mints
// `external_authors` with `ON CONFLICT (protocol, stable_handle) DO UPDATE`,
// overwriting the victim's display name and avatar with the impostor's; the
// note id becomes `external_items.source_item_uri`, so a hostile document
// inserted first `DO NOTHING`-suppresses the genuine post for ever.
//
// Mastodon's own rule closes it: an object may only claim ids on the origin
// that served it. This is the one home for that comparison, because it is one
// rule held in two packages (feed-ingest's outbox adapter and the gateway's
// resolver) and their disagreement would be silent.
//
// Two things the shape carries.
//
// The authority is the POST-REDIRECT url — `safeFetch` follows up to 3 hops
// and returns the url it ended on — never the url we asked for. Comparing
// against the request would refuse a legitimately redirecting instance
// (`example.social/users/a` → `www.example.social/users/a`), which is a
// perfectly ordinary fediverse deployment.
//
// And it REFUSES rather than falling back. The call sites used to read
// `actor.id ?? actorUri`, which quietly substitutes the safe value — so a
// hostile document is silently accepted as if it had claimed nothing, and the
// only evidence that anything was wrong is gone.
// =============================================================================

/** The http(s) origin of a URI, or null if it is not one. */
export function httpOrigin(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin;
}

/**
 * The id a fetched document may claim, or `null` if it may not claim it.
 *
 * @param id          the `id` the document gives itself
 * @param authorityUrl the url the document actually came from — for an actor,
 *                     `safeFetch`'s post-redirect `res.url`; for a note, the
 *                     actor id whose outbox served it
 */
export function authoritativeId(
  id: unknown,
  authorityUrl: string,
): string | null {
  const idOrigin = httpOrigin(id);
  const authority = httpOrigin(authorityUrl);
  if (!idOrigin || !authority) return null;
  return idOrigin === authority ? (id as string) : null;
}
