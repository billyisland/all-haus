"use client";

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { workspaceFeeds as workspaceFeedsApi } from "../../lib/api";
import { useFeedSeenCounts } from "../../stores/feedSeen";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { apiErrorMessage } from "../../lib/api/client";
import { useResolverInput } from "../../hooks/useResolverInput";
import { reportFollowState } from "../../hooks/useFeedFollow";
import type { MatchOption } from "../../lib/workspace/resolve";
import { FEED_ERROR_ADD_SOURCE, FEED_RESOLVER_NO_MATCH } from "../../content/feed-settings";
import type { VesselPalette } from "./tokens";

// The parts of a vessel's bar, lifted out of `VesselBar` so the queue can
// build its bars from the same pieces (WORKSPACE-QUEUE-ADR §VII.4, B3):
// `BarButton`, the reading-count pills, and the resolver input with its
// dropdown. `VesselBar` composes them and renders byte-identically to the bar
// it was before the lift (`Vessel.dom.test.tsx`, pills included).
//
// The resolver input is a hook and TWO pieces, not one component, because
// the dropdown is not inside the input: it hangs off the whole bar (above it,
// right-aligned), so the bar places each piece where it always sat.

export const BAR_H = 32;

// =============================================================================
// Adding a source from the bar.
// =============================================================================

export function useSourceAdder(feedId: string, onSourceAdded?: () => void) {
  const ri = useResolverInput();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleAdd(opt: MatchOption) {
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await workspaceFeedsApi.addSource(feedId, opt.add);
      // Same act as pressing Follow, so the same report to the shared graph
      // store (§0ab item 6) — this bar had never told it anything.
      reportFollowState(
        opt.add.sourceType === "account" ? opt.add.accountId : null,
        res.following,
      );
      ri.reset();
      onSourceAdded?.();
    } catch (err) {
      // Server liveness verdicts (invalid_source_uri / source_unreachable,
      // audit F1) carry a human-readable message — show it in the dropdown
      // instead of failing silently.
      setAddError(apiErrorMessage(err) ?? FEED_ERROR_ADD_SOURCE);
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

  return {
    ri,
    adding,
    addError,
    setAddError,
    setFocused,
    inputRef,
    handleAdd,
    showDropdown,
  };
}

export type SourceAdder = ReturnType<typeof useSourceAdder>;

/** The `+ add source` field. */
export function SourceInput({
  adder,
  palette,
}: {
  adder: SourceAdder;
  palette: VesselPalette;
}) {
  const { ri, setAddError, setFocused, inputRef } = adder;
  return (
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
  );
}

/** The resolver's answers, hung above the whole bar. */
export function SourceDropdown({
  adder,
  palette,
}: {
  adder: SourceAdder;
  palette: VesselPalette;
}) {
  const { ri, adding, addError, handleAdd, showDropdown } = adder;
  if (!showDropdown) return null;
  return (
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
          Couldn’t look that up. Please try again.
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
          {FEED_RESOLVER_NO_MATCH}
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

export function BarButton({
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

// =============================================================================
// The reading counts on the bar (WORKSPACE-QUEUE-ADR §IV.8).
//
//   new    — a FILLED pill: the bar's own two fields swapped, so the pair stays
//            in one inversion family.
//   unread — a WASH pill, mixed from the palette's own two fields and never
//            branched on isDark (`.claude/rules/web-theme.md`).
//
// A truncated count reads "N+", so it still ticks down as posts are passed:
// what is known is a floor, and the floor moves.
//
// Each hidden at 0, and both ABSENT until the feed's first window lands: a 0
// before then would be a claim (§IV.5). Ground alone, nothing drawn round.
// =============================================================================

export function SeenPills({
  feedId,
  palette,
  bare,
}: {
  feedId: string;
  palette: VesselPalette;
  /** Numbers only, the words in `title` — the queue's compact bar, when the
   *  words do not fit its width (§VII.4). */
  bare?: boolean;
}) {
  const counts = useFeedSeenCounts(feedId);
  if (!counts) return null;
  const { unread, truncated, newTruncated } = counts;
  const fresh = counts.new;
  if (unread === 0 && fresh === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexShrink: 0, marginRight: 4 }}
    >
      {fresh > 0 && (
        <Pill
          value={newTruncated ? `${fresh}+` : String(fresh)}
          word="new"
          bare={bare}
          ground={palette.barText}
          ink={palette.barBg}
        />
      )}
      {unread > 0 && (
        <Pill
          value={truncated ? `${unread}+` : String(unread)}
          word="unread"
          bare={bare}
          // 14%, not the ADR's 18%: measured across the five schemes in both
          // modes, 18% put the text at 2.86:1 on spring-dark; 14% is the
          // largest mix that holds 3:1 everywhere (lowest 3.03).
          ground={`color-mix(in srgb, ${palette.barBg}, ${palette.barText} 14%)`}
          ink={palette.barText}
        />
      )}
    </div>
  );
}

function Pill({
  value,
  word,
  bare,
  ground,
  ink,
}: {
  value: string;
  word: string;
  bare?: boolean;
  ground: string;
  ink: string;
}) {
  const reduced = prefersReducedMotion();
  return (
    <span
      className="label-ui tabular-nums"
      aria-label={`${value} ${word}`}
      title={bare ? `${value} ${word}` : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 6px",
        background: ground,
        color: ink,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {/* Keyed on the value, so a change remounts it and the tick plays. */}
      <motion.span
        key={value}
        aria-hidden
        initial={reduced ? false : { y: "-45%", opacity: 0.15 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3 }}
        style={{ display: "inline-block" }}
      >
        {value}
      </motion.span>
      {!bare && <span aria-hidden>{word}</span>}
    </span>
  );
}
