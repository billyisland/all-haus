import type { Post } from "./types";

// =============================================================================
// quotePreviewContent — the text snapshot stored on a quote.
//
// Quoting a post writes a small frozen copy of what was quoted (notes.quoted_*),
// so the inset can be drawn without re-fetching the original. That snapshot is
// what the reader eventually sees IN FULL: `.claude/rules/web-cards-and-threads.md`
// › "Expansion is transitive" makes an expanded card show its inset whole, so
// whatever we cut here is text nobody can ever reach from the quoting note —
// the truncation is permanent in a way a render-time clamp is not.
//
// So the cut follows the post's own kind rather than one flat character budget:
//
//   note    → the WHOLE body. A native note is capped at 1000 chars by the
//             gateway (NOTE_CHAR_LIMIT), so "whole" is already bounded, and an
//             expanded inset showing all of it is the point.
//   article → the standfirst (`summary`), which is exactly what an expanded card
//             renders for an article — its body belongs in the reader, not in a
//             quote tile. Falling back to `text` means an article with no
//             standfirst still says something, and that fallback is why the cap
//             below exists at all.
//
// This replaced six call sites that each cut their own way (120 chars on the
// profile/tag/source surfaces, 200 in the workspace); a snapshot's size is a
// property of what is being quoted, not of the surface the Quote button sat on.
// =============================================================================

// A native note's own ceiling (gateway/src/routes/notes.ts::NOTE_CHAR_LIMIT), so
// a whole note is never cut. It binds only the article-without-a-standfirst and
// long-external-item fallbacks.
export const QUOTE_SNAPSHOT_CHARS = 1000;

// The one cut. The gateway clamps to the same figure (notes.ts) — a bound on a
// rendered, client-supplied column belongs on the server too — so this is the
// friendly copy, not the enforcement.
export function quoteSnapshot(text: string | undefined | null): string | undefined {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  return t.length > QUOTE_SNAPSHOT_CHARS ? t.slice(0, QUOTE_SNAPSHOT_CHARS) : t;
}

export function quotePreviewContent(post: Post): string | undefined {
  return quoteSnapshot(
    post.type === "article"
      ? (post.body.summary ?? post.body.text)
      : (post.body.text ?? post.body.summary),
  );
}
