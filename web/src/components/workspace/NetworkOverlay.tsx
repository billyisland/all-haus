"use client";

// =============================================================================
// NetworkOverlay — the social graph (following / followers / blocked / muted /
// vouches) in a workspace Glasshouse. Mounted once in WorkspaceView; opened
// from the ForallMenu Network row, or via /reader?overlay=network[&tab=…]
// (the retired /network route — and the /followers shim before it — redirect
// here; see the deep-link dispatcher in WorkspaceView). Wraps NetworkPanel in
// the canonical frosted overlay so the ForallMenu stays crisp above it.
// =============================================================================

import { useNetworkOverlay } from "../../stores/networkOverlay";
import { Glasshouse } from "./Glasshouse";
import { NetworkPanel } from "../network/NetworkPanel";

export function NetworkOverlay() {
  const { isOpen, tab, close } = useNetworkOverlay();
  if (!isOpen) return null;

  // 780px is the feed width the network used as a page; the inner scroll fills
  // the pane minus its 64px (my-8) vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={780} ariaLabel="Network" persistKey="network">
      <div data-explain="network" className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <NetworkPanel inOverlay initialTab={tab} />
      </div>
    </Glasshouse>
  );
}
