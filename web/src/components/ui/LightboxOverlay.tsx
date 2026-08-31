"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useLightbox } from "../../stores/lightbox";

// =============================================================================
// LightboxOverlay — the single mounted image-enlarge surface (LayoutShell).
//
// Reads useLightbox; renders null until an image is opened. Click anywhere /
// Escape / the floating ✕ dismisses (the ✕ is the canonical close affordance,
// per the overlay-close rule). Floats above every surface at z-[70] (above the
// ForallMenu's z-60) because it's an explicit, transient modal — not a
// Glasshouse (those are capped at z-[56]). Scrim is `bg-black/80` (the black
// token + alpha, registry-resolved); the image sits centred, scaled to fit.
// =============================================================================

export function LightboxOverlay() {
  const { isOpen, src, alt, close } = useLightbox();

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // The Lightbox is the topmost modal (z-70, above every Glasshouse), so
        // Escape must close ONLY it — not the Glasshouse underneath (which would
        // also fire its history.back() for a URL-synced pane). This document
        // listener runs before Glasshouse's window listener in the bubble phase,
        // so stopping propagation here keeps the pane below open (M22).
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    // Lock body scroll while enlarged so the page behind doesn't move.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, close]);

  if (!isOpen || !src) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-8"
      onClick={close}
    >
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="focus-ring absolute right-6 top-6 text-3xl leading-none text-white/80 transition-colors hover:text-white"
      >
        ✕
      </button>
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-[85vw] cursor-default object-contain"
      />
    </div>,
    document.body,
  );
}
