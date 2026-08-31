// =============================================================================
// Text helpers shared by outbound adapters.
//
// Post-length limits on the platforms we federate to are counted in graphemes
// (Bluesky: 300, Mastodon: 500 by default — operator-overridable per instance),
// not code units. An emoji, CJK ideogram, or combining-mark sequence renders
// as a single grapheme but takes multiple JS string units, so naive
// `text.length` truncation over-cuts non-Latin posts and can split surrogate
// pairs, producing invalid UTF-16.
//
// countGraphemes() returns the grapheme array (null if Intl.Segmenter is
// missing — Node 18+ always has it, so the fallback is defensive only).
// truncateWithLink() keeps room for a "…\n\n<url>" tail so truncated
// federations still link back to the canonical all.haus post.
// =============================================================================

function countGraphemes(text: string): string[] | null {
  // Intl.Segmenter is runtime-available on Node 18+ but may be missing from
  // the TS lib target on older setups — cast through any to tolerate both.
  const Segmenter = (typeof Intl !== 'undefined' ? (Intl as any).Segmenter : undefined) as
    | (new (locale: string | undefined, options: { granularity: 'grapheme' }) => {
        segment: (t: string) => Iterable<{ segment: string }>
      })
    | undefined
  if (!Segmenter) return null
  const seg = new Segmenter(undefined, { granularity: 'grapheme' })
  const parts: string[] = []
  for (const s of seg.segment(text)) parts.push(s.segment)
  return parts
}

interface TruncateOptions {
  /** Maximum number of graphemes in the output. */
  max: number
  /** Appended verbatim when truncation is needed, e.g. all.haus canonical URL. */
  linkSuffix?: string
  /** Ellipsis glyph. Default "…" (one grapheme). */
  ellipsis?: string
  /** Separator between body and linkSuffix. Default "\n\n". */
  separator?: string
}

/**
 * Compose `body + tail` within a grapheme budget, guaranteeing the tail is
 * always present. If the body is short enough, both are returned unmodified;
 * otherwise the body is truncated (with an ellipsis) so the tail still fits.
 *
 * Use this when the tail carries meaning that must survive truncation — e.g.
 * a Mastodon quote URL. `truncateWithLink` drops the tail entirely when no
 * truncation is needed, which is wrong for quote semantics.
 */
export function appendWithinBudget(body: string, tail: string, maxGraphemes: number): string {
  const bodyParts = countGraphemes(body) ?? [body]
  const tailParts = countGraphemes(tail) ?? [tail]

  // If the tail alone is over budget, emit as much of it as fits. The caller
  // is expected to guard this case (shouldn't happen in practice: a status
  // URL is well under Mastodon's 500-grapheme default).
  if (tailParts.length >= maxGraphemes) {
    return tailParts.slice(0, maxGraphemes).join('')
  }

  const budget = maxGraphemes - tailParts.length
  if (bodyParts.length <= budget) return `${body}${tail}`
  // Reserve one grapheme for the ellipsis.
  return bodyParts.slice(0, Math.max(0, budget - 1)).join('') + '…' + tail
}

export function truncateWithLink(text: string, opts: TruncateOptions): string {
  if (!text) return ''
  const { max } = opts
  if (max <= 0) return ''

  const ellipsis = opts.ellipsis ?? '…'
  const separator = opts.separator ?? '\n\n'
  const parts = countGraphemes(text)

  // Fallback: no Intl.Segmenter — assume 1 code unit ≈ 1 grapheme. Callers
  // on modern Node hit this only if text is short enough that mis-counting is
  // harmless; still, prefer the Segmenter path when present.
  if (!parts) {
    if (text.length <= max) return text
    if (!opts.linkSuffix) return text.slice(0, Math.max(0, max - 1)) + ellipsis
    const tail = `${separator}${opts.linkSuffix}`
    const budget = Math.max(0, max - tail.length - 1)
    return text.slice(0, budget) + ellipsis + tail
  }

  if (parts.length <= max) return text
  if (!opts.linkSuffix) return parts.slice(0, Math.max(0, max - 1)).join('') + ellipsis

  const tail = `${separator}${opts.linkSuffix}`
  const tailParts = countGraphemes(tail) ?? [tail]
  const budget = Math.max(0, max - tailParts.length - 1) // -1 for ellipsis
  return parts.slice(0, budget).join('') + ellipsis + tail
}
