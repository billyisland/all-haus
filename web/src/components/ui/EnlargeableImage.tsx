"use client";

import React from "react";
import { useLightbox } from "../../stores/lightbox";

// =============================================================================
// EnlargeableImage — a picture that opens at full size, and whose click is
// never ALSO something else.
//
// Every picture a card renders goes through here (PostMedia's hero, its extra
// visuals and the quoted thumbnail; QuotedPostTile's own image), so a new card
// image cannot quietly ship un-openable. The two that deliberately do NOT are
// affordances toward somewhere else and would be broken by hijacking their
// click: a LINK PREVIEW's thumbnail (the whole preview is one link — "an action
// whose product is a link is ONE button") and a VIDEO poster, whose click
// bubbles to the card by design so the card expands and the player starts.
//
// A card's own click expands or collapses it, so a picture inside one has to
// take its click back, and BOTH halves are needed: the chassis guards anchors
// (`closest("a")`) and nothing else, and the quoted path (`spec.insideHost`)
// is a bare div with no guard at all. Hence stopPropagation on click AND on
// keydown — a native button fires click from Enter, but the keydown goes on
// bubbling to the card's own Enter handler either way, so guarding the click
// alone leaves the keyboard opening the lightbox and toggling the card under it.
//
// The wrapper is a real <button> rather than an <img onClick>, for the reason
// Avatar's `enlargeable` branch already is: focus, Enter/Space and an
// accessible name come free. The name comes off the image's own `alt` where
// there is one — an aria-label here would REPLACE that description, not add to
// it — so only an alt-less picture gets the generic label.
// =============================================================================

export function EnlargeableImage({
  src,
  alt = "",
  className,
  style,
  wrapperClassName,
  wrapperStyle,
  loading = "lazy",
}: {
  src: string;
  alt?: string;
  /** Applied to the <img>, so a call site moves over unchanged. */
  className?: string;
  style?: React.CSSProperties;
  /** Applied to the button, which is the box the layout sees. */
  wrapperClassName?: string;
  wrapperStyle?: React.CSSProperties;
  loading?: "lazy" | "eager";
}) {
  return (
    <button
      type="button"
      aria-label={alt ? undefined : "View picture"}
      className={`focus-ring${wrapperClassName ? ` ${wrapperClassName}` : ""}`}
      style={{
        display: "block",
        padding: 0,
        border: 0,
        background: "none",
        cursor: "zoom-in",
        ...wrapperStyle,
      }}
      onClick={(e) => {
        e.stopPropagation();
        useLightbox.getState().open(src, alt);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
    >
      <img
        src={src}
        alt={alt}
        loading={loading}
        referrerPolicy="no-referrer"
        className={className}
        style={style}
      />
    </button>
  );
}
