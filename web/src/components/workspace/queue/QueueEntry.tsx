"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { LIGHT_ISLAND_STYLE } from "../../../lib/palette/island";
import { INERT } from "../../../lib/inert";
import { queueCountedName } from "../../../lib/workspace/queueLabel";
import type { QueueGeometry } from "../../../lib/workspace/queueGeometry";
import { useFeedSeenCounts } from "../../../stores/feedSeen";
import { ROUNDEL_HOST, RoundelLabel } from "../RoundelLabel";
import { BAR_H } from "../VesselBarParts";
import { VESSEL_WALL, type VesselPalette } from "../tokens";
import { useExplainable } from "../ExplainProvider";
import { useQueueBinding, type QueueBinding } from "./queueBinding";

// QueueEntry — the queue's shell around the shared ⊔ (WORKSPACE-QUEUE-ADR
// §VII.2), the queue's twin of the floor's `Vessel`.
//
// A CLIP OVER A CHASSIS THAT NEVER CHANGES WIDTH. The chassis is always laid
// out at the focal width; the clip shows all of it (focal), its left `CW` px
// (compact), or its left wall alone (line). So a transition animates one
// width — the clip's — and no card list ever re-wraps (§VI.4). At rest the
// widths simply jump.
//
// THE RIGHT WALL IS AN OVERLAY, pinned to the clip's right edge, so the entry
// reads as a closed ⊔ at every width; at the line width it lands on the left
// wall, and the line is the vessel with nothing left to show.
//
// A LINE THAT MOUNTS NO CHASSIS IS NOT A VESSEL (§VI.1): a bare `<button>`,
// `VESSEL_WALL` wide, filled with the walls colour, named with the feed and its
// counts ("Feed 3: Philosophy, 2 new, 8 unread") — to assistive tech that name
// is all a line is. It walks to its feed. It is not a tab stop — the queue has
// one, the focal scroller (§VI.7).
//
// THE LINE JUST LEFT OF FOCAL KEEPS ITS CHASSIS (§VII.3): its list stays
// mounted so a step back finds it where the reader left it, clipped to the
// wall and `inert` under the same button, which carries the name and takes the
// click. It is the same element tree as the focal and compact states, so the
// chassis survives the change of state — that survival is the point.
//
// HOVERING A LINE OR A COMPACT ENTRY NAMES ITS FEED (§VII.4, resolving §X.1):
// the shared roundel label, as on the vessel and the muster. It hangs OUTSIDE
// the clip, as the clip's sibling, so a name longer than the compact width is
// not cut off; a line's label follows the pointer down the line, since a line
// is as tall as the queue. The SHELL is the label's hover host, so the
// browser's own `:hover` shows it — never React state, which a step left
// stale: an entry changes state under a still pointer, its handlers change
// with it, and no `mouseleave` ever comes (`RoundelLabel.tsx`). The hovered
// entry is lifted one step so its label clears the entries to its right
// (`globals.css`), and every clip isolates its own stacking,
// so the chassis's inner layers (the numeral, the add-source dropdown) never
// compete with a neighbour's. The focal entry has the chassis's own numeral
// label, and no second one.
//
// `overflow: clip`, never `hidden`: `hidden` lets the browser scroll the box
// to a focused descendant, and a compact entry clipping a focusable control
// would then slide sideways under the reader.
//
// THE CLIP'S WIDTH IS BOUND TO THE GESTURE (§VII.6): `widthAt` maps the
// queue's progress to this entry's width, written straight to the style, so a
// drag moves the clip and nothing re-renders. At rest it is the width of the
// entry's state.
//
// THE FOCAL ENTRY IS THE QUEUE'S `vessel` EXPLAIN ROOT (T1, WORKSPACE-QUEUE-ADR
// §XI.6). The first-run tour waits for a registered vessel and anchors its
// first three beats inside one (the feed, its add-source, a card byline); on
// the floor `Vessel` registers each, and in the queue the feed being read is
// the one there is. Registered on the CLIP, which holds the chassis, and only
// while focal — the neighbours' chassis are mounted `inert`, and a beat must
// not land on a feed the reader cannot use. The clip's own `queue.focal` tag
// still answers an Explain hover, since a tag is found before a root.

export type QueueEntryState = "focal" | "compact" | "line";

interface QueueEntryProps {
  state: QueueEntryState;
  geom: QueueGeometry;
  palette: VesselPalette;
  /** "Feed 3: Philosophy" — before the counts. */
  label: string;
  /** What a hover shows: the feed's name. Absent, a hover shows nothing. */
  hoverName?: string;
  /** Whose counts a line's name carries. */
  feedId: string;
  /** Walk here. Lines and compact entries only. */
  onWalk: () => void;
  /** The clip's width through a step. */
  widthAt: QueueBinding;
  /** Reduced motion, read once by the queue: the labels do not fade. */
  reduced: boolean;
  /** The chassis under a line is `inert`. Default: whenever the entry is a
   *  line; the queue passes it from where focal RESTS, because the switch
   *  restyles the whole chassis and must not land in a step's commit. */
  chassisInert?: boolean;
  /** The chassis. A line renders none. */
  children?: ReactNode;
  /** The Explain root's facts — the numeral, and the D7 provenance fork's
   *  inputs. Read only while the entry is focal. */
  explain?: { order: number; fromStarter: boolean; feedName: string | null };
}

export function QueueEntry({
  state,
  geom,
  palette,
  label,
  hoverName,
  feedId,
  onWalk,
  widthAt,
  reduced,
  chassisInert,
  children,
  explain,
}: QueueEntryProps) {
  const clipRef = useRef<HTMLDivElement>(null);
  useExplainable("vessel", {
    ref: clipRef,
    key: feedId,
    order: explain?.order,
    params: explain
      ? { feedName: explain.feedName, fromStarter: explain.fromStarter }
      : undefined,
    enabled: state === "focal" && !!children,
  });
  useQueueBinding(clipRef, "width", widthAt);
  // Where the pointer is down a line, kept after it leaves so the fade-out
  // plays in place. Position only: whether the label shows is `:hover`'s.
  // Written to the label directly, so a mousemove renders nothing.
  const lineLabelRef = useRef<HTMLDivElement>(null);
  const onPointerY = useCallback((y: number) => {
    if (lineLabelRef.current) lineLabelRef.current.style.top = `${y}px`;
  }, []);

  const shell = {
    position: "relative" as const,
    flex: "0 0 auto",
  };

  const line = state === "line";
  const lineButton = line && (
    <LineButton
      feedId={feedId}
      label={label}
      geom={geom}
      palette={palette}
      onWalk={onWalk}
      onPointerY={onPointerY}
    />
  );
  const lineLabel = line && hoverName && (
    <RoundelLabel
      labelRef={lineLabelRef}
      ariaHidden
      fade={!reduced}
      place={{
        ...LIGHT_ISLAND_STYLE,
        position: "absolute",
        left: geom.lineW + 4,
        top: 0,
        transform: "translateY(-50%)",
      }}
    >
      {hoverName}
    </RoundelLabel>
  );

  // What a re-sort's FLIP finds the entry by (§VII.8).
  const key = feedId;
  if (line && !children) {
    return (
      <div data-queue-key={key} className={ROUNDEL_HOST} style={shell}>
        {lineButton}
        {lineLabel}
      </div>
    );
  }

  const compact = state === "compact";
  return (
    <div
      data-queue-key={key}
      className={ROUNDEL_HOST}
      style={shell}
    >
      <div
        ref={clipRef}
        data-queue-entry={state}
        data-queue-feed={feedId}
        // Explain (B9): the feed being read answers for itself; the other
        // entries fall through to the queue's own tag.
        data-explain={state === "focal" ? "queue.focal" : undefined}
        onClick={compact ? onWalk : undefined}
        style={{
          ...LIGHT_ISLAND_STYLE,
          position: "relative",
          height: geom.entryH,
          overflow: "clip",
          isolation: "isolate",
          cursor: compact ? "pointer" : undefined,
        }}
      >
        <div
          {...((chassisInert ?? line) ? INERT : undefined)}
          style={{ width: geom.focalW, height: geom.entryH }}
        >
          {children}
        </div>
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: VESSEL_WALL,
            background: palette.walls,
            pointerEvents: "none",
          }}
        />
        {line && (
          <div style={{ position: "absolute", top: 0, left: 0 }}>
            {lineButton}
          </div>
        )}
      </div>
      {lineLabel}
      {compact && hoverName && (
        <RoundelLabel
          ariaHidden
          fade={!reduced}
          place={{
            ...LIGHT_ISLAND_STYLE,
            position: "absolute",
            left: VESSEL_WALL,
            bottom: BAR_H + 4,
          }}
        >
          {hoverName}
        </RoundelLabel>
      )}
    </div>
  );
}

/** The line itself — its own component so the counts in its name re-render
 *  the line alone, never the queue (QueueView reads no counts, §VII.10). */
function LineButton({
  feedId,
  label,
  geom,
  palette,
  onWalk,
  onPointerY,
}: {
  feedId: string;
  label: string;
  geom: QueueGeometry;
  palette: VesselPalette;
  onWalk: () => void;
  onPointerY: (y: number) => void;
}) {
  const counts = useFeedSeenCounts(feedId);
  const name = queueCountedName(label, counts);
  return (
    <button
      type="button"
      aria-label={name}
      tabIndex={-1}
      onClick={onWalk}
      onMouseEnter={(e) => onPointerY(e.nativeEvent.offsetY)}
      onMouseMove={(e) => onPointerY(e.nativeEvent.offsetY)}
      className="hover:opacity-70"
      style={{
        display: "block",
        width: geom.lineW,
        height: geom.entryH,
        padding: 0,
        border: 0,
        background: palette.walls,
        cursor: "pointer",
      }}
    />
  );
}
