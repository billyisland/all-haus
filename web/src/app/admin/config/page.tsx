'use client'

import { useEffect, useMemo, useState } from 'react'
import { adminDashboard, type AdminConfigRow } from '../../../lib/api'
import { apiErrorMessage } from '../../../lib/api/client'
import { timeAgo } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { SeedFormulaPanel } from '../../../components/admin/SeedFormulaPanel'
import { useConfirm } from '../../../components/ui/ConfirmDialog'

// Ordered grouping — first matching rule wins.
//
// The Money list is a SECOND COPY of "which dials are money": the keys share
// no prefix, so a new money dial that is not added here lands under "Other",
// which is where `arrival_gift_cap_pence` sat for a day after it was split
// from `free_allowance_pence` (CONSOLIDATED-TODO §0w item 5). When adding a
// money dial to `config-defaults.sql`, add it here too.
const GROUPS: Array<{ label: string; match: (key: string) => boolean }> = [
  {
    label: 'Money',
    match: (k) =>
      [
        'free_allowance_pence',
        'arrival_gift_cap_pence',
        'tab_settlement_threshold_pence',
        'tab_ceiling_pence',
        'monthly_fallback_minimum_pence',
        'monthly_fallback_days',
        'writer_payout_threshold_pence',
        'publication_payout_threshold_pence',
        'platform_fee_bps',
      ].includes(k),
  },
  { label: 'Regulatory thresholds', match: (k) => k.startsWith('tax_') || k.startsWith('regulatory_') },
  { label: 'Channels and ranking', match: (k) => k.startsWith('feed_') && !k.startsWith('feed_ingest_') },
  { label: 'Resonance', match: (k) => k.startsWith('resonance_') },
  { label: 'Ingest', match: (k) => k.startsWith('feed_ingest_') || k.startsWith('external_') },
  { label: 'Outbound', match: (k) => k.startsWith('outbound_') },
  { label: 'Access control', match: (k) => k === 'admin_account_ids' },
  { label: 'Runtime state (read-only)', match: () => false }, // filled by readOnly flag
  { label: 'Other', match: () => true },
]

export default function AdminConfigPage() {
  const [rows, setRows] = useState<AdminConfigRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const { ask, dialog } = useConfirm()

  async function load() {
    try {
      const r = await adminDashboard.config()
      setRows(r.config)
      setDrafts({})
      setError(null)
    } catch {
      setError('Couldn’t load config. Please reload the page to try again.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const grouped = useMemo(() => {
    if (!rows) return []
    const out = GROUPS.map((g) => ({ label: g.label, rows: [] as AdminConfigRow[] }))
    for (const row of rows) {
      if (row.readOnly) {
        out.find((g) => g.label === 'Runtime state (read-only)')!.rows.push(row)
        continue
      }
      const idx = GROUPS.findIndex((g) => g.match(row.key))
      out[idx].rows.push(row)
    }
    return out.filter((g) => g.rows.length > 0)
  }, [rows])

  const dirty = useMemo(() => {
    if (!rows) return []
    return Object.entries(drafts)
      .filter(([key, value]) => rows.find((r) => r.key === key)?.value !== value)
      .map(([key, value]) => ({ key, value }))
  }, [drafts, rows])

  async function save(anchor: HTMLElement) {
    if (dirty.length === 0) return
    const trimmed = reason.trim()
    // The button is disabled without one; this is the second door, for a save
    // reached any other way.
    if (trimmed === '') return
    const ok = await ask(anchor, {
      title: `Update ${dirty.length} config value${dirty.length === 1 ? '' : 's'}?`,
      body: (
        <ul className="font-mono text-mono-xs text-black space-y-1">
          {dirty.map((d) => (
            <li key={d.key} className="break-all">
              {d.key} → {d.value}
            </li>
          ))}
        </ul>
      ),
      confirmLabel: 'Save',
      width: 360,
    })
    if (!ok) return
    setSaving(true)
    setNotice(null)
    try {
      await adminDashboard.updateConfig(dirty, trimmed)
      setNotice(`Saved ${dirty.length} value${dirty.length === 1 ? '' : 's'}.`)
      setReason('')
      await load()
    } catch (err) {
      setNotice(apiErrorMessage(err) ?? 'Couldn’t save. Please reload to see which values are in force.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AdminShell title="Site owner">
      {dialog}
      {/* Not a platform_config dial — it is the other thing this tab is for,
          an operator setting that used to be a hand-run UPDATE. It loads and
          saves on its own, so a config save never touches it and a failure in
          one panel cannot take the other down. */}
      <SeedFormulaPanel />
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!rows && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {rows && (
        <>
          <p className="text-ui-xs text-grey-600 mb-8 max-w-article">
            Live tuning dials. Changes apply on the next config read (services cache for up to a
            minute). New dials are added via <span className="font-mono">config-defaults.sql</span>,
            never here.
          </p>

          {grouped.map((g) => (
            <section key={g.label} className="mb-10">
              <p className="label-ui text-grey-600 mb-3">{g.label}</p>
              <div className="bg-glasshouse-well/40 px-6 py-5 space-y-5">
                {g.rows.map((row) => {
                  const value = drafts[row.key] ?? row.value
                  const changed = value !== row.value
                  return (
                    <div key={row.key} className="sm:flex sm:items-start sm:gap-6">
                      <div className="sm:w-1/2">
                        <p className="text-mono-xs text-black">{row.key}</p>
                        {row.description && (
                          <p className="text-ui-xs text-grey-600 mt-1">{row.description}</p>
                        )}
                        <p className="text-mono-xs text-grey-400 mt-1">
                          updated {timeAgo(row.updatedAt)}
                        </p>
                      </div>
                      <div className="mt-2 sm:mt-0 sm:flex-1">
                        {row.readOnly ? (
                          <p className="text-ui-sm text-grey-600 font-mono">{row.value}</p>
                        ) : (
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [row.key]: e.target.value }))
                            }
                            className={`w-full bg-glasshouse-well px-3 py-2 font-mono text-ui-sm focus-ring ${
                              changed ? 'text-crimson' : 'text-black'
                            }`}
                            aria-label={row.key}
                          />
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}

          {/* THE REASON (L5.2). One line, one save — the batch is the
              operator's act, so it takes one reason and not one per dial. It
              appears only once there is something to explain, because before
              the first edit there is nothing that has happened yet. It is
              REQUIRED: the gateway refuses a blank one and so does the
              column's own CHECK, and the button is disabled rather than
              letting anyone meet a 400 by accident. */}
          {dirty.length > 0 && (
            <div className="mb-5 max-w-article">
              <label htmlFor="config-reason" className="label-ui text-grey-600 block mb-2">
                Why
              </label>
              <input
                id="config-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What this change is for…"
                className="w-full bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring"
              />
              <p className="text-ui-xs text-grey-600 mt-2">
                Recorded against every value in this save, with your account and the old figure.
              </p>
            </div>
          )}

          <div className="flex items-center gap-4">
            <button
              className="btn"
              disabled={saving || dirty.length === 0 || reason.trim() === ''}
              onClick={(e) => void save(e.currentTarget)}
            >
              {saving ? 'Saving…' : dirty.length > 0 ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'No changes'}
            </button>
            {notice && <p className="text-ui-xs text-grey-600">{notice}</p>}
          </div>
        </>
      )}
    </AdminShell>
  )
}
