"use client";

import type { VesselPalette } from "../tokens";
import { BAR_H } from "../VesselBarParts";

// HiddenBars — where hidden feeds live in queue mode (WORKSPACE-QUEUE-ADR
// §VII.4, as amended 2026-09-26): one upright bar per hidden feed, after the
// last entry, as thick as a feed's own bar, with the feed's name run along it.
// A click restores the feed; nothing else touches it.
//
// NOT A STOP IN THE QUEUE. The bars sit in the row but outside the model's keys
// (`lib/workspace/queue.ts`), so no swipe, walk or hotkey ever lands on one — a
// hidden feed is reached only by pointing at it. That is the whole change from
// the tray, which was a key and so the last thing every walk to the end met.
// They count nothing, so they never dwell and never track a pass; and they are
// clipped with the rest of the row, so they are seen once the reader is near
// the end of the queue.

/** What a bar reads of a hidden feed. */
export interface HiddenFeed {
  id: string;
  /** Trimmed; empty when the feed has none. */
  name: string;
  createdAt: string;
}

const fmtMade = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

export function hiddenFeedTitle(f: Pick<HiddenFeed, "name" | "createdAt">): string {
  return f.name || `Untitled channel · made ${fmtMade.format(new Date(f.createdAt))}`;
}

export function HiddenBars({
  hidden,
  height,
  palette,
  onRestore,
}: {
  hidden: HiddenFeed[];
  height: number;
  /** The `basic` scheme, so the bars are black in light and dark alike. */
  palette: VesselPalette;
  onRestore: (feedId: string) => void;
}) {
  return (
    <>
      {hidden.map((f) => {
        const title = hiddenFeedTitle(f);
        return (
          <button
            key={f.id}
            type="button"
            data-hidden-bar={f.id}
            aria-label={`Restore ${title}`}
            onClick={() => onRestore(f.id)}
            className="label-ui focus-ring-inset hover:opacity-70"
            style={{
              flex: "0 0 auto",
              width: BAR_H,
              height,
              padding: `${BAR_H / 4}px 0`,
              background: palette.barBg,
              color: palette.barText,
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start",
              overflow: "hidden",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {/* The name runs up the bar on a SPAN, never the button: WebKit
                ignores `writing-mode` on a form control, so in WebKitGTK the
                name lay horizontal and was cut off (the operator, 2026-10-01). */}
            <span
              style={{
                writingMode: "vertical-rl",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxHeight: "100%",
              }}
            >
              {title}
            </span>
          </button>
        );
      })}
    </>
  );
}
