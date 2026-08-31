"use client";

import { useCallback, useEffect, useState } from "react";
import {
  followImports,
  type FeedImportBinding,
  type FollowImportRun,
  type FollowImportSyncPreview,
} from "../../lib/api";
import { apiErrorMessage } from "../../lib/api/client";
import { timeAgo } from "../../lib/format";

// =============================================================================
// FeedSyncSection — the FeedComposer's "Sync now" block for an import-bound
// feed (FOLLOW-GRAPH-IMPORT-ADR §11.5, Phase 2). Preview-then-confirm: the
// server re-reads the origin network's follow graph, the diff renders as
// "+N to add · M to remove" with sample names, and Apply hands the plan to the
// same background engine the initial import used (progress polled here).
// Removals mirror remote unfollows only — local removals are exclusion-guarded
// server-side and never resurrected. Renders on the composer's fixed-light
// Glasshouse pane, so fixed neutral tokens (not a feed palette) are correct.
// =============================================================================

const T = {
  fg: "var(--ah-ink-925)",
  hintFg: "var(--ah-grey-600)",
  fieldBg: "var(--ah-white)",
  errorFg: "var(--ah-crimson)",
};

const PROTOCOL_LABELS: Record<string, string> = {
  atproto: "Bluesky",
  nostr_external: "Nostr",
  activitypub: "Fediverse",
  rss: "RSS",
};

const POLL_MS = 2000;

// Middle-ellipsis for DIDs / hex pubkeys — the binding stores the canonical
// identity, which is machine-shaped.
function shortenIdentity(s: string, max = 28): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, max - 1 - half)}…${s.slice(-half)}`;
}

export function FeedSyncSection({
  feedId,
  binding,
  onApplied,
}: {
  feedId: string;
  binding: FeedImportBinding;
  /** Fired once when an applied sync finishes, so the composer can reload
   *  its source list and the feed behind the glass. */
  onApplied: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<FollowImportSyncPreview | null>(null);
  const [run, setRun] = useState<FollowImportRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local override so an up-to-date verdict refreshes the "synced …" line
  // without re-fetching the binding.
  const [syncedAt, setSyncedAt] = useState<string | null>(binding.lastSyncedAt);

  const applying = run?.status === "pending" || run?.status === "running";
  const busy = previewing || confirming || applying;

  const handleSyncNow = useCallback(async () => {
    if (busy) return;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setRun(null);
    try {
      const { preview: p } = await followImports.syncPreview(feedId);
      if (p.upToDate) setSyncedAt(new Date().toISOString());
      setPreview(p);
    } catch (err) {
      setError(apiErrorMessage(err) ?? "Could not read the origin network — try again.");
    } finally {
      setPreviewing(false);
    }
  }, [busy, feedId]);

  const handleApply = useCallback(async () => {
    // confirming (via busy) is the in-flight guard: without it a double-click
    // POSTs confirm twice — the loser 404s ("no confirmable preview") and
    // paints an error next to a sync that actually started.
    if (!preview || preview.upToDate || busy) return;
    setConfirming(true);
    setError(null);
    try {
      const { import: started } = await followImports.confirmSync(preview.id);
      setRun(started);
      setPreview(null);
    } catch (err) {
      setError(apiErrorMessage(err) ?? "Could not start the sync — try again.");
    } finally {
      setConfirming(false);
    }
  }, [preview, busy]);

  const handleCancel = useCallback(() => {
    if (!preview || preview.upToDate) return;
    const id = preview.id;
    setPreview(null);
    // Best effort — an abandoned preview is superseded by the next one and
    // GC'd server-side regardless.
    followImports.cancelSync(id).catch(() => {});
  }, [preview]);

  // Poll the applied run until terminal, then reload the composer's world.
  const runId = run?.id ?? null;
  useEffect(() => {
    if (!runId || !applying) return;
    const t = setInterval(() => {
      followImports
        .get(runId)
        .then(({ import: next }) => {
          setRun((prev) => (prev && prev.id === runId ? { ...prev, ...next } : prev));
          if (next.status === "done") {
            setSyncedAt(new Date().toISOString());
            onApplied();
          }
        })
        .catch(() => {
          // Transient poll failure — keep polling; the run is server-side.
        });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [runId, applying, onApplied]);

  const originLine = [
    PROTOCOL_LABELS[binding.protocol] ?? binding.protocol,
    shortenIdentity(binding.originIdentity),
    syncedAt ? `synced ${timeAgo(syncedAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div style={{ marginTop: 20 }}>
      <div className="label-ui" style={{ color: T.hintFg, marginBottom: 6 }}>
        Imported from
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          className="font-mono text-mono-xs"
          style={{
            color: T.hintFg,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {originLine}
        </div>
        <button
          type="button"
          onClick={() => void handleSyncNow()}
          disabled={busy}
          className="label-ui"
          style={{
            padding: "6px 10px",
            background: busy ? "transparent" : T.fieldBg,
            border: "none",
            color: busy ? T.hintFg : T.fg,
            cursor: busy ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {previewing ? "Checking…" : "Sync now"}
        </button>
      </div>

      {error && (
        <div className="font-mono text-mono-xs" style={{ color: T.errorFg, marginTop: 6 }}>
          {error}
        </div>
      )}

      {preview?.upToDate && (
        <p className="font-mono text-mono-xs" style={{ color: T.hintFg, marginTop: 6 }}>
          UP TO DATE — nothing changed at the origin.
          {preview.removalsSkipped &&
            " (Follow list exceeds the import cap, so unfollows weren’t checked.)"}
        </p>
      )}

      {preview && !preview.upToDate && (
        <div style={{ marginTop: 8 }}>
          <div className="font-mono text-mono-xs" style={{ color: T.fg }}>
            {preview.adds > 0 && `+${preview.adds} TO ADD`}
            {preview.adds > 0 && preview.removes > 0 && " · "}
            {preview.removes > 0 && `−${preview.removes} TO REMOVE`}
          </div>
          {preview.addSample.length > 0 && (
            <p className="text-ui-xs" style={{ color: T.hintFg, marginTop: 4 }}>
              Adding {preview.addSample.slice(0, 6).join(", ")}
              {preview.adds > 6 && ` and ${preview.adds - 6} more`}.
            </p>
          )}
          {preview.removeSample.length > 0 && (
            <p className="text-ui-xs" style={{ color: T.hintFg, marginTop: 4 }}>
              Removing {preview.removeSample.slice(0, 6).join(", ")}
              {preview.removes > 6 && ` and ${preview.removes - 6} more`} (unfollowed at the
              origin — nothing is unfollowed there by us).
            </p>
          )}
          {(preview.truncated || preview.removalsSkipped) && (
            <p className="text-ui-xs" style={{ color: T.hintFg, marginTop: 4 }}>
              The origin follow list exceeds the {preview.cap}-source cap
              {preview.removalsSkipped && "; unfollows weren’t checked this time"}.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={busy}
              className="label-ui"
              style={{
                padding: "6px 10px",
                background: busy ? "transparent" : T.fieldBg,
                border: "none",
                color: busy ? T.hintFg : T.fg,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {confirming ? "Starting…" : "Apply"}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={confirming}
              className="label-ui"
              style={{
                padding: "6px 10px",
                background: "transparent",
                border: "none",
                color: T.hintFg,
                cursor: confirming ? "default" : "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {run && (
        <div style={{ marginTop: 8 }}>
          {run.status === "failed" ? (
            <p className="font-mono text-mono-xs" style={{ color: T.errorFg }}>
              SYNC FAILED{run.error ? ` — ${run.error}` : ""}
            </p>
          ) : run.status === "done" ? (
            <p className="font-mono text-mono-xs" style={{ color: T.hintFg }}>
              SYNC COMPLETE — {run.imported} ADDED · {run.removed ?? 0} REMOVED
              {run.failed > 0 && ` · ${run.failed} FAILED`}
            </p>
          ) : (
            <p className="font-mono text-mono-xs" style={{ color: T.hintFg }}>
              SYNCING… {run.imported + run.skipped + run.failed}/{run.total} ADDED ·{" "}
              {run.removed ?? 0}/{run.removalsTotal ?? 0} REMOVED
            </p>
          )}
          {run.status === "done" && run.protocol === "nostr_external" && (
            <p className="text-ui-xs" style={{ color: T.hintFg, marginTop: 4 }}>
              Names fill in over the next few minutes as profiles arrive from relays.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
