"use client";

import React from "react";
import { type VesselPalette } from "../workspace/tokens";

// =============================================================================
// InlineReplyPanel — the chrome both in-situ reply boxes wear.
//
// A card answers Reply IN PLACE, never by opening a pane over the floor: a
// reply is a remark inside a conversation you are already reading, and taking
// the screen away to write one loses the thing being replied to. Two
// machineries sit behind that one gesture — a NATIVE reply (`NativeReplyBox`,
// a kind-1111 comment into an all.haus conversation) and an ORIGIN
// interact-back reply (`InlineReplyBox`, pushed to Bluesky/Mastodon through a
// linked account) — and on the card they must read as ONE affordance, so the
// panel they share (inset wash, mono-caps heading, dismiss ✕) lives here and
// neither box draws its own.
//
// IT ALSO STOPS THE CARD HEARING THE TYPING. The card shell is a
// `role="button"` carrying its own click AND KEYDOWN handler — Enter/Space
// expand or collapse the card (`chassis.tsx`) — and a keystroke inside a
// textarea within it BUBBLES: every space typed into an inline reply on a
// collapsed card toggled the card under the writer. The click half was stopped
// here from the start; the key half was not, which is the shape to watch
// wherever a form is mounted inside an element that is itself pressable.
// =============================================================================

export function InlineReplyPanel({
  palette,
  label,
  onClose,
  children,
}: {
  palette: VesselPalette;
  /** Mono-caps heading — `.label-ui` uppercases, so pass ordinary prose. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // The panel is an inset FILL, never an outline (single-pixel lines are
  // banned sitewide): the card's OWN ground nudged toward its OWN ink, which
  // is the only construction that survives both axes. It used to branch on
  // `isDarkPalette` between a black wash and `--ah-white-rgb` at 5% — and
  // `white` is in `DARK_SLUGS`, so off a light island (the profile, source and
  // tag logs all take `globalContentPalette`) it had itself inverted to the
  // ink triple: in dark mode the "light wash on a dark card" was a dark wash on
  // a dark card, `rgba(30,29,26,0.05)` on `rgb(30,29,26)`, and the panel was
  // not there at all. Branching on the palette double-counts an inversion the
  // slug has already applied. Mixing the two palette fields needs no branch and
  // no slug: `cardTitle` is whatever contrasts with `cardBg` in this mode and
  // this colourway, so the wash lifts the right way by construction. Same
  // family on both sides — `.claude/rules/web-theme.md` › *A foreground and its
  // ground must belong to the same inversion family*.
  const panelWash = `color-mix(in srgb, ${palette.cardBg}, ${palette.cardTitle} 6%)`;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className="mt-3 rounded overflow-hidden"
      style={{ background: panelWash }}
    >
      <div className="px-3 pt-2 flex items-center justify-between gap-3">
        <span className="label-ui truncate" style={{ color: palette.cardMeta }}>
          {label}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[16px] leading-none transition-opacity hover:opacity-70"
          style={{ color: palette.cardMeta }}
          aria-label="Close reply"
        >
          ×
        </button>
      </div>
      {children}
    </div>
  );
}
