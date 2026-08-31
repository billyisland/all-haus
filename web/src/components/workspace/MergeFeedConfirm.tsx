"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api/client";
import { formulas as formulasApi } from "../../lib/api/formulas";

const TOKENS = {
  scrim: "rgb(var(--ah-ink-925-rgb) / 0.4)",
  panelBg: "var(--ah-white)",
  panelFg: "var(--ah-ink-925)",
  errorFg: "var(--ah-crimson)",
  primaryBg: "var(--ah-ink-925)",
  primaryFg: "var(--ah-bone)",
  primaryDisabled: "var(--ah-grey-300)",
};

interface MergeFeedConfirmProps {
  open: boolean;
  sourceName: string;
  targetName: string;
  /** The feed being absorbed. Merge deletes it, so a live share link pointing
   *  at it dangles from then on — the same consequence as delete, and the
   *  composer's delete path carries the same sentence (FEED-SHARE-LIVE-LINKS
   *  §7). Silent otherwise: nothing else on this dialog says a link exists. */
  sourceFeedId?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function MergeFeedConfirm({
  open,
  sourceName,
  targetName,
  sourceFeedId,
  onClose,
  onConfirm,
}: MergeFeedConfirmProps) {
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasShareLink, setHasShareLink] = useState(false);
  const scrimRef = useRef<HTMLDivElement>(null);

  // Asked rather than carried: the status route is the one thing that knows,
  // and it 404s while the feature is dark — which resolves to "no line", the
  // right answer in that case too.
  useEffect(() => {
    if (!open || !sourceFeedId) {
      setHasShareLink(false);
      return;
    }
    let live = true;
    formulasApi
      .status(sourceFeedId)
      .then((s) => {
        if (live) setHasShareLink(s.link !== null);
      })
      .catch(() => {
        if (live) setHasShareLink(false);
      });
    return () => {
      live = false;
    };
  }, [open, sourceFeedId]);

  useEffect(() => {
    if (!open) return;
    setMerging(false);
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !merging) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, merging]);

  if (!open) return null;

  async function handleConfirm() {
    if (merging) return;
    setMerging(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      // Prefer the server's own copy (the starter-template refusal explains what
      // to do); ApiError.message is the raw "API error 409: {...}" dump.
      setError(apiErrorMessage(err) ?? "Merge failed.");
      setMerging(false);
    }
  }

  function onScrimClick(e: React.MouseEvent) {
    if (e.target === scrimRef.current && !merging) onClose();
  }

  return (
    <div
      ref={scrimRef}
      onMouseDown={onScrimClick}
      role="dialog"
      aria-modal="true"
      aria-label="Merge feeds"
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
          // No enclosing rule — lifted by its shadow alone, per the Glasshouse
          // grammar. (Removed 2026-07-22; see the no-thin-line invariant.)
          padding: 24,
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.18)",
        }}
      >
        <p
          className="font-sans text-ui-sm leading-[1.5]"
          style={{ color: TOKENS.panelFg, marginBottom: 16 }}
        >
          Merge <strong>{sourceName}</strong> into <strong>{targetName}</strong>
          ? Sources will be combined. <strong>{sourceName}</strong> will be
          deleted.
          {hasShareLink &&
            " This feed has a live share link; it will stop working."}
        </p>

        {/* Own line, not inline beside the buttons: a server refusal is a full
            sentence (the starter-template guard) and would otherwise squeeze
            the actions out of the 420px panel. */}
        {error && (
          <p
            className="font-mono text-mono-xs leading-[1.5]"
            style={{ color: TOKENS.errorFg, marginBottom: 16 }}
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 16,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={merging}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 14px",
                background: "transparent",
                color: TOKENS.panelFg,
                border: "none",
                cursor: merging ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={merging}
              className="font-sans text-ui-xs"
              style={{
                padding: "8px 16px",
                background: merging ? TOKENS.primaryDisabled : TOKENS.primaryBg,
                color: TOKENS.primaryFg,
                border: "none",
                cursor: merging ? "default" : "pointer",
              }}
            >
              {merging ? "Merging…" : "Merge"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
