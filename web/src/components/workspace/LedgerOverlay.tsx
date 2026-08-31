"use client";

// =============================================================================
// LedgerOverlay — the reading-tab / earnings ledger in a workspace Glasshouse.
// Mounted once in WorkspaceView; opened from the ForallMenu Ledger row, or via
// /reader?overlay=ledger (the retired /ledger route — and the /account shim —
// redirect here; see the deep-link dispatcher in WorkspaceView). Wraps
// LedgerPanel in the canonical frosted overlay so the ForallMenu stays crisp
// above it.
// =============================================================================

import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { Glasshouse } from "./Glasshouse";
import { LedgerPanel } from "../account/LedgerPanel";

export function LedgerOverlay() {
  const { isOpen, close } = useLedgerOverlay();
  if (!isOpen) return null;

  // 1040px gives the transaction ledger's rows room beyond the 960px content
  // width the ledger used as a page. The inner scroll fills the pane minus its
  // 64px (my-8) vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={1040} ariaLabel="Ledger" persistKey="ledger">
      <div data-explain="ledger" className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <LedgerPanel inOverlay />
      </div>
    </Glasshouse>
  );
}
