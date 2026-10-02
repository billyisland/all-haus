"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useFeedSeenCounts } from "../../../stores/feedSeen";
import { queueCountedName } from "../../../lib/workspace/queueLabel";
import { GRID } from "../../../lib/workspace/grid";
import { BAR_H, SeenPills } from "../VesselBarParts";

/** The bar's side padding: half a grid on the right, the numeral square and
 *  its gap on the left. */
const PAD_R = GRID / 2;
const PAD_L = BAR_H + 6;
import type { VesselPalette } from "../tokens";
import { useQueueBinding, type QueueBinding } from "./queueBinding";

// The compact bar (WORKSPACE-QUEUE-ADR §VII.4): `[numeral] ──── [N new]
// [N unread]`. The whole bar is ONE button that walks to the feed; ⚙, × and
// add-source are the focal bar's, and a feed ahead has none of them. Its
// accessible name carries the counts, in the line's form (§VI.1).
//
// IT IS SIZED TO THE CLIP, NOT THE CHASSIS. The chassis under it is laid out
// at the focal width and never changes (§VII.2), so a bar as wide as the
// chassis would put its pills past the clip's right edge, where nothing shows.
// The numeral square is the chassis's (overlaid bottom-left), so the bar
// reserves it and draws nothing there.
//
// THE PILLS KEEP THEIR WORDS WHILE THEY FIT. Near the narrowest compact width
// (192) "2 NEW" and "8 UNREAD" do not fit beside the numeral, so the bar
// measures after layout and, where they overflow, drops the words and keeps
// the numbers, with the words in each pill's `title` (§VII.4). The measure is
// keyed on what it measured — the figures and the width — so a change to
// either tries the words again, and nothing loops.
//
// THE ROOM IS THE `width` PROP, NEVER THE BAR'S LIVE WIDTH. Through a step
// the binding sets the bar to a line's width (0) or the focal's, and the fit
// is not re-asked when the entry comes to rest at compact with the same
// counts: a bar mounted on a line wash measured 0 and kept its words dropped,
// and one measured on a focal wash kept words that then clipped.

interface QueueBarProps {
  palette: VesselPalette;
  /** The feed's name — "Feed 3: Philosophy" — before its counts. */
  label: string;
  /** The clip's interior: the compact width less the two walls. What the
   *  words are fitted against. */
  width: number;
  /** The width through a step: the bar follows its clip (§VII.2), or a feed
   *  coming forward would show a bar ending short of its right wall. */
  widthAt: QueueBinding;
  onWalk: () => void;
  /** Whose counts are on the bar and in the name. */
  feedId: string;
}

export function QueueBar({
  palette,
  label,
  width,
  widthAt,
  onWalk,
  feedId,
}: QueueBarProps) {
  const counts = useFeedSeenCounts(feedId);
  const name = queueCountedName(label, counts);

  const barRef = useRef<HTMLButtonElement>(null);
  const pillsRef = useRef<HTMLSpanElement>(null);
  useQueueBinding(barRef, "width", widthAt);
  const fitKey = counts
    ? `${width}:${counts.new}:${counts.unread}:${counts.truncated}:${counts.newTruncated}`
    : null;
  const [bareFor, setBareFor] = useState<string | null>(null);
  const bare = fitKey !== null && bareFor === fitKey;

  useLayoutEffect(() => {
    if (fitKey === null || bare) return;
    const pills = pillsRef.current;
    if (!pills) return;
    if (pills.scrollWidth > width - PAD_L - PAD_R) setBareFor(fitKey);
  }, [fitKey, bare, width]);

  return (
    <button
      ref={barRef}
      type="button"
      aria-label={name}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        onWalk();
      }}
      className="label-ui hover:opacity-70"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        height: BAR_H,
        flex: "0 0 auto",
        padding: `0 ${PAD_R}px 0 ${PAD_L}px`,
        border: 0,
        background: palette.barBg,
        color: palette.barText,
        cursor: "pointer",
        overflow: "clip",
      }}
    >
      <span ref={pillsRef} style={{ display: "flex", flexShrink: 0 }}>
        <SeenPills feedId={feedId} palette={palette} bare={bare} />
      </span>
    </button>
  );
}
