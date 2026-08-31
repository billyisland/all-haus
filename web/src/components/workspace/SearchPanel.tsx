"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  search as searchApi,
  type SearchArticleResult,
  type SearchWriterResult,
  type SearchPublicationResult,
} from "../../lib/api";
import { useReader } from "../../stores/reader";
import { useProfile } from "../../stores/profileOverlay";
import { publicationsEnabled } from "../../lib/featureFlags";

const TOKENS = {
  rowHoverBg: "rgb(var(--ah-ink-rgb) / 0.06)", // subtle dark wash on the warm pane
  inputBg: "var(--ah-glasshouse-well)", // inset well — a touch below the white pane
  sectionBg: "rgb(var(--ah-ink-rgb) / 0.04)",
  text: "var(--ah-ink-925)",
  meta: "var(--ah-grey-600)", // grey-600 — legible on the mid-light pane
  hint: "var(--ah-grey-600)",
};

const DEBOUNCE_MS = 200;
const MIN_QUERY_LEN = 2;

interface Results {
  writers: SearchWriterResult[];
  articles: SearchArticleResult[];
  publications: SearchPublicationResult[];
}

const EMPTY_RESULTS: Results = { writers: [], articles: [], publications: [] };

/**
 * Live-search dialog body, opened in place from the ∀ dock menu. Self-contained
 * query/debounce/abort logic; the dock owns open/close.
 */
export function SearchPanel({
  onClose,
  placement = "row",
}: {
  onClose: () => void;
  /** "row" drops the panel out of the desktop ∀ lockup at the nav bar's LEFT end
   *  (anchored to its container, opening downward into the floor); "below" drops
   *  it under the mobile bar's docked trigger (MOBILE-LAYOUT-ADR §III), clamped
   *  to the viewport width. */
  placement?: "row" | "below";
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Autofocus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
    },
    [],
  );

  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStatus("loading");
    try {
      const [writers, articles, publications] = await Promise.all([
        searchApi.writers(q, 5, ac.signal),
        searchApi.articles(q, 8, ac.signal),
        searchApi.publications(q, 5, ac.signal),
      ]);
      if (ac.signal.aborted) return;
      setResults({
        writers: writers.results,
        articles: articles.results,
        publications: publications.results,
      });
      setStatus("ready");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Search error:", err);
      setStatus("error");
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const trimmed = value.trim();
      if (trimmed.length < MIN_QUERY_LEN) {
        abortRef.current?.abort();
        setResults(EMPTY_RESULTS);
        setStatus("idle");
        return;
      }
      debounceRef.current = window.setTimeout(() => {
        void runSearch(trimmed);
      }, DEBOUNCE_MS);
    },
    [runSearch],
  );

  const navigate = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  // Writers and articles open as workspace overlays (profile / reader) rather
  // than navigating to a black-topbar page; publications have no overlay yet,
  // so they still fall back to navigate() (flagged for overlay work).
  const openWriter = useCallback(
    (username: string) => {
      onClose();
      useProfile.getState().openNative(username);
    },
    [onClose],
  );
  const openArticle = useCallback(
    (dTag: string) => {
      onClose();
      useReader.getState().openNative(dTag);
    },
    [onClose],
  );

  const totalResults =
    results.writers.length +
    results.articles.length +
    results.publications.length;
  const showEmpty =
    status === "ready" &&
    totalResults === 0 &&
    query.trim().length >= MIN_QUERY_LEN;

  return (
    <div
      role="dialog"
      aria-label="Search"
      className="bg-glasshouse shadow-lg"
      style={{
        position: "absolute",
        // "below" is the mobile bar's drop; "row" is the desktop bar's. Both
        // open DOWNWARD now (NavBar.tsx) — the desktop panel hangs off the
        // lockup's left edge, clearing the 40px disc plus the bar, exactly as
        // the ∀ menu beside it does. (It hung UPWARD off a bottom row, then
        // sideways off a left rail; neither survives the move to the top.)
        ...(placement === "below"
          ? { right: 0, top: 44 }
          : { left: 0, top: 58 }),
        // The desktop panel starts 24px in from the window's left edge (the
        // lockup's own inset), so its clearance comes off the available width
        // there; the mobile drop keeps the 16px it always had.
        width:
          placement === "below"
            ? "min(380px, calc(100vw - 16px))"
            : "min(380px, calc(100vw - 48px))",
        maxHeight: "min(480px, calc(100vh - 120px))",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 16px 10px 16px",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={
            // Publications suspended 2026-08-31 — the gateway's publications
            // leg returns an empty set while dark, so naming it here would
            // promise a kind of result that can never come back.
            publicationsEnabled()
              ? "Search writers, articles, publications…"
              : "Search writers and articles…"
          }
          className="font-sans text-ui-sm"
          style={{
            width: "100%",
            padding: "8px 10px",
            background: TOKENS.inputBg,
            border: "none",
            color: TOKENS.text,
            outline: "none",
          }}
        />
      </div>

      <div style={{ overflowY: "auto", flex: 1 }}>
        {status === "idle" && (
          <div
            className="label-ui"
            style={{
              color: TOKENS.hint,
              padding: "24px 16px",
              textAlign: "center",
            }}
          >
            Type at least {MIN_QUERY_LEN} characters
          </div>
        )}
        {status === "loading" && (
          <div
            className="label-ui"
            style={{
              color: TOKENS.hint,
              padding: "24px 16px",
              textAlign: "center",
            }}
          >
            Searching…
          </div>
        )}
        {status === "error" && (
          <div
            className="label-ui"
            style={{
              color: TOKENS.hint,
              padding: "24px 16px",
              textAlign: "center",
            }}
          >
            Couldn’t run search
          </div>
        )}
        {showEmpty && (
          <div
            style={{
              color: TOKENS.hint,
              padding: "32px 16px",
              textAlign: "center",
              fontStyle: "italic",
            }}
            className="font-serif text-[13px]"
          >
            No results for “{query.trim()}”.
          </div>
        )}

        {status === "ready" && results.writers.length > 0 && (
          <Section label="Writers">
            {results.writers.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => openWriter(w.username)}
                style={rowStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = TOKENS.rowHoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  className="font-sans text-ui-xs"
                  style={{ color: TOKENS.text, fontWeight: 500 }}
                >
                  {w.displayName ?? w.username}
                </div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.06em]"
                  style={{ color: TOKENS.hint, marginTop: 2 }}
                >
                  @{w.username} · {w.articleCount} article
                  {w.articleCount === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </Section>
        )}

        {status === "ready" && results.articles.length > 0 && (
          <Section label="Articles">
            {results.articles.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => openArticle(a.dTag)}
                style={rowStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = TOKENS.rowHoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  className="font-serif text-[14px]"
                  style={{
                    color: TOKENS.text,
                    lineHeight: 1.35,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {a.title}
                </div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.06em]"
                  style={{ color: TOKENS.hint, marginTop: 4 }}
                >
                  {a.writer.displayName ?? a.writer.username}
                  {a.isPaywalled ? " · paywalled" : ""}
                </div>
              </button>
            ))}
          </Section>
        )}

        {status === "ready" && results.publications.length > 0 && (
          <Section label="Publications">
            {results.publications.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(`/pub/${p.slug}`)}
                style={rowStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = TOKENS.rowHoverBg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  className="font-sans text-ui-xs"
                  style={{ color: TOKENS.text, fontWeight: 500 }}
                >
                  {p.name}
                </div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.06em]"
                  style={{ color: TOKENS.hint, marginTop: 2 }}
                >
                  /{p.slug} · {p.articleCount} article
                  {p.articleCount === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 16px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  transition: "background 80ms linear",
};

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="label-ui"
        style={{
          color: TOKENS.meta,
          padding: "10px 16px 6px 16px",
          background: TOKENS.sectionBg,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
