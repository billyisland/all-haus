"use client";

import { useEffect, useRef } from "react";

// =============================================================================
// Escape handling for a popover/dialog layered over a Glasshouse pane — the
// one home for the SchemeMenu/M22 pattern (§0k.3).
//
// Glasshouse's Escape-close listener lives on `window`, which fires AFTER any
// `document` listener in the bubble phase. So a popover that closes itself on
// a bare `document` Escape lets the event travel on and ALSO dismisses its
// host pane — the double-close. The fix is to claim the key: stop propagation
// so the window listener never sees it, and close only the topmost surface.
//
// `yieldTo` is for a surface that itself sits UNDER a higher transient modal
// (the AuthorModal → Lightbox case): when it returns true the event is left
// entirely alone — not stopped, not handled — so the modal above takes it.
// (stopPropagation can't arbitrate that case: both listeners sit on
// `document`, where registration order wins — yield explicitly instead.)
// =============================================================================

export function useEscapeShield(
  active: boolean,
  onEscape: () => void,
  yieldTo?: () => boolean,
): void {
  // Refs so callers can pass inline closures without re-registering the
  // listener (and losing its position in the registration order) per render.
  const onEscapeRef = useRef(onEscape);
  const yieldToRef = useRef(yieldTo);
  onEscapeRef.current = onEscape;
  yieldToRef.current = yieldTo;

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (yieldToRef.current?.()) return;
      e.stopPropagation();
      onEscapeRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}
