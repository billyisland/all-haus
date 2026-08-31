'use client'

import { useState } from 'react'
import TraffologyFeedPage from '../../app/traffology/page'
import TraffologyOverviewPage from '../../app/traffology/overview/page'

type AnalyticsView = 'feed' | 'overview'

export function AnalyticsTab() {
  const [view, setView] = useState<AnalyticsView>('feed')

  return (
    <div>
      {/* Traffology header */}
      <div className="mb-6">
        <div className="mb-1">
          <span className="label-ui font-bold text-black">
            ∀ Traffology
          </span>
        </div>
        <div className="w-full h-1 bg-black" />
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 mb-8">
        {(['feed', 'overview'] as AnalyticsView[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-ui-xs font-medium border-2 border-black border-r-0 last:border-r-2 transition-colors ${
              view === v
                ? 'bg-black text-white'
                : 'bg-transparent text-black hover:bg-grey-100'
            }`}
          >
            {v === 'feed' ? 'Feed' : 'Overview'}
          </button>
        ))}
      </div>

      {view === 'feed' ? <TraffologyFeedPage /> : <TraffologyOverviewPage />}
    </div>
  )
}
