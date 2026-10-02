'use client'

import { useState, useEffect, useCallback } from 'react'
import { notifications } from '../../lib/api'
import { failureSentence } from '../../lib/api/client'
import { pledgesEnabled } from '../../lib/featureFlags'
import {
  NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABEL, NOTIFICATION_PLEDGES_ONLY,
  SETTINGS_ON, SETTINGS_OFF, SETTINGS_RETRY,
  NOTIFICATION_PREFS_LOAD_FAILED, NOTIFICATION_PREF_SAVE_FAILED,
} from '../../content/settings'

// 'commission_request' is gated with the parked pledge-drives feature (2026-07-13).
// The labels live in content/settings.ts. `new_reply`'s is not only about
// articles: a `new_reply` now also reaches the author of a COMMENT that was
// replied to (migration 230), and a category label that names one of the two
// describes a toggle narrower than the thing it governs.
//
// NOTE: none of these toggles does anything yet. `notification_preferences`
// is written by this panel, read by `GET /notifications/preferences` and by
// the data export, and consulted by NO insert site — every notification is
// written regardless. Queued in CONSOLIDATED-TODO rather than fixed here:
// honouring them means notifications start disappearing for whoever has
// already switched one off, which is a product decision and not a repair.
const CATEGORIES: { key: string; label: string }[] = NOTIFICATION_CATEGORIES
  .filter(key => key !== NOTIFICATION_PLEDGES_ONLY || pledgesEnabled())
  .map(key => ({ key, label: NOTIFICATION_CATEGORY_LABEL[key] }))

export function NotificationPreferences() {
  // `null` until a load has SAID what the member's settings are (CA-E10). A
  // failed load used to leave `{}`, and the Off chip's guard (`=== false`)
  // passed on `undefined`, so the press wrote `!undefined` — ON — the
  // opposite of what was pressed. Unknown is unknown: said, with a Retry,
  // and nothing pressable.
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState<{ category: string; message: string } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    notifications.getPreferences()
      .then(res => setPrefs(res.preferences))
      .catch(() => setPrefs(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function choose(category: string, value: boolean) {
    if (!prefs || prefs[category] === value) return
    setSaveError(null)
    setPrefs(p => p && { ...p, [category]: value })
    try {
      await notifications.setPreference(category, value)
    } catch (err) {
      setPrefs(p => p && { ...p, [category]: !value })
      setSaveError({ category, message: failureSentence(err, NOTIFICATION_PREF_SAVE_FAILED) })
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-9 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  return (
      <div>
        {!prefs && (
          <p className="text-ui-xs text-grey-600">
            {NOTIFICATION_PREFS_LOAD_FAILED}{' '}
            <button onClick={load} className="btn-text-muted">{SETTINGS_RETRY}</button>
          </p>
        )}
        {CATEGORIES.map(cat => {
          const value = prefs?.[cat.key]
          return (
            <div key={cat.key} className="py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-ui-sm text-black">{cat.label}</span>
                <div className="flex shrink-0">
                  <button
                    disabled={!prefs}
                    onClick={() => void choose(cat.key, true)}
                    className={`label-ui toggle-chip disabled:opacity-50 ${
                      value === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
                    }`}
                  >
                    {SETTINGS_ON}
                  </button>
                  <button
                    disabled={!prefs}
                    onClick={() => void choose(cat.key, false)}
                    className={`label-ui toggle-chip disabled:opacity-50 ${
                      value === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
                    }`}
                  >
                    {SETTINGS_OFF}
                  </button>
                </div>
              </div>
              {saveError?.category === cat.key && (
                <p role="alert" className="text-ui-xs text-crimson pt-1">{saveError.message}</p>
              )}
            </div>
          )
        })}
      </div>
  )
}
