'use client'

import { useEffect, useState } from 'react'
import { readingPreferences, readingLog } from '../../lib/api'
import {
  READING_LOG_TITLE, readingWindowPhrase, readingLogSentence,
  READING_CLEAR_TITLE, READING_CLEAR_BEFORE, READING_CLEAR_NOTHING, readingClearedSentence,
  READING_CLEAR_BUTTON, READING_CLEAR_CONFIRM, READING_CLEARING, READING_CLEAR_FAILED,
  SETTINGS_CANCEL,
} from '../../content/settings'

// =============================================================================
// Settings › Reading — the two account-level reading dials, plus the log's
// clear (READING-LOG-AND-LIBRARY-ADR D1/D4).
//
// BOTH TOGGLES ARE ACCOUNT STATE, NOT localStorage, and that is the same split
// the once-per-member invariant draws: a per-device flag is right for what is
// genuinely per-device (the type-size control next door, which says "Applies to
// this device"), and wrong for a fact about the person. Somebody who set resume
// on their laptop and found it off on their phone would read that as the
// setting not working — and somebody who switched their reading log off on one
// browser would rightly expect it to stay off everywhere.
//
// RESUME REUSES THE COLUMN THAT ALREADY EXISTED (`always_open_articles_at_top`,
// migration 069). A second column meaning the same thing with the opposite
// polarity is the drift the tuning-dials invariant exists to prevent, and it is
// worse here than in config: both would be writable from this screen, and the
// loser would present as a control that does nothing.
// =============================================================================

export function ReadingPreferences() {
  const [alwaysOpenAtTop, setAlwaysOpenAtTop] = useState<boolean | null>(null)
  const [logEnabled, setLogEnabled] = useState<boolean | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState<number | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  // A FAILED READ ASSERTS NOTHING (walkthrough A10, same shape as Settings ›
  // Networks). This used to fall to the server's defaults on the theory that a
  // write corrects a wrong guess — but each setter early-returns when the
  // pressed value equals the one on screen, so a guess that happened to equal
  // the member's wish made their press a no-op: logging really off, guessed
  // On, press On, nothing. Unknown stays unknown, says so, and offers a retry.
  function load() {
    setLoadFailed(false)
    readingPreferences.get()
      .then(res => {
        setAlwaysOpenAtTop(res.alwaysOpenAtTop)
        setLogEnabled(res.readingLogEnabled)
        setRetentionDays(res.retentionDays ?? null)
      })
      .catch(() => setLoadFailed(true))
  }

  useEffect(() => { load() }, [])

  const unread = loadFailed ? (
    <>
      Couldn&rsquo;t load this setting.{' '}
      <button onClick={load} className="btn-text">Retry</button>
    </>
  ) : null

  const SAVE_FAILED = "Couldn’t save that change, so the setting is as it was. Please try again."

  // The window, named from the dial (walkthrough A11) — see readingWindowPhrase.
  const windowPhrase = readingWindowPhrase(retentionDays)

  async function setTop(value: boolean) {
    if (alwaysOpenAtTop === value) return
    const previous = alwaysOpenAtTop
    setAlwaysOpenAtTop(value)
    setWriteError(null)
    try {
      // `readingLogEnabled` is deliberately OMITTED, not sent as its current
      // value: the route leaves an omitted field alone, so a stale local copy
      // of the other toggle can never be written back over a change made in
      // another tab.
      await readingPreferences.update({ alwaysOpenAtTop: value })
    } catch {
      setAlwaysOpenAtTop(previous)
      setWriteError(SAVE_FAILED)
    }
  }

  async function setLogging(value: boolean) {
    if (logEnabled === value) return
    const previous = logEnabled
    setLogEnabled(value)
    setWriteError(null)
    try {
      // `alwaysOpenAtTop` is OMITTED for exactly the reason `setTop` above
      // states about this field: the route leaves an omitted field alone, so a
      // stale local copy cannot be written back over a change made elsewhere.
      // Sending it was worse than stale — `?? false` turned "not loaded yet"
      // and "the fetch failed" into a positive write of OFF, so a member who
      // toggled logging before the preferences call returned silently switched
      // their own resume setting off.
      const res = await readingPreferences.update({
        readingLogEnabled: value,
      })
      setLogEnabled(res.readingLogEnabled)
    } catch {
      setLogEnabled(previous)
      setWriteError(SAVE_FAILED)
    }
  }

  async function clear() {
    setClearing(true)
    setWriteError(null)
    try {
      const res = await readingLog.clear()
      setCleared(res.deleted)
      setConfirmClear(false)
    } catch {
      // Leave the confirm open AND say so — a failure that only left the
      // confirm standing looked like a press that had not registered.
      setWriteError(READING_CLEAR_FAILED)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between py-1">
        <div className="pr-6">
          <p className="text-ui-sm text-black">Always open articles at the top</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            {alwaysOpenAtTop === null && unread
              ? unread
              : <>By default, articles you&apos;ve started reading reopen where you left off. Turn this on to always start from the beginning.</>}
          </p>
        </div>
        <div className="flex shrink-0">
          <button
            onClick={() => setTop(true)}
            className={`label-ui toggle-chip ${
              alwaysOpenAtTop === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={alwaysOpenAtTop === null}
          >
            On
          </button>
          <button
            onClick={() => setTop(false)}
            className={`label-ui toggle-chip ${
              alwaysOpenAtTop === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={alwaysOpenAtTop === null}
          >
            Off
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between py-1">
        <div className="pr-6">
          <p className="text-ui-sm text-black">{READING_LOG_TITLE}</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            {logEnabled === null && unread
              ? unread
              : readingLogSentence(windowPhrase)}
          </p>
        </div>
        <div className="flex shrink-0">
          <button
            onClick={() => setLogging(true)}
            className={`label-ui toggle-chip ${
              logEnabled === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={logEnabled === null}
          >
            On
          </button>
          <button
            onClick={() => setLogging(false)}
            className={`label-ui toggle-chip ${
              logEnabled === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
            disabled={logEnabled === null}
          >
            Off
          </button>
        </div>
      </div>

      {/* The clear stands whether logging is on or off — switching it off
          stops new rows and does not remove the ones already there, and a
          member who has just turned it off is exactly who wants this. */}
      <div className="flex items-center justify-between py-1">
        <div className="pr-6">
          <p className="text-ui-sm text-black">{READING_CLEAR_TITLE}</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            {cleared === null
              ? READING_CLEAR_BEFORE
              : cleared === 0
                ? READING_CLEAR_NOTHING
                : readingClearedSentence(cleared)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {confirmClear ? (
            <>
              <button
                onClick={() => setConfirmClear(false)}
                className="btn-text-muted"
                disabled={clearing}
              >
                {SETTINGS_CANCEL}
              </button>
              <button
                onClick={() => void clear()}
                className="btn-text-danger"
                disabled={clearing}
              >
                {clearing ? READING_CLEARING : READING_CLEAR_CONFIRM}
              </button>
            </>
          ) : (
            <button
              onClick={() => { setCleared(null); setConfirmClear(true) }}
              className="btn-text-danger"
            >
              {READING_CLEAR_BUTTON}
            </button>
          )}
        </div>
      </div>
      {writeError && <p className="text-ui-xs text-crimson">{writeError}</p>}
    </div>
  )
}
