'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi } from '../../lib/api'

interface Props {
  publicationId: string
}

export function PublicationEarningsTab({ publicationId }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof pubApi.getEarnings>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    pubApi.getEarnings(publicationId)
      .then(setData)
      .catch(() => setError('Failed to load earnings.'))
      .finally(() => setLoading(false))
  }, [publicationId])

  if (loading) return <div className="space-y-4">{[1,2,3].map(i => <div key={i} className="h-20 animate-pulse bg-glasshouse-well" />)}</div>
  if (error || !data) return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>

  const { summary, articles, payouts } = data
  const fmt = (pence: number) => `\u00a3${(pence / 100).toFixed(2)}`

  return (
    <div className="space-y-8">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Net earnings" value={fmt(summary.netPence)} />
        <SummaryCard label="Pending" value={fmt(summary.pendingPence)} />
        <SummaryCard label="Paid out" value={fmt(summary.paidPence)} />
        <SummaryCard label="Paid reads" value={summary.readCount.toLocaleString()} />
        {summary.subscriptionNetPence > 0 && (
          <SummaryCard label="From subscriptions" value={fmt(summary.subscriptionNetPence)} />
        )}
      </div>

      {/* Per-article table */}
      <div className="bg-glasshouse-well px-6 py-5">
        <p className="label-ui text-grey-400 mb-4">Revenue by article</p>
        {articles.length === 0 ? (
          <p className="text-ui-xs text-grey-300">No revenue yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-ui-xs">
              <thead>
                <tr className="border-b-2 border-grey-200">
                  <th className="px-3 py-2 text-left label-ui text-grey-400">Title</th>
                  <th className="px-3 py-2 text-right label-ui text-grey-400">Reads</th>
                  <th className="px-3 py-2 text-right label-ui text-grey-400">Net earned</th>
                </tr>
              </thead>
              <tbody>
                {articles.map(a => (
                  <tr key={a.articleId} className="border-b-2 border-grey-200 last:border-b-0">
                    <td className="px-3 py-2 text-black truncate max-w-[300px]">{a.title}</td>
                    <td className="px-3 py-2 text-right text-grey-600 tabular-nums">{a.readCount}</td>
                    <td className="px-3 py-2 text-right text-black tabular-nums">{fmt(a.netPence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Payout history */}
      {payouts.length > 0 && (
        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Payout history</p>
          <div className="space-y-4">
            {payouts.map(p => (
              <div key={p.id} className="bg-grey-50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-ui-xs text-black">
                      {fmt(p.totalPoolPence - p.platformFeePence + (p.subNetPence ?? 0))} distributed
                    </p>
                    <p className="text-ui-xs text-grey-300">
                      {new Date(p.triggeredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {' \u00b7 '}Platform fee: {fmt(p.platformFeePence)}
                      {p.flatFeesPaidPence > 0 && ` \u00b7 Flat fees: ${fmt(p.flatFeesPaidPence)}`}
                      {(p.subNetPence ?? 0) > 0 && ` \u00b7 Subscriptions: ${fmt(p.subNetPence)}`}
                    </p>
                  </div>
                  <span className={`text-ui-xs ${p.status === 'completed' ? 'text-grey-400' : 'text-black'}`}>
                    {p.status}
                  </span>
                </div>
                {p.splits.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {p.splits.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-ui-xs">
                        <span className="text-grey-600">
                          {s.displayName || s.username}
                          <span className="text-grey-300 ml-1">
                            ({s.shareType === 'standing' ? `${((s.shareBps ?? 0) / 100).toFixed(1)}%` : s.shareType === 'flat_fee' ? 'flat' : 'article'})
                          </span>
                        </span>
                        <span className="text-black tabular-nums">{fmt(s.amountPence)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-glasshouse-well p-4">
      <p className="text-ui-xs text-grey-300 mb-1">{label}</p>
      <p className="text-[20px] font-sans text-black tabular-nums">{value}</p>
    </div>
  )
}
