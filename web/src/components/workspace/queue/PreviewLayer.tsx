"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { INERT } from "../../../lib/inert";
import {
  captureCardAnchor,
  restoreCardAnchor,
  type CardAnchor,
} from "../../../lib/workspace/preserveCardPosition";
import { BAR_H } from "../VesselBarParts";
import { PullToRefresh, type RefreshResult } from "../PullToRefresh";
import { VESSEL_GAP, VESSEL_PAD } from "../tokens";
import { useQueueBinding, type QueueBinding } from "./queueBinding";

// PreviewLayer — a feed ahead of the reader, shown as a list of what is in it
// (WORKSPACE-QUEUE-ADR §VII.5). The chassis's `previewLayer` slot: a second
// layer OVER the full card list, laid out at the compact width, so the clip
// shows one or the other and neither ever re-wraps (§VI.4).
//
// ITS ROWS ARE CARDS AT `Level` `preview`, built by the host's one card path
// (`renderFeedContents(v, "preview")`) — there is no row component here, and
// no `Post` is rendered outside `resolveSpec` (UNIVERSAL-POST-ADR §4).
//
// IT COUNTS NOTHING. It is a sibling of the scroll body, never inside it, so
// the pass tracker cannot see a row; its rows carry no `data-seen-at` either,
// so a tracker pointed at it would still find nothing to pass. It never
// paginates: it shows what is loaded, capped by the host.
//
// IT KEEPS ITS OWN PLACE, never the full list's (§VI.2). The anchor is taken
// as the reader scrolls it — the only thing that moves it — and put back at
// every mount, so a layer the queue unmounted on the way past is where it was
// left. A row landing ABOVE the reader keeps the view where it was: the rows
// are re-found by id and the difference goes on `scrollTop`. At the very top it
// does not, and that is deliberate: a reader at the top of a list is reading
// its newest posts, and the rows arriving there are what they came for.
//
// IT HAS NO HEAD. An `N new` line used to open it, counting the window's new
// posts NOT already loaded as rows — so it never agreed with the bar's `N new`
// pill, which counts them all, and two figures for one fact is one too many
// (operator, 2026-09-26). The pill is the count.
//
// IT PULLS TO REFRESH, as focal does (operator, 2026-09-26): the feed's
// buffer shown and a fresh read poked, through the host's `onRefresh`. A pull
// is a gesture on the ROWS, so it passes nothing and marks nothing read.
//
// Its scrollbar is the silent default (web-workspace.md › *A scroll marker is
// a reading affordance*): a preview is not a place anyone reads to the end of.

const noRefresh = async () => {};

export function PreviewLayer({
  shown,
  opacityAt,
  width,
  anchor,
  onRefresh,
  messageColor,
  children,
}: {
  /** The compact state shows it; focal holds it unseen and `inert`, ready for
   *  a step back (§VII.3). */
  shown: boolean;
  /** Its opacity through a step (§VII.6). `inert` still follows `shown`, so it
   *  switches at the commit and never follows the crossfade. */
  opacityAt: QueueBinding;
  /** The clip's interior width: `CW − 2·VESSEL_WALL`. */
  width: number;
  /** Where this layer was left, held by the queue across unmounts. */
  anchor: { get: () => CardAnchor | undefined; set: (a: CardAnchor) => void };
  /** A pull at the top of the rows. Absent while the layer is held unseen. */
  onRefresh?: () => Promise<RefreshResult | void>;
  /** The mouth's result line — the feed palette's `cardMeta`. */
  messageColor?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useQueueBinding(rootRef, "opacity", opacityAt);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Put back at mount, before paint.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current.get();
    if (el && a) restoreCardAnchor(el, a);
  }, []);

  // Taken as the reader scrolls, once a frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        anchorRef.current.set(captureCardAnchor(el));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Rows landing above: a MutationObserver's callback runs after React's
  // commit and before the browser paints, so the view never visibly jumps.
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list) return;
    const mo = new MutationObserver(() => {
      const a = anchorRef.current.get();
      if (a && a.scrollTop > 0) restoreCardAnchor(el, a);
    });
    mo.observe(list, { childList: true });
    return () => mo.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      data-queue-preview=""
      {...(shown ? undefined : INERT)}
      // A click on a ROW is the row's to answer — a note walks and opens its
      // conversation on arrival, an article
      // opens the reader and the queue stays put (D6) — so it must not also
      // reach the compact entry, where any click walks. Between the rows it
      // still does.
      onClick={(e) => {
        if ((e.target as Element).closest?.("[data-post-id]")) e.stopPropagation();
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        bottom: BAR_H,
        width,
        zIndex: 1,
      }}
    >
      <div
        ref={scrollRef}
        style={{
          height: "100%",
          overflowY: "auto",
          overflowX: "clip",
          padding: VESSEL_PAD,
        }}
      >
        {/* Always mounted, so the list (and the observer on it) never remounts
            when the layer is shown or held; a held layer is `inert`, so its
            pull cannot fire anyway. */}
        <PullToRefresh
          onRefresh={onRefresh ?? noRefresh}
          scrollRef={scrollRef}
          messageColor={messageColor}
        >
          <div
            ref={listRef}
            style={{ display: "flex", flexDirection: "column", gap: VESSEL_GAP }}
          >
            {children}
          </div>
        </PullToRefresh>
      </div>
    </div>
  );
}
