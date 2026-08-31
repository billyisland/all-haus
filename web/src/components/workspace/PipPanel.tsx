'use client'

import { useEffect, useRef, useState } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { useAuth } from '../../stores/auth'
import { TrustPip } from '../ui/TrustPip'
import { trustEnabled } from '../../lib/featureFlags'
import {
  trust as trustApi,
  follows as followsApi,
  workspaceFeeds as workspaceFeedsApi,
  type AuthorVolume,
} from '../../lib/api'
import type {
  TrustProfileResponse,
  PollAnswer,
  PollQuestion,
  PollsResponse,
  VouchDimension,
  VouchValue,
  VouchVisibility,
} from '../../lib/api/trust'
import type { PipStatus } from '../../lib/ndk'

// PipPanel — popover surface opened by tapping a TrustPip on a vessel card.
// Slice 12: native authors only (notes + articles). External cards' pips stay
// inert because external authors don't have a platform user id and the trust
// route keys on user id.
//
// Per CARDS-AND-PIP-PANEL-HANDOFF.md §"The pip panel": header (large pip +
// author name + chevron link to profile + right-aligned FOLLOW), bio line,
// TRUST section, VOLUME section, footer (SUBSCRIBE if offered).
//
// This slice ships a first cut: trust section renders the existing Layer 1
// signals + dimension scores from `trust_profiles` rather than the polling
// questions described in the handoff (the polling backend is a future system
// per ADR-OMNIBUS §III.7 and the trust-system spec proper). Slice 14 wired
// the VOLUME bar against feed_sources rows; slice 15 added the polling-
// questions row; slice 16 made weight/sampling_mode actually load-bearing in
// the items query.

const TOKENS = {
  scrim: 'rgb(var(--ah-ink-925-rgb) / 0.18)',
  panelBg: 'var(--ah-white)',
  panelBorder: 'var(--ah-ink-925)',
  fg: 'var(--ah-ink-925)',
  meta: 'var(--ah-stone-600)',
  hint: 'var(--ah-stone-400)',
  rule: 'var(--ah-bone-bright)',
  crimson: 'var(--ah-crimson)',
}

// Slice 19 — per-pip-status framing for the panel. Subtitle copy names what
// the pip means and (where applicable) which gesture would move it; accent
// is the matching pip colour, applied as a 3px stripe at the panel top so
// the panel reads visually keyed to the state. Self-pip suppresses both
// (the framing addresses how *others* read the writer; doesn't apply when
// looking at your own pip).
//
// Colour palette mirrors web/src/components/ui/TrustPip.tsx#PIP_COLORS so
// the inline glyph and the panel stripe share a single source of truth via
// duplication. Re-importing the constant would have meant either exporting
// it from TrustPip.tsx (incidental coupling) or pulling it through a shared
// tokens module that doesn't exist yet — the four-line dup is honest.
const STATUS_PRESENTATION: Record<PipStatus, { accent: string; subtitle: string }> = {
  known: {
    accent: 'var(--ah-trust-green)',
    subtitle: 'Established profile — readers confirm the basics.',
  },
  partial: {
    accent: 'var(--ah-trust-amber)',
    subtitle: 'Developing profile — some signal, more would help.',
  },
  unknown: {
    accent: 'var(--ah-trust-grey)',
    subtitle: 'New here — tap below to share what you know.',
  },
  contested: {
    accent: 'var(--ah-crimson)',
    subtitle: 'Contested — readers have raised concerns.',
  },
}

interface PipPanelProps {
  open: boolean
  pubkey: string
  pipStatus?: PipStatus
  // Page coordinates of the tapped pip — used to anchor the popover.
  anchorRect: { top: number; left: number; bottom: number; right: number } | null
  initialIsFollowing: boolean
  // Slice 14: when set, the volume bar is wired against this feed.
  feedId?: string
  onClose: () => void
  onFollowChanged?: (pubkey: string, following: boolean) => void
  onVolumeChanged?: (feedId: string) => void
}

interface WriterMeta {
  id: string
  username: string
  displayName: string | null
  bio: string | null
  subscriptionPricePence: number
}

export function PipPanel({
  open,
  pubkey,
  pipStatus = 'unknown',
  anchorRect,
  initialIsFollowing,
  feedId,
  onClose,
  onFollowChanged,
  onVolumeChanged,
}: PipPanelProps) {
  const { user } = useAuth()
  const [writer, setWriter] = useState<WriterMeta | null>(null)
  const [trustProfile, setTrustProfile] = useState<TrustProfileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(initialIsFollowing)
  const [followBusy, setFollowBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setFollowing(initialIsFollowing)
  }, [open, initialIsFollowing])

  // Fetch writer meta + trust profile on open. Sequenced because the trust
  // route keys on the writer's user id which we don't have until the writer
  // lookup returns.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setWriter(null)
    setTrustProfile(null)

    void (async () => {
      try {
        const writerRes = await fetch(`/api/v1/writers/by-pubkey/${pubkey}`, {
          credentials: 'include',
        })
        if (!writerRes.ok) {
          throw new Error('Writer not found')
        }
        const wd = await writerRes.json()
        if (cancelled) return
        const writerMeta: WriterMeta = {
          id: wd.id,
          username: wd.username,
          displayName: wd.displayName ?? null,
          bio: wd.bio ?? null,
          subscriptionPricePence: wd.subscriptionPricePence ?? 0,
        }
        setWriter(writerMeta)
        // Trust parked (item 7): skip the trust-profile fetch entirely — the
        // section that consumes it is hidden, so don't hit the parked route.
        if (trustEnabled()) {
          try {
            const profile = await trustApi.getProfile(writerMeta.id)
            if (cancelled) return
            setTrustProfile(profile)
          } catch {
            // Trust route 404s for non-writer accounts; not fatal — leave the
            // section blank rather than blocking the rest of the panel.
          }
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, pubkey])

  // Esc + outside click close. Outside-click is a pointerdown listener on
  // document so a click that lands on the scrim or anywhere outside the panel
  // dismisses immediately.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current) return
      if (panelRef.current.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onClose])

  if (!open || !anchorRect) return null

  // Anchor positioning: open below-and-right of the pip when there's room,
  // otherwise above. Width clamps inside the viewport.
  const PANEL_W = 420
  const PANEL_H_HINT = 360 // estimate for placement; actual height is intrinsic.
  const margin = 12
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const preferredLeft = Math.min(
    Math.max(anchorRect.left, margin),
    viewportW - PANEL_W - margin,
  )
  const wantsAbove = anchorRect.bottom + margin + PANEL_H_HINT > viewportH
  const top = wantsAbove
    ? Math.max(margin, anchorRect.top - PANEL_H_HINT - margin)
    : anchorRect.bottom + margin

  const isOwn = !!user && user.pubkey === pubkey
  const profileHref = writer ? `/${writer.username}` : '#'
  const subscriptionPence = writer?.subscriptionPricePence ?? 0
  const offersSubscription = subscriptionPence > 0
  const presentation = STATUS_PRESENTATION[pipStatus] ?? STATUS_PRESENTATION.unknown
  // Trust parked (item 7): the pip-status framing (accent stripe + subtitle) and
  // the TRUST section are trust UI — hidden when off. VolumeBar (per-feed author
  // volume, not trust) stays, so the panel still opens via the neutral pip.
  const showTrust = trustEnabled()
  const showFraming = showTrust && !isOwn && !loading && !error && writer !== null

  async function handleFollowToggle() {
    if (!writer || !user || isOwn || followBusy) return
    setFollowBusy(true)
    try {
      if (following) {
        await followsApi.unfollow(writer.id)
        setFollowing(false)
        onFollowChanged?.(pubkey, false)
      } else {
        await followsApi.follow(writer.id)
        setFollowing(true)
        onFollowChanged?.(pubkey, true)
      }
    } catch {
      // Silent — the visible state stays as-is on failure.
    } finally {
      setFollowBusy(false)
    }
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Author details"
      style={{
        position: 'fixed',
        top,
        left: preferredLeft,
        width: PANEL_W,
        maxWidth: 'calc(100vw - 24px)',
        background: TOKENS.panelBg,
        border: `1px solid ${TOKENS.panelBorder}`,
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
        zIndex: 70,
      }}
    >
      {/* Slice 19 — accent stripe keyed to pip status. Sits flush at the top,
          inside the panel border. Suppressed for self-pip and during the
          load/error states (otherwise it'd flash with whatever the assumed
          pipStatus default is before the trust profile actually loads). */}
      {showFraming && (
        <div
          style={{
            height: 3,
            background: presentation.accent,
            width: '100%',
          }}
          aria-hidden="true"
        />
      )}
      <div style={{ padding: 24 }}>
      {loading ? (
        <div
          className="label-ui"
          style={{ color: TOKENS.hint }}
        >
          LOADING…
        </div>
      ) : error ? (
        <div className="font-sans text-ui-xs" style={{ color: TOKENS.meta }}>
          {error}
        </div>
      ) : writer ? (
        <>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{ display: 'inline-flex', transform: 'scale(1.4)', transformOrigin: 'center' }}
            >
              <TrustPip status={pipStatus} />
            </span>
            <ProfileLink
              href={profileHref}
              onClick={onClose}
              className="font-serif"
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: TOKENS.fg,
                textDecoration: 'none',
                flex: 1,
              }}
            >
              {writer.displayName || writer.username}
              <span style={{ color: TOKENS.hint, marginLeft: 6 }}>›</span>
            </ProfileLink>
            {!isOwn && user && (
              <button
                type="button"
                onClick={handleFollowToggle}
                disabled={followBusy}
                className="label-ui"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: followBusy ? 'default' : 'pointer',
                  color: following ? TOKENS.meta : TOKENS.fg,
                  padding: 0,
                }}
              >
                {following ? 'FOLLOWING ›' : 'FOLLOW ›'}
              </button>
            )}
          </div>

          {/* Slice 19 — pip-status subtitle. Italic Literata, hint colour;
              names what the pip means and (for non-green) suggests where the
              gesture lives. Suppressed for self-pip via showFraming. */}
          {showFraming && (
            <p
              className="font-serif italic"
              style={{
                fontSize: 13,
                color: TOKENS.hint,
                marginTop: 6,
                lineHeight: 1.45,
              }}
            >
              {presentation.subtitle}
            </p>
          )}

          {/* Bio */}
          {writer.bio && (
            <p
              className="font-serif"
              style={{
                fontSize: 14,
                color: TOKENS.fg,
                marginTop: 12,
                lineHeight: 1.5,
              }}
            >
              {writer.bio}
            </p>
          )}

          {/* TRUST section — first cut. Hidden when trust is parked (item 7);
              VolumeBar below stays. */}
          {showTrust && (
          <div style={{ marginTop: 20 }}>
            <div
              className="label-ui"
              style={{ color: TOKENS.meta, marginBottom: 8 }}
            >
              Trust
            </div>
            {trustProfile ? (
              <TrustSignals profile={trustProfile} />
            ) : (
              <p
                className="font-sans text-ui-xs"
                style={{ color: TOKENS.hint }}
              >
                No trust signals yet.
              </p>
            )}
            {/* Slice 18: encounter (in-person met) line + viewer toggle.
                Rendered after the L1 signals because it joins them as the
                hard-upgrade-to-green anchor. Self-pip suppresses (you don't
                vouch you've met yourself). */}
            {!isOwn && writer && trustProfile && (
              <EncounterRow
                subjectUserId={writer.id}
                initialAffirmCount={trustProfile.encounter.affirmCount}
                initialViewerVouch={
                  trustProfile.viewerVouches.find(
                    (v) => v.dimension === 'encounter' && v.value === 'affirm',
                  ) ?? null
                }
              />
            )}
            {/* Slice 15: poll-questions section — separate from layer-1 signals
                because the question shape and the data shape are different.
                Rendered only for non-self panels (you don't poll yourself). */}
            {!isOwn && writer && (
              <PollQuestions subjectUserId={writer.id} subjectName={writer.displayName || writer.username} />
            )}
          </div>
          )}

          {/* VOLUME section — slice 14 */}
          {!isOwn && feedId && writer && (
            <VolumeBar
              feedId={feedId}
              pubkey={pubkey}
              onChanged={() => onVolumeChanged?.(feedId)}
            />
          )}

          {/* Footer */}
          {offersSubscription && writer.username && (
            <div
              style={{
                marginTop: 20,
                paddingTop: 16,
                borderTop: `1px solid ${TOKENS.rule}`,
                textAlign: 'right',
              }}
            >
              <ProfileLink
                href={`/${writer.username}`}
                onClick={onClose}
                className="label-ui"
                style={{
                  color: TOKENS.crimson,
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                SUBSCRIBE · £{(subscriptionPence / 100).toFixed(2)}/MO ›
              </ProfileLink>
            </div>
          )}
        </>
      ) : null}
      </div>
    </div>
  )
}

// Slice 14 — VOLUME bar. Five-step horizontal bar + RANDOM/TOP sampling
// toggle. The bar represents per-feed-per-author commitment; an empty state
// (no row) reads as "passive" (default ranking, no commit). Steps:
//   0 = mute (suppress the author from this feed)
//   1..5 = quieter → louder
// Step 3 is the default weight (1.0); rates either side bracket it.
//
// The items query already honours `muted_at` on the underlying feed_sources
// row (slice 4); weight ordering is the eventual ranking story and not yet
// observable. The bar is honest about this in its hint copy.
function VolumeBar({
  feedId,
  pubkey,
  onChanged,
}: {
  feedId: string
  pubkey: string
  onChanged?: () => void
}) {
  const [state, setState] = useState<AuthorVolume | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    workspaceFeedsApi
      .getAuthorVolume(feedId, pubkey)
      .then((res) => {
        if (cancelled) return
        setState(res)
      })
      .catch(() => {
        if (cancelled) return
        // Author isn't a native account, or feed not found — leave the section
        // hidden. The volume commit only makes sense for tracked native authors.
        setState(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [feedId, pubkey])

  // The route returns 200 with accountId=null for unknown authors — that's
  // the cue to hide the bar entirely. Loading state suppresses render to
  // avoid flicker.
  if (loading) return null
  if (!state || !state.accountId) return null

  const currentStep = state.step
  const sampling: 'random' | 'top' = state.sampling

  async function commit(nextStep: number) {
    if (busy) return
    setBusy(true)
    try {
      const res = await workspaceFeedsApi.setAuthorVolume(feedId, pubkey, {
        step: nextStep,
        sampling,
      })
      setState(res)
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  async function commitSampling(next: 'random' | 'top') {
    if (busy) return
    if (currentStep === null) return // sampling toggle is moot before commit
    setBusy(true)
    try {
      const res = await workspaceFeedsApi.setAuthorVolume(feedId, pubkey, {
        step: currentStep,
        sampling: next,
      })
      setState(res)
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    if (busy) return
    setBusy(true)
    try {
      await workspaceFeedsApi.clearAuthorVolume(feedId, pubkey)
      setState({ ...state!, step: null, muted: false, sampling: 'random' })
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 20 }}>
      <div
        className="label-ui"
        style={{ color: TOKENS.meta, marginBottom: 8 }}
      >
        Volume
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {[0, 1, 2, 3, 4, 5].map((s) => {
          const active = currentStep !== null && s <= currentStep && currentStep > 0 && s > 0
          const muteActive = currentStep === 0 && s === 0
          return (
            <button
              key={s}
              type="button"
              onClick={() => commit(s)}
              disabled={busy}
              aria-label={s === 0 ? 'Mute' : `Volume ${s}`}
              style={{
                width: s === 0 ? 24 : 20,
                height: 20,
                background: muteActive
                  ? TOKENS.crimson
                  : active
                    ? TOKENS.fg
                    : 'var(--ah-bone-bright)',
                border: 'none',
                cursor: busy ? 'default' : 'pointer',
                padding: 0,
                fontSize: 10,
                color: muteActive ? 'var(--ah-white)' : TOKENS.meta,
                fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
              }}
            >
              {s === 0 ? '×' : ''}
            </button>
          )
        })}
        {currentStep !== null && (
          <button
            type="button"
            onClick={clear}
            disabled={busy}
            className="label-ui"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
              color: TOKENS.hint,
              padding: 0,
              marginLeft: 8,
            }}
          >
            CLEAR
          </button>
        )}
      </div>

      {/* RANDOM / TOP toggle — only meaningful once committed */}
      {currentStep !== null && currentStep > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {(['random', 'top'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => commitSampling(mode)}
              disabled={busy}
              className="label-ui"
              style={{
                background: sampling === mode ? TOKENS.fg : 'transparent',
                color: sampling === mode ? 'var(--ah-white)' : TOKENS.meta,
                border: `1px solid ${sampling === mode ? TOKENS.fg : TOKENS.rule}`,
                cursor: busy ? 'default' : 'pointer',
                padding: '4px 10px',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      )}

      <p
        className="font-serif italic"
        style={{
          fontSize: 12,
          color: TOKENS.hint,
          marginTop: 10,
          lineHeight: 1.45,
        }}
      >
        {currentStep === null
          ? 'Default — no commitment yet. Pick a step to set how much of this author you want in this feed.'
          : currentStep === 0
            ? 'Muted in this feed.'
            : 'Weight applied to this feed’s ranking.'}
      </p>
    </div>
  )
}

// Slice 15 — three-question poll section per CARDS-AND-PIP-PANEL-HANDOFF.md.
// Each row is question label · YES/NO toggle · aggregate confidence percentage.
// The viewer's own answer (if any) is highlighted; tapping again withdraws it.
function PollQuestions({
  subjectUserId,
  subjectName,
}: {
  subjectUserId: string
  subjectName: string
}) {
  const [polls, setPolls] = useState<PollsResponse['polls'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<PollQuestion | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    trustApi
      .getPolls(subjectUserId)
      .then((res) => {
        if (cancelled) return
        setPolls(res.polls)
      })
      .catch(() => {
        if (cancelled) return
        setPolls(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [subjectUserId])

  if (loading) return null
  if (!polls) return null

  const QUESTIONS: { key: PollQuestion; label: string }[] = [
    { key: 'humanity', label: 'Are they human?' },
    { key: 'authenticity', label: 'Are they who they seem to be?' },
    { key: 'good_faith', label: 'Do they engage in good faith?' },
  ]

  async function answer(q: PollQuestion, a: PollAnswer) {
    if (busy || !polls) return
    const current = polls[q]
    const isWithdraw = current.viewerAnswer === a
    setBusy(q)
    // Optimistic update — adjust aggregate counts so the bar moves immediately.
    const next: PollsResponse['polls'] = JSON.parse(JSON.stringify(polls))
    const slot = next[q]
    if (current.viewerAnswer === 'yes') slot.yes = Math.max(0, slot.yes - 1)
    if (current.viewerAnswer === 'no') slot.no = Math.max(0, slot.no - 1)
    if (!isWithdraw) {
      slot[a] += 1
      slot.viewerAnswer = a
    } else {
      slot.viewerAnswer = null
    }
    setPolls(next)
    try {
      if (isWithdraw) {
        await trustApi.withdrawPoll(subjectUserId, q)
      } else {
        await trustApi.submitPoll(subjectUserId, q, a)
      }
    } catch {
      // Re-fetch on failure to recover from drift.
      const recovered = await trustApi.getPolls(subjectUserId).catch(() => null)
      if (recovered) setPolls(recovered.polls)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {QUESTIONS.map(({ key, label }) => {
        const slot = polls[key]
        const total = slot.yes + slot.no
        const yesPct = total > 0 ? Math.round((slot.yes / total) * 100) : null
        const isBusy = busy === key
        return (
          <div
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span
              className="font-serif"
              style={{ fontSize: 13, color: TOKENS.fg, flex: 1, lineHeight: 1.4 }}
            >
              {label}
            </span>
            <button
              type="button"
              onClick={() => answer(key, 'yes')}
              disabled={isBusy}
              className="label-ui"
              style={{
                background: slot.viewerAnswer === 'yes' ? TOKENS.fg : 'transparent',
                color: slot.viewerAnswer === 'yes' ? 'var(--ah-white)' : TOKENS.meta,
                border: `1px solid ${slot.viewerAnswer === 'yes' ? TOKENS.fg : TOKENS.rule}`,
                cursor: isBusy ? 'default' : 'pointer',
                padding: '3px 8px',
              }}
            >
              YES
            </button>
            <button
              type="button"
              onClick={() => answer(key, 'no')}
              disabled={isBusy}
              className="label-ui"
              style={{
                background: slot.viewerAnswer === 'no' ? TOKENS.crimson : 'transparent',
                color: slot.viewerAnswer === 'no' ? 'var(--ah-white)' : TOKENS.meta,
                border: `1px solid ${slot.viewerAnswer === 'no' ? TOKENS.crimson : TOKENS.rule}`,
                cursor: isBusy ? 'default' : 'pointer',
                padding: '3px 8px',
              }}
            >
              NO
            </button>
            <span
              className="label-ui"
              style={{ color: TOKENS.hint, minWidth: 40, textAlign: 'right' }}
            >
              {yesPct === null ? '—' : `${yesPct}%`}
            </span>
          </div>
        )
      })}
      <p
        className="font-serif italic"
        style={{ fontSize: 12, color: TOKENS.hint, marginTop: 4, lineHeight: 1.45 }}
      >
        Polls about {subjectName} are visible only as totals — your own answer is
        editable.
      </p>
    </div>
  )
}

// Slice 18 — encounter (in-person met) row + viewer's "I've met them" toggle.
// The handoff (CARDS-AND-PIP-PANEL-HANDOFF.md §"Trust section") frames
// in-person meetings as the most expensive signal to fake; slice 17 reserved
// it as the "hard upgrade path to green" but didn't pipe the data in. Slice
// 18 closes that loop: the count line lives in TRUST alongside L1 signals,
// and the toggle posts an `encounter`/`affirm`/`aggregate` vouch via the
// existing /vouches route.
//
// Visibility decision: aggregate (count-only, attestor not surfaced) rather
// than public. The panel's privacy ethos matches the polling section — your
// own gesture is editable, totals are what other people see. A reader who
// wants to publicly endorse "I've met X" can still do so via the full
// vouch surface at /network. This keeps the panel gesture lightweight and
// matches the slice-15 polling-as-aggregate-only contract.
function EncounterRow({
  subjectUserId,
  initialAffirmCount,
  initialViewerVouch,
}: {
  subjectUserId: string
  initialAffirmCount: number
  initialViewerVouch: { id: string; dimension: VouchDimension; value: VouchValue; visibility: VouchVisibility } | null
}) {
  const [count, setCount] = useState(initialAffirmCount)
  const [viewerVouch, setViewerVouch] = useState(initialViewerVouch)
  const [busy, setBusy] = useState(false)

  const youMet = viewerVouch !== null

  async function toggle() {
    if (busy) return
    setBusy(true)
    // Optimistic update — the count moves immediately.
    if (youMet) {
      setCount((c) => Math.max(0, c - 1))
      const prev = viewerVouch
      setViewerVouch(null)
      try {
        await trustApi.withdrawVouch(prev.id)
      } catch {
        // Re-affirm on failure to recover.
        setCount((c) => c + 1)
        setViewerVouch(prev)
      } finally {
        setBusy(false)
      }
    } else {
      setCount((c) => c + 1)
      try {
        const created = await trustApi.vouch({
          subjectId: subjectUserId,
          dimension: 'encounter',
          value: 'affirm',
          visibility: 'aggregate',
        })
        setViewerVouch({
          id: created.id,
          dimension: 'encounter',
          value: 'affirm',
          visibility: 'aggregate',
        })
      } catch {
        setCount((c) => Math.max(0, c - 1))
      } finally {
        setBusy(false)
      }
    }
  }

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: `1px solid ${TOKENS.rule}`,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span
        className="font-sans text-ui-xs"
        style={{ color: TOKENS.fg, flex: 1 }}
      >
        {count === 0
          ? 'Not yet met by anyone in person.'
          : count === 1
            ? 'Met by 1 person in person.'
            : `Met by ${count} people in person.`}
      </span>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className="label-ui"
        style={{
          background: youMet ? TOKENS.fg : 'transparent',
          color: youMet ? 'var(--ah-white)' : TOKENS.fg,
          border: `1px solid ${youMet ? TOKENS.fg : TOKENS.rule}`,
          cursor: busy ? 'default' : 'pointer',
          padding: '4px 10px',
        }}
      >
        {youMet ? 'I’VE MET THEM ✓' : 'I’VE MET THEM'}
      </button>
    </div>
  )
}

// First-cut trust signals row. Renders the Layer 1 signals + dimension counts
// rather than the polling questions described in CARDS-AND-PIP-PANEL-HANDOFF.md
// — those need a polling backend that doesn't exist yet. The current set
// answers a similar question (what does the system know about this author?)
// using data that's actually available.
function TrustSignals({ profile }: { profile: TrustProfileResponse }) {
  const l1 = profile.layer1
  const rows: Array<{ label: string; value: string }> = [
    {
      label: 'Account age',
      value: l1.accountAgeDays >= 365
        ? `${Math.floor(l1.accountAgeDays / 365)}y`
        : `${l1.accountAgeDays}d`,
    },
    { label: 'Articles', value: String(l1.articleCount) },
    { label: 'Paying readers', value: String(l1.payingReaderCount) },
    { label: 'NIP-05', value: l1.nip05Verified ? 'YES' : 'NO' },
    { label: 'Payment verified', value: l1.paymentVerified ? 'YES' : 'NO' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}
        >
          <span
            className="font-sans text-ui-xs"
            style={{ color: 'var(--ah-ink-925)', flex: 1 }}
          >
            {r.label}
          </span>
          <span
            className="label-ui"
            style={{ color: 'var(--ah-stone-600)' }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}
