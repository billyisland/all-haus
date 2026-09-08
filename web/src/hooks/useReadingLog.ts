'use client'

import { useEffect, useRef } from 'react'
import { readingLog } from '../lib/api'

// =============================================================================
// useReadingLog — record that this reader opened this piece.
//
// THE LOG HAS ONE WRITER (READING-LOG-AND-LIBRARY-ADR §6), and this is it. Both
// reader components call it and nothing else does. The alternative that was
// nearly built — a seed at signup for the arrival reader — would have been a
// second writer of a row the ordinary path already writes, in another service,
// on another trigger, with its own idea of what counts as an open.
//
// IT HANGS OFF MOUNT, NOT OFF UNLOCK, and that is the whole of §8.3. A write on
// unlock looks identical in every ordinary session and silently drops the
// above-cap arrival (PAYWALL-ARRIVAL D4 Path C): a reader who met the paywall
// and read what sits above it. Recent reading is attention; the library is
// possession; the gate separates the two tabs, not the log from itself.
//
// FIRE-AND-FORGET, AND THAT IS A CONTRACT RATHER THAN LAZINESS. A failed log
// write loses a row; a log write that could fail an open would cost the reader
// the piece. Nothing here is awaited by a render and every failure is swallowed
// — the same discipline as the notification inserts.
//
// ONCE PER MOUNT PER PIECE. Re-opening the same piece later moves it up the
// list rather than adding to it, and that is the primary key's job on the
// server; the guard here is only so a re-render does not fire a second request
// for a row that is already correct.
// =============================================================================

export function useReadingLog(postId: string | null | undefined, enabled: boolean) {
  const loggedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !postId) return
    if (loggedRef.current === postId) return
    loggedRef.current = postId
    void readingLog.record(postId)
  }, [postId, enabled])
}
