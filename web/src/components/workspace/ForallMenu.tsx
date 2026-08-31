"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useUnreadCounts } from "../../stores/unread";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay } from "../../stores/libraryOverlay";
import { useNetworkOverlay } from "../../stores/networkOverlay";
import { useGlasshousePresence } from "../../stores/glasshouse";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useColorScheme } from "../../stores/colorScheme";
import { useExplain } from "../../stores/explain";
import { useAboutOverlay } from "../../stores/aboutOverlay";
import { useOpenExplain, useExplainable } from "./ExplainProvider";
import { SearchPanel } from "./SearchPanel";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import { NAV_BAR_INSET } from "./NavBar";

const TOKENS = {
  buttonBg: "var(--ah-ink-925)",
  buttonFg: "var(--ah-bone)",
  glyphFg: "var(--ah-bone)", // workspace floor colour (FLOOR in WorkspaceView)
  itemFg: "var(--ah-ink-925)",
  itemFocusBg: "rgb(var(--ah-ink-rgb) / 0.06)", // subtle dark wash on the warm pane
  itemMuted: "var(--ah-grey-600)", // grey-600 — legible on the mid-light glasshouse pane
  badgeBg: "var(--ah-crimson)",
  badgeFg: "var(--ah-white)",
};

export type ForallAction = "new-feed" | "new-note";

// NOTHING ON THE BAR IS TURNED. The two labels that live in the lockup — the
// wordmark and the About pill that stands in for it under Explain — are plain
// horizontal type. They were set bottom-to-top (`writing-mode: vertical-rl`
// plus a 180° box turn) for the one year the chrome ran up the left margin;
// that went with the bar's move to the top edge (NavBar.tsx). Do not
// reintroduce a writing mode here.

export interface HiddenFeed {
  id: string;
  name: string;
}

interface ForallMenuProps {
  onAction: (key: ForallAction) => void;
  hiddenFeeds?: HiddenFeed[];
  onRestore?: (feedId: string) => void;
  /** The feed the menu is relativised to — the one under the reader's thumb on
   *  the mobile pager. When set, the menu carries a feed-scoped "Feed settings"
   *  row (the discoverable twin of tapping the active pip — MOBILE-LAYOUT-ADR
   *  §VI). Null on the desktop canvas, where there is no single active feed and
   *  each vessel carries its own gear, so the row is suppressed there. */
  currentFeed?: { id: string; name: string } | null;
  /** Open the FeedComposer for the feed-scoped row's target. */
  onFeedSettings?: (feedId: string) => void;
  /** Placement of the ∀ trigger. "row" docks the whole lockup (disc + wordmark,
   *  adjacent) into the LEFT end of the desktop nav bar, menu opening DOWNWARD
   *  (WORKSPACE-COLUMN-LAYOUT-ADR §VI, as re-oriented 2026-08-25 — NavBar.tsx).
   *  The disc comes FIRST and the wordmark sits to its right: the mark, then its
   *  name. It was "rail" for a day (the lockup stood on end at the top of a left
   *  margin, wordmark under the disc, menu opening rightward) and a bottom-row
   *  "row" before that (lockup at the RIGHT end, wordmark LEFT of the disc, menu
   *  opening upward). Neither turn survives: everything here is horizontal.
   *  "bar" docks a smaller disc into the mobile bar's right end, with the menu
   *  dropping DOWN below the bar (MOBILE-LAYOUT-ADR §III — the bar's burger is
   *  the ∀, the existing command surface, not a second menu system); mobile
   *  never moved, so that branch has been untouched throughout. Same rows, same
   *  z-60 crisp-above-the-frost invariant. */
  anchor?: "row" | "bar";
}

type View = "closed" | "menu" | "search";

// Flattened, keyboard-navigable menu rows. Order here is the arrow-key order.
type FocusRow =
  | { kind: "action"; key: ForallAction; label: string }
  | { kind: "open"; target: "search"; label: string; count: number }
  | {
      kind: "overlay";
      onOpen: () => void;
      label: string;
      count: number;
      // Secondary-tier destinations (Library / Network / Ledger / Settings)
      // render in the muted weight so the menu reads as a primary pair
      // (Messages · Dashboard) over a quieter account cluster, without dropping
      // any destination (they all stay reachable here).
      muted?: boolean;
      // Generic disable machinery (dim + title, inert on select). Currently
      // unused — the D10 Explain-while-pane-open disable was retired when
      // pane-mode Explain shipped (2026-07-15) — but kept as row plumbing.
      disabled?: boolean;
      disabledTitle?: string;
    }
  | { kind: "link"; href: string; label: string; count: number }
  | { kind: "restore"; id: string; label: string };

export function ForallMenu({
  onAction,
  hiddenFeeds = [],
  onRestore,
  currentFeed = null,
  onFeedSettings,
  anchor = "row",
}: ForallMenuProps) {
  const inBar = anchor === "bar";
  // Disc 40 / wordmark 24 in the nav bar (§V lockup rebalance,
  // FORALL-CUT-AND-LOCKUP-ADR): disc/cap-height ≈ 2.3, so the two read as kin
  // on one axis rather than a disc looming over a label. The docked disc is a
  // touch smaller than the old floating 46. It is also the number the bar's own
  // height is built from (`NAV_BAR_H = NAV_BAR_INSET + 40`), so a disc resize is
  // not a local change — read NavBar.tsx before touching it. The wordmark scales
  // with it (28 → 24).
  const discSize = inBar ? 36 : 40;
  const wordmarkSize = 24;
  // The disc inverts under global dark mode — a light bone disc with a dark ink
  // glyph, the photo-negative of the light-mode dark disc. The disc stays
  // islanded (its tokens resolve to canonical light in both modes), so we pick
  // the swapped token explicitly rather than letting the root inversion do it.
  // The dropdown menu is unaffected (still light). See globals.css dark block.
  const dark = useColorScheme((s) => s.dark);
  const discBg = dark ? "var(--ah-bone)" : TOKENS.buttonBg;
  const discGlyph = dark ? "var(--ah-ink-925)" : TOKENS.glyphFg;
  // The wordmark now lives INSIDE the islanded lockup container (it was its own
  // fixed layer only because the lens needed an un-nested blend group). Inside
  // the island `var(--ah-ink)` resolves canonical-dark in both modes, which
  // would read dark-on-dark against the inverted nav bar — so, like the disc,
  // it picks its mode explicitly. It matches the disc's GROUND, not its glyph:
  // ink on the light bone bar, bone on the inverted dark bar.
  const chromeFg = discBg;
  const router = useRouter();
  const logout = useAuth((s) => s.logout);
  const dmCount = useUnreadCounts((s) => s.dmCount);
  const notificationCount = useUnreadCounts((s) => s.notificationCount);
  const totalUnread = dmCount + notificationCount;

  // On the mobile workspace every Glasshouse is a full-screen sheet (note /
  // article / feed composers, reader, profile, the six destinations …), so the
  // disc is the minimise-X for *any* of them — the sheet's only dismiss
  // affordance on touch. The presence registry tracks whichever single sheet
  // is live; we collapse it to the disc-X and close it on tap. On DESKTOP the
  // disc never flips to an X for an open pane (removed 2026-07-15 — that was
  // mobile's necessity bleeding into a surface with ✕ / Esc / scrim-click to
  // spare): it stays the ∀ and the menu opens OVER any pane, which is also
  // what makes Explain reachable while one is up.
  const isMobile = useIsMobile();
  const glasshouseOpen = useGlasshousePresence((s) => s.isOpen);
  const mobileSheetOpen = isMobile && glasshouseOpen;

  // Explain chrome swap (EXPLAIN-ADR D3, 2026-07-15 form). While an Explain
  // program is active only the WORDMARK gives way to an "About all.haus"
  // button; the ∀ disc itself stays on screen, is annotated in place (hovering
  // it surfaces the `disc` label), and clicking it exits Explain — no more
  // awkwardly describing an invisible menu. `isActive` is only ever set on the
  // desktop floor (Explain is desktop-only), so this naturally scopes to the
  // floating anchor. While the About pane itself is open the About button is
  // suppressed (the pane owns its own dismiss) and the disc flips to the X,
  // closing the pane back to Explain. PANE-mode Explain (annotating an open
  // Glasshouse, D10 reversal) suppresses the swap entirely: clicking About
  // there would open a pane that SUPERSEDES the very pane being explained (the
  // one-Glasshouse rule) — a rug-pull — so the wordmark stays put.
  const explainActive = useExplain((s) => s.isActive);
  const paneExplain = useExplain((s) => s.program?.surface === "pane");
  const aboutOpen = useAboutOverlay((s) => s.isOpen);
  const openExplain = useOpenExplain();

  const [view, setView] = useState<View>("closed");

  // On mobile the ∀ menu and its in-place panels (Search) are not Glasshouse
  // sheets, so they aren't tracked by the presence registry above — yet the
  // disc is still the only way to dismiss them (no outside-click target, no ✕
  // on the panel). So treat any open ∀ surface as a close state on mobile too:
  // the disc shows the X and `onTriggerClick`'s toggle (view !== "closed" →
  // "closed") dismisses it. Desktop keeps the disc as ∀ while the dropdown is
  // open — a mouse can click outside, and an X on a small anchored dropdown
  // would read oddly.
  const mobileMenuOpen = isMobile && view !== "closed";
  // The disc shows the close glyph whenever it would act as a minimise-X: any
  // mobile sheet / open mobile menu, and — the one desktop X left — the About
  // pane opened from Explain (a click closes it back to Explain). During plain
  // Explain the disc keeps the ∀: it is being annotated as the menu, so it
  // must look like the menu.
  const showClose =
    mobileSheetOpen || mobileMenuOpen || (explainActive && aboutOpen);
  // The difference lens is GONE (WORKSPACE-COLUMN-LAYOUT-ADR §VI). The disc no
  // longer floats over the canvas compositing `mix-blend-mode: difference`
  // against it: it is docked in an opaque nav row, so there is nothing left for
  // it to float over, and the viewport-sized blend surface it re-rendered on
  // every scroll frame is no longer paid for. What that deleted with it: the
  // `lensMode` derivation and its painted/punched swap, the `body { isolation }`
  // scope and the canvas isolation, the z-index:auto stacking-context
  // choreography, and `stores/lensSuppress.ts` with the self-declaring
  // suppressors in NewFeedPrompt / LightboxOverlay. The ∀ mark, the menu and
  // the ceremony are untouched — only the blend and the float go.
  const [activeIndex, setActiveIndex] = useState(0);
  // ∀ glyph rotation. Hover rotates it to 180° (a right-side-up A) and holds;
  // leaving completes the turn to 360° (back to ∀), then snaps to 0 for next
  // time. `spinTransition` is dropped to "none" only for that invisible
  // 360°→0° reset so it doesn't visibly unwind.
  const [glyphRot, setGlyphRot] = useState(0);
  const [spinTransition, setSpinTransition] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The `disc` explainable root is the REAL ∀ disc (2026-07-15 rework: the
  // chrome swap keeps the disc on screen, replacing only the wordmark), so the
  // first-run beat-4 leader and any anchored fallback point at the disc itself.
  useExplainable<HTMLButtonElement>("disc", { ref: buttonRef });

  // Rows are grouped find → make → go: search first (the way in), then the
  // create actions, then the destinations, then any hidden-feed restores. The
  // groups render with a tight gap between them and flatten into `rows` for
  // arrow-key navigation.
  const findRows: FocusRow[] = [
    { kind: "open", target: "search", label: "Search", count: 0 },
  ];
  // Feed-scoped row — present only when the menu is relativised to a feed (the
  // mobile pager's active feed). Its own group, directly under Search, so the
  // action that's about "the thing you're looking at" sits at the top of the
  // make/do region. Reuses the overlay row (an onOpen closure) rather than a
  // new ForallAction, since it targets a specific feed, not a global create.
  const feedRows: FocusRow[] =
    currentFeed && onFeedSettings
      ? [
          {
            kind: "overlay",
            onOpen: () => onFeedSettings(currentFeed.id),
            label: "Feed settings",
            count: 0,
          },
        ]
      : [];
  const createRows: FocusRow[] = [
    // One write entry. It opens the note composer; article writing is reached
    // through its "Make this an article →" escalation (which carries the typed
    // body along), never a second menu row.
    { kind: "action", key: "new-note", label: "Write something" },
    { kind: "action", key: "new-feed", label: "New feed" },
  ];
  // The "what is this place" group (EXPLAIN-ADR §8, keep the menu slim).
  // Desktop: Explain alone (2026-07-16, amendment 11) — About left the menu;
  // it is reached through Explain's own "About all.haus" button (the wordmark
  // swap) or /about. Mobile: About alone — Explain has no hover branch there
  // (ADR §Surface), so the row it would occupy carries the About page instead.
  const explainRows: FocusRow[] = isMobile
    ? [
        {
          kind: "overlay",
          onOpen: () => useAboutOverlay.getState().open(),
          label: "About",
          count: 0,
        },
      ]
    : [
        {
          kind: "overlay",
          onOpen: () => openExplain(),
          label: "Explain",
          count: 0,
        },
      ];
  // The go-group keeps all six destinations but reads in two tiers: a primary
  // pair (the high-traffic inbox + dashboard) over a muted account cluster.
  // Same group-gap separates them; the muted weight does the demoting.
  const goPrimaryRows: FocusRow[] = [
    {
      // Notifications folded into Messages — one merged inbox surface. The count
      // is the combined unread (DMs + notifications).
      kind: "overlay",
      onOpen: () => useMessagesOverlay.getState().open(),
      label: "Messages",
      count: dmCount + notificationCount,
    },
    {
      kind: "overlay",
      onOpen: () => useDashboardOverlay.getState().open(),
      label: "Dashboard",
      count: 0,
    },
  ];
  const goSecondaryRows: FocusRow[] = [
    {
      kind: "overlay",
      onOpen: () => useLibraryOverlay.getState().open(),
      label: "Library",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useNetworkOverlay.getState().open(),
      label: "Network",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useLedgerOverlay.getState().open(),
      label: "Ledger",
      count: 0,
      muted: true,
    },
    {
      kind: "overlay",
      onOpen: () => useSettingsOverlay.getState().open(),
      label: "Settings",
      count: 0,
      muted: true,
    },
  ];
  const restoreRows: FocusRow[] = hiddenFeeds.map((hf) => ({
    kind: "restore",
    id: hf.id,
    label: hf.name,
  }));
  // Sign-out is the terminal action, in its own group at the very bottom. It
  // lives here because the retired black topbar's avatar dropdown used to carry
  // it and there is no topbar anywhere any more — the ∀ is the member's sole
  // nav. logout() clears the session; WorkspaceView's `!user` guard then
  // bounces to /auth.
  const accountRows: FocusRow[] = [
    {
      kind: "overlay",
      onOpen: () => {
        void logout();
      },
      label: "Log out",
      count: 0,
    },
  ];
  const groups: FocusRow[][] = [
    findRows,
    feedRows,
    createRows,
    explainRows,
    goPrimaryRows,
    goSecondaryRows,
    restoreRows,
    accountRows,
  ].filter((g) => g.length > 0);
  const rows: FocusRow[] = groups.flat();

  function closeAll() {
    setView("closed");
    buttonRef.current?.focus();
  }

  // The disc / wordmark trigger. On mobile, with a sheet open, it is the
  // back-to-workspace button (close the sheet); otherwise — including on
  // desktop with any pane open — it toggles the command menu, which renders at
  // z-60 above every Glasshouse.
  function onTriggerClick() {
    // While Explain is active the disc is the way back out (EXPLAIN-ADR D3,
    // 2026-07-15 form): close the About pane if it is open (back to Explain),
    // else close Explain itself (in pane mode the explained pane stays open —
    // the click sheds only the annotations). Never toggle the menu over the
    // frozen surface.
    if (explainActive) {
      if (aboutOpen) useAboutOverlay.getState().close();
      else useExplain.getState().close();
      return;
    }
    // Mobile: any open full-screen sheet (incl. the six destinations, which are
    // also Glasshouses) minimises through the presence registry.
    if (mobileSheetOpen) {
      useGlasshousePresence.getState().close();
      return;
    }
    setView((v) => (v === "closed" ? "menu" : "closed"));
  }

  function selectRow(row: FocusRow) {
    switch (row.kind) {
      case "action":
        setView("closed");
        buttonRef.current?.focus();
        onAction(row.key);
        return;
      case "open":
        setView(row.target);
        return;
      case "overlay":
        if (row.disabled) return; // D10: inert while disabled (keep menu open)
        setView("closed");
        buttonRef.current?.focus();
        row.onOpen();
        return;
      case "link":
        setView("closed");
        buttonRef.current?.focus();
        router.push(row.href);
        return;
      case "restore":
        setView("closed");
        buttonRef.current?.focus();
        onRestore?.(row.id);
        return;
    }
  }

  // Outside-click + Esc close any open surface (menu or panel). The panels
  // render inside this same container, so one handler covers all of them.
  useEffect(() => {
    if (view === "closed") return;
    const onDocClick = (e: MouseEvent) => {
      // One check covers the whole lockup: the wordmark is now a CHILD of this
      // container (it needed its own fixed layer only for the lens), so a click
      // on it — which toggles the menu — is never an outside click.
      if (containerRef.current?.contains(e.target as Node)) return;
      setView("closed");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setView("closed");
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [view]);

  // Reset + focus the first menu row each time the menu opens.
  useEffect(() => {
    if (view === "menu") setActiveIndex(0);
  }, [view]);

  useEffect(() => {
    if (view === "menu") itemRefs.current[activeIndex]?.focus();
  }, [view, activeIndex]);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    }
  }

  // Spin transform for the ∀/X glyph group (§IV.1). Carries the 360°→0° snap
  // reset handler; the punched lens variant that shared it is gone.
  const spinStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    transformOrigin: "center",
    // The close glyph never spins — when it's showing, the hover spin is
    // pinned to 0 and the ∀↔X swap is carried by the two morph groups.
    transform: `rotate(${showClose ? 0 : glyphRot}deg)`,
    transition: spinTransition ? "transform 480ms ease-in-out" : "none",
  };
  const onSpinTransitionEnd = (e: React.TransitionEvent<SVGSVGElement>) => {
    // The completing turn has landed back at ∀ — snap 360°→0° with no
    // transition so the next hover starts cleanly from upside-down. Only the
    // svg's own transform counts (the glyph groups bubble their morph
    // transitions up here too).
    if (
      e.target === e.currentTarget &&
      e.propertyName === "transform" &&
      glyphRot === 360
    ) {
      setSpinTransition(false);
      setGlyphRot(0);
    }
  };

  // The unread badge rides the button (part of the click target). It used to
  // need a hoisted un-blended twin in lens mode; with the lens gone there is
  // one badge, in one place.
  const unreadBadge =
    totalUnread > 0 ? (
      <span
        aria-hidden="true"
        className="font-mono"
        style={{
          position: "absolute",
          top: -2,
          right: -2,
          minWidth: 20,
          height: 20,
          padding: "0 6px",
          borderRadius: 10,
          background: TOKENS.badgeBg,
          color: TOKENS.badgeFg,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: "20px",
          textAlign: "center",
          border: `2px solid ${discBg}`,
        }}
      >
        {totalUnread > 99 ? "99+" : totalUnread}
      </span>
    ) : null;

  return (
    <>
      <div
        ref={containerRef}
        style={
          // Light island: the dropdown is LOCKED chrome — it stays light in both
          // modes (its tokens resolve to canonical light here). The disc lives in
          // the same island so its tokens also resolve light, but it explicitly
          // INVERTS its fill/glyph under dark mode (discBg/discGlyph above): a
          // light bone disc + dark ink glyph, the photo-negative of light mode.
          // The wordmark, now a child of this same container, picks its mode the
          // same explicit way (chromeFg).
          inBar
            ? { ...LIGHT_ISLAND_STYLE, position: "fixed", right: 8, top: 6, zIndex: 60 }
            : {
                // The LOCKUP, in one fixed container docked at the nav bar's
                // LEFT end (§VI): disc and wordmark adjacent, reading as one mark
                // (FORALL-CUT-AND-LOCKUP-ADR §V). The wordmark's own fixed layer
                // is gone — it existed only so the lens could blend without a
                // stacking context between it and the canvas, and there is no
                // lens. NOT centred across the bar: the disc's top sits one
                // GRID down (`NAV_BAR_INSET`) and its bottom IS the band's
                // bottom edge, so the floor's own top buffer supplies a matching
                // GRID below it. NavBar.tsx carries the whole reasoning — the
                // short version is that the gap a reader actually sees below the
                // disc is the one to the first vessel, not to the invisible edge
                // of the band.
                //
                // `left: 24` is the inset from the end the lockup docks at — the
                // same 24 the bottom row and the left rail each used from
                // theirs. The main axis is `row-reverse`, NOT `row`: the disc
                // reads FIRST (∀ · all.haus, the mark before its name) while the
                // DOM order stays About/wordmark-then-disc, exactly as it has
                // been through both moves, so tab order has never turned.
                ...LIGHT_ISLAND_STYLE,
                position: "fixed",
                left: 24,
                top: NAV_BAR_INSET,
                zIndex: 60,
                display: "flex",
                flexDirection: "row-reverse",
                alignItems: "center",
                gap: 14,
              }
        }
      >
      {/* D3 chrome swap (2026-07-15 form, re-anchored into the row): while an
          Explain program is active only the WORDMARK slot gives way to an
          "About all.haus" button — the disc stays, gets annotated as itself,
          and its click exits Explain (onTriggerClick above). It inherits the
          container's island, then takes the same dark-mode photo-negative (bone
          pill + ink label). Suppressed while the About pane is open (the pane
          owns its own dismiss); restored on close. Also suppressed for the whole
          of a PANE-mode program (see paneExplain above) — opening About would
          supersede the explained pane. */}
      {!inBar && explainActive && !paneExplain && !aboutOpen && (
        <button
          type="button"
          className="forall-trigger font-sans font-medium"
          aria-label="About all.haus"
          onClick={() => {
            // Clear the hover before the pane mounts: opening About unmounts
            // this button without a mouseleave, and a stale `about` bubble
            // would linger faintly under the Glasshouse frost.
            useExplain.getState().setHover(null);
            useAboutOverlay.getState().open();
          }}
          // The button sits above the Explain scrim, so the scrim's
          // pointermove hit-test never reaches it — it reports its own hover
          // (the `about` label) to honour Explain's "hover anything, read its
          // label" contract. Click opens About; hover teaches.
          onMouseEnter={() =>
            useExplain.getState().setHover({ kind: "about" })
          }
          onMouseLeave={() => useExplain.getState().setHover(null)}
          style={{
            // The elongated disc, lying down with the bar: the pill keeps the
            // disc's diameter as its HEIGHT and takes 22px of breathing room at
            // each end of the label. (Standing this on end was the rail's one
            // concession; on the bar it is simply a pill again.)
            height: discSize,
            display: "flex",
            alignItems: "center",
            padding: "0 22px",
            borderRadius: discSize / 2,
            background: discBg,
            color: discGlyph,
            border: "none",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          About all.haus
        </button>
      )}
      {/* Wordmark — "all.haus" set to the RIGHT of the ∀ disc so the two read as
          one mark (glyph · text). It is part of the trigger's click target (same
          toggle + glyph-spin as the disc) and, like the disc, stays CRISP above
          the frost: the container sits at z-60, above the Glasshouse scrim
          (z-[55]), so an open overlay never blurs or dims it. Row anchor only —
          the mobile bar carries its own wordmark. Gives way to the About button
          while a FLOOR-mode Explain program is active; stays put through a
          pane-mode one. */}
      {!inBar && (!explainActive || paneExplain) && (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={onTriggerClick}
          onMouseEnter={() => {
            setSpinTransition(true);
            setGlyphRot(180);
          }}
          onMouseLeave={() => {
            setSpinTransition(true);
            setGlyphRot(360);
          }}
          style={{
            // No fixed width: the wordmark is horizontal type again, so it sizes
            // to its own text and the flex container shrinks to the pair. (The
            // rail pinned it to `discSize` because a turned label had to be
            // centred across a 56px band.)
            display: "flex",
            alignItems: "center",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <span
            className="font-sans font-medium leading-none"
            style={{
              // 24 with the 40px bar disc — §V's disc/cap-height ≈ 2.3 carried
              // over from the 46/28 floating pair, so the two still read as kin.
              fontSize: wordmarkSize,
              // Explicit, not var(--ah-ink): inside the island that would
              // resolve canonical-dark in both modes and read dark-on-dark
              // against the inverted nav row.
              color: chromeFg,
              letterSpacing: "-0.01em",
            }}
          >
            all.haus
          </span>
        </button>
      )}

      {view === "menu" && (
        <div
          role="menu"
          aria-label="Workspace actions"
          onKeyDown={onMenuKey}
          className="bg-glasshouse shadow-lg"
          style={{
            position: "absolute",
            // Track discSize (§V follow-through) rather than a fixed 64, so a
            // disc resize can't silently widen the disc↔menu gap. On the bar the
            // menu opens DOWNWARD (§VI) — into the floor, the only direction
            // with room — flush with the disc's leading edge, which is now the
            // container's left. discSize + 18 clears both the disc and the bar.
            ...(inBar
              ? { right: 0, top: discSize + 8 }
              : { left: 0, top: discSize + 18 }),
            minWidth: 240,
            padding: 6,
          }}
        >
          {(() => {
            let flat = 0;
            return groups.map((group, gi) => (
              <div key={gi} style={gi > 0 ? { marginTop: 6 } : undefined}>
                {group.map((row) => {
                  const idx = flat++;
                  return (
                    <MenuRow
                      key={idx}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      row={row}
                      active={idx === activeIndex}
                      onSelect={() => selectRow(row)}
                      onHover={() => setActiveIndex(idx)}
                    />
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}

      {view === "search" && (
        <SearchPanel
          onClose={closeAll}
          placement={inBar ? "below" : "row"}
        />
      )}

      <button
        ref={buttonRef}
        type="button"
        className="forall-trigger"
        aria-label={
          explainActive
            ? aboutOpen
              ? "Back to Explain"
              : "Exit Explain"
            : mobileSheetOpen
              ? "Back to workspace"
              : mobileMenuOpen
                ? "Close menu"
                : `Workspace actions${
                    totalUnread > 0 ? ` (${totalUnread} unread)` : ""
                  }`
        }
        aria-haspopup="menu"
        aria-expanded={view !== "closed"}
        onClick={onTriggerClick}
        onMouseEnter={() => {
          setSpinTransition(true);
          setGlyphRot(180);
          // The disc sits above the Explain scrim, so it reports its own hover
          // to the engine (the `disc` label) — the scrim's hit-test never
          // reaches it. Suppressed while the About pane is open (bubbles
          // render below the Glasshouse scrim).
          if (explainActive && !aboutOpen)
            useExplain.getState().setHover({ kind: "disc" });
        }}
        onMouseLeave={() => {
          setSpinTransition(true);
          setGlyphRot(360);
          if (explainActive) useExplain.getState().setHover(null);
        }}
        style={{
          position: "relative",
          // Block, not the button-default inline-block: an inline-block child
          // sits on its container's text BASELINE, so the line box reserves
          // strut-descent space (~8px) below the disc — which pushed the disc
          // up off the container's bottom anchor, visibly above the About pill
          // / wordmark sharing it. Block-level kills the line box; the disc
          // sits flush with its siblings ("disc + elongated disc"), which is
          // also what keeps the lockup centred in the nav row.
          display: "block",
          width: discSize,
          height: discSize,
          borderRadius: "50%",
          background: discBg,
          color: discGlyph,
          border: "none",
          padding: 0,
          cursor: "pointer",
          transition: "transform 120ms ease-out",
          // translateZ(0) pins the disc to its own integer-pixel compositor
          // layer so the open-menu scale (and the SVG spin inside) introduce no
          // fractional offset that could nudge the clipped rim (§III.3 item 4).
          transform:
            view !== "closed"
              ? "scale(1.04) translateZ(0)"
              : "scale(1) translateZ(0)",
        }}
      >
        {/* The ∀ is constructed, not typed: stroked bars forming the A
            skeleton, in the workspace floor colour, dividing the black disc.
            The legs are one mitred path, the straight crossbar sits in the upper
            third, slightly lighter than the legs.

            GEOMETRY = THE CUT MARK'S, ported (2026-07-22). The dimensions here
            are FORALL-CUT-AND-LOCKUP-ADR §III.1's cut construction — feet on the
            rim at ±28° from top (overshot along the leg axis so the disc trims
            them flush), apex vertex set so the mitred outer tip resolves to a
            point ON the bottom rim, crossbar spanning the leg centrelines —
            transposed from its 200-unit frame (disc r=94 at (100,100)) into this
            56-unit one (disc r=28 at (28,28)): scale 28/94, so
            `M54.2 11.4 L100 164.3 L145.8 11.4` w17 becomes
            `M14.36 1.61 L28 47.15 L41.64 1.61` w5.06, and the crossbar
            (73,74)→(127,74) w14 becomes (19.96,20.26)→(36.04,20.26) w4.17.

            That resolves the ADR §III.1 honesty note / CONSOLIDATED-TODO §10
            open question in favour of "the DISC form carries the rim-kiss
            stance": pinning both ends to the rim forces a ≈16.7° splay from
            vertical rather than the bare glyph's ~20.5°, so the disc reads
            narrower and taller than the bare stance — deliberately. The splay is
            a consequence of the rim constraint, and only the disc form has a rim.
            (The bare crimson ∀ that kept the ~20.5° stance — Nav/Footer/About —
            left the design language 2026-07-25, and `ForAllMark` with it; the
            disc is now the mark's only rendered form.) The trigger, the favicon
            and the brand exports are that one geometry. (§IV.4's earlier
            "the live button keeps the ∀ clear of the rim" recommendation is
            superseded by this call.)

            REALISATION is still PAINT, not punch — only the dimensions came
            across. The punched lens (a masked white disc composited with
            mix-blend-mode: difference) went with the floating disc,
            WORKSPACE-COLUMN-LAYOUT-ADR §VI; the cut realisation survives only in
            the brand exports (web/public/brand/), where the ground is ours.

            The feet overshoot the top circumference by construction, so the bar
            group is *doubly clipped to the disc the user sees* (§III.3): the SVG
            `#forall-clip` AND the `overflow:hidden`+`borderRadius:50%` wrapper
            span below, which clips in the SAME scaled coordinate space as the
            rendered rim. The two together make the disc background-independent —
            overshoot can never paint past the edge under any transform or DPR, so
            the legs read identically over the workspace floor and over the frosted
            scrim (the old single floor-on-floor clip leaked once the open-menu
            scale + spin stopped the compositor cancelling the tips against the
            floor). Wrapper + inner SVG so the unread badge stays an UN-clipped
            sibling on the button. */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            overflow: "hidden",
          }}
        >
        <svg
          aria-hidden="true"
          viewBox="0 0 56 56"
          onTransitionEnd={onSpinTransitionEnd}
          style={spinStyle}
        >
          <defs>
            {/* The disc itself — clips the bars so their overshoot can never
                paint past the rim. Centred on the rotation origin (28,28), so a
                circle is invariant under both the hover spin and the group morph
                rotations and stays aligned with the button's border-radius disc.

                r=28, the LITERAL rim, not the old r=27 hair-inset: under the cut
                geometry the feet meet the rim flush and the apex kisses it, and a
                1-unit inset would leave a ring of ink between letter and edge —
                the exact "ink slice" §III.1 constructs the overshoot to avoid.
                The anti-aliased seam the inset used to guard is handled by the
                wrapper span, which clips in the rendered coordinate space. */}
            <clipPath id="forall-clip">
              <circle cx="28" cy="28" r="28" />
            </clipPath>
          </defs>
          {/* The ∀ and the close-X are stacked groups that cross-fade with a
              discreet quarter-turn between them — a soft morph, not a hard swap.
              The idle/∀ group fades+rotates out as the X fades+rotates in (and
              vice-versa). Both rotate about the view-box centre so the clipped
              disc never shifts. stroke via style, not the presentation
              attribute — the token is a var() reference, which attributes don't
              resolve. */}
          <g
            clipPath="url(#forall-clip)"
            style={{
              stroke: discGlyph,
              opacity: showClose ? 0 : 1,
              transform: `rotate(${showClose ? -90 : 0}deg)`,
              transformBox: "view-box",
              transformOrigin: "28px 28px",
              transition:
                "opacity 200ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            strokeWidth={5.06}
            strokeLinecap="butt"
            fill="none"
          >
            {/* legs: one path so the interior apex miter-joins — two separate
                lines with butt caps would notch at the apex. The apex vertex
                (28, 47.15) puts the mitred outer tip at y≈56 — a point on the
                bottom rim. miterlimit 12 per §III.1 (the join needs ≈3.5). */}
            <path
              d="M14.36 1.61 L28 47.15 L41.64 1.61"
              strokeLinejoin="miter"
              strokeMiterlimit={12}
            />
            {/* crossbar: upper third, spanning the leg centrelines, ~0.82 of
                the legs' weight */}
            <line x1="19.96" y1="20.26" x2="36.04" y2="20.26" strokeWidth={4.17} />
          </g>
          <g
            clipPath="url(#forall-clip)"
            style={{
              stroke: discGlyph,
              opacity: showClose ? 1 : 0,
              transform: `rotate(${showClose ? 0 : 90}deg)`,
              transformBox: "view-box",
              transformOrigin: "28px 28px",
              transition:
                "opacity 200ms ease, transform 260ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            strokeWidth={6}
            strokeLinecap="round"
            fill="none"
          >
            {/* Close glyph: a large X spanning the disc, the same white bars
                construction as the ∀, signalling "back to workspace". */}
            <line x1="11" y1="11" x2="45" y2="45" />
            <line x1="45" y1="11" x2="11" y2="45" />
          </g>
        </svg>
        </span>
        {unreadBadge}
      </button>
      </div>
    </>
  );
}

interface MenuRowProps {
  row: FocusRow;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}

const MenuRow = forwardRef<HTMLButtonElement, MenuRowProps>(function MenuRow(
  { row, active, onSelect, onHover },
  ref,
) {
  const isRestore = row.kind === "restore";
  const disabled = row.kind === "overlay" && row.disabled === true;
  // Secondary-tier destinations dim to the muted weight too, but keep the
  // normal row font (only restores get the small label-ui treatment). A disabled
  // row (D10 Explain-while-pane-open) reads muted as well.
  const muted =
    disabled || isRestore || (row.kind === "overlay" && row.muted === true);
  const count =
    row.kind === "open" || row.kind === "link" || row.kind === "overlay"
      ? row.count
      : 0;
  return (
    <button
      ref={ref}
      role="menuitem"
      type="button"
      aria-disabled={disabled || undefined}
      title={
        row.kind === "overlay" && disabled ? row.disabledTitle : undefined
      }
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`${isRestore ? "label-ui" : "font-sans text-ui-sm"} block w-full text-left`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: muted ? TOKENS.itemMuted : TOKENS.itemFg,
        opacity: disabled ? 0.55 : 1,
        padding: isRestore ? "8px 14px 8px 24px" : "10px 14px",
        background: active ? TOKENS.itemFocusBg : "transparent",
        transition: "background 80ms linear",
        outline: "none",
        border: "none",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span>{row.label}</span>
      {count > 0 && (
        <span
          className="font-mono"
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: TOKENS.badgeBg,
            color: TOKENS.badgeFg,
            fontSize: 10,
            fontWeight: 600,
            lineHeight: "18px",
            textAlign: "center",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
});
