import { useCallback, useEffect, useRef, useState } from "react";
import { resolver, type ResolverResult } from "../lib/api";
import {
  partitionMatchOptions,
  resolveMatches,
  type MatchOption,
  type MatchSections,
} from "../lib/workspace/resolve";

const DEBOUNCE_MS = 300;
const MAX_POLLS = 8;

export interface UseResolverInput {
  query: string;
  onQueryChange: (value: string) => void;
  /** Explicit submit (Enter) — re-runs resolution with the discovery fallback
   *  enabled (§V.5.8), searching the external world for the current query. */
  submit: () => void;
  matches: MatchOption[];
  /** Confidence-tier split of `matches` (RESOLVER-DISCOVERY-ADR §6.4):
   *  exact/probable under `matches`, speculative under `suggestions`. */
  sections: MatchSections;
  resolving: boolean;
  /** True whenever `matches` may not answer the CURRENT query: a resolve is
   *  in flight OR the query changed and the debounced resolve hasn't landed
   *  yet (during that window `matches` still reflect the previous query while
   *  `resolving` is false). Implicit-pick logic (Enter picks the single match)
   *  MUST gate on this, not on `resolving` — the stale-Enter race. */
  pending: boolean;
  resolveError: boolean;
  doneEmpty: boolean;
  reset: () => void;
}

export function useResolverInput(opts?: {
  maxPolls?: number;
  context?: "subscribe" | "invite" | "dm" | "import" | "general";
}): UseResolverInput {
  const maxPolls = opts?.maxPolls ?? MAX_POLLS;
  const context = opts?.context ?? "subscribe";
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ResolverResult | null>(null);
  // The trimmed query the current `result` answers — the staleness signal
  // behind `pending`. Set only where `result` is set.
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);
  const genRef = useRef(0);

  useEffect(() => {
    return () => {
      genRef.current++;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  const pollForResults = useCallback(
    async (requestId: string, gen: number) => {
      if (gen !== genRef.current) return;
      pollCountRef.current++;
      if (pollCountRef.current > maxPolls) {
        setResolving(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      if (gen !== genRef.current) return;
      try {
        const res = await resolver.poll(requestId);
        if (gen !== genRef.current) return;
        setResult(res);
        if (res.status === "pending") void pollForResults(requestId, gen);
        else setResolving(false);
      } catch {
        if (gen !== genRef.current) return;
        setResolving(false);
      }
    },
    [maxPolls],
  );

  const runResolve = useCallback(
    async (value: string, gen: number, discover: boolean) => {
      if (gen !== genRef.current) return;
      setResolving(true);
      setResolveError(false);
      pollCountRef.current = 0;
      try {
        const res = await resolver.resolve(value.trim(), context, discover);
        if (gen !== genRef.current) return;
        setResult(res);
        setResolvedFor(value.trim());
        if (res.requestId && res.status === "pending")
          void pollForResults(res.requestId, gen);
        else setResolving(false);
      } catch {
        if (gen !== genRef.current) return;
        setResolveError(true);
        setResolving(false);
      }
    },
    [context, pollForResults],
  );

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!value.trim()) {
        genRef.current++;
        setResult(null);
        setResolvedFor(null);
        setResolving(false);
        setResolveError(false);
        return;
      }
      genRef.current++;
      const gen = genRef.current;
      // Keystroke path never triggers discovery — typeahead stays cheap.
      debounceRef.current = setTimeout(() => {
        void runResolve(value, gen, false);
      }, DEBOUNCE_MS);
    },
    [runResolve],
  );

  // Explicit submit (Enter): cancel any pending debounce and re-resolve the
  // current query with the discovery fallback enabled (§V.5.8).
  const submit = useCallback(() => {
    if (!query.trim()) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    genRef.current++;
    void runResolve(query, genRef.current, true);
  }, [query, runResolve]);

  const reset = useCallback(() => {
    genRef.current++;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery("");
    setResult(null);
    setResolvedFor(null);
    setResolving(false);
    setResolveError(false);
  }, []);

  const matches = resolveMatches(query, result?.matches ?? []);
  const sections = partitionMatchOptions(matches);
  const pending =
    query.trim().length > 0 && (resolving || resolvedFor !== query.trim());
  const doneEmpty =
    !pending &&
    result !== null &&
    matches.length === 0 &&
    query.trim().length > 0;

  return {
    query,
    onQueryChange,
    submit,
    matches,
    sections,
    resolving,
    pending,
    resolveError,
    doneEmpty,
    reset,
  };
}
