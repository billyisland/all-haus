
// =============================================================================
// WHERE THE PAYWALL GATE FALLS — one home.
//
// The editor stores a paywalled article as ONE markdown string carrying
// `PAYWALL_GATE_MARKER`, and publish splits it there: everything above the
// marker is the free run indexed on the relay, everything below is the body
// sealed into the vault. That split was a private function inside
// `ArticleEditor`, which was fine while publish was its only caller.
//
// The draft preview is the second caller, and it is the one that makes this a
// SHARED rule rather than an implementation detail: a preview that splits
// differently from the publish path shows the writer a gate in a place their
// readers will not find it, which is worse than no preview at all — the whole
// point of the feature is fidelity, and a drift here is invisible until the
// piece is live.
//
// The marker string is declared HERE, not in the node that mints it
// (`PaywallGateNode`, which re-exports it): the plain-HTML register splits and
// validates a draft in a server route handler, and importing the marker from
// the node would load the TipTap editor to read one string. The node is still
// the other end of the pair — its renderer and parse rules write and read it.
// =============================================================================

/** The line in a draft's markdown where the free part ends and the paid part begins. */
export const PAYWALL_GATE_MARKER = "<!-- paywall-gate -->";

/**
 * Split a draft's markdown at the paywall gate.
 *
 * With no marker the whole string is `free` and `paywall` is empty, which is
 * exactly right for an unpaywalled piece — the caller does not have to ask
 * first.
 */
export function splitAtGateMarker(markdown: string): { free: string; paywall: string } {
  const markerIndex = markdown.indexOf(PAYWALL_GATE_MARKER);
  if (markerIndex === -1) {
    return { free: markdown, paywall: "" };
  }

  const free = markdown.slice(0, markerIndex).trim();
  const paywall = markdown.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim();

  return { free, paywall };
}

/** True when a draft's markdown carries a gate — i.e. it publishes paywalled. */
export function hasGateMarker(markdown: string): boolean {
  return markdown.includes(PAYWALL_GATE_MARKER);
}

/**
 * Where the gate falls, as a percentage of the text — the figure the article
 * row and the key service store. 1..99 by construction, because the three
 * publish-side validators refuse anything else on a paywalled piece
 * (money.md: they stay in lockstep); 50 when there is nothing to measure.
 */
export function gatePositionPct(free: string, paywall: string): number {
  const totalLen = free.length + paywall.length;
  return totalLen > 0 ? Math.min(99, Math.max(1, Math.round((free.length / totalLen) * 100))) : 50;
}
