"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  type ExplainKind,
  buildExplainSequence,
  explainCopy,
  explainVesselLabel,
  firstRunBeats,
} from "../../lib/explain/registry";
import { useExplain, type Annotation, type Program } from "../../stores/explain";
import { useGlasshousePresence } from "../../stores/glasshouse";
import { readingLog } from "../../lib/api/articles";

// =============================================================================
// ExplainProvider — the registration substrate for the Explain engine.
//
// EXPLAIN-ADR D4/§8. Holds a live Map of the explainable ROOTS on the workspace
// floor (`floor`, `disc`, each `vessel`). Roots register their DOM ref via
// `useExplainable`; leaves (`vessel.name`, `card.byline`, …) are NOT registered
// here — they carry `data-explain="…"` attributes and are discovered by DOM
// query at resolve time (D4: registered roots + delegated leaves).
//
// The Map holds LIVE refs, so a registration survives drag / reorder / mount
// churn: the engine reads `ref.current.getBoundingClientRect()` at open()/hover,
// never a cached snapshot (D11). This slice ships the substrate only — nothing
// consumes the Map yet (no visible UI).
// =============================================================================

export interface ExplainRegistration {
  kind: ExplainKind;
  // Singleton kinds key on the kind itself; per-feed `vessel` keys on feedId.
  key: string;
  ref: React.RefObject<HTMLElement>;
  // Ordering hint — the vessel's sort_rank, for the derived sequence (D4).
  order?: number;
  // Copy-fork inputs read off the anchored object (vessel: { feedName,
  // fromStarter }).
  params?: Record<string, unknown>;
}

interface ExplainRegistry {
  register: (reg: ExplainRegistration) => () => void;
  // A snapshot of the current registrations (call at open()/hover, never cache).
  snapshot: () => ExplainRegistration[];
}

const ExplainContext = createContext<ExplainRegistry | null>(null);

export function ExplainProvider({ children }: { children: React.ReactNode }) {
  const mapRef = useRef<Map<string, ExplainRegistration>>(new Map());

  const register = useCallback((reg: ExplainRegistration) => {
    const id = `${reg.kind}:${reg.key}`;
    mapRef.current.set(id, reg);
    return () => {
      // Guard the remount race: only drop the slot if it still holds THIS
      // registration (a fast unmount→remount may have already replaced it).
      if (mapRef.current.get(id) === reg) mapRef.current.delete(id);
    };
  }, []);

  const snapshot = useCallback(
    () => Array.from(mapRef.current.values()),
    [],
  );

  const value = useMemo<ExplainRegistry>(
    () => ({ register, snapshot }),
    [register, snapshot],
  );

  return (
    <ExplainContext.Provider value={value}>{children}</ExplainContext.Provider>
  );
}

// Read the registry directly (the engine's resolver, later slice).
export function useExplainRegistry(): ExplainRegistry | null {
  return useContext(ExplainContext);
}

// ---------------------------------------------------------------------------
// Program resolution (EXPLAIN-ADR §9 slice 4, D4/D5/D7).
//
// The Explain program is built ONCE at open() from the live registry: the
// registered vessel roots ∪ the tagged descendants present at that moment,
// ordered floor → per-vessel (by sort_rank) → representative card kinds → disc
// (buildExplainSequence). Each step's copy is resolved here — the vessel label
// forks on the anchored feed's `fromStarter` param (D7); card kinds contribute
// ONE representative annotation each (D5, gated on any vessel actually having
// cards). Runs against the registry, so it must be called from inside the
// provider (the ForallMenu Explain row is — it lives on the floor).
//
// NOTE (2026-07-15): the Explain program renders HOVER-ONLY (bubble at the
// cursor), so this resolved sequence is currently consumed only as the
// non-empty gate in useOpenExplain. The ordering machinery is kept — it is the
// seam for any future stepped walk-through of the floor.
// ---------------------------------------------------------------------------

function resolveExplainProgram(registry: ExplainRegistry): Program {
  // PANE mode (D10 reversal, 2026-07-15 second session): with a Glasshouse
  // open, the pane is the topmost surface and the program annotates IT, not
  // the floor behind the frost. The program is just the `pane` root (the
  // hover channel discovers everything else live from `[data-explain]` tags
  // inside the pane — the same delegated-leaf model as the floor); it exists
  // so the non-empty gate in useOpenExplain holds and as the seam for any
  // future stepped pane walk-through.
  if (useGlasshousePresence.getState().isOpen) {
    return {
      kind: "explain",
      surface: "pane",
      annotations: [{ kind: "pane", copy: explainCopy("pane") }],
    };
  }

  const roots = registry.snapshot();
  const vesselRoots = roots.filter((r) => r.kind === "vessel");

  // A vessel "has cards" iff its live subtree contains a tagged card leaf. The
  // representative card annotation (D5) then anchors to the lowest-sort_rank
  // such vessel (resolved in the overlay's elementFor).
  const hasCards = vesselRoots.some(
    (v) => !!v.ref.current?.querySelector('[data-explain="card"]'),
  );

  const steps = buildExplainSequence(
    vesselRoots.map((v) => ({ key: v.key, order: v.order ?? 0 })),
    hasCards,
  );

  const fromStarterByKey = new Map(
    vesselRoots.map((v) => [v.key, !!v.params?.fromStarter]),
  );

  const annotations: Annotation[] = steps.map((s) => ({
    kind: s.kind,
    key: s.key,
    copy:
      s.kind === "vessel"
        ? explainVesselLabel(fromStarterByKey.get(s.key ?? "") ?? false)
        : explainCopy(s.kind),
  }));

  return { kind: "explain", surface: "floor", annotations };
}

// Returns a callback that resolves the Explain program from the live registry
// and opens it (EXPLAIN-ADR §8). No-op outside a provider or with zero targets
// (the latter is genuinely unreachable on the desktop floor once ≥1 vessel is
// registered — floor + disc alone already give a non-empty sequence).
export function useOpenExplain(): () => void {
  const registry = useContext(ExplainContext);
  return useCallback(() => {
    if (!registry) return;
    const program = resolveExplainProgram(registry);
    if (program.annotations.length === 0) return;
    useExplain.getState().open(program);
  }, [registry]);
}

// ---------------------------------------------------------------------------
// First-run program (EXPLAIN-ADR §9 slice 6, D6-D8).
//
// The six-beat sequence, resolved from the live registry at open(). Beats 1-2
// (the vessel and its add-source) anchor to the LOWEST-sort_rank vessel; the
// provenance fork (D7) reads that vessel's `fromStarter`. Beat 3 (card.byline)
// and beat 4 (disc) carry no key (representative card / singleton). Beats 5-6
// free-float over the floor (`alwaysFloat`); beat 6 carries the "done"
// affordance. Anchor-or-float is decided per beat in the overlay (D8): a beat
// whose target element is absent at render renders free-floating centred.
// ---------------------------------------------------------------------------

function resolveFirstRunProgram(
  registry: ExplainRegistry,
  hasReading: boolean,
): Program {
  const anchor = registry
    .snapshot()
    .filter((r) => r.kind === "vessel")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  const anchorKey = anchor?.key;
  const fromStarter = !!anchor?.params?.fromStarter;

  const annotations: Annotation[] = firstRunBeats(fromStarter, hasReading).map((b) => ({
    kind: b.kind,
    // Beats 1 (vessel) + 2 (vessel.addSource) anchor to the same vessel; every
    // other beat is a singleton / representative card and carries no key.
    key:
      b.kind === "vessel" || b.kind === "vessel.addSource"
        ? anchorKey
        : undefined,
    copy: b.copy,
    alwaysFloat: b.alwaysFloat,
    done: b.done,
  }));

  return { kind: "firstrun", surface: "floor", annotations };
}

// Resolve the first-run program from the live registry and open it. No-op
// outside a provider or with zero annotations (unreachable — the six beats are
// fixed). Used by the FirstRunController's D6 auto-entry.
export function useOpenFirstRun(): (hasReading?: boolean) => void {
  const registry = useContext(ExplainContext);
  return useCallback(
    (hasReading = false) => {
      if (!registry) return;
      const program = resolveFirstRunProgram(registry, hasReading);
      if (program.annotations.length === 0) return;
      useExplain.getState().open(program);
    },
    [registry],
  );
}

// Has this member opened anything in a reader? Gates the arrival beat
// (PAYWALL-ARRIVAL D6, re-housed), and since 2026-09-04 it reads RECENT READING
// rather than the library — the beat says "the piece you were just reading",
// which is a recency claim, so it lands on the log that makes the same claim
// (READING-LOG-AND-LIBRARY-ADR §8.1; the Path C consequence is written out at
// the copy itself).
//
// RESOLVES ON FAILURE, NEVER REJECTS, and that is the rule rather than
// defensiveness: a failed read means NO BEAT, which is the same answer as an
// empty log — whereas a rejection here would take the whole tour down with it,
// for a member who by construction gets one showing. Losing one pointer to the
// Library is a smaller failure than losing the introduction.
//
// AND THAT SWALLOW IS EXACTLY WHY THE ROUTE BEHIND IT MUST BE DRIVEN. Its
// predecessor (`/my/reading-history`) answered 500 for every caller from the
// day it was written, and this `.catch` — correctly — turned that into the
// ordinary negative answer, so the beat silently never fired for anyone. Prove
// a gate like this by asserting the ROW, never by the caller's silence.
async function readHasReading(): Promise<boolean> {
  try {
    return (await readingLog.list(1)).items.length > 0;
  } catch {
    return false;
  }
}

export const FIRSTRUN_SEEN_PREFIX = "workspace:firstrun_seen:";

// Headless D6 auto-entry controller. REVIVED 2026-09-04 and mounted again in
// WorkspaceView's desktop branch. It was dormant from 2026-07-15 —
// auto-running the tour on a fresh device's first load proved disorienting, so
// Explain was made strictly ∀-menu-invoked and the tour was reached only by
// accepting the welcome sheet's last step. That sheet is deleted, so this is the entry again.
//
// TWO GATES, AND THE OUTER ONE IS ABOUT THE MEMBER. `armed` carries the
// caller's: bootstrap ready, no ceremony playing, and `accounts.onboarded_at`
// still NULL — the last of which is what stops a member who took the tour on
// their laptop being ambushed by it on their phone (the once-per-member
// invariant; a localStorage key alone is exactly the failure it names). This
// component adds the rest of D6: the per-device seen-flag, (d) ≥1 vessel
// registered, the ≤4s wait for a card.byline (beat-3 readiness) then
// run-anyway on timeout, and the courtesy of never firing over a deep-linked
// Glasshouse. The seen-flag is written when first-run OPENS (§6), so a
// one-gesture dismiss still counts — and `onOpened` fires there too, for the
// same reason: the caller stamps the member-level fact at the moment the tour
// is shown, not when it is finished.
export function FirstRunController({
  userId,
  armed,
  onOpened,
}: {
  userId: string;
  armed: boolean;
  /** Fired at the same instant as the per-device flag is written — the tour is
   *  on screen. The caller stamps `accounts.onboarded_at` here. */
  onOpened?: () => void;
}) {
  const registry = useContext(ExplainContext);
  const openFirstRun = useOpenFirstRun();

  useEffect(() => {
    if (!armed || !registry || typeof window === "undefined") return;
    const seenKey = `${FIRSTRUN_SEEN_PREFIX}${userId}`;
    try {
      if (window.localStorage.getItem(seenKey) === "true") return;
    } catch {
      // Private browsing / storage disabled — treat as unseen and fall
      // through (the write below is guarded too; worst case the tour offers
      // again next session, which is harmless).
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();

    const poll = () => {
      if (cancelled) return;
      const vessels = registry.snapshot().filter((r) => r.kind === "vessel");
      // (d) ≥1 vessel rendered — else keep waiting.
      if (vessels.length === 0) {
        timer = setTimeout(poll, 200);
        return;
      }
      // Never open over a deep-linked Glasshouse the user navigated to; retry on
      // a later mount (no seen-flag written, so first-run isn't consumed).
      if (useGlasshousePresence.getState().isOpen) return;
      // Beat-3 readiness (D6): wait up to 4s for a card with a linked byline,
      // then run anyway with beat 3 free-floating (D8).
      const hasByline = vessels.some((v) =>
        v.ref.current?.querySelector('[data-explain="card.byline"]'),
      );
      if (!hasByline && Date.now() - started < 4000) {
        timer = setTimeout(poll, 200);
        return;
      }
      try {
        window.localStorage.setItem(seenKey, "true"); // seen-on-open (D6)
      } catch {
        // Quota / private browsing — run the tour anyway; it may offer once
        // more next session, which is harmless.
      }
      // The arrival beat's gate is the LAST thing resolved, so the wait for it
      // cannot delay any of the readiness checks above — and it cannot fail
      // the tour either (`readHasReading` resolves on failure).
      void readHasReading().then((hasReading) => {
        if (cancelled) return;
        openFirstRun(hasReading);
        onOpened?.();
      });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [armed, userId, registry, openFirstRun, onOpened]);

  return null;
}

// ---------------------------------------------------------------------------
// Headless PREVIEW entry — `/reader?firstrun=1` replays the six beats on
// demand. Added 2026-09-04 because the sequence had become unwatchable: with
// the welcome sheet deleted the tour runs exactly once per member, gated on a
// column and a device key, so seeing it meant minting a fresh account or
// hand-editing the database — and a piece of copy nobody can look at is a
// piece of copy nobody checks.
//
// IT IS A PREVIEW, SO IT CONSUMES NOTHING. No seen-flag is written and
// `onboarded_at` is not stamped: the whole point is that it can be run twice.
// That is the entire difference from `FirstRunController` above, and it is why
// this is a separate component rather than a `preview` prop on that one — a
// gate with a bypass inside it stops being a gate you can read.
//
// GATED ON THE BROWSER BEING ON LOCALHOST, which is an unusual gate and is the
// honest one available: the web image is a PRODUCTION build even in the dev
// stack (`NODE_ENV=production` in web/Dockerfile), so the usual environment
// check is false exactly where this needs to be true. The hostname is the
// address bar's, so this is inert on the deployed site. It is a low-stakes
// affordance — it replays copy, moves no money and changes no state — but an
// ungated `?firstrun=1` is still a URL somebody could hand a member, and a
// tour that arrives unasked is the thing amendment 1 was written about.
//
// WAITS FOR A VESSEL like the controller does, and for the same reason: the
// beats anchor to real elements, and a program resolved against an empty
// registry has nothing to point at.
export function FirstRunPreview() {
  const registry = useContext(ExplainContext);
  const openFirstRun = useOpenFirstRun();

  useEffect(() => {
    if (!registry || typeof window === "undefined") return;
    const { hostname, search } = window.location;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") return;
    if (new URLSearchParams(search).get("firstrun") !== "1") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();

    const poll = () => {
      if (cancelled) return;
      const vessels = registry.snapshot().filter((r) => r.kind === "vessel");
      if (vessels.length === 0 && Date.now() - started < 8000) {
        timer = setTimeout(poll, 200);
        return;
      }
      // Beat-3 readiness, same 4s window as the controller: beat 3 anchors on a
      // card byline, and without one it free-floats (D8) — fine, but not what
      // you want to be looking at when you opened this to check the beats.
      const hasByline = vessels.some((v) =>
        v.ref.current?.querySelector('[data-explain="card.byline"]'),
      );
      if (!hasByline && Date.now() - started < 4000) {
        timer = setTimeout(poll, 200);
        return;
      }
      void readHasReading().then((hasReading) => {
        if (!cancelled) openFirstRun(hasReading);
      });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [registry, openFirstRun]);

  return null;
}

// `FirstRunLauncher` — the headless launcher for the tour ACCEPTED on the
// welcome sheet's last step — was DELETED 2026-09-04 with the sheet itself. It
// existed to fire on an explicit yes, which was the distinction EXPLAIN-ADR
// amendment 1 turned on; with no sheet there is no yes to fire on, and
// `FirstRunController` above is the entry again.

// Register an explainable ROOT. Pass an existing `ref` (the vessel/floor already
// owns one) or let the hook mint one and attach the returned ref to the DOM
// node. Outside a provider (e.g. the loading-state Floor) this is an inert
// no-op. Re-registers when key/order/params change.
export function useExplainable<T extends HTMLElement = HTMLElement>(
  kind: ExplainKind,
  opts?: {
    key?: string;
    ref?: React.RefObject<T>;
    order?: number;
    params?: Record<string, unknown>;
  },
): React.RefObject<T> {
  const registry = useContext(ExplainContext);
  const internalRef = useRef<T>(null);
  const ref = opts?.ref ?? internalRef;
  const key = opts?.key ?? kind;
  const order = opts?.order;
  const params = opts?.params;
  // Serialise params so the effect re-registers when a value (feedName /
  // fromStarter) changes, without depending on object identity.
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    if (!registry) return;
    return registry.register({
      kind,
      key,
      ref: ref as unknown as React.RefObject<HTMLElement>,
      order,
      params,
    });
    // params is captured via paramsKey; ref identity is stable per element.
  }, [registry, kind, key, order, paramsKey, ref]);

  return ref;
}
