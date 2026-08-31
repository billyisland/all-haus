import type { Post } from "./types";

// =============================================================================
// Resonance marks — the shared logic behind the ONE symbol (SOCIAL-PROOF-
// RESONANCE-ADR D7).
//
// THERE IS ONE MARK, AND ITS SCOPE IS WHATEVER IT STANDS BESIDE. The triangle
// means "popping" — drew more response than expected. Beside the author's name
// it means popping for THEM; beside the platform name in the origin row it
// means popping for THAT NETWORK. Same claim, two scopes, disambiguated by
// adjacency rather than by a second symbol family — which keeps the reader's
// vocabulary at one mark instead of two, and makes the pair legible at a
// glance ("big for them, notable for Bluesky").
//
// Two independent axes, each with its own stored column:
//   author   → feed_items.resonance_band  (0-3, dialled at 2.5/4/6)
//   platform → feed_items.ambient_pctl    (0..1, 0.5 = network median, 0.9 = p90)
//
// Neither gates the other. A card can carry both marks, one, or neither — a
// post can be huge for a small account and ordinary for the network, or
// ordinary for a large account and an event for the network. That second case
// is the one the platform mark exists to surface; it was invisible while the
// band was the only thing rendered.
//
// This module is pure so the level matrix can import it without dragging a
// component in; the glyphs themselves live in PostResonance.tsx.
// =============================================================================

export type AuthorMark = "noticed" | "high";

/**
 * Author axis. Four stored bands, two rendered senses: bands 1-2 both mean
 * "above this author's usual" at different strengths and read identically on a
 * card, so they collapse. Which posts land in which band is the band dials'
 * job (resonance_band{1,2,3}_min), not this function's.
 */
export function authorMark(post: Post): AuthorMark | null {
  const band = post.resonanceBand ?? 0;
  if (band >= 3) return "high";
  if (band >= 1) return "noticed";
  return null;
}

/**
 * Platform axis, p90 — the top decile of engagement on the post's own network.
 *
 * ONE STATE, and that is a property of the data rather than a design choice.
 * PCTL_EXPR's top segment is `LEAST(1.0, 0.9 + 0.1*(e - p90)/p90)`, so it
 * SATURATES at 1.0 for anything at or above 2x p90 — and the tail past that is
 * fat: 6.8% of scored atproto rows sit at exactly 1.0 against 10.3% at >= 0.9,
 * so a two-step split would make the modest mark (3.5%) RARER than the loud one
 * (6.8%). A scale whose stronger step is commoner than its weaker one is not a
 * scale. Giving this axis a second step needs headroom above p90 in the
 * scorer (a p99 landmark, or log-scaling the tail), not a threshold here.
 *
 * No per-protocol gate is needed, unlike the author bands: a percentile is
 * per-protocol by construction, which is why this lands at 10.3% on atproto
 * and 11.1% on activitypub off one number.
 */
export const PLATFORM_P90 = 0.9;

export function platformMark(post: Post): boolean {
  const pctl = post.ambientPctl;
  // Absence is not zero: null means no band was computed for this row at all
  // (rss/email, dark nostr, unscored), which must never render as "quiet".
  if (pctl == null) return false;
  return pctl >= PLATFORM_P90;
}
