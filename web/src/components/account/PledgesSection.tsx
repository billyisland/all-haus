'use client'

import { useState, useEffect } from 'react'
import { drives as drivesApi, type Pledge } from '../../lib/api'

export function PledgesSection() {
  const [pledges, setPledges] = useState<Pledge[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const data = await drivesApi.myPledges()
        setPledges(data.pledges)
      } catch {}
      finally { setLoading(false) }
    })()
  }, [])

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />
  if (pledges.length === 0) return null

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Pledges</p>
      <div className="bg-glasshouse-well divide-y divide-grey-200/50">
        {pledges.map(p => (
          <div key={p.id} className="flex items-center justify-between px-6 py-4">
            <div className="min-w-0">
              <p className="text-ui-sm font-sans text-black">{p.driveTitle}</p>
              <p className="label-ui text-grey-300">by @{p.writer.username}</p>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[12px] text-black tabular-nums">£{(p.amountPence / 100).toFixed(2)}</span>
              <span className={`label-ui ${
                p.status === 'fulfilled' ? 'text-black' : p.status === 'active' ? 'text-grey-400' : 'text-grey-300'
              }`}>
                {p.status === 'fulfilled' ? 'Funded' : p.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
