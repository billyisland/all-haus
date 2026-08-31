"use client";

import { useEffect, useRef, useState } from "react";

// NewFeedPrompt — slice 3, minimal naming dialog for ∀ → New feed.
// Source-set authoring lives in a later slice; this only captures a name and
// hands it back to the caller, which posts to /api/v1/feeds.

const TOKENS = {
  scrim: "rgb(var(--ah-ink-925-rgb) / 0.4)",
  panelBg: "var(--ah-white)",
  panelBorder: "var(--ah-ink-925)",
  hintFg: "var(--ah-stone-400)",
  errorFg: "var(--ah-crimson)",
  primaryBg: "var(--ah-ink-925)",
  primaryFg: "var(--ah-bone)",
  primaryDisabled: "var(--ah-grey-300)",
};

const NAME_LIMIT = 80;

interface NewFeedPromptProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function NewFeedPrompt({ open, onClose, onCreate }: NewFeedPromptProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSubmitting(false);
    setError(null);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, submitting]);

  if (!open) return null;

  const trimmed = name.trim();
  const overLimit = trimmed.length > NAME_LIMIT;
  const canSubmit = !overLimit && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create feed.");
      setSubmitting(false);
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !submitting) onClose();
  }

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label="New feed"
      style={{
        position: "fixed",
        inset: 0,
        background: TOKENS.scrim,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 144,
      }}
    >
      <div
        style={{
          width: 420,
          maxWidth: "calc(100vw - 48px)",
          background: TOKENS.panelBg,
          // Floating material is lifted by its shadow alone, per the glasshouse
          // material grammar (see CLAUDE.md › no single-pixel lines).
          padding: 24,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.18)",
        }}
      >
        <label
          className="label-ui block"
          htmlFor="new-feed-name"
          style={{ color: TOKENS.hintFg, marginBottom: 6 }}
        >
          Name (optional)
        </label>
        <input
          id="new-feed-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="e.g. Politics, Friends, Reading list"
          // A text field on a panel interior is the inset well; `focus-ring`
          // restores the keyboard ring that the inline `outline: none` here
          // used to suppress for everyone.
          className="font-sans text-ui-sm w-full bg-glasshouse-well focus-ring"
          style={{
            padding: "10px 12px",
            marginBottom: 12,
          }}
        />
        <div
          className="font-mono text-mono-xs"
          style={{ color: TOKENS.hintFg, marginBottom: 16 }}
        >
          A numeral is assigned automatically. Add a name to help you remember
          what this feed is for.
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            className="font-mono text-mono-xs"
            style={{ color: TOKENS.hintFg }}
          >
            {error ? (
              <span style={{ color: TOKENS.errorFg }}>{error}</span>
            ) : overLimit ? (
              <span style={{ color: TOKENS.errorFg }}>
                Name must be {NAME_LIMIT} characters or fewer.
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 14px",
                background: "transparent",
                color: TOKENS.panelBorder,
                border: "none",
                cursor: submitting ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 16px",
                background: canSubmit
                  ? TOKENS.primaryBg
                  : TOKENS.primaryDisabled,
                color: TOKENS.primaryFg,
                border: "none",
                cursor: canSubmit ? "pointer" : "default",
              }}
            >
              {submitting ? "Creating…" : "Create feed"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
