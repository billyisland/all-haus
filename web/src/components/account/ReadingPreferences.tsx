'use client'

import { useEffect, useState } from 'react'
import { readingPreferences, readingLog } from '../../lib/api'

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

  useEffect(() => {
    readingPreferences.get()
      .then(res => {
        setAlwaysOpenAtTop(res.alwaysOpenAtTop)
        setLogEnabled(res.readingLogEnabled)
      })
      .catch(() => {
        // Unknown, not "off" — but the controls need a value to render, and the
        // server's own defaults are resume-on / logging-on, so failing to those
        // shows the member what they most likely have. A write from here reads
        // its own result back, so a wrong guess corrects itself on first use.
        setAlwaysOpenAtTop(false)
        setLogEnabled(true)
      })
  }, [])

  async function setTop(value: boolean) {
    if (alwaysOpenAtTop === value) return
    const previous = alwaysOpenAtTop
    setAlwaysOpenAtTop(value)
    try {
      // `readingLogEnabled` is deliberately OMITTED, not sent as its current
      // value: the route leaves an omitted field alone, so a stale local copy
      // of the other toggle can never be written back over a change made in
      // another tab.
      await readingPreferences.update({ alwaysOpenAtTop: value })
    } catch {
      setAlwaysOpenAtTop(previous)
    }
  }

  async function setLogging(value: boolean) {
    if (logEnabled === value) return
    const previous = logEnabled
    setLogEnabled(value)
    try {
      const res = await readingPreferences.update({
        alwaysOpenAtTop: alwaysOpenAtTop ?? false,
        readingLogEnabled: value,
      })
      setLogEnabled(res.readingLogEnabled)
    } catch {
      setLogEnabled(previous)
    }
  }

  async function clear() {
    setClearing(true)
    try {
      const res = await readingLog.clear()
      setCleared(res.deleted)
      setConfirmClear(false)
    } catch {
      // Leave the confirm open — saying nothing here would look exactly like
      // a clear that worked, on the one control whose whole job is to be
      // believed.
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
            By default, articles you&apos;ve started reading reopen where you left off. Turn this on to always start from the beginning.
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
          <p className="text-ui-sm text-black">Keep a record of what you read</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            Recent reading lists everything you open in a reader for a week, then forgets it. Nobody else can see it — not the writers you read, not us.
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
          <p className="text-ui-sm text-black">Clear Recent reading</p>
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            {cleared === null
              ? 'Empties the list now. It cannot be undone, and it does not affect your library.'
              : cleared === 0
                ? 'There was nothing to clear.'
                : `Cleared ${cleared} ${cleared === 1 ? 'piece' : 'pieces'}.`}
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
                Cancel
              </button>
              <button
                onClick={() => void clear()}
                className="btn-text-danger"
                disabled={clearing}
              >
                {clearing ? 'Clearing…' : 'Clear it'}
              </button>
            </>
          ) : (
            <button
              onClick={() => { setCleared(null); setConfirmClear(true) }}
              className="btn-text-danger"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
