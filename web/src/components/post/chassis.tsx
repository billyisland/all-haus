"use client";

import React from "react";
import type { Density, VesselPalette } from "../workspace/tokens";
import { isDragSurface } from "../../lib/dragSurface";
import {
  CARD_DRAG_MIME,
  beginCardDrag,
  endCardDrag,
} from "../../lib/workspace/cardDrag";

// The card's declared grab handle (see CARD_DRAG_HANDLE_ATTR's consumer,
// Byline.tsx). Bare card chrome grabs too, but it is only the padding ring and
// the gaps between rows — findable once you know, invisible until then.
export const CARD_DRAG_HANDLE_SELECTOR = "[data-card-drag-handle]";

// =============================================================================
// PostCard chassis — the shared shell + context for the unified card family.
//
// CardContext mirrors the workspace VesselCard's private context (density /
// palette / bodyPx) so PostCard drops into the ⊔ vessel with no visual change.
// Phase 5 will retire VesselCard's private copy in favour of this module.
//
// Separation rule (CLAUDE.md, absolute sitewide): this shell uses background
// fills + whitespace for spacing — no thin rules or dividers of any kind.
// =============================================================================

export interface CardContext {
  density: Density;
  palette: VesselPalette;
  bodyPx: number; // base reading size; the matrix textScale multiplies this
  dragData?: string;
  // The workspace feed this card is rendered in. Present only on feed surfaces
  // (absent on feedless surfaces like profile overlays / the reader). Drives
  // the feed-derived external Follow affordance (add-to-this-feed).
  feedId?: string;
  // The reading counts' mark for a FEED card (WORKSPACE-QUEUE-ADR §IV.8), off
  // the feed's window — never the loaded list, so the card and the bar's count
  // cannot disagree. PRESENT (even as null) means this card is counted: its
  // shell carries `data-seen-at` for the pass tracker. Absent on every surface
  // that does not count, and on the cards inside an expanded conversation,
  // which never mark anything passed. `read` = passed inside the window.
  seen?: "new" | "unread" | "read" | null;
}

/** The card's own padding, both densities. Exported because a card that is not
 *  a post — the profile's `PersonCard` — must take the same shell numbers
 *  rather than restate them; the shell itself is not reusable there (it hard-
 *  codes `data-explain="card"`, whose copy names a feed item). */
export const CARD_PADDING = { standard: "16px", tight: "8px 12px" } as const;

export function PostCardShell({
  ctx,
  postId,
  indentPx,
  gapBelowPx,
  onClick,
  explainParam,
  seenAt,
  receded = false,
  children,
}: {
  ctx: CardContext;
  // The post this card renders, as a DOM attribute. A host that needs to know
  // which cards a reader actually saw (PostThread's seen-marking, which feeds
  // the workspace's weed-on-collapse) observes `[data-post-id]` inside its own
  // root. It is on the SHELL rather than on a wrapper div deliberately: the
  // gutter-pointer clash test walks `spineRef`'s direct children one rect each,
  // and a wrapper's rect spans the container's full width whatever its child's
  // margin is — interposing one would put back the exact bug the 2026-09-12
  // narrowing fixed.
  postId?: string;
  indentPx: number;
  gapBelowPx: number;
  onClick?: () => void;
  // Explain card flavour (registry.ts::explainCardFlavour): rides the card as
  // data-explain-param so the Explain hover caption can say WHAT KIND of card
  // this is (a Bluesky post, an RSS item, …). Absent → the generic card copy.
  explainParam?: string | null;
  // A COUNTED feed card's publishedAt (unix seconds): rides the shell as
  // `data-seen-at`, which is what `usePassTracker` observes. Absent on every
  // card the reading counts do not track.
  seenAt?: number;
  // A READ card's ground darkens, in both modes (§IV.8, inverted 2026-09-24). Its own prop, not
  // read off `seenAt`: a queue preview row recedes and must not be tracked
  // (§VII.5).
  receded?: boolean;
  children: React.ReactNode;
}) {
  const padding =
    ctx.density !== "standard" ? CARD_PADDING.tight : CARD_PADDING.standard;
  // Every density can be dragged. The old standard-only gate existed because a
  // tightened card has almost no bare chrome left to grab by — but the byline
  // handle below is present at every density, and a condensed / headline feed is
  // exactly where source curation happens.
  const canDrag = !!ctx.dragData;
  const rootRef = React.useRef<HTMLDivElement>(null);

  // `draggable` and text selection are mutually exclusive: a draggable element
  // swallows the mousedown that would otherwise begin a selection. So instead of
  // pinning `draggable` on, we resolve it per pointerdown — land on the byline
  // handle or on bare card chrome (padding / margins) and the HTML5
  // drag-to-another-feed is armed; land on the body text, a link, or a control
  // and we disarm it so the browser is free to select or click. Set imperatively
  // (not via state) so it lands before the same gesture's dragstart, with no
  // re-render race.
  const onPointerDown = canDrag
    ? (e: React.PointerEvent) => {
        const el = rootRef.current;
        if (!el || e.button !== 0) return;
        el.draggable = isDragSurface(
          e.target as Element,
          el,
          e.clientX,
          e.clientY,
          CARD_DRAG_HANDLE_SELECTOR,
        );
      }
    : undefined;

  // A body click focuses the card (expand), but ending a text drag-select must
  // not: at click time a real selection is non-empty (a plain click leaves it
  // collapsed/empty), so bail then. Links carry their own stopPropagation, but
  // guard anchor targets too in case one slips through.
  const handleClick = onClick
    ? (e: React.MouseEvent) => {
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
        if ((e.target as Element).closest?.("a")) return;
        onClick();
      }
    : undefined;

  return (
    <div
      ref={rootRef}
      data-post-id={postId}
      data-seen-at={seenAt}
      data-receded={receded || undefined}
      data-explain="card"
      data-explain-param={explainParam ?? undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={
        onClick
          ? (e) => {
              // Mirror the click path's anchor guard: Enter on a focused link
              // inside the card must follow the link (native default), never
              // toggle the card.
              if ((e.target as Element).closest?.("a")) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onDragStart={
        canDrag
          ? (e) => {
              e.dataTransfer.setData(CARD_DRAG_MIME, ctx.dragData!);
              e.dataTransfer.effectAllowed = "move";
              // dataTransfer is unreadable during dragover, so publish the
              // origin feed for the gesture's lifetime — that is what lets the
              // OTHER vessels light up and this one stay quiet.
              beginCardDrag(ctx.feedId);
            }
          : undefined
      }
      onDragEnd={canDrag ? () => endCardDrag() : undefined}
      style={{
        // Unread cards are the plain card; a READ one is DARKER, in both
        // modes (§IV.8; fading the ink instead read as tired eyes, 2026-09-24).
        // Anchored on `true-black`, which never inverts, so the branch on
        // isDark picks only an AMOUNT and cannot count the inversion twice
        // (web-theme.md). A dark card sits ~10-15 levels above its interior,
        // so 6% would not show there; 15% lands about halfway down to the
        // ground and the card still stands off it. Nothing on the edge: the
        // 4px left bar is the provenance slab and crimson means paid.
        background: receded
          ? `color-mix(in srgb, ${ctx.palette.cardBg}, var(--ah-true-black) ${ctx.palette.isDark ? 15 : 6}%)`
          : ctx.palette.cardBg,
        padding,
        marginLeft: indentPx || undefined,
        marginBottom: gapBelowPx || undefined,
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}
