"use client";

import { useEffect, useRef } from "react";

// =============================================================================
// Back-guard — "browser Back / OS edge-swipe closes the open sheet, it does not
// leave the site."
//
// The in-memory overlays (Messages, Dashboard, Library, Network, Ledger,
// Settings, the composers, the editor) and the mobile DM drill-down cover push
// NO history entry, so a hardware/edge Back has nothing to pop and navigates off
// the site. This module gives each such surface one history sentinel while it's
// open, and a single global popstate listener that — on Back — closes the
// topmost guarded surface instead of letting the navigation through.
//
// It is a LIFO stack: opening a surface pushes a sentinel; a real Back pops the
// top surface's close handler; closing a surface by its own means (✕ / Esc /
// scrim / swipe) consumes its sentinel via history.back(). Closes must be
// idempotent (calling twice is a harmless no-op) — every wired surface's close
// already is.
//
// The three URL-synced overlays (reader / profile / surface) manage their OWN
// history (they push a canonical URL and listen for popstate themselves — see
// stores/reader.ts et al.) and must NOT use this, or they'd double-push.
// =============================================================================

interface GuardEntry {
  id: number;
  close: () => void;
}

let stack: GuardEntry[] = [];
let nextId = 1;
// Number of upcoming popstate events to swallow — one per programmatic
// history.back() we fire when a surface closes by its own means (so that
// self-close doesn't also trip the Back-driven close path).
let suppress = 0;
let listening = false;

function onPop() {
  if (suppress > 0) {
    suppress -= 1;
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  // The browser already consumed this surface's sentinel entry. Drop it from
  // the stack first so the close()'s own teardown (which calls the released
  // unregister) is a no-op rather than firing a second history.back().
  stack = stack.slice(0, -1);
  top.close();
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("popstate", onPop);
  listening = true;
}

// Register a dismissible surface. Pushes a same-URL history sentinel and returns
// an unregister to call when the surface closes by its own means; the unregister
// consumes the sentinel so the history stack stays in sync. Safe on the server
// (no-op).
export function pushBackGuard(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  ensureListening();
  const id = nextId++;
  stack.push({ id, close });
  // Same-URL entry (no second arg) — adds a poppable step without changing the
  // address bar. Raw history manipulation is already the codebase's idiom for
  // overlay back-handling (stores/reader.ts).
  window.history.pushState({ ahBackGuard: id }, "");
  return () => {
    const idx = stack.findIndex((e) => e.id === id);
    if (idx === -1) return; // already removed by a Back-driven close
    stack.splice(idx, 1);
    // Consume our sentinel — but ONLY when it is still the TOP history entry.
    // The "surfaces unmount top-first" assumption breaks when this sheet opens a
    // URL-synced overlay (reader / profile / surface): that overlay pushes its
    // own canonical URL on top of our sentinel *before* the supersede unmounts
    // us, so a blind history.back() here pops the SUCCESSOR's entry, and its
    // popstate handler then closes the just-opened pane (H14 — reader/profile
    // flashed open then self-closed from any guarded mobile sheet). history.state
    // carries our sentinel id only while it is the top, so gate on it: if
    // something was pushed above us, leave the (now inert) sentinel buried rather
    // than popping the wrong entry.
    if ((window.history.state as { ahBackGuard?: number } | null)?.ahBackGuard === id) {
      suppress += 1;
      window.history.back();
    }
  };
}

// React binding: while `active`, this surface is a back-guarded dismissible.
// `onBack` is read through a ref so changing the closure doesn't re-register
// (which would churn the history sentinel) — only the active toggle does.
export function useBackGuard(active: boolean, onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!active) return;
    return pushBackGuard(() => cb.current());
  }, [active]);
}
