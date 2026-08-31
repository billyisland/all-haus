"use client";

import { useState, type ReactNode } from "react";
import type { VesselPalette } from "./tokens";

interface ContentWarningProps {
  warningText: string;
  palette: VesselPalette;
  children: ReactNode;
}

export function ContentWarning({
  warningText,
  palette,
  children,
}: ContentWarningProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span className="label-ui" style={{ color: palette.cardMeta }}>
          {warningText}
        </span>
        {/* Palette-driven so the toggle never hovers to invisible #111 on the
            dark card (the old `.btn-text-muted` did). */}
        <button
          type="button"
          className="label-ui transition-opacity hover:opacity-70"
          style={{ color: palette.cardTitle, background: "none", padding: 0 }}
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? "HIDE CONTENT" : "SHOW CONTENT"}
        </button>
      </div>
      {revealed && children}
    </div>
  );
}
