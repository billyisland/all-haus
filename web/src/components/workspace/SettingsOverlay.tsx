"use client";

// =============================================================================
// SettingsOverlay — account settings in a workspace Glasshouse. Mounted once in
// WorkspaceView; opened from the ForallMenu Settings row, or via
// /reader?overlay=settings (the retired /settings route redirects here,
// forwarding any OAuth ?linked flag; see the deep-link dispatcher in
// WorkspaceView). Wraps SettingsPanel in the canonical frosted overlay so the
// ForallMenu stays crisp above it.
// =============================================================================

import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { Glasshouse } from "./Glasshouse";
import { SettingsPanel } from "../account/SettingsPanel";

export function SettingsOverlay() {
  const { isOpen, linked, follows, close } = useSettingsOverlay();
  if (!isOpen) return null;

  // 720px keeps the settings form at its article-reading rhythm (the body is
  // max-w-md within); the inner scroll fills the pane minus its 64px (my-8)
  // vertical margin.
  return (
    <Glasshouse onClose={close} maxWidth={720} ariaLabel="Settings" persistKey="settings">
      <div data-explain="settings" className="overflow-y-auto max-h-[var(--gh-h)] px-6 sm:px-10 py-12">
        <SettingsPanel inOverlay initialLinked={linked} initialFollows={follows} />
      </div>
    </Glasshouse>
  );
}
