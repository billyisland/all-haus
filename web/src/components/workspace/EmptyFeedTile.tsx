"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { type VesselPalette } from "./tokens";

interface EmptyFeedTileProps {
  variant: "no-sources" | "no-items" | "caught-up";
  // The already-resolved palette for this feed (colourway × global mode on
  // desktop, globalContentPalette on mobile) — computed by the caller so the
  // empty-state tile matches the cards in the same vessel.
  palette: VesselPalette;
  onAddSources?: () => void;
  onDismiss?: () => void;
}

// A muted text-link button whose colour tracks the live palette — replaces
// `.btn-text-muted` here, whose #111 hover is invisible on the dark interior.
function MutedAction({
  palette,
  onClick,
  children,
}: {
  palette: VesselPalette;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="label-ui transition-opacity hover:opacity-70"
      style={{ color: palette.cardMeta, background: "none", padding: 0 }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function EmptyFeedTile({
  variant,
  palette,
  onAddSources,
  onDismiss,
}: EmptyFeedTileProps) {

  if (variant === "no-sources") {
    return (
      <div className="px-6 py-8 text-center">
        <p className="label-ui mb-2" style={{ color: palette.cardMeta }}>
          NO SOURCES
        </p>
        <p
          className="text-ui-xs mb-4"
          style={{ color: palette.cardStandfirst }}
        >
          Add feeds, accounts, or publications to fill this vessel.
        </p>
        {onAddSources && (
          <button type="button" className="btn-accent" onClick={onAddSources}>
            ADD SOURCES
          </button>
        )}
      </div>
    );
  }

  if (variant === "caught-up") {
    return (
      <CaughtUpTile
        palette={palette}
        onAddSources={onAddSources}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <div className="px-6 py-8 text-center">
      <p className="label-ui mb-2" style={{ color: palette.cardMeta }}>
        NO ITEMS YET
      </p>
      <p className="text-ui-xs mb-4" style={{ color: palette.cardStandfirst }}>
        No new items. Add more sources or check back later.
      </p>
      {onAddSources && <MutedAction palette={palette} onClick={onAddSources}>ADD MORE</MutedAction>}
    </div>
  );
}

// The caught-up tile auto-dismisses 2s after it appears if untouched; hovering
// pauses the countdown so it can't vanish under the cursor.
function CaughtUpTile({
  palette,
  onAddSources,
  onDismiss,
}: {
  palette: VesselPalette;
  onAddSources?: () => void;
  onDismiss?: () => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onDismiss?.(), 2000);
  };
  const stop = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    start();
    return stop;
    // onDismiss is stable enough for this lifecycle; intentionally mount-only.
     
  }, []);

  return (
    <div
      className="px-4 py-4 text-center"
      onMouseEnter={stop}
      onMouseLeave={start}
    >
      <p className="text-ui-xs mb-3" style={{ color: palette.cardStandfirst }}>
        You&rsquo;re caught up. Add new sources or strengthen current ones to see
        more.
      </p>
      <div className="flex items-center justify-center gap-4">
        {onAddSources && (
          <MutedAction
            palette={palette}
            onClick={() => {
              onDismiss?.();
              onAddSources();
            }}
          >
            ADD SOURCES
          </MutedAction>
        )}
        <MutedAction palette={palette} onClick={() => onDismiss?.()}>
          DISMISS
        </MutedAction>
      </div>
    </div>
  );
}
