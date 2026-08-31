'use client'

import { useEffect, useState } from 'react'
import { readingPreferences } from '../../lib/api'

export function ReadingPreferences() {
  const [alwaysOpenAtTop, setAlwaysOpenAtTop] = useState<boolean | null>(null)

  useEffect(() => {
    readingPreferences.get()
      .then(res => setAlwaysOpenAtTop(res.alwaysOpenAtTop))
      .catch(() => setAlwaysOpenAtTop(false))
  }, [])

  async function set(value: boolean) {
    if (alwaysOpenAtTop === value) return
    const previous = alwaysOpenAtTop
    setAlwaysOpenAtTop(value)
    try {
      await readingPreferences.update(value)
    } catch {
      setAlwaysOpenAtTop(previous)
    }
  }

  return (
        <div className="flex items-center justify-between py-1">
          <div className="pr-6">
            <p className="text-ui-sm text-black">Always open articles at the top</p>
            <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
              By default, articles you've started reading reopen where you left off. Turn this on to always start from the beginning.
            </p>
          </div>
          <div className="flex shrink-0">
            <button
              onClick={() => set(true)}
              className={`label-ui toggle-chip ${
                alwaysOpenAtTop === true ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={alwaysOpenAtTop === null}
            >
              On
            </button>
            <button
              onClick={() => set(false)}
              className={`label-ui toggle-chip ${
                alwaysOpenAtTop === false ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
              disabled={alwaysOpenAtTop === null}
            >
              Off
            </button>
          </div>
        </div>
  )
}
