'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi } from '../../lib/api'

interface Props {
  publicationId: string
}

interface MemberShare {
  memberId: string
  accountId: string
  username: string
  displayName: string
  avatarBlossomUrl: string | null
  role: string
  contributorType: string
  isOwner: boolean
  revenueShareBps: number | null
}

interface ArticleShare {
  id: string
  articleId: string
  accountId: string
  username: string
  displayName: string
  articleTitle: string
  articleSlug: string
  shareType: string
  shareValue: number
  paidOut: boolean
}

export function PayrollTab({ publicationId }: Props) {
  const [members, setMembers] = useState<MemberShare[]>([])
  const [articleShares, setArticleShares] = useState<ArticleShare[]>([])
  const [totalBps, setTotalBps] = useState(0)
  const [editShares, setEditShares] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { void load() }, [publicationId])

  async function load() {
    setLoading(true)
    try {
      const data = await pubApi.getPayroll(publicationId)
      setMembers(data.members)
      setArticleShares(data.articleShares)
      setTotalBps(data.totalStandingBps)
      const initial: Record<string, string> = {}
      for (const m of data.members) {
        initial[m.memberId] = String(m.revenueShareBps ?? 0)
      }
      setEditShares(initial)
    } catch { setMsg('Failed to load payroll.') }
    finally { setLoading(false) }
  }

  function editTotal(): number {
    return Object.values(editShares).reduce((sum, v) => sum + (parseInt(v, 10) || 0), 0)
  }

  async function handleSave() {
    const shares = Object.entries(editShares).map(([memberId, val]) => ({
      memberId,
      revenueShareBps: parseInt(val, 10) || 0,
    }))
    const total = shares.reduce((s, x) => s + x.revenueShareBps, 0)
    if (total > 10000) { setMsg('Total shares cannot exceed 10,000 bps (100%).'); return }

    setSaving(true); setMsg(null)
    try {
      const res = await pubApi.updatePayroll(publicationId, shares)
      setTotalBps(res.totalBps)
      setMsg('Payroll updated.')
      void load()
    } catch { setMsg('Failed to save.') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="h-40 animate-pulse bg-glasshouse-well" />

  const currentTotal = editTotal()
  const overBudget = currentTotal > 10000

  return (
    <div className="space-y-8">
      {/* Standing shares */}
      <div className="bg-glasshouse-well px-6 py-5">
        <div className="flex items-center justify-between mb-4">
          <p className="label-ui text-grey-400">Standing revenue shares</p>
          <p className={`text-ui-xs font-sans tabular-nums ${overBudget ? 'text-crimson' : 'text-grey-400'}`}>
            {(currentTotal / 100).toFixed(1)}% of 100%
          </p>
        </div>

        {/* Visual bar */}
        <div className="h-2 bg-grey-100 mb-6 flex overflow-hidden">
          {members.filter(m => parseInt(editShares[m.memberId] || '0', 10) > 0).map(m => {
            const bps = parseInt(editShares[m.memberId] || '0', 10)
            return (
              <div
                key={m.memberId}
                className="h-full bg-black first:rounded-l last:rounded-r"
                style={{ width: `${Math.min(bps / 100, 100)}%` }}
                title={`${m.displayName || m.username}: ${(bps / 100).toFixed(1)}%`}
              />
            )
          })}
        </div>

        <div className="space-y-3">
          {members.map(m => (
            <div key={m.memberId} className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-ui-xs text-black truncate">
                  {m.displayName || m.username}
                  {m.isOwner && <span className="text-grey-300 ml-1">(Owner)</span>}
                </p>
                <p className="text-[12px] font-sans text-grey-300">{m.role} &middot; {m.contributorType}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number" min="0" max="10000" step="100"
                  value={editShares[m.memberId] ?? '0'}
                  onChange={e => setEditShares(prev => ({ ...prev, [m.memberId]: e.target.value }))}
                  className="w-20 bg-grey-100 px-2 py-1 text-ui-xs font-sans text-black text-right tabular-nums"
                />
                <span className="text-[12px] font-sans text-grey-300 w-12">
                  {((parseInt(editShares[m.memberId] || '0', 10)) / 100).toFixed(1)}%
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={handleSave} disabled={saving || overBudget} className="btn text-sm disabled:opacity-50">
            {saving ? 'Saving\u2026' : 'Save'}
          </button>
          {overBudget && <p className="text-ui-xs font-sans text-crimson">Total exceeds 100%</p>}
        </div>
        {msg && <p className="text-ui-xs text-grey-600 mt-2">{msg}</p>}
      </div>

      {/* Per-article overrides */}
      {articleShares.length > 0 && (
        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Per-article overrides</p>
          <div className="overflow-x-auto">
            <table className="w-full text-ui-xs">
              <thead>
                <tr className="border-b-2 border-grey-200">
                  <th className="px-3 py-2 text-left label-ui text-grey-400">Article</th>
                  <th className="px-3 py-2 text-left label-ui text-grey-400">Contributor</th>
                  <th className="px-3 py-2 text-right label-ui text-grey-400">Type</th>
                  <th className="px-3 py-2 text-right label-ui text-grey-400">Value</th>
                  <th className="px-3 py-2 text-right label-ui text-grey-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {articleShares.map(s => (
                  <tr key={s.id} className="border-b-2 border-grey-200 last:border-b-0">
                    <td className="px-3 py-2 text-black truncate max-w-[200px]">{s.articleTitle}</td>
                    <td className="px-3 py-2 text-grey-600">{s.displayName || s.username}</td>
                    <td className="px-3 py-2 text-right text-grey-400">
                      {s.shareType === 'revenue_bps' ? 'Revenue %' : 'Flat fee'}
                    </td>
                    <td className="px-3 py-2 text-right text-black tabular-nums">
                      {s.shareType === 'revenue_bps'
                        ? `${(s.shareValue / 100).toFixed(1)}%`
                        : `\u00a3${(s.shareValue / 100).toFixed(2)}`
                      }
                    </td>
                    <td className="px-3 py-2 text-right">
                      {s.paidOut
                        ? <span className="text-grey-300">Paid</span>
                        : <span className="text-black">Pending</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
