"use client";

// =============================================================================
// Lazy overlays (performance audit #4)
//
// Every over-workspace Glasshouse surface used to be statically imported and
// mounted unconditionally (rendering null until its store's `isOpen` flipped).
// That pulled all of them — including TipTap (EditorOverlay) and Stripe
// (Ledger/Settings) — into the initial bundle even though they only mount on
// demand.
//
// Here each overlay is:
//   1. code-split via `next/dynamic({ ssr: false })`, so its chunk leaves the
//      initial bundle, and
//   2. wrapped in a tiny *gate* that subscribes only to that overlay's
//      `isOpen` and renders the dynamic component **only while open** — so the
//      chunk is fetched on first open, not on mount. (A bare `<Dynamic />`
//      rendered unconditionally would fetch the chunk immediately on mount,
//      defeating the split.)
//
// Each overlay already returns null when closed and is opened via an external
// store action, so gating the mount on `isOpen` is behaviourally identical to
// the previous always-mounted-renders-null shape — only the chunk timing
// changes. The subscription lives in the small gate, not the big parent, so the
// parent (WorkspaceView / LayoutShell) doesn't re-render on open/close.
// =============================================================================

import dynamic from "next/dynamic";

import { useReader } from "../../stores/reader";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay } from "../../stores/libraryOverlay";
import { useNetworkOverlay } from "../../stores/networkOverlay";
import { useProfile } from "../../stores/profileOverlay";
import { useSurfaceOverlay } from "../../stores/surfaceOverlay";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useCompose } from "../../stores/compose";

// NB: `next/dynamic`'s options must be an *inline object literal* — the Next SWC
// transform rejects a shared `const opts` reference (tsc doesn't flag it), so
// `{ ssr: false }` is repeated at every call below intentionally.

// --- Workspace overlays (were in WorkspaceView) -----------------------------

const ReaderOverlayDyn = dynamic(
  () => import("./ReaderOverlay").then((m) => m.ReaderOverlay),
  { ssr: false },
);
export function LazyReaderOverlay() {
  const isOpen = useReader((s) => s.isOpen);
  return isOpen ? <ReaderOverlayDyn /> : null;
}

const MessagesOverlayDyn = dynamic(
  () => import("./MessagesOverlay").then((m) => m.MessagesOverlay),
  { ssr: false },
);
export function LazyMessagesOverlay() {
  const isOpen = useMessagesOverlay((s) => s.isOpen);
  return isOpen ? <MessagesOverlayDyn /> : null;
}

const DashboardOverlayDyn = dynamic(
  () => import("./DashboardOverlay").then((m) => m.DashboardOverlay),
  { ssr: false },
);
export function LazyDashboardOverlay() {
  const isOpen = useDashboardOverlay((s) => s.isOpen);
  return isOpen ? <DashboardOverlayDyn /> : null;
}

const LedgerOverlayDyn = dynamic(
  () => import("./LedgerOverlay").then((m) => m.LedgerOverlay),
  { ssr: false },
);
export function LazyLedgerOverlay() {
  const isOpen = useLedgerOverlay((s) => s.isOpen);
  return isOpen ? <LedgerOverlayDyn /> : null;
}

const SettingsOverlayDyn = dynamic(
  () => import("./SettingsOverlay").then((m) => m.SettingsOverlay),
  { ssr: false },
);
export function LazySettingsOverlay() {
  const isOpen = useSettingsOverlay((s) => s.isOpen);
  return isOpen ? <SettingsOverlayDyn /> : null;
}

const LibraryOverlayDyn = dynamic(
  () => import("./LibraryOverlay").then((m) => m.LibraryOverlay),
  { ssr: false },
);
export function LazyLibraryOverlay() {
  const isOpen = useLibraryOverlay((s) => s.isOpen);
  return isOpen ? <LibraryOverlayDyn /> : null;
}

const NetworkOverlayDyn = dynamic(
  () => import("./NetworkOverlay").then((m) => m.NetworkOverlay),
  { ssr: false },
);
export function LazyNetworkOverlay() {
  const isOpen = useNetworkOverlay((s) => s.isOpen);
  return isOpen ? <NetworkOverlayDyn /> : null;
}

// --- Layout-shell overlays (were in LayoutShell, in every page bundle) ------

const ProfileOverlayDyn = dynamic(
  () => import("./ProfileOverlay").then((m) => m.ProfileOverlay),
  { ssr: false },
);
export function LazyProfileOverlay() {
  const isOpen = useProfile((s) => s.isOpen);
  return isOpen ? <ProfileOverlayDyn /> : null;
}

const SurfaceOverlayDyn = dynamic(
  () => import("./SurfaceOverlay").then((m) => m.SurfaceOverlay),
  { ssr: false },
);
export function LazySurfaceOverlay() {
  const isOpen = useSurfaceOverlay((s) => s.isOpen);
  return isOpen ? <SurfaceOverlayDyn /> : null;
}

const EditorOverlayDyn = dynamic(
  () => import("./EditorOverlay").then((m) => m.EditorOverlay),
  { ssr: false },
);
export function LazyEditorOverlay() {
  const isOpen = useEditorOverlay((s) => s.isOpen);
  return isOpen ? <EditorOverlayDyn /> : null;
}

const ComposeOverlayDyn = dynamic(
  () => import("../compose/ComposeOverlay").then((m) => m.ComposeOverlay),
  { ssr: false },
);
// Compose has no `isOpen`-only render guard caller-side (LayoutShell already
// gates it on `!chromeless`); gate the *chunk* on the compose store's isOpen so
// it loads on first compose, while leaving the caller's `!chromeless` guard to
// decide whether the global compose surface participates at all.
export function LazyComposeOverlay() {
  const isOpen = useCompose((s) => s.isOpen);
  return isOpen ? <ComposeOverlayDyn /> : null;
}
