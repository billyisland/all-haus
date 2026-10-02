'use client'

import { useState, useEffect, useRef, Fragment } from 'react'
import Link from 'next/link'
import { SettlementReceipt } from './SettlementReceipt'
import { request } from '../../lib/api/client'
import {
  LEDGER_CATEGORY_LABELS,
  LEDGER_ALL_READS,
  LEDGER_PAID_ONLY,
  LEDGER_EMPTY,
  LEDGER_LOAD_FAILED,
  LEDGER_COLUMNS,
  LEDGER_RECEIPT,
  LEDGER_HIDE_RECEIPT,
  ledgerAmount,
} from '../../content/ledger'
import { SETTINGS_RETRY } from '../../content/settings'

type LedgerFilter = 'all' | 'income' | 'spending'

interface LedgerEntry {
  id: string
  date: string
  type: 'credit' | 'debit' | 'settlement'
  category: string
  description: string
  amount_pence: number
  link: string | null
  /** The settlement this row is about, on a settlement row and nowhere else.
   *  Not derived by stripping the display id's prefix: a key that groups is not
   *  a key that joins, and the column is the key. */
  ref_id: string | null
}

const PAGE_SIZE = 30

const CATEGORY_LABELS = LEDGER_CATEGORY_LABELS

export function AccountLedger({ initialIncludeFreeReads = false }: { initialIncludeFreeReads?: boolean } = {}) {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [totalEntries, setTotalEntries] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [includeFreeReads, setIncludeFreeReads] = useState(initialIncludeFreeReads)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // THE STATEMENT COULD NOT BE READ is its own state (CA-E1): a bare `catch {}`
  // left `entries` empty and the branch below said "No transactions yet" — a
  // ledger that failed to load, presented as a ledger with nothing in it, on
  // the one surface that states what a member owes and is owed.
  const [loadFailed, setLoadFailed] = useState(false)
  // A SEQUENCE GUARD (CA-E7): the effect fires per filter change, and a late
  // answer for the OLD filter used to overwrite the list the new one had just
  // set; "Load more" then appended a page of one filter onto another's rows.
  // Every fetch takes a ticket, and only the latest ticket may write.
  const seqRef = useRef(0)
  // The receipt a settlement row has open, if any. ONE at a time: a ledger with
  // six charges expanded is a list nobody can read, and the question a reader
  // brings here is about one charge.
  const [openReceipt, setOpenReceipt] = useState<string | null>(null)

  // Map our filter names to the backend's expected values
  const filterMap: Record<LedgerFilter, string> = { all: 'all', income: 'credits', spending: 'debits' }

  async function fetchEntries(f: LedgerFilter, offset: number, append: boolean, freeReads?: boolean) {
    const showFree = freeReads ?? includeFreeReads
    const isInitial = offset === 0 && !append
    const seq = ++seqRef.current
    if (isInitial) { setLoading(true); setLoadFailed(false) }
    else setLoadingMore(true)
    try {
      const data = await request<{ entries: LedgerEntry[]; totalEntries: number; hasMore: boolean }>(
        `/my/account-statement?filter=${filterMap[f]}&limit=${PAGE_SIZE}&offset=${offset}${showFree ? '&include_free_reads=true' : ''}`,
      )
      if (seq !== seqRef.current) return
      setEntries(prev => append ? [...prev, ...data.entries] : data.entries)
      setTotalEntries(data.totalEntries)
      setHasMore(data.hasMore)
    } catch {
      if (seq !== seqRef.current) return
      if (isInitial) setLoadFailed(true)
    } finally {
      if (seq === seqRef.current) { setLoading(false); setLoadingMore(false) }
    }
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
          {includeFreeReads ? LEDGER_ALL_READS : LEDGER_PAID_ONLY}
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      ) : loadFailed ? (
        <div className="py-12 text-center">
          <p className="text-ui-sm text-grey-600">
            {LEDGER_LOAD_FAILED}{' '}
            <button onClick={() => void fetchEntries(filter, 0, false, includeFreeReads)} className="btn-text-muted">{SETTINGS_RETRY}</button>
          </p>
        </div>
      ) : entries.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-ui-sm text-grey-400">{LEDGER_EMPTY}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto ah-scrollbar bg-glasshouse-well">
            <table className="w-full text-ui-xs">
              <thead>
                <tr className="border-b-2 border-grey-200/50">
                  <th className="px-4 py-3 text-left label-ui text-grey-400">{LEDGER_COLUMNS.date}</th>
                  <th className="px-4 py-3 text-left label-ui text-grey-400">{LEDGER_COLUMNS.type}</th>
                  <th className="px-4 py-3 text-left label-ui text-grey-400">{LEDGER_COLUMNS.description}</th>
                  <th className="px-4 py-3 text-right label-ui text-grey-400">{LEDGER_COLUMNS.amount}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <Fragment key={entry.id}>
                  <tr className="border-b-2 border-grey-200/50 last:border-b-0">
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
                      {/* A settlement row is the one line that says a charge
                          happened, so it is where the receipt Reader Terms 5.2
                          promises belongs. Offered only where there IS a
                          settlement to open — a button that cannot do its job is
                          not offered. */}
                      {entry.ref_id && (
                        <button
                          onClick={() => setOpenReceipt(openReceipt === entry.ref_id ? null : entry.ref_id)}
                          className="btn-text-muted ml-3"
                        >
                          {openReceipt === entry.ref_id ? LEDGER_HIDE_RECEIPT : LEDGER_RECEIPT}
                        </button>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium font-mono text-mono-xs ${
                      entry.category === 'free_read' ? 'text-grey-300' : entry.type === 'credit' ? 'text-crimson' : 'text-black'
                    }`}>
                      {ledgerAmount(entry)}
                    </td>
                  </tr>
                  {entry.ref_id && openReceipt === entry.ref_id && (
                    <tr className="border-b-2 border-grey-200/50 last:border-b-0">
                      <td colSpan={4} className="px-4 pb-4">
                        <SettlementReceipt settlementId={entry.ref_id} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
