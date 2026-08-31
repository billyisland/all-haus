'use client'

import { useState, useEffect } from 'react'
import { dmPricing, type DmPricingOverride } from '../../lib/api'
import { useResolverInput } from '../../hooks/useResolverInput'

export function DmFeeSettings() {
  const [dmPrice, setDmPrice] = useState('')
  const [dmOverrides, setDmOverrides] = useState<DmPricingOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [overridePrice, setOverridePrice] = useState('')
  const [addingOverride, setAddingOverride] = useState(false)
  // Omnivorous person input (CLAUDE.md rule; audit F4) — replaces the old
  // username-only /v1/search + blind results[0]. Picking a match selects the
  // account; Add then acts on the selection, never a guess.
  const ri = useResolverInput({ context: 'dm', maxPolls: 3 })
  const [overrideTarget, setOverrideTarget] = useState<{
    id: string
    username: string
    displayName: string
  } | null>(null)
  const overrideMatches = ri.matches.filter(m => m.account)

  useEffect(() => {
    dmPricing.get().then(data => {
      setDmPrice(data.defaultPricePence > 0 ? (data.defaultPricePence / 100).toFixed(2) : '')
      setDmOverrides(data.overrides)
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">DM access</p>
      <p className="text-ui-xs text-grey-600 leading-relaxed mb-4">
        Discourage unwanted messages by setting a fee for DMs from people you don&apos;t follow. Set to £0 or leave blank for free.
      </p>

      {loading ? (
        <div className="h-8 w-48 animate-pulse bg-grey-100" />
      ) : (
        <>
          <form onSubmit={async (e) => {
            e.preventDefault()
            const pence = dmPrice.trim() ? Math.round(parseFloat(dmPrice) * 100) : 0
            if (isNaN(pence) || pence < 0) { setMsg('Enter a valid price.'); return }
            setSaving(true); setMsg(null)
            try {
              await dmPricing.update(pence)
              setMsg('DM pricing updated.')
            } catch { setMsg('Failed to update.') }
            finally { setSaving(false) }
          }} className="space-y-4 mb-6">
            <div className="flex items-center gap-3">
              <span className="text-ui-sm text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={dmPrice}
                onChange={(e) => setDmPrice(e.target.value)}
                className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm text-black placeholder-grey-300"
                placeholder="0.00"
              />
              <span className="text-ui-xs text-grey-300">per message</span>
            </div>
            <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </form>
          {msg && <p className="text-ui-xs text-grey-600 mb-4">{msg}</p>}

          <details className="text-ui-xs">
            <summary className="text-grey-400 cursor-pointer hover:text-grey-600 mb-3">
              Per-user overrides ({dmOverrides.length})
            </summary>

            {dmOverrides.length > 0 && (
              <div className="space-y-1 mb-4">
                {dmOverrides.map(o => (
                  <div key={o.userId} className="flex items-center justify-between py-1">
                    <span className="text-black">{o.displayName ?? o.username} <span className="text-grey-300">@{o.username}</span></span>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums">{o.pricePence === 0 ? 'Free' : `£${(o.pricePence / 100).toFixed(2)}`}</span>
                      <button
                        onClick={async () => {
                          try {
                            await dmPricing.removeOverride(o.userId)
                            setDmOverrides(prev => prev.filter(x => x.userId !== o.userId))
                          } catch {}
                        }}
                        className="text-grey-300 hover:text-black"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={async (e) => {
              e.preventDefault()
              if (!overrideTarget) return
              setAddingOverride(true)
              try {
                const pence = overridePrice.trim() ? Math.round(parseFloat(overridePrice) * 100) : 0
                await dmPricing.setOverride(overrideTarget.id, pence)
                setDmOverrides(prev => [...prev.filter(x => x.userId !== overrideTarget.id), {
                  userId: overrideTarget.id,
                  username: overrideTarget.username,
                  displayName: overrideTarget.displayName,
                  pricePence: pence,
                }])
                setOverrideTarget(null)
                setOverridePrice('')
              } catch { setMsg('Failed to add override.') }
              finally { setAddingOverride(false) }
            }}>
              <div className="flex items-center gap-2">
                {overrideTarget ? (
                  <span className="flex w-40 items-center justify-between gap-1 bg-grey-100 px-2 py-1 text-ui-xs text-black">
                    <span className="truncate">{overrideTarget.displayName || `@${overrideTarget.username}`}</span>
                    <button
                      type="button"
                      onClick={() => setOverrideTarget(null)}
                      aria-label="Clear person"
                      className="flex-shrink-0 text-grey-400 hover:text-black"
                    >
                      &times;
                    </button>
                  </span>
                ) : (
                  <input
                    type="text"
                    value={ri.query}
                    onChange={(e) => { setMsg(null); ri.onQueryChange(e.target.value) }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      // A lone speculative fuzzy match is not unambiguous, and
                      // `pending` guards the debounce window where matches
                      // still answer the previous query (explicit click-pick
                      // below stays available for both).
                      if (
                        overrideMatches.length === 1 &&
                        !ri.pending &&
                        overrideMatches[0].confidence !== 'speculative'
                      ) {
                        setOverrideTarget(overrideMatches[0].account!)
                        ri.reset()
                      } else ri.submit()
                    }}
                    placeholder="Username, email, npub…"
                    className="w-40 bg-grey-100 px-2 py-1 text-ui-xs text-black placeholder-grey-300"
                  />
                )}
                <span className="text-ui-xs text-grey-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={overridePrice}
                  onChange={(e) => setOverridePrice(e.target.value)}
                  placeholder="0.00"
                  className="w-20 bg-grey-100 px-2 py-1 text-ui-xs text-black placeholder-grey-300"
                />
                <button type="submit" disabled={addingOverride || !overrideTarget} className="btn-text underline underline-offset-4 disabled:opacity-50">
                  {addingOverride ? '...' : 'Add'}
                </button>
              </div>
              {!overrideTarget && (
                <div className="mt-1 min-h-[20px]">
                  {ri.resolving && (
                    <p className="label-ui text-grey-600 py-0.5">RESOLVING…</p>
                  )}
                  {!ri.resolving && (ri.doneEmpty || ri.resolveError) && overrideMatches.length === 0 && (
                    <p className="text-ui-xs text-grey-600 py-0.5">
                      No one found — try a username, email, or npub.
                    </p>
                  )}
                  {overrideMatches.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      {overrideMatches.map(m => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => { setOverrideTarget(m.account!); ri.reset() }}
                          className="flex w-full items-center justify-between gap-2 px-1 py-1 text-left text-ui-xs text-black hover:bg-grey-100 transition-colors"
                        >
                          <span className="truncate">{m.label}</span>
                          {m.sublabel && (
                            <span className="label-ui text-grey-600">{m.sublabel}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </form>
          </details>
        </>
      )}
    </div>
  )
}
