'use client'

import { useEffect, useRef, useState } from 'react'
import { social, type ViewerRelation } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { reportFollowState } from '../../hooks/useFeedFollow'
import { invalidateAuthorCardCache } from '../../hooks/useAuthorCard'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import {
  MUTE_LABEL, UNMUTE_LABEL, BLOCK_LABEL, UNBLOCK_LABEL, MUTE_BLOCK_UNAVAILABLE,
  blockConfirmTitle, BLOCK_CONFIRM_LABEL, BLOCK_CONSEQUENCES,
  MUTE_FAILED, UNMUTE_FAILED, UNBLOCK_FAILED, BLOCK_FAILED,
} from '../../content/social'

// =============================================================================
// MuteBlockControls — the way INTO the two lists Settings could only empty
// (W2, walkthrough A7, operator ruling 2026-09-24).
//
// Mounted in two places and no others: the profile bar (native profile, and an
// external author profile only where a native account is behind it — Report's
// own gate) and the DM header. NOT on cards: a card is about a post, and the
// ruling kept a person-level act off a post-level row.
//
// EACH CONTROL SHOWS THE STATE IT WOULD CHANGE — Mute/Unmute, Block/Unblock —
// read off what the VIEWER has done (`ViewerRelation`), never off a block the
// other party set: a control reading "Unblock" on somebody who blocked you is
// the oracle the gateway's neutral refusals exist to avoid, and you could not
// undo it anyway. Where the host has the state already (the profile payload)
// it passes `initial`; where it does not (the DM header, the SSR'd page) the
// control asks `/my/relations/:id` itself, and draws NOTHING until it knows —
// a guessed "Block" on somebody already blocked is a press that does nothing.
//
// MUTE IS ONE PRESS; BLOCK IS CONFIRMED. A mute is silent and one-sided and
// undoes cleanly. A block ends things for two people — follows both ways, and
// a subscription either way stops renewing — so the confirm says so BEFORE
// the press, and the follow the block dropped is REPORTED to the shared store
// (`reportFollowState`, the one home; this issues no follow write). Unblock is
// one press: it restores nothing the block ended, and the confirm said so.
// =============================================================================

export function MuteBlockControls({
  userId,
  name,
  initial,
  triggerClassName,
  triggerStyle,
  onChange,
}: {
  userId: string
  /** Who, in the confirm's sentence. */
  name: string
  /** The viewer's state, when the host already holds it. */
  initial?: ViewerRelation
  /** The host row's own register, as ReportButton takes it. */
  triggerClassName: string
  triggerStyle?: React.CSSProperties
  /** Told whenever the control learns the state: once it has fetched it,
   *  and after each change the route confirmed. */
  onChange?: (next: ViewerRelation) => void
}) {
  const [relation, setRelation] = useState<ViewerRelation | null>(initial ?? null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'mute' | 'block' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [blockError, setBlockError] = useState<string | null>(null)
  const blockRef = useRef<HTMLButtonElement>(null)
  // Read at resolve time, so a host passing an inline callback does not
  // refetch on every render of its own.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (initial) {
      setRelation(initial)
      return
    }
    let cancelled = false
    setRelation(null)
    setLoadFailed(false)
    social
      .relation(userId)
      .then((r) => {
        if (cancelled) return
        setRelation(r)
        onChangeRef.current?.(r)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [userId, initial])

  if (!relation) {
    // Refuse to guess, and say so rather than leaving a gap that reads as
    // "this person cannot be muted".
    return loadFailed ? (
      <span className={triggerClassName} style={triggerStyle} role="status">
        {MUTE_BLOCK_UNAVAILABLE}
      </span>
    ) : null
  }

  function commit(next: ViewerRelation) {
    setRelation(next)
    invalidateAuthorCardCache()
    onChange?.(next)
  }

  async function toggleMute() {
    if (!relation || busy) return
    setBusy('mute')
    setError(null)
    try {
      if (relation.muted) await social.unmute(userId)
      else await social.mute(userId)
      commit({ ...relation, muted: !relation.muted })
    } catch (err) {
      setError(
        apiErrorMessage(err) ?? (relation.muted ? UNMUTE_FAILED : MUTE_FAILED),
      )
    } finally {
      setBusy(null)
    }
  }

  async function unblock() {
    if (!relation || busy) return
    setBusy('block')
    setError(null)
    try {
      await social.unblock(userId)
      commit({ ...relation, blocked: false })
    } catch (err) {
      setError(apiErrorMessage(err) ?? UNBLOCK_FAILED)
    } finally {
      setBusy(null)
    }
  }

  async function block() {
    if (!relation || busy) return
    setBusy('block')
    setBlockError(null)
    try {
      await social.block(userId)
      // The block dropped the viewer's follow of this person, whatever it was.
      reportFollowState(userId, false)
      commit({ ...relation, blocked: true })
      setConfirming(false)
    } catch (err) {
      setBlockError(apiErrorMessage(err) ?? BLOCK_FAILED)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        onClick={toggleMute}
        disabled={busy !== null}
        className={triggerClassName}
        style={triggerStyle}
        aria-pressed={relation.muted}
      >
        {busy === 'mute' ? '…' : relation.muted ? UNMUTE_LABEL : MUTE_LABEL}
      </button>
      <button
        ref={blockRef}
        onClick={() => {
          if (relation.blocked) void unblock()
          else {
            setBlockError(null)
            setConfirming((v) => !v)
          }
        }}
        disabled={busy !== null && !confirming}
        className={triggerClassName}
        style={triggerStyle}
        aria-haspopup={relation.blocked ? undefined : 'dialog'}
        aria-expanded={relation.blocked ? undefined : confirming}
      >
        {busy === 'block' && !confirming ? '…' : relation.blocked ? UNBLOCK_LABEL : BLOCK_LABEL}
      </button>
      {error && (
        <span className={triggerClassName} style={triggerStyle} role="alert">
          {error}
        </span>
      )}
      <ConfirmDialog
        anchorRef={blockRef}
        open={confirming}
        title={blockConfirmTitle(name)}
        confirmLabel={BLOCK_CONFIRM_LABEL}
        busy={busy === 'block'}
        error={blockError}
        onConfirm={() => void block()}
        onCancel={() => setConfirming(false)}
      >
        {BLOCK_CONSEQUENCES.map((line) => <p key={line}>{line}</p>)}
      </ConfirmDialog>
    </>
  )
}
