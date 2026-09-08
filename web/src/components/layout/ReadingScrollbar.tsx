"use client";

// =============================================================================
// ReadingScrollbar — the opt-in that keeps a scroll marker on a reading page.
//
// Silence is the sitewide default (globals.css, "A scroll marker is a READING
// affordance"). A container opts back in by wearing `.ah-scrollbar` itself, but
// the two standalone reading routes — /article/:dTag and /read/:postId — scroll
// the DOCUMENT, and a document scroller has no element a page can put a class
// on. So this mounts in those pages and marks the root instead, the same shape
// as the `html.dark` toggle these pages already live under.
//
// BOTH <html> AND <body>. The viewport scrollbar is drawn from the root's
// styles, but which of the two the engine reads depends on the root's own
// overflow — so marking one and not the other leaves the answer to a rule
// elsewhere in the stylesheet. Marking both makes it not a question.
//
// It cleans up on unmount, because these routes are reachable by client-side
// navigation: without that, one visit to an article would leave the marker on
// for every workspace and feed the reader moved to afterwards.
// =============================================================================

import { useEffect } from "react";

export function ReadingScrollbar() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.add("ah-scrollbar");
    body.classList.add("ah-scrollbar");
    return () => {
      root.classList.remove("ah-scrollbar");
      body.classList.remove("ah-scrollbar");
    };
  }, []);
  return null;
}
