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

function resolveFirstRunProgram(registry: ExplainRegistry): Program {
  const anchor = registry
    .snapshot()
    .filter((r) => r.kind === "vessel")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  const anchorKey = anchor?.key;
  const fromStarter = !!anchor?.params?.fromStarter;

  const annotations: Annotation[] = firstRunBeats(fromStarter).map((b) => ({
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
export function useOpenFirstRun(): () => void {
  const registry = useContext(ExplainContext);
  return useCallback(() => {
    if (!registry) return;
    const program = resolveFirstRunProgram(registry);
    if (program.annotations.length === 0) return;
    useExplain.getState().open(program);
  }, [registry]);
}

export const FIRSTRUN_SEEN_PREFIX = "workspace:firstrun_seen:";

// Headless D6 auto-entry controller — DORMANT since 2026-07-15 (no longer
// mounted): auto-running the tour on a fresh device's first load proved
// disorienting on the live site, so Explain is strictly ∀-menu-invoked. Kept
// intact for revival — remount it in WorkspaceView's desktop branch.
// When mounted, it lives inside the provider on the DESKTOP
// floor only. `armed` carries the WorkspaceView-owned gates: bootstrap ready,
// the ForallCeremony not pending/playing (defensively subscribed even though it
// is dark today — D6/§0.2), and BringYourWorld not showing. This component adds
// the rest of D6: (a) the per-device seen-flag, (d) ≥1 vessel registered, the
// ≤4s wait for a card.byline (beat-3 readiness) then run-anyway on timeout, and
// the courtesy of never firing over a deep-linked Glasshouse. The seen-flag is
// written when first-run OPENS (§6), so a one-gesture dismiss still counts.
export function FirstRunController({
  userId,
  armed,
}: {
  userId: string;
  armed: boolean;
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
      openFirstRun();
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [armed, userId, registry, openFirstRun]);

  return null;
}

// Headless launcher for the tour ACCEPTED on the welcome sheet's last step
// (`Welcome.tsx`). Distinct from `FirstRunController` above, which is the
// dormant AUTO-entry: this fires only on an explicit yes, which is the whole
// difference EXPLAIN-ADR amendment 1 turned on ("landing in Explain mode on load
// without asking for it read as a malfunction, not a welcome").
//
// IT EXISTS TO OWN THE ORDERING. Floor-mode Explain sits BELOW the Glasshouse
// band by design (CLAUDE.md, Stacking order), so a tour opened while the welcome
// pane is still mounted renders behind it — the accepted tour would look like
// nothing happening. Mounting this only once the sheet has gone means the open
// lands in a later commit than the unmount, rather than relying on both
// batching. The caller renders it as `{tourPending && !welcomeOpen && <…/>}`.
//
// Writes the first-run seen-flag on open (D6's seen-on-open), so a revived
// `FirstRunController` would not re-offer a tour this member has already taken.
// Declining does NOT write it: they have not seen it, and Explain stays
// reachable from the ∀ menu either way.
export function FirstRunLauncher({
  userId,
  onLaunched,
}: {
  userId: string;
  onLaunched: () => void;
}) {
  const openFirstRun = useOpenFirstRun();

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(`${FIRSTRUN_SEEN_PREFIX}${userId}`, "true");
      } catch {
        // Quota / private browsing — the tour still runs; worst case a revived
        // auto-entry offers it once more, which is harmless.
      }
    }
    openFirstRun();
    onLaunched();
    // Fire once per mount: the caller unmounts this via `onLaunched`, and a
    // re-run would re-open a tour the member may have just dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

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
