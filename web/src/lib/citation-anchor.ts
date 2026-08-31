// =============================================================================
// Citation anchoring — plain-text offsets into the rendered article body.
//
// A citation may pin itself to a span of the citing piece (char_start/char_end).
// The anchor basis is the concatenation of every text-node's data within the
// rendered prose body, in document order — the same measure whether we are
// *capturing* an offset from the author's selection (a DOM Range) or *placing*
// the in-prose marker at read time (walking to that offset). Because both sides
// use one basis, an offset the author records lands on the same text for every
// reader of the (stable, deterministically-rendered) free body.
//
// Scope: the free body only (the QuoteSelector / marker host). Paid-span anchors
// are out of scope for v1 (UPSTREAM-EDGES-ADR, the paid-span hole).
// =============================================================================

const MARKER_CLASS = 'citation-marker'

// Plain-text offset of a DOM boundary (container, offset) within `root`. Equal
// to the length of the text that a copy of [root-start … boundary] would yield.
export function offsetOfBoundary(root: Node, container: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(container, offset)
  return range.toString().length
}

// Capture a selection Range as a {start, end} offset pair within `root`, or null
// when the range falls outside it. Normalised so start <= end.
export function rangeToOffsets(root: Node, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const a = offsetOfBoundary(root, range.startContainer, range.startOffset)
  const b = offsetOfBoundary(root, range.endContainer, range.endOffset)
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

// Locate the text node + local offset that holds global plain-text offset
// `charOffset` within `root`. Markers themselves are excluded so re-runs stay
// stable. Returns null when the offset is past the end (e.g. it lands in a
// not-yet-rendered paid span).
function findTextPosition(root: Node, charOffset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement?.closest('.' + MARKER_CLASS))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  let acc = 0
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.length
    if (charOffset <= acc + len) return { node, offset: charOffset - acc }
    acc += len
  }
  return null
}

// Insert `el` at global plain-text offset `charOffset` within `root`, splitting
// the host text node. Returns false when the offset is unreachable (marker is
// then simply not drawn; the foot apparatus still lists the citation).
//
// Callers inserting several markers must do so in DESCENDING offset order so an
// earlier insertion never shifts the basis of a later one.
export function insertMarkerAt(root: Node, charOffset: number, el: HTMLElement): boolean {
  const pos = findTextPosition(root, charOffset)
  if (!pos) return false
  const tail = pos.node.splitText(pos.offset)
  tail.parentNode?.insertBefore(el, tail)
  return true
}

// Remove every injected marker and merge the split text nodes back, returning
// `root` to a clean basis before a re-injection.
export function clearMarkers(root: HTMLElement): void {
  root.querySelectorAll('.' + MARKER_CLASS).forEach((el) => el.remove())
  root.normalize()
}

// The plain-text basis substring [start, end) within `root`, over the SAME
// text-node concatenation that findTextPosition/insertMarkerAt walk (markers
// excluded). Returns null when the span runs past the body's end (unreachable).
function textBetween(root: Node, start: number, end: number): string | null {
  if (end < start) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.' + MARKER_CLASS)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  let acc = 0
  let out = ''
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.length
    if (acc + len > start && acc < end) {
      out += node.data.slice(Math.max(0, start - acc), Math.min(len, end - acc))
    }
    acc += len
    if (acc >= end) return out
  }
  return acc >= end ? out : null
}

// Integrity check before drawing an anchored marker: does the live body text at
// [start, end) still equal the stored excerpt? The offsets span the full
// selection while the stored excerpt is its trimmed form (QuoteSelector trims;
// the composer only sends offsets when the excerpt is unchanged from that span —
// UpstreamEdges CitationComposer), so the basis substring is compared trimmed.
// Native articles are NIP-23 replaceable/editable, so a republish can shift the
// offsets — without this the "[N]" marker would silently land on unrelated prose,
// corrupting the faithfulness the citation exists to assert. A mismatch (or an
// unreachable span) ⇒ skip the marker; the foot apparatus still lists the citation.
export function excerptMatchesAt(root: Node, start: number, end: number, excerpt: string): boolean {
  const text = textBetween(root, start, end)
  return text != null && text.trim() === excerpt
}

export { MARKER_CLASS }
