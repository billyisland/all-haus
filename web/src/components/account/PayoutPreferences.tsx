'use client'

import { useEffect, useState } from 'react'
import {
  account,
  PAYOUT_CADENCES,
  type PayoutCadence,
  type PayoutPreferences as Prefs,
} from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import {
  PAYOUT_CADENCE_LABEL,
  PAYOUT_CADENCE_HELP,
  PAYOUT_PREFS_UNAVAILABLE,
  PAYOUT_SAVED,
  PAYOUT_SAVE_FAILED,
  PAYOUT_HOW_OFTEN,
  PAYOUT_THRESHOLD_LABEL,
  payoutFloorSentence,
  PAYOUT_MALFORMED,
  payoutBelowFloor,
} from '../../content/money-settings'

// =============================================================================
// When and how much (L5.3, migration 210; Writer Agreement 6.3).
//
// Writer 6.3 offers the Writer a say in when they are paid and the code had
// none: one platform threshold for everybody, and a transfer the moment it was
// crossed. This is that say — a cadence and a figure of their own.
//
// A CADENCE IS A MINIMUM GAP, NOT A DATE, and the copy says so in those words.
// "Weekly" here means at most once every seven days since the last payment, not
// every Tuesday — the platform never promises a date, and wording it as one
// would be a promise the payout cycle does not keep. (The gateway measures the
// gap from the last COMPLETED payout, read fresh each cycle.)
//
// THE FLOOR IS STATED, NOT DISCOVERED. Each transfer costs the platform a
// Stripe fee, so a figure below the platform's is refused — and the refusal is
// a fact about the product, so the surface says it before the press rather than
// after it. The floor arrives WITH the preferences, never as a constant over
// here: it is a dial, and a copy in the client is a dial with two readers that
// can disagree.
// =============================================================================

const CADENCE_LABEL = PAYOUT_CADENCE_LABEL

const CADENCE_HELP = PAYOUT_CADENCE_HELP

export function PayoutPreferences() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [cadence, setCadence] = useState<PayoutCadence>('daily')
  const [thresholdInput, setThresholdInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const p = await account.getPayoutPreferences()
        if (!live) return
        setPrefs(p)
        setCadence(p.cadence)
        // Pounds in the box, pence on the wire. An empty box is "use the
        // platform's figure" — a distinct answer from typing the platform's
        // own number, which would pin them to it if the dial later moved down.
        setThresholdInput(p.thresholdPence === null ? '' : (p.thresholdPence / 100).toString())
      } catch {
        // An outage renders as an outage, never as "no preferences set" — the
        // second would invite a save that overwrites what is actually stored.
        if (live) setLoadFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  if (loadFailed) {
    return (
      <p className="text-ui-xs text-grey-600">
        {PAYOUT_PREFS_UNAVAILABLE}
      </p>
    )
  }
  if (!prefs) return <div className="h-16 animate-pulse bg-glasshouse-well" />

  const floor = prefs.platformThresholdPence
  const parsedPounds = thresholdInput.trim() === '' ? null : Number(thresholdInput)
  const thresholdPence =
    parsedPounds === null || !Number.isFinite(parsedPounds)
      ? null
      : Math.round(parsedPounds * 100)
  const malformed = thresholdInput.trim() !== '' && !Number.isFinite(parsedPounds)
  const belowFloor = thresholdPence !== null && thresholdPence < floor
  const changed = cadence !== prefs.cadence || thresholdPence !== prefs.thresholdPence

  async function save() {
    if (!changed || malformed || belowFloor) return
    setSaving(true)
    setNotice(null)
    setError(null)
    try {
      const saved = await account.updatePayoutPreferences(cadence, thresholdPence)
      setPrefs({ ...prefs!, cadence: saved.cadence, thresholdPence: saved.thresholdPence })
      setNotice(PAYOUT_SAVED)
    } catch (err) {
      setError(apiErrorMessage(err) ?? PAYOUT_SAVE_FAILED)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="label-ui text-grey-600 mb-2">{PAYOUT_HOW_OFTEN}</p>
        <div className="flex flex-wrap gap-2">
          {PAYOUT_CADENCES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCadence(c)}
              className={`toggle-chip label-ui ${
                cadence === c ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
            >
              {CADENCE_LABEL[c]}
            </button>
          ))}
        </div>
        <p className="text-ui-xs text-grey-600 mt-2">{CADENCE_HELP[cadence]}</p>
      </div>

      <div>
        <label htmlFor="payout-threshold" className="label-ui text-grey-600 block mb-2">
          {PAYOUT_THRESHOLD_LABEL}
        </label>
        <div className="flex items-center gap-3">
          <span className="text-ui-sm text-grey-600">£</span>
          <input
            id="payout-threshold"
            type="text"
            inputMode="decimal"
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            placeholder={(floor / 100).toString()}
            className="bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring w-32"
          />
        </div>
        <p className="text-ui-xs text-grey-600 mt-2">
          {payoutFloorSentence(floor)}
        </p>
        {malformed && (
          <p className="text-ui-xs text-crimson mt-2">{PAYOUT_MALFORMED}</p>
        )}
        {belowFloor && !malformed && (
          <p className="text-ui-xs text-crimson mt-2">
            {payoutBelowFloor(floor)}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          className="btn-soft"
          disabled={saving || !changed || malformed || belowFloor}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {notice && <p className="text-ui-xs text-grey-600">{notice}</p>}
        {error && <p className="text-ui-xs text-crimson">{error}</p>}
      </div>
    </div>
  )
}
