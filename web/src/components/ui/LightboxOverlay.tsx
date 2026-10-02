"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLightbox } from "../../stores/lightbox";
import { useBackGuard } from "../../lib/backGuard";

// =============================================================================
// LightboxOverlay — the single mounted image-enlarge surface (LayoutShell).
//
// Reads useLightbox; renders null until an image is opened. Click anywhere /
// Escape / the floating ✕ dismisses (the ✕ is the canonical close affordance,
// per the overlay-close rule). Floats above every surface at z-[70] (above the
// ForallMenu's z-60) because it's an explicit, transient modal — not a
// Glasshouse (those are capped at z-[56]). Scrim is `bg-black/80` (the black
// token + alpha, registry-resolved); the image sits centred, scaled to fit.
//
// FIT IS THE DEFAULT AND IT IS NOT ENOUGH ON ITS OWN. A card image opens here
// mostly because somebody screenshotted text, and a tall screenshot scaled into
// 85vh is exactly as unreadable as it was in the card — the enlarge would have
// been in name only. So a picture bigger than its fitted box toggles to its
// NATURAL size on a click and scrolls; a second click returns it to fit. The
// toggle is offered only when it would do something (measured on load, against
// the fitted box rather than the viewport — an image narrower than 85vw may
// still be taller than 85vh), and an image that already fits keeps the plain
// cursor and no affordance, rather than a control that visibly does nothing.
//
// Centring a scrollable child is `margin: auto` inside a flex container, NOT
// `justify/align-center` — a centred flex item that overflows its container is
// clipped at the START edge and the top of the picture cannot be scrolled to.
// =============================================================================

export function LightboxOverlay() {
  const { isOpen, src, alt, close } = useLightbox();
  const imgRef = useRef<HTMLImageElement>(null);
  // Whether the gesture that is about to produce a `click` began on the scrim
  // itself — see the wrapper's handlers.
  const pressedOutsideRef = useRef(false);
  // `canZoom` is measured, so it is false until the picture has loaded.
  const [canZoom, setCanZoom] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  // A new picture is a new question on both counts — this surface is mounted
  // once and only `src` changes, so neither can be left carrying.
  useEffect(() => {
    setZoomed(false);
    setCanZoom(false);
  }, [src]);

  // THE TOPMOST SURFACE OWNS BACK, AND THIS IS THE TOPMOST SURFACE. Without a
  // guard, an OS back gesture over an open lightbox fell through to whatever
  // was beneath — on a phone, the Glasshouse sheet the picture was opened
  // from — which closed the SHEET and left the picture standing over a page
  // that had already restored its own scroll. The ✕ then restored `hidden`
  // over the top of that and the page could not scroll again until a reload.
  // Registering here makes Back the twin of the ✕ for the lightbox exactly as
  // it is for every other dismissible, and the LIFO ordering does the rest:
  // the lightbox opens last, so it closes first.
  useBackGuard(isOpen, close);

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
      // RESTORE ONLY WHAT WE STILL OWN. Two surfaces save-and-restore this one
      // property, and a sheet closing underneath an open lightbox puts its own
      // value back first — so a blind restore here writes a stale `hidden`
      // over a page that has already been released, and nothing ever clears
      // it. If the value is no longer the one we set, somebody else is now in
      // charge of it and the honest thing is to leave it alone.
      if (document.body.style.overflow === "hidden") {
        document.body.style.overflow = prevOverflow;
      }
    };
  }, [isOpen, close]);

  if (!isOpen || !src) return null;

  // Measured against the FITTED box: `clientWidth/Height` is what the picture is
  // actually being shown at, so this asks "is anything being lost?" rather than
  // "is this bigger than the window?".
  function measure() {
    const el = imgRef.current;
    if (!el) return;
    setCanZoom(
      el.naturalWidth > el.clientWidth || el.naturalHeight > el.clientHeight,
    );
  }

  const interactive = canZoom || zoomed;

  return createPortal(
    <div
      // `.ah-scrollbar`: a zoomed picture is bigger than the window in BOTH
      // axes, and a scroll region with nothing to say it scrolls is a picture
      // that looks cropped. Scrollbars are silent by default sitewide and this
      // is what the opt-in is for — a reading affordance, on the one surface
      // here that is being read.
      // The topmost surface owns a wheel over it — see `useForwardedWheel`.
      data-lightbox=""
      className={`ah-scrollbar fixed inset-0 z-[70] flex overflow-auto bg-black/80 p-8${
        zoomed ? "" : " items-center justify-center"
      }`}
      // CLICK-OUTSIDE MEANS THE PRESS STARTED OUTSIDE. A `click` is dispatched
      // on the nearest common ancestor of its pointerdown and pointerup
      // targets, so a drag that begins on the zoomed picture and ends over the
      // scrim dispatches its click on THIS wrapper — and a bare `onClick`
      // therefore closes the lightbox at the end of a pan. The picture's own
      // `stopPropagation` cannot help: the event never passes through it. Same
      // pair the Glasshouse backdrop owes, for the same reason.
      onPointerDown={(e) => {
        pressedOutsideRef.current = e.target === e.currentTarget;
      }}
      onClick={() => {
        if (pressedOutsideRef.current) close();
      }}
    >
      <button
        type="button"
        onClick={close}
        aria-label="Close"
        className="focus-ring fixed right-6 top-6 text-3xl leading-none text-white/80 transition-colors hover:text-white"
      >
        ✕
      </button>
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onLoad={measure}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={
          interactive
            ? zoomed
              ? "Fit picture to the screen"
              : "View picture at full size"
            : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          if (interactive) setZoomed((z) => !z);
        }}
        onKeyDown={(e) => {
          if (!interactive) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setZoomed((z) => !z);
          }
        }}
        className={
          zoomed
            ? "m-auto max-h-none max-w-none cursor-zoom-out"
            : `max-h-[85vh] max-w-[85vw] object-contain ${
                canZoom ? "cursor-zoom-in" : "cursor-default"
              }`
        }
      />
    </div>,
    document.body,
  );
}
