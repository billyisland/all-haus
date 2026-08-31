"use client";

import React from "react";
import Link from "next/link";
import { formatDateRelative } from "../../lib/format";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
import type { VesselPalette } from "./tokens";

// Shared byline row for the workspace card family (task 9b). One visual
// treatment — mono `label-ui` pip · name · time — used by the main card, the
// expanded reply thread (playscript entries), reply groups, and parent tiles,
// so a reply byline reads identically to a main-card byline. Always meta-sized
// (mono); the per-feed text-size control governs prose, never the chrome.
//
// `replyingTo` renders the non-adjacent-parent "→ NAME" affordance ahead of the
// speaker, in the same byline idiom (no bold-sans, no colon convention).
export function Byline({
  pipNode,
  name,
  nameHref,
  publishedAt,
  replyingTo,
  trailing,
  palette,
  className = "mb-2",
  nameRef,
  onNameMouseEnter,
  onNameMouseLeave,
  dataExplain,
  dragHandle,
}: {
  pipNode?: React.ReactNode;
  name: string;
  nameHref?: string;
  publishedAt: number;
  replyingTo?: { name: string } | null;
  trailing?: React.ReactNode;
  palette: VesselPalette;
  className?: string;
  // Byline-hover modal (§4.4): the author name anchors the profile preview.
  nameRef?: React.Ref<HTMLElement>;
  onNameMouseEnter?: () => void;
  onNameMouseLeave?: () => void;
  // Explain-engine leaf tag (EXPLAIN-ADR D4). Only PostByline passes it, so the
  // shared Byline stays untagged in its other (thread / playscript) contexts.
  dataExplain?: string;
  // This byline is the card's grab handle for drag-a-source-into-another-feed
  // (post/chassis.tsx::CARD_DRAG_HANDLE_SELECTOR). It reads as the right handle
  // because the gesture moves the SOURCE and the byline is what names it — and
  // `cursor: grab` is the only thing on the card that says so, which is why the
  // affordance lives here rather than on bare chrome the user has to discover.
  dragHandle?: boolean;
}) {
  const nameHover = {
    onMouseEnter: onNameMouseEnter,
    onMouseLeave: onNameMouseLeave,
  };
  return (
    <div
      className={`flex items-center gap-2 label-ui ${className}`}
      style={{ color: palette.cardMeta, cursor: dragHandle ? "grab" : undefined }}
      data-explain={dataExplain}
      data-card-drag-handle={dragHandle ? "" : undefined}
    >
      {replyingTo && (
        <>
          <span>&rarr;</span>
          <span className="font-medium">{replyingTo.name}</span>
          <span aria-hidden="true" style={{ display: "inline-block", width: 8 }} />
        </>
      )}
      {pipNode}
      {nameHref ? (
        <Link
          href={nameHref}
          ref={nameRef as React.Ref<HTMLAnchorElement>}
          onClick={(e) => {
            // Don't let the card's own click handler fire.
            e.stopPropagation();
            // Plain left-click opens the profile overlay in place; modified
            // clicks (new tab) fall through to the real link. The feed's
            // COLOURWAY travels with it, so the pane opens wearing this feed's
            // scheme entire (launched-from-this-feed cue).
            if (!isModifiedClick(e) && openProfileHref(nameHref, palette.scheme)) {
              e.preventDefault();
            }
          }}
          style={{ color: palette.cardTitle }}
          className="font-medium hover:underline"
          {...nameHover}
        >
          {name}
        </Link>
      ) : (
        <span
          ref={nameRef as React.Ref<HTMLSpanElement>}
          style={{ color: palette.cardTitle }}
          className="font-medium"
          {...nameHover}
        >
          {name}
        </span>
      )}
      <span>·</span>
      <time dateTime={new Date(publishedAt * 1000).toISOString()}>
        {formatDateRelative(publishedAt)}
      </time>
      {trailing}
    </div>
  );
}
