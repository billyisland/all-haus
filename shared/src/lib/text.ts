// =============================================================================
// Text helpers shared between services.
//
// Primary job right now: truncatePreview. The denormalised
// feed_items.content_preview is written from several paths (article publish,
// note publish, every ingest adapter, the feed_items_reconcile safety net).
// JS `.slice(0, 200)` counts UTF-16 code units while Postgres `LEFT(..., 200)`
// counts characters; the two disagree on astral-plane code points (emoji,
// most non-BMP CJK). Using a shared code-point-aware helper across JS call
// sites keeps ingest and reconcile writing the same bytes, so the daily
// reconcile drift pass doesn't bounce the same rows back and forth.
// =============================================================================

export const PREVIEW_LIMIT = 200;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function truncatePreview(
  text: string | null | undefined,
  max = PREVIEW_LIMIT,
): string {
  if (!text) return "";
  // Array.from splits surrogate pairs into code points, so `.length` here
  // matches pg's LEFT(..., max) on UTF-8 columns for the characters we
  // actually get in user content (pg `LEFT` returns the first `max`
  // characters, and for UTF-8 one character is one code point).
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join("");
}
