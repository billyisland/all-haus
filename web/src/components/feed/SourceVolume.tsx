"use client";

import { useEffect, useState } from "react";
import {
  workspaceFeeds as workspaceFeedsApi,
  type AuthorVolume,
  type WorkspaceFeedSource,
} from "../../lib/api";
import type { AuthorCardData } from "../../hooks/useAuthorCard";

// =============================================================================
// SourceVolume — per-feed volume/sampling control hosted in the byline hover
// panel (AuthorModal). It supersedes the parked pip panel as the place the
// reader tunes how much of a followed source they want in a given feed.
//
// "Followed" is the gate (matches the user's framing — volume only for sources
// one follows):
//   - native author  → shown when isFollowing; commits via the author-volume
//     route (keyed on the 64-hex pubkey, which upserts the per-feed account
//     row even when the writer entered the feed via a tag/publication).
//   - external source → "follow" == the source sits in THIS feed, so we resolve
//     its feed_sources row and commit via patchSource (the same universal
//     by-feed-source-id path the FeedComposer uses). Absent row ⇒ not followed
//     here ⇒ no control.
//
// The 5-step weight + RANDOM/TOP sampling mirror the FeedComposer SourceRow and
// the gateway stepToWeight scale. Weight is recorded but the items query is
// still chronological (mute is honoured); the hint copy stays honest about that.
// =============================================================================

// Mirror of FeedComposer's VOLUME_WEIGHTS / gateway stepToWeight. 0 = mute,
// 1..5 quieter→louder, step 3 = the default weight (1.0).
const VOLUME_WEIGHTS = [1.0, 0.25, 0.5, 1.0, 2.0, 4.0];
function weightToStep(weight: number): number {
  let best = 3;
  let bestDelta = Infinity;
  for (let s = 1; s <= 5; s++) {
    const d = Math.abs(VOLUME_WEIGHTS[s] - weight);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best;
}

export function SourceVolume({
  data,
  feedId,
  pubkey,
}: {
  data: AuthorCardData;
  // The workspace feed the byline was hovered in. Without it there's no per-feed
  // context, so no volume control (the hover panel still shows Follow etc.).
  feedId?: string;
  // The native author's 64-hex pubkey (from the feed-card byline). Absent for
  // external bylines and for hovers outside the feed (e.g. profile overlay).
  pubkey?: string;
}) {
  const ft = data.followTarget;
  if (!feedId || !ft) return null;

  if (ft.type === "user") {
    // Native: tune only an author you actually follow.
    if (!ft.isFollowing || !pubkey) return null;
    return <NativeVolume feedId={feedId} pubkey={pubkey} />;
  }

  // External: the source must already exist (sourceId set) to live in a feed.
  if (ft.type === "source" && ft.sourceId) {
    return <ExternalVolume feedId={feedId} externalSourceId={ft.sourceId} />;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Native author volume — author-volume route (keyed on pubkey). step=null is
// the "passive / no commitment" state (no feed_sources account row yet).
// ---------------------------------------------------------------------------
function NativeVolume({ feedId, pubkey }: { feedId: string; pubkey: string }) {
  const [state, setState] = useState<AuthorVolume | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workspaceFeedsApi
      .getAuthorVolume(feedId, pubkey)
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [feedId, pubkey]);

  // accountId=null ⇒ not a native account (shouldn't happen for ft.type==='user',
  // but the route returns it defensively). Hide rather than show a dead control.
  if (loading || !state || !state.accountId) return null;

  async function commitStep(next: number) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await workspaceFeedsApi.setAuthorVolume(feedId, pubkey, {
        step: next,
        sampling: state!.sampling,
      });
      setState(res);
    } finally {
      setBusy(false);
    }
  }

  async function commitSampling(mode: "random" | "top") {
    if (busy || state!.step === null || state!.step === 0) return;
    setBusy(true);
    try {
      const res = await workspaceFeedsApi.setAuthorVolume(feedId, pubkey, {
        step: state!.step,
        sampling: mode,
      });
      setState(res);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    try {
      await workspaceFeedsApi.clearAuthorVolume(feedId, pubkey);
      setState({ ...state!, step: null, muted: false, sampling: "random" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VolumeStepper
      step={state.step}
      sampling={state.sampling}
      busy={busy}
      onStep={commitStep}
      onSampling={commitSampling}
      onClear={clear}
    />
  );
}

// ---------------------------------------------------------------------------
// External source volume — resolve the feed_sources row, commit via patchSource
// (the universal by-feed-source-id path). A source in a feed always has a
// weight, so there is no passive/null state and no CLEAR (clearing == removing
// the source, which is the Follow toggle's job).
// ---------------------------------------------------------------------------
function ExternalVolume({
  feedId,
  externalSourceId,
}: {
  feedId: string;
  externalSourceId: string;
}) {
  const [row, setRow] = useState<WorkspaceFeedSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workspaceFeedsApi
      .listSources(feedId)
      .then(({ sources }) => {
        if (cancelled) return;
        setRow(
          sources.find(
            (s) =>
              s.sourceType === "external_source" &&
              s.externalSourceId === externalSourceId,
          ) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setRow(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [feedId, externalSourceId]);

  // No row ⇒ the source isn't in this feed ⇒ not followed here ⇒ no control.
  if (loading || !row) return null;

  const isMuted = row.mutedAt !== null;
  const step = isMuted ? 0 : weightToStep(row.weight);

  async function commitStep(next: number) {
    if (busy || !row) return;
    setBusy(true);
    try {
      const { source } = await workspaceFeedsApi.patchSource(feedId, row.id, {
        step: next,
        muted: next === 0,
      });
      setRow(source);
    } finally {
      setBusy(false);
    }
  }

  async function commitSampling(mode: "random" | "top") {
    if (busy || !row || isMuted) return;
    setBusy(true);
    try {
      const { source } = await workspaceFeedsApi.patchSource(feedId, row.id, {
        sampling: mode,
      });
      setRow(source);
    } finally {
      setBusy(false);
    }
  }

  return (
    <VolumeStepper
      step={step}
      sampling={row.samplingMode}
      busy={busy}
      onStep={commitStep}
      onSampling={commitSampling}
    />
  );
}

// ---------------------------------------------------------------------------
// Presentational stepper. Fill-only swatches (no borders — the no-thin-line
// rule); colours are the INVERTING neutral slugs (ink / grey-600 / bone-bright /
// white) so they read on the AuthorModal panel in both modes — the panel is
// mode-neutral chrome that flips to dark under html.dark, so the fixed-dark slugs
// this once used (ink-925 / stone-600) rendered dark-on-dark and vanished.
// ---------------------------------------------------------------------------
function VolumeStepper({
  step,
  sampling,
  busy,
  onStep,
  onSampling,
  onClear,
}: {
  step: number | null;
  sampling: "random" | "top";
  busy: boolean;
  onStep: (s: number) => void;
  onSampling: (m: "random" | "top") => void;
  onClear?: () => void;
}) {
  const isMuted = step === 0;
  // Sampling is moot with no committed level (passive) or while muted.
  const samplingMoot = step === null || isMuted;
  return (
    <div className="mt-3">
      <p className="label-ui text-grey-400 mb-1.5">VOLUME</p>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center" style={{ gap: 3 }}>
          {[0, 1, 2, 3, 4, 5].map((s) => {
            const active = step !== null && !isMuted && s > 0 && s <= step;
            const muteActive = isMuted && s === 0;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onStep(s)}
                disabled={busy}
                aria-label={s === 0 ? "Mute" : `Volume ${s}`}
                style={{
                  width: s === 0 ? 20 : 16,
                  height: 16,
                  background: muteActive
                    ? "var(--ah-crimson)"
                    : active
                      ? "var(--ah-ink)"
                      : "var(--ah-bone-bright)",
                  border: "none",
                  cursor: busy ? "default" : "pointer",
                  padding: 0,
                  fontSize: 9,
                  color: muteActive ? "var(--ah-white)" : "var(--ah-grey-600)",
                  fontFamily: "IBM Plex Mono, ui-monospace, monospace",
                }}
              >
                {s === 0 ? "×" : ""}
              </button>
            );
          })}
        </div>

        {/* RANDOM / TOP — fill-only chips, dimmed while muted. */}
        <div
          className="flex items-center"
          style={{ gap: 3, opacity: samplingMoot ? 0.4 : 1 }}
        >
          {(["random", "top"] as const).map((mode) => {
            const on = sampling === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onSampling(mode)}
                disabled={busy || samplingMoot}
                className="label-ui"
                style={{
                  background: on ? "var(--ah-ink)" : "var(--ah-bone-bright)",
                  color: on ? "var(--ah-white)" : "var(--ah-grey-600)",
                  border: "none",
                  cursor: busy || isMuted ? "default" : "pointer",
                  padding: "3px 8px",
                }}
              >
                {mode}
              </button>
            );
          })}
        </div>

        {onClear && step !== null && (
          <button
            type="button"
            onClick={onClear}
            disabled={busy}
            className="label-ui text-grey-400"
            style={{
              background: "transparent",
              border: "none",
              cursor: busy ? "default" : "pointer",
              padding: 0,
            }}
          >
            CLEAR
          </button>
        )}
      </div>
      <p
        className="font-serif italic text-grey-400 mt-2"
        style={{ fontSize: 12, lineHeight: 1.4 }}
      >
        {step === null
          ? "No commitment yet — set how much of this source you want here."
          : isMuted
            ? "Muted in this feed."
            : "Weight applied to this feed’s ranking."}
      </p>
    </div>
  );
}
