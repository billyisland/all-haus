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
import { WriterAccessPanel } from "../writer/WriterAccessPanel";
import { useAuth } from "../../stores/auth";

export function DashboardOverlay() {
  const { isOpen, initialTab, initialContext, close } = useDashboardOverlay();
  const canWrite = useAuth((s) => s.user?.canWrite === true);
  if (!isOpen) return null;

  // A READER has no dashboard (READER-WRITER-SPLIT-ADR §6.2): the ∀ menu's
  // "Apply to write" row and a `?overlay=dashboard` deep link both land here,
  // on the one explanation, in a pane sized to it.
  if (!canWrite) {
    return (
      <Glasshouse onClose={close} maxWidth={640} ariaLabel="Writing articles">
        <div className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
          <WriterAccessPanel />
        </div>
      </Glasshouse>
    );
  }

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
