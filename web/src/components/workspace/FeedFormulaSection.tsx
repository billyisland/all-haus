"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formulas as formulasApi,
  type FeedLinkStatus,
} from "../../lib/api/formulas";
import { apiErrorMessage } from "../../lib/api/client";
import {
  CONFIRM_MS,
  copyPendingOrReveal,
  pendingClipboardWriter,
} from "../../hooks/useCopyLink";
import {
  FEED_SHARE,
  FEED_SHARE_COPIED,
  FEED_SHARE_ERROR_MINT,
  FEED_SHARE_ERROR_STOP,
  FEED_SHARE_STOP,
  feedShareCaveat,
} from "../../content/feed-settings";

// =============================================================================
// FeedFormulaSection — the FeedComposer's share control
// (FEED-SHARE-LIVE-LINKS-ADR §3, §7, as simplified 2026-08-30 — see §13.5).
//
// ONE BUTTON, AND PRESSING IT PUTS THE LINK ON THE CLIPBOARD. Not a section
// with a heading, an explanatory paragraph, a read-only field and a Copy beside
// it — the author does not want to LOOK at a URL, they want it in the message
// they are already writing. So the act is "share feed" and the result is
// "share link copied", and everything the old surface displayed is either
// deleted or turned into a consequence of that press.
//
// The button is the same button whether or not a link exists, because minting
// is idempotent server-side (L2). That is what lets there be one control: the
// first press mints and copies, every later press copies the same link, and
// nothing here has to know which happened. It sits with `Delete feed` in the
// composer's bare-action grammar rather than under a heading of its own.
//
// THREE THINGS SURVIVE THE SIMPLIFICATION, and none of them is furniture:
//
//   1. **Stop sharing**, but only once there is something to stop. A live link
//      exposes the feed's FUTURE composition — L1 records that as an accepted
//      cost *because* Stop revokes it, so a surface with no Stop would be
//      removing the mitigation and keeping the cost. It renders quiet, beside
//      the button, only when `link` is non-null.
//   2. **The caveat**, one line, only when there is one, and only when a link
//      is actually out there. D5: an author who shares a four-source feed and
//      whose recipient gets three must be told so — silent omission would let
//      them believe they had shared their whole feed. And a link nobody can
//      redeem (empty, or over the cap) must not be handed over as though it
//      worked. Before anything is shared there is nothing to caveat, so the
//      line does not exist.
//   3. **The fallback**, when the clipboard refuses. A button that says
//      "copied" without copying is the worst outcome available here, so a
//      rejected write reveals the URL to be copied by hand instead.
//
// THE COPY RIDES THE GESTURE, NOT THE ROUND TRIP (§0u.5). The URL does not
// exist until the mint returns, and awaiting it spends Safari's transient user
// activation — so the clipboard is handed the PENDING value synchronously and
// the discipline lives in `copyPendingOrReveal`. This control used to inline
// its own `writeText`-after-await, which was both the WebKit failure and an
// untested third copy of a mutation-tested rule that had already drifted.
//
// WHAT THE STATUS READ IS NOW FOR. It no longer gates the render — the button
// paints immediately, so there is no flash of nothing — it only answers "is a
// link already out there", which decides Stop and the caveat. Everything else
// comes back on the mint response, which carries the live projection.
//
// It renders on the composer's Glasshouse pane, so neutral tokens are correct
// here, exactly as in FeedSyncSection — and, exactly as there, that pane is
// mode-neutral rather than fixed light, so the tokens must be inverting slugs.
// =============================================================================

const T = {
  fg: "var(--ah-ink)",
  hintFg: "var(--ah-grey-600)",
  fieldBg: "var(--ah-white)",
  errorFg: "var(--ah-crimson)",
};

function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// ─── The small mono action button the composer uses everywhere ───────────────

function Action({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "quiet" | "danger";
}) {
  const colour =
    tone === "danger" ? T.errorFg : tone === "quiet" ? T.hintFg : T.fg;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="label-ui"
      style={{
        padding: "6px 10px",
        background: tone === "default" && !disabled ? T.fieldBg : "transparent",
        border: "none",
        color: disabled ? T.hintFg : colour,
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}


export function FeedFormulaSection({
  feedId,
  onLinkChange,
}: {
  feedId: string;
  /** Reported up so the composer's delete path can say that destroying this
   *  feed stops the link (§7). One read, two surfaces. */
  onLinkChange?: (hasLink: boolean) => void;
}) {
  const [status, setStatus] = useState<FeedLinkStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the status read depends on `feedId` ALONE and honestly.
  // The alternative — the callback in the dep array — re-runs the fetch on
  // every parent render the moment a caller passes an inline arrow, which is
  // the ordinary way to pass a callback and would be silent when it happened.
  const report = useRef(onLinkChange);
  report.current = onLinkChange;

  useEffect(() => {
    let live = true;
    setStatus(null);
    setError(null);
    setCopied(false);
    setRevealed(null);
    formulasApi
      .status(feedId)
      .then((s) => {
        if (!live) return;
        setStatus(s);
        report.current?.(s.link !== null);
      })
      .catch(() => {
        // The control is an offer, not a required read: a failed status leaves
        // the button live (minting is what actually matters) and says nothing.
      });
    return () => {
      live = false;
    };
  }, [feedId]);

  const share = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRevealed(null);
    // Started, not awaited. Everything up to the first `await` below runs
    // inside the click handler, which is what keeps the gesture alive for the
    // clipboard — see copyPendingOrReveal.
    //
    // Idempotent server-side (L2): mints on the first press, returns the same
    // link on every later one. Nothing here needs to know which it was, which
    // is the whole reason this is one button.
    const minting = formulasApi.mint(feedId);
    try {
      const outcome = await copyPendingOrReveal(
        minting.then((l) => absoluteUrl(l.url)),
        {
          writePending: pendingClipboardWriter(),
          writeText: (t) => navigator.clipboard.writeText(t),
        },
      );
      const link = await minting;
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              link,
              excludedCount: link.excludedCount,
              refusal: link.refusal,
            }
          : {
              link,
              sourceCount: link.sourceCount,
              excludedCount: link.excludedCount,
              refusal: link.refusal,
              // The link's OWN cap, never a fabricated zero (§0u.6). This
              // branch runs when the initial status GET blipped — a tolerated
              // case — and the caveat it feeds reads "trim it to N", so a
              // stand-in 0 turned a recoverable blip into instructions nobody
              // can follow.
              maxSources: link.maxSources,
            },
      );
      report.current?.(true);
      if (outcome.ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), CONFIRM_MS);
      } else {
        // Saying "copied" without copying is the worst outcome available here,
        // so the link is revealed to be taken by hand instead.
        setRevealed(outcome.url);
      }
    } catch (err) {
      setError(apiErrorMessage(err) ?? FEED_SHARE_ERROR_MINT);
    } finally {
      setBusy(false);
    }
  }, [busy, feedId]);

  const stop = useCallback(async () => {
    const link = status?.link;
    if (busy || !link) return;
    setBusy(true);
    setError(null);
    try {
      await formulasApi.revoke(link.id);
      setStatus((prev) => (prev ? { ...prev, link: null } : prev));
      report.current?.(false);
      setCopied(false);
      setRevealed(null);
    } catch (err) {
      setError(apiErrorMessage(err) ?? FEED_SHARE_ERROR_STOP);
    } finally {
      setBusy(false);
    }
  }, [busy, status]);

  // Only once a link is actually out there: before that nothing has been
  // shared, so there is nothing to caveat.
  const line = status?.link ? feedShareCaveat(status) : null;
  // D11 — a designated seed cannot be withdrawn. Unreachable here (a link is
  // never a seed; the schema says so), and kept because that is what makes it
  // unreachable.
  const canStop = !!status?.link && !status.link.isDefaultSeed;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Action disabled={busy} onClick={() => void share()}>
          {copied ? FEED_SHARE_COPIED : busy ? "…" : FEED_SHARE}
        </Action>
        {canStop && (
          <Action tone="quiet" disabled={busy} onClick={() => void stop()}>
            {FEED_SHARE_STOP}
          </Action>
        )}
      </div>

      {line && (
        <p
          className="text-ui-xs"
          style={{
            color: status?.refusal ? T.errorFg : T.hintFg,
            margin: "6px 0 0",
          }}
        >
          {line}
        </p>
      )}

      {revealed && (
        <input
          type="text"
          readOnly
          value={revealed}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-mono-xs"
          style={{
            width: "100%",
            marginTop: 6,
            background: T.fieldBg,
            border: "none",
            padding: "8px 10px",
            outline: "none",
            color: T.fg,
          }}
        />
      )}

      {error && (
        <p
          className="font-mono text-mono-xs"
          style={{ color: T.errorFg, margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
