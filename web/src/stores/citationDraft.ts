import { create } from 'zustand'

// A pending citation anchored to a span the author selected in the article body.
// The selection affordance (QuoteSelector, author-only "Cite") sets it; the
// piece-foot CitationComposer (UpstreamEdges) consumes it — opening prefilled
// with the excerpt and carrying the char offsets through to POST /citations, so
// the citation lands anchored and a marker appears in-prose. A manual "+ Add
// citation" (no selection) leaves the draft null and lands unanchored.
export interface CitationDraft {
  excerpt: string
  charStart: number
  charEnd: number
}

interface CitationDraftState {
  draft: CitationDraft | null
  setDraft: (draft: CitationDraft) => void
  clear: () => void
}

export const useCitationDraft = create<CitationDraftState>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
  clear: () => set({ draft: null }),
}))
