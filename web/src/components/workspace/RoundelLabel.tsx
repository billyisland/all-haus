"use client";

import type { CSSProperties, ReactNode, Ref } from "react";

// The roundel hover label — a feed's name, floated beside the thing that
// stands for it (WORKSPACE-QUEUE-ADR §VI.1, §VII.4). One treatment, three
// callers: the vessel's corner numeral, the muster's discs, and the queue's
// lines and compact entries. Each caller says only WHERE it sits; what it looks
// like is here, so the three cannot drift apart.
//
// THE TOKENS INVERT ASYMMETRICALLY, SO THE LABEL MUST SIT ON THE LIGHT ISLAND.
// `bone` is in `DARK_SLUGS` and `ink-925` is not, so under `html.dark` the
// ground stays dark while the text goes dark with it — a dark smudge on a dark
// pill. On the island both are canonical light: a dark pill with light text in
// either mode. A caller inside a vessel or a queue entry is already on the
// island; one that is not (the muster, a queue line) spreads
// `LIGHT_ISLAND_STYLE` into its `place`.
//
// Pointer-inert, and kept mounted so the fade-out plays; `visible` drives the
// opacity alone.
//
// OR THE BROWSER'S OWN `:hover` DRIVES IT, and that is the default. Leave
// `visible` out and the label shows while its PARENT (`ROUNDEL_HOST`) is
// hovered (`globals.css`). Hover kept in React state goes stale whenever the
// thing hovered moves, changes kind or unmounts under a still pointer — no
// `mouseleave` comes — and the queue does all three on every step, so names
// were left hanging beside lines nobody was pointing at. `:hover` cannot go
// stale: the browser re-tests it when layout moves. Pass `visible` only where
// the label cannot be its host's child (the muster's is a fixed sibling).

/** The class that makes an element the host of a `:hover`-driven label; the
 *  label must be its DIRECT child. */
export const ROUNDEL_HOST = "ah-roundel-host";

const ROUNDEL_LABEL_BG = "var(--ah-ink-925)";
const ROUNDEL_LABEL_FG = "var(--ah-bone)";

interface RoundelLabelProps {
  /** Absent: shown while the parent `ROUNDEL_HOST` is hovered. */
  visible?: boolean;
  /** Where it sits — position and offsets, plus the island where needed. */
  place: CSSProperties;
  /** Fade on show/hide. Off under reduced motion. */
  fade?: boolean;
  /** When the name is already the accessible name of what it labels. */
  ariaHidden?: boolean;
  /** For a caller that moves the label by hand (a queue line's follows the
   *  pointer without a render). */
  labelRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function RoundelLabel({
  visible,
  place,
  fade = true,
  ariaHidden,
  labelRef,
  children,
}: RoundelLabelProps) {
  return (
    <div
      ref={labelRef}
      className="label-ui ah-roundel-label"
      aria-hidden={ariaHidden || undefined}
      style={{
        ...place,
        background: ROUNDEL_LABEL_BG,
        color: ROUNDEL_LABEL_FG,
        padding: "3px 8px",
        whiteSpace: "nowrap",
        boxShadow: "0 2px 6px rgba(0, 0, 0, 0.15)",
        opacity: visible === undefined ? undefined : visible ? 1 : 0,
        pointerEvents: "none",
        transition: fade ? "opacity 120ms ease-out" : undefined,
      }}
    >
      {children}
    </div>
  );
}
