"use client";

// =============================================================================
// DashboardOverlay — the writer/publication dashboard in a workspace Glasshouse.
// Mounted once in WorkspaceView; opened from the ForallMenu Dashboard row, or
// via /reader?overlay=dashboard (the retired /dashboard route redirects here
// — see the deep-link effect in WorkspaceView). Wraps DashboardPanel in the
// canonical frosted overlay so the ForallMenu stays crisp above it.
// =============================================================================

import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { Glasshouse } from "./Glasshouse";
import { DashboardPanel } from "../dashboard/DashboardPanel";

export function DashboardOverlay() {
  const { isOpen, initialTab, initialContext, close } = useDashboardOverlay();
  if (!isOpen) return null;

  // 1040px gives the dashboard's tables and three-up cards room beyond the
  // 960px content width the dashboard used as a page. The inner scroll fills the
  // pane minus its 64px (my-8) vertical margin; the left-aligned context
  // switcher clears the Glasshouse close ✕ (top-right).
  return (
    <Glasshouse onClose={close} maxWidth={1040} ariaLabel="Dashboard" persistKey="dashboard">
      <div data-explain="dashboard" className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <DashboardPanel inOverlay initialTab={initialTab} initialContext={initialContext} />
      </div>
    </Glasshouse>
  );
}
