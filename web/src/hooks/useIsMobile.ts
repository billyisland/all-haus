"use client";

import { useEffect, useState } from "react";

// =============================================================================
// useIsMobile — the workspace's mobile breakpoint (MOBILE-LAYOUT-ADR §I).
//
// Mobile is not a responsive reflow of the canvas; it is a different
// interaction model (one feed per screen, paged horizontally). This hook is
// the single switch between the two. SSR/first paint resolves false (the
// desktop canvas) and corrects on mount — the workspace is client-rendered
// behind auth, so the flash window is the bootstrap spinner, not content.
// =============================================================================

const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
