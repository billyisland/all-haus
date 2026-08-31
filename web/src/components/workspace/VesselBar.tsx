"use client";

import { useRef, useState } from "react";
import { workspaceFeeds as workspaceFeedsApi } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api/client";
import { useResolverInput } from "../../hooks/useResolverInput";
import type { MatchOption } from "../../lib/workspace/resolve";
import type { VesselPalette } from "./tokens";

const BAR_H = 32;

interface VesselBarProps {
  feedId: string;
  palette: VesselPalette;
  onSourceAdded?: () => void;
  onNameClick?: () => void;
  onHide?: () => void;
}

export { BAR_H };

export function VesselBar({
  feedId,
  palette,
  onSourceAdded,
  onNameClick,
  onHide,
}: VesselBarProps) {
  const ri = useResolverInput();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  async function handleAdd(opt: MatchOption) {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await workspaceFeedsApi.addSource(feedId, opt.add);
      ri.reset();
      onSourceAdded?.();
    } catch (err) {
      // Server liveness verdicts (invalid_source_uri / source_unreachable,
      // audit F1) carry a human-readable message — show it in the dropdown
      // instead of failing silently.
      setAddError(apiErrorMessage(err) ?? "Failed to add source.");
      console.error("VesselBar add source error:", err);
    } finally {
      setAdding(false);
    }
  }

  const showDropdown =
    focused &&
    ri.query.trim().length > 0 &&
    (ri.matches.length > 0 ||
      ri.resolving ||
      ri.doneEmpty ||
      ri.resolveError ||
      addError !== null);

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
            label="Feed settings"
            glyph="⚙"
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={onNameClick}
            dataExplain="vessel.gear"
          />
        )}

        {onHide && (
          <BarButton
            label="Hide feed"
            glyph="×"
            color={palette.barText}
            mutedColor={palette.barTextMuted}
            onClick={onHide}
            dataExplain="vessel.hide"
          />
        )}

        {/* Spacer */}
        <div style={{ flex: 1, minWidth: 8 }} />

        {/* Source search input */}
        <div
          data-explain="vessel.addSource"
          style={{
            position: "relative",
            maxWidth: 200,
            minWidth: 80,
            flex: "0 1 200px",
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={ri.query}
            onChange={(e) => {
              setAddError(null);
              ri.onQueryChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ri.submit();
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setTimeout(() => setFocused(false), 150);
            }}
            placeholder="+ add source"
            className="font-mono text-[11px] uppercase tracking-[0.04em]"
            style={{
              width: "100%",
              height: 22,
              background: palette.barInputBg,
              color: palette.barInputText,
              border: "none",
              borderRadius: 2,
              padding: "0 8px",
              outline: "none",
              lineHeight: "22px",
            }}
          />
        </div>
      </div>

      {/* Dropdown — renders above the bar so it can't drop off the bottom of
          the screen (the bar sits at the vessel's bottom edge). */}
      {showDropdown && (
        <div
          style={{
            position: "absolute",
            right: 6,
            bottom: BAR_H,
            width: 280,
            maxHeight: 200,
            overflowY: "auto",
            background: palette.barDropdownBg,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            zIndex: 20,
          }}
        >
          {ri.resolving && ri.matches.length === 0 && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: "8px 10px", color: palette.barTextMuted }}
            >
              Resolving…
            </div>
          )}
          {ri.resolveError && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: "8px 10px", color: palette.crimson }}
            >
              Resolution failed
            </div>
          )}
          {addError && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: "8px 10px", color: palette.crimson }}
            >
              {addError}
            </div>
          )}
          {ri.doneEmpty && (
            <div
              className="font-mono text-[11px] uppercase tracking-[0.04em]"
              style={{ padding: "8px 10px", color: palette.barTextMuted }}
            >
              No match — press Enter to search, or try a URL, @user, npub, #tag
            </div>
          )}
          {/* Confidence tiers (§6.4): Matches (exact + probable), then
              Suggestions (speculative). Headers derive from the vessel
              palette — a hard-coded grey is a dark-mode regression here. */}
          {ri.sections.matches.length > 0 &&
            ri.sections.suggestions.length > 0 && (
              <SectionHeader color={palette.barTextMuted} label="Matches" />
            )}
          {ri.sections.matches.map((opt) => (
            <MatchRow
              key={opt.key}
              opt={opt}
              adding={adding}
              palette={palette}
              onAdd={() => void handleAdd(opt)}
            />
          ))}
          {ri.sections.suggestions.length > 0 && (
            <SectionHeader color={palette.barTextMuted} label="Suggestions" />
          )}
          {ri.sections.suggestions.map((opt) => (
            <MatchRow
              key={opt.key}
              opt={opt}
              adding={adding}
              palette={palette}
              onAdd={() => void handleAdd(opt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ color, label }: { color: string; label: string }) {
  return (
    <div
      className="font-mono text-[10px] uppercase tracking-[0.06em]"
      style={{ padding: "6px 10px 2px", color }}
    >
      {label}
    </div>
  );
}

function MatchRow({
  opt,
  adding,
  palette,
  onAdd,
}: {
  opt: MatchOption;
  adding: boolean;
  palette: VesselPalette;
  onAdd: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAdd}
      disabled={adding}
      className="font-mono text-mono-xs tracking-[0.02em]"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "8px 10px",
        background: "transparent",
        border: "none",
        color: palette.barText,
        cursor: adding ? "default" : "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = palette.barDropdownHover)
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {opt.label}
      </span>
      {opt.sublabel && (
        <span
          className="font-mono text-[10px] uppercase tracking-[0.06em]"
          style={{
            color: palette.barTextMuted,
            marginLeft: 8,
            flexShrink: 0,
          }}
        >
          {opt.sublabel}
        </span>
      )}
    </button>
  );
}

function BarButton({
  label,
  glyph,
  color,
  mutedColor,
  onClick,
  dataExplain,
}: {
  label: string;
  glyph: string;
  color: string;
  mutedColor: string;
  onClick: () => void;
  dataExplain?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-explain={dataExplain}
      className="label-ui select-none"
      style={{
        color: mutedColor,
        background: "transparent",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: BAR_H * 2,
        padding: "0 12px",
        fontSize: 22,
        lineHeight: 1,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = color)}
      onMouseLeave={(e) => (e.currentTarget.style.color = mutedColor)}
    >
      {glyph}
    </button>
  );
}
