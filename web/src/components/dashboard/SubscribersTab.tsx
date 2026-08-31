'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { ProfileLink } from '../ui/ProfileLink'
import { account as accountApi, type Subscriber } from '../../lib/api'
import { Avatar } from '../ui/Avatar'

export function SubscribersTab() {
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    accountApi.getSubscribers()
      .then(res => setSubscribers(res.subscribers))
      .catch(() => setError('Failed to load subscribers.'))
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
        <p className="text-ui-sm text-grey-400">No subscribers yet.</p>
        <Link href="?tab=pricing" className="text-ui-xs text-black underline mt-2 inline-block">
          Set up subscription pricing
        </Link>
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
          <p className="label-ui text-grey-400 mt-1">Active subscribers</p>
        </div>
        <div className="flex-1 text-center">
          <p className="font-serif text-2xl text-black">
            £{(monthlyRevenuePence / 100).toFixed(2)}
          </p>
          <p className="label-ui text-grey-400 mt-1">Monthly revenue (est.)</p>
        </div>
        <div className="flex-1 text-center">
          <p className="font-serif text-2xl text-black">{newThisMonth}</p>
          <p className="label-ui text-grey-400 mt-1">New this month</p>
        </div>
      </div>

      {/* Subscriber table */}
      <div className="overflow-x-auto bg-glasshouse-well">
        <table className="w-full text-ui-xs">
          <thead>
            <tr className="border-b-2 border-grey-200">
              <th className="px-4 py-3 text-left label-ui text-grey-400">Subscriber</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Since</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Plan</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Status</th>
              <th className="px-4 py-3 text-right label-ui text-grey-400">Amount</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map(s => {
              const since = new Date(s.startedAt).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
              })

              const plan = s.isComp ? 'Comp' : s.subscriptionPeriod === 'annual' ? 'Annual' : 'Monthly'

              const amount = s.isComp
                ? 'Free'
                : `£${(s.pricePence / 100).toFixed(2)}/${s.subscriptionPeriod === 'annual' ? 'yr' : 'mo'}`

              const statusLabel = s.status === 'active' ? 'Active' : 'Cancelled'

              // For cancelled subs, show "Access until <date>"
              const cancelNote = s.status === 'cancelled' && s.currentPeriodEnd
                ? `Access until ${new Date(s.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
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
