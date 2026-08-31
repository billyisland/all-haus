"use client";

// =============================================================================
// WriterActivity — tiers 3 and 4 of the native profile: the tab rig and the
// post log (PROFILE-PANE-REDESIGN-ADR D11).
//
// TWO TABS, NOT FOUR. Followers and Following used to be counts in the stats
// line AND pills in the rig — the same navigation stated twice, one of the two
// inert. Mobile decided it: four `.tab-pill`s come to ~350px against 327px of
// content width at 375px, in a container with no wrap and no scroll, so the rig
// was already broken on a phone and no bar sizing fixes it. The counts in tier 2
// are now the live links into those views (owned by NativeProfileBody, since a
// count view replaces THIS region), and the rig is Work · Social.
//
// THE ZERO-ARTICLE FILTER STANDS, and generalises: with no articles there is
// nothing to switch between, so the rig renders only when both tabs exist — a
// lone pill is furniture — and the log simply shows Social.
//
// Everything that used to live here besides the rig (the action pair, the
// subscribe row, the vouch/trust blocks) moved up to NativeProfileBody, where
// tiers 1 and 2 are.
// =============================================================================

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import type { WriterProfile } from "../../lib/api";
import type { VesselPalette } from "../workspace/tokens";
import { WorkTab } from "./WorkTab";
import { SocialTab } from "./SocialTab";

type ProfileTab = "work" | "social";

interface WriterActivityProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
  palette: VesselPalette;
  // Hosted inside the profile overlay (NativeProfilePanel). The overlay's
  // pushed URL is /<username>, so we ignore the ambient ?tab the workspace URL
  // may carry and drive tab state internally (switchTab still reflects it onto
  // the URL).
  inOverlay?: boolean;
}

export function WriterActivity({
  username,
  writer,
  isOwnProfile,
  palette,
  inOverlay = false,
}: WriterActivityProps) {
  const searchParams = useSearchParams();

  const hasWork = writer.articleCount > 0;
  const tabs: ProfileTab[] = hasWork ? ["work", "social"] : ["social"];

  const rawTab = inOverlay ? null : searchParams.get("tab");
  const initialTab: ProfileTab =
    rawTab && tabs.includes(rawTab as ProfileTab)
      ? (rawTab as ProfileTab)
      : tabs[0];

  const [activeTab, setActiveTab] = useState<ProfileTab>(initialTab);
  // A writer's first article makes the Work tab appear; if the rig has shrunk
  // back to Social alone, the state must follow it rather than render a panel
  // no pill can reach.
  const tab: ProfileTab = tabs.includes(activeTab) ? activeTab : tabs[0];

  function switchTab(next: ProfileTab) {
    setActiveTab(next);
    const url = new URL(window.location.href);
    if (next === "work") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url.toString());
  }

  return (
    <>
      {tabs.length > 1 && (
        <div
          className="flex gap-2 mb-4"
          role="tablist"
          aria-label="Profile sections"
        >
          {tabs.map((t, i) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`profile-panel-${t}`}
              id={`profile-tab-${t}`}
              onClick={() => switchTab(t)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  switchTab(tabs[(i + 1) % tabs.length]);
                  e.preventDefault();
                }
                if (e.key === "ArrowLeft") {
                  switchTab(tabs[(i - 1 + tabs.length) % tabs.length]);
                  e.preventDefault();
                }
              }}
              tabIndex={tab === t ? 0 : -1}
              className={`tab-pill ${tab === t ? "tab-pill-active" : "tab-pill-inactive"}`}
            >
              {t === "work" ? "Work" : "Social"}
            </button>
          ))}
        </div>
      )}

      {tab === "work" && (
        <div
          role="tabpanel"
          id="profile-panel-work"
          aria-labelledby="profile-tab-work"
        >
          <WorkTab
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        </div>
      )}
      {tab === "social" && (
        // With no rig there is no tablist, so the panel carries no tab
        // semantics either — it is simply the log.
        <div
          role={tabs.length > 1 ? "tabpanel" : undefined}
          id="profile-panel-social"
          aria-labelledby={tabs.length > 1 ? "profile-tab-social" : undefined}
        >
          <SocialTab
            username={username}
            writer={writer}
            isOwnProfile={isOwnProfile}
            palette={palette}
          />
        </div>
      )}
    </>
  );
}
