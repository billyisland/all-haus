"use client";

// =============================================================================
// LibraryOverlay — the reader's two logs (Recent reading + the all.haus
// library) in a workspace Glasshouse. Mounted once in WorkspaceView; opened
// from the ForallMenu Library row, or via /reader?overlay=library[&tab=…] (the
// retired /library route — and the /history and /reading-history shims before
// it — redirect here; see the deep-link dispatcher in WorkspaceView).
// Wraps LibraryPanel in the canonical frosted overlay so the ForallMenu stays
// crisp above it.
// =============================================================================

import { useLibraryOverlay } from "../../stores/libraryOverlay";
import { Glasshouse } from "./Glasshouse";
import { LibraryPanel } from "../library/LibraryPanel";

export function LibraryOverlay() {
  const { isOpen, tab, close } = useLibraryOverlay();
  if (!isOpen) return null;

  // 780px is the feed/reading width the library used as a page; the inner
  // scroll fills the pane minus its 64px (my-8) vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={780} ariaLabel="Library" persistKey="library">
      <div data-explain="library" className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <LibraryPanel inOverlay initialTab={tab} />
      </div>
    </Glasshouse>
  );
}
