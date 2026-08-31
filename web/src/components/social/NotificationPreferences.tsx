'use client'

import { useState, useEffect } from 'react'
import { notifications } from '../../lib/api'
import { pledgesEnabled } from '../../lib/featureFlags'

// 'commission_request' is gated with the parked pledge-drives feature (2026-07-13).
const CATEGORIES: { key: string; label: string }[] = [
  { key: 'new_follower', label: 'New followers' },
  { key: 'new_reply', label: 'Replies to your articles' },
  { key: 'new_mention', label: 'Mentions' },
  { key: 'new_quote', label: 'Quotes of your work' },
  ...(pledgesEnabled() ? [{ key: 'commission_request', label: 'Commission requests' }] : []),
  { key: 'pub_events', label: 'Publication events' },
  { key: 'subscription_activity', label: 'Subscription activity' },
]

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    notifications.getPreferences()
      .then(res => setPrefs(res.preferences))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function toggle(category: string) {
    const newValue = !prefs[category]
    setPrefs(p => ({ ...p, [category]: newValue }))
    try {
      await notifications.setPreference(category, newValue)
    } catch {
      setPrefs(p => ({ ...p, [category]: !newValue }))
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
        {CATEGORIES.map(cat => (
          <div key={cat.key} className="flex items-center justify-between py-2.5">
            <span className="text-ui-sm text-black">{cat.label}</span>
            <div className="flex shrink-0">
              <button
                onClick={() => { if (!prefs[cat.key]) return; void toggle(cat.key) }}
                className={`label-ui toggle-chip ${
                  prefs[cat.key] ? 'toggle-chip-active' : 'toggle-chip-inactive'
                }`}
              >
                On
              </button>
              <button
                onClick={() => { if (prefs[cat.key] === false) return; void toggle(cat.key) }}
                className={`label-ui toggle-chip ${
                  prefs[cat.key] === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
                }`}
              >
                Off
              </button>
            </div>
          </div>
        ))}
      </div>
  )
}
