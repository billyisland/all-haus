"use client";

import React from "react";
import type { VesselPalette } from "../workspace/tokens";
import type { Post } from "../../lib/post/types";
import { authorMark, type AuthorMark } from "../../lib/post/resonance";

// =============================================================================
// The resonance mark (SOCIAL-PROOF-RESONANCE-ADR D7).
//
// ONE SYMBOL, TWO SCOPES. The triangle means "popping" — this drew more
// response than expected. What it is popping RELATIVE TO is set by what it
// stands beside, not by a second symbol: next to the author's name in the
// byline it means popping for THEM, next to the network name in the origin row
// it means popping for THAT NETWORK. So a card reading
//
//     ● BBC · 2h ▲
//       VIA BLUESKY ▴ · @bbc
//
// says "big for the BBC, and notable for Bluesky" with one mark to learn
// instead of two. The size step is degree, in both scopes.
//
// Aggression rides the palette's own text ramp — muted `cardMeta` for the
// modest state, full-strength `cardTitle` for the loud one — never crimson,
// which means PAID on a card (the left bar) and would make a popular post look
// like a charged one.
//
// It replaced · / ·· / ···, which was recessive AND sat in a cluster whose
// first element is also a dot (the parked TrustPip), so the two read as one run
// of punctuation. A filled triangle points, which is the actual claim.
//
// What it is NOT: a quality mark, a like count, or anything money touches (D8).
//
// The two axes are independent and neither gates the other; the thresholds and
// the reasons the platform scope has only one step live in lib/post/resonance.ts.
// Absence vs zero is load-bearing throughout — a null band or pctl means NOTHING
// WAS COMPUTED (rss/email, dark nostr, unscored rows), never "quiet".
// =============================================================================

const GLYPH: Record<AuthorMark, string> = {
  noticed: "▴",
  high: "▲",
};

// Shared presentation so the two scopes cannot drift apart visually — they are
// the same mark, and a size or colour that applied to only one of them would
// quietly turn them back into two symbols.
function markStyle(
  palette: VesselPalette,
  level: AuthorMark,
): React.CSSProperties {
  return {
    color: level === "high" ? palette.cardTitle : palette.cardMeta,
    // A hair of optical size keeps a small glyph from disappearing between
    // the middle dots of a caps row.
    fontSize: "1.08em",
    lineHeight: 1,
  };
}

const MARK_CLASS = "cursor-default select-none";

// The label names the CORPUS the mark was measured against, and that axis is
// protocol alone: native rows are protocol "nostr" (external nostr is always
// "nostr_external"), scored against all.haus's own corpus — including a native
// row with a NULL custodial pubkey, which the old pubkey-first check let fall
// through to the open-Nostr gloss (§0i.9; isNativePost's pubkey conjunct is
// about byline routing, not baseline membership).
export function networkLabel(post: Post): string {
  switch (post.origin.protocol) {
    case "nostr":
      return "all.haus";
    case "atproto":
      return "Bluesky";
    case "activitypub":
      return "the Fediverse";
    case "nostr_external":
      return "Nostr";
    default:
      return "this network";
  }
}

// The byline shows the author by display name where there is one; the gloss
// names the same person the reader is looking at, so it follows the same
// preference and falls back to the handle, then to a neutral phrase — never to
// an empty string, which would read as "High engagement for ."
function authorLabel(post: Post): string {
  const name = post.author.displayName?.trim();
  if (name) return name;
  const handle = post.author.handle?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return "this author";
}

const AUTHOR_CLAUSE: Record<AuthorMark, string> = {
  noticed: "Good engagement for",
  high: "High engagement for",
};

/**
 * Author scope — the byline mark. Mounted only when resolveSpec says so, so it
 * assumes nothing about level; it still returns null defensively on no mark.
 */
export function PostResonance({
  post,
  palette,
}: {
  post: Post;
  palette: VesselPalette;
}) {
  const level = authorMark(post);
  if (!level) return null;

  // One scope, one clause. The platform half used to be welded on here as a
  // second clause off a band that never measured it; it now has its own mark
  // beside the thing it is about.
  const gloss = `${AUTHOR_CLAUSE[level]} ${authorLabel(post)}.`;

  return (
    <span
      // The mark is meaningful, not decoration, so it carries the gloss to
      // assistive tech rather than being aria-hidden like the (parked) pip.
      // `title` is the hover tooltip; both read the same sentence.
      title={gloss}
      aria-label={gloss}
      role="img"
      data-explain="card.resonance"
      style={markStyle(palette, level)}
      className={MARK_CLASS}
    >
      {GLYPH[level]}
    </span>
  );
}

/**
 * Platform scope — the origin-row mark, beside the network name that gives it
 * its scope. One step only (see lib/post/resonance.ts for why the stored
 * percentile cannot support a second), so it always renders the modest glyph.
 */
export function PlatformResonance({
  post,
  palette,
}: {
  post: Post;
  palette: VesselPalette;
}) {
  const gloss = `In the top 10% of engagement for ${networkLabel(post)}.`;
  return (
    <span
      title={gloss}
      aria-label={gloss}
      role="img"
      data-explain="card.resonance"
      style={markStyle(palette, "noticed")}
      className={MARK_CLASS}
    >
      {GLYPH.noticed}
    </span>
  );
}
