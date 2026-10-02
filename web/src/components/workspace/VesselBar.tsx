"use client";

import { useRef } from "react";
import {
  BAR_H,
  BarButton,
  SeenPills,
  SourceDropdown,
  SourceInput,
  useSourceAdder,
} from "./VesselBarParts";
import type { VesselPalette } from "./tokens";

interface VesselBarProps {
  feedId: string;
  palette: VesselPalette;
  onSourceAdded?: () => void;
  onNameClick?: () => void;
  onHide?: () => void;
}

export { BAR_H };

// The floor's bar, and the queue's focal bar (WORKSPACE-QUEUE-ADR §VII.4):
// numeral square, ⚙, ×, the pills, `+ add source`. Its parts live in
// `VesselBarParts.tsx`, where the queue's compact bar takes them from too.

export function VesselBar({
  feedId,
  palette,
  onSourceAdded,
  onNameClick,
  onHide,
}: VesselBarProps) {
  const adder = useSourceAdder(feedId, onSourceAdded);
  const barRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={barRef} style={{ position: "relative" }}>
      <div
        style={{
          height: BAR_H,
          background: palette.barBg,
          display: "flex",
          alignItems: "center",
          gap: 2,
          // Reserve the bottom-left square for the vessel numeral (overlaid by
          // Vessel.tsx) so the controls don't crowd it.
          paddingLeft: BAR_H + 6,
          paddingRight: 6,
        }}
      >
        {/* Appearance controls (brightness / density / orientation / text size)
            now live in the FeedComposer modal — see task 8. */}
        {/* Gear button — opens the FeedComposer modal for rename/delete/full source list + appearance */}
        {onNameClick && (
          <BarButton
            label="Channel settings"
            glyph="⚙"
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={onNameClick}
            dataExplain="vessel.gear"
          />
        )}

        {onHide && (
          <BarButton
            label="Hide channel"
            glyph="×"
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={onHide}
            dataExplain="vessel.hide"
          />
        )}

        {/* Spacer */}
        <div style={{ flex: 1, minWidth: 8 }} />

        <SeenPills feedId={feedId} palette={palette} />

        {/* Source search input */}
        <SourceInput adder={adder} palette={palette} />
      </div>

      {/* Dropdown — renders above the bar so it can't drop off the bottom of
          the screen (the bar sits at the vessel's bottom edge). */}
      <SourceDropdown adder={adder} palette={palette} />
    </div>
  );
}
