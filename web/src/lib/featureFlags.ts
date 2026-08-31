// =============================================================================
// Client feature flags
//
// NEXT_PUBLIC_* env vars are inlined at build time, so these read as plain
// constants in the bundle. Each gates a subsystem that has been *parked*
// (architecture-audit 2026-06-15, items 7 & 8) — defaulting OFF so the
// subsystem ships dark until an operator flips it on. Server counterparts live
// in shared/src/lib/env.ts (trustSystemEnabled) and the per-service env.
// =============================================================================

// Trust graph (Layer 1/2/4) — item 7. When off the trust pip degrades to a
// neutral dot, the PipPanel trust sections hide (VolumeBar, a non-trust
// per-feed control, stays), and the Network "vouches" tab is dropped.
export function trustEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRUST_ENABLED === "1";
}

// Reader-telemetry beacon (traffology) — item 8. When off the article page
// stops loading the beacon script + meta, so readers' browsers don't POST to
// the parked /ingest/* endpoint.
export function traffologyEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TRAFFOLOGY_ENABLED === "1";
}

// Pledge drives (commissioning + pledging) — parked 2026-07-13. When off, every
// pledge/commission entry point hides: the DM "Commission" button, the dashboard
// "New pledge drive"/drive/commission cards (subscription offers in the same tab
// stay), the profile ProfileDriveCard, and the Ledger "my pledges" list. The
// gateway /drives routes 403 in lockstep. Server counterpart: PLEDGES_ENABLED
// (shared/src/lib/env.ts). Revive by setting both to "1".
export function pledgesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PLEDGES_ENABLED === "1";
}

// Publications (multi-author titles) — SUSPENDED BY OPERATOR DIRECTIVE
// 2026-08-31; launch is solo author accounts only. When off: the six /pub/[slug]/* pages 404, the six publication
// dashboard tabs and PublicationPanel don't render, the editor offers no
// publication to submit to, and the invite page explains rather than crashing.
// The gateway's publication routes 404 in lockstep. Server counterpart:
// PUBLICATIONS_ENABLED (shared/src/lib/env.ts), which carries the operational
// detail and the list of what is deliberately NOT gated. Revive by setting both to "1"
// — and the web is a BUILD ARG, so that needs `docker compose build web`, not a
// restart. Reinstatement: docs/adr/PUBLICATIONS-SUSPENSION-PLAN.md §8.
export function publicationsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PUBLICATIONS_ENABLED === "1";
}
