'use client'

import React, { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { account as accountApi, type Subscriber } from '../../lib/api'
import { Avatar } from '../ui/Avatar'
import * as C from '../../content/dashboard'

// `onSetUpPricing` is the panel's `switchTab('pricing')`. The empty state's one
// control was a `<Link href="?tab=pricing">` left over from when the dashboard
// was a page (walkthrough A13): in the overlay the tab is a prop, not the query,
// so the press only appended a parameter nobody reads.
export function SubscribersTab({ onSetUpPricing }: { onSetUpPricing: () => void }) {
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    accountApi.getSubscribers()
      .then(res => setSubscribers(res.subscribers))
      .catch(() => setError(C.SUBSCRIBERS_LOAD_FAILED))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  if (error) {
    return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>
  }

  if (subscribers.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400">{C.SUBSCRIBERS_EMPTY}</p>
        <button onClick={onSetUpPricing} className="btn-text mt-2">
          {C.SUBSCRIBERS_SET_UP_PRICING}
        </button>
      </div>
    )
  }

  const active = subscribers.filter(s => s.status === 'active')
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const newThisMonth = active.filter(s => new Date(s.startedAt) >= startOfMonth).length

  // Estimate monthly revenue: active monthly subs at face value,
  // active annual subs divided by 12
  const monthlyRevenuePence = active.reduce((sum, s) => {
    if (s.isComp) return sum
    return sum + (s.subscriptionPeriod === 'annual' ? Math.round(s.pricePence / 12) : s.pricePence)
  }, 0)

  return (
    <div className="space-y-8">
      {/* Summary stats */}
      <div className="flex bg-glasshouse-well px-6 py-5">
        <div className="flex-1 text-center">
          <p className="font-serif text-2xl text-black">{active.length}</p>
          <p className="label-ui text-grey-400 mt-1">{C.SUBSCRIBERS_STAT_ACTIVE}</p>
        </div>
        <div className="flex-1 text-center">
          <p className="font-serif text-2xl text-black">
            £{(monthlyRevenuePence / 100).toFixed(2)}
          </p>
          <p className="label-ui text-grey-400 mt-1">{C.SUBSCRIBERS_STAT_REVENUE}</p>
        </div>
        <div className="flex-1 text-center">
          <p className="font-serif text-2xl text-black">{newThisMonth}</p>
          <p className="label-ui text-grey-400 mt-1">{C.SUBSCRIBERS_STAT_NEW}</p>
        </div>
      </div>

      {/* Subscriber table */}
      <div className="overflow-x-auto ah-scrollbar bg-glasshouse-well">
        <table className="w-full text-ui-xs">
          <thead>
            <tr className="border-b-2 border-grey-200">
              <th className="px-4 py-3 text-left label-ui text-grey-400">{C.SUBSCRIBERS_COL_SUBSCRIBER}</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">{C.SUBSCRIBERS_COL_SINCE}</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">{C.SUBSCRIBERS_COL_PLAN}</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">{C.SUBSCRIBERS_COL_STATUS}</th>
              <th className="px-4 py-3 text-right label-ui text-grey-400">{C.SUBSCRIBERS_COL_AMOUNT}</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map(s => {
              const since = new Date(s.startedAt).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
              })

              const plan = s.isComp ? C.SUBSCRIBER_PLAN_COMP : s.subscriptionPeriod === 'annual' ? C.SUBSCRIBER_PLAN_ANNUAL : C.SUBSCRIBER_PLAN_MONTHLY

              const amount = s.isComp
                ? C.SUBSCRIBER_AMOUNT_FREE
                : C.subscriberAmount(`£${(s.pricePence / 100).toFixed(2)}`, s.subscriptionPeriod === 'annual')

              const statusLabel = s.status === 'active' ? C.SUBSCRIBER_STATUS_ACTIVE : C.SUBSCRIBER_STATUS_CANCELLED

              // For cancelled subs, show "Access until <date>"
              const cancelNote = s.status === 'cancelled' && s.currentPeriodEnd
                ? C.subscriberAccessUntil(new Date(s.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))
                : null

              return (
                <tr key={s.subscriptionId} className="border-b-2 border-grey-200 last:border-b-0">
                  <td className="px-4 py-3">
                    <ProfileLink href={`/${s.readerUsername}`} className="flex items-center gap-2 hover:opacity-80">
                      <Avatar src={s.readerAvatar} name={s.readerDisplayName ?? s.readerUsername} size={32} />
                      <span className="text-black">{s.readerDisplayName ?? s.readerUsername}</span>
                    </ProfileLink>
                  </td>
                  <td className="px-4 py-3 text-grey-400">{since}</td>
                  <td className="px-4 py-3 text-grey-400">{plan}</td>
                  <td className="px-4 py-3">
                    <span className={s.status === 'active' ? 'text-black' : 'text-grey-300'}>
                      {cancelNote ?? statusLabel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{amount}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
