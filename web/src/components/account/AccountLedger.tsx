'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type LedgerFilter = 'all' | 'income' | 'spending'

interface LedgerEntry {
  id: string
  date: string
  type: 'credit' | 'debit' | 'settlement'
  category: string
  description: string
  amount_pence: number
  link: string | null
}

const PAGE_SIZE = 30

const CATEGORY_LABELS: Record<string, string> = {
  free_allowance: 'Free credit',
  article_read: 'Paywall',
  article_earning: 'Article read',
  free_read: 'Free',
  subscription_charge: 'Subscription',
  subscription_earning: 'Subscriber',
  vote_charge: 'Vote',
  vote_earning: 'Vote income',
  settlement: 'Settlement',
}

export function AccountLedger({ initialIncludeFreeReads = false }: { initialIncludeFreeReads?: boolean } = {}) {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [totalEntries, setTotalEntries] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [includeFreeReads, setIncludeFreeReads] = useState(initialIncludeFreeReads)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // Map our filter names to the backend's expected values
  const filterMap: Record<LedgerFilter, string> = { all: 'all', income: 'credits', spending: 'debits' }

  async function fetchEntries(f: LedgerFilter, offset: number, append: boolean, freeReads?: boolean) {
    const showFree = freeReads ?? includeFreeReads
    const isInitial = offset === 0 && !append
    if (isInitial) setLoading(true)
    else setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/v1/my/account-statement?filter=${filterMap[f]}&limit=${PAGE_SIZE}&offset=${offset}${showFree ? '&include_free_reads=true' : ''}`,
        { credentials: 'include' }
      )
      if (!res.ok) throw new Error('Failed to load')
      const data = await res.json()
      setEntries(prev => append ? [...prev, ...data.entries] : data.entries)
      setTotalEntries(data.totalEntries)
      setHasMore(data.hasMore)
    } catch {}
    finally { setLoading(false); setLoadingMore(false) }
  }

  useEffect(() => { void fetchEntries(filter, 0, false, includeFreeReads) }, [filter, includeFreeReads])

  return (
    <div data-explain="ledger.transactions" className="mb-10">
      {/* Filter tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          {(['all', 'income', 'spending'] as LedgerFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`tab-pill ${filter === f ? 'tab-pill-active' : 'tab-pill-inactive'}`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <button
          onClick={() => setIncludeFreeReads(!includeFreeReads)}
          className={`text-ui-xs ${includeFreeReads ? 'text-black' : 'text-grey-300'} hover:text-black transition-colors`}
        >
          {includeFreeReads ? 'All reads' : 'Paid only'}
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      ) : entries.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-ui-sm text-grey-400">No transactions yet.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto bg-glasshouse-well">
            <table className="w-full text-ui-xs">
              <thead>
                <tr className="border-b-2 border-grey-200/50">
                  <th className="px-4 py-3 text-left label-ui text-grey-400">Date</th>
                  <th className="px-4 py-3 text-left label-ui text-grey-400">Type</th>
                  <th className="px-4 py-3 text-left label-ui text-grey-400">Description</th>
                  <th className="px-4 py-3 text-right label-ui text-grey-400">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b-2 border-grey-200/50 last:border-b-0">
                    <td className="px-4 py-3 text-grey-300 whitespace-nowrap font-mono text-mono-xs">
                      {new Date(entry.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`text-ui-xs ${entry.type === 'credit' ? 'text-black' : entry.type === 'settlement' ? 'text-grey-400' : 'text-crimson-dark'}`}>
                        {CATEGORY_LABELS[entry.category] ?? entry.category}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {entry.link ? (
                        <Link href={entry.link} className="text-black hover:opacity-70">{entry.description}</Link>
                      ) : (
                        <span className="text-black">{entry.description}</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium font-mono text-mono-xs ${
                      entry.category === 'free_read' ? 'text-grey-300' : entry.type === 'credit' ? 'text-crimson' : 'text-black'
                    }`}>
                      {entry.category === 'free_read' ? 'Free' : `${entry.type === 'credit' ? '+' : '−'}£${(Math.abs(entry.amount_pence) / 100).toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="mt-4 text-center">
              <button
                onClick={() => fetchEntries(filter, entries.length, true)}
                disabled={loadingMore}
                className="btn-text underline underline-offset-4"
              >
                {loadingMore ? 'Loading…' : `Show more (${totalEntries - entries.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
