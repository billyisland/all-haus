'use client'

import { useState, useEffect } from 'react'
import { drives as drivesApi, subscriptionOffers, type Commission, type PledgeDrive, type SubscriptionOffer } from '../../lib/api'
import { CommissionCard } from './CommissionsTab'
import { DriveCard } from './DriveCard'
import { DriveCreateForm } from './DriveCreateForm'
import { pledgesEnabled } from '../../lib/featureFlags'
import { useCopyLink } from '../../hooks/useCopyLink'

type ProposalFilter = 'all' | 'commissions' | 'drives' | 'offers'

// Pledge drives + commissions are parked behind PLEDGES_ENABLED (2026-07-13).
// When off, only the subscription-offer half of this tab renders.
const showPledges = pledgesEnabled()

export function ProposalsTab({ userId }: { userId: string }) {
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [drives, setDrives] = useState<PledgeDrive[]>([])
  const [offers, setOffers] = useState<SubscriptionOffer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ProposalFilter>('all')

  // Creation forms
  const [showDriveForm, setShowDriveForm] = useState(false)
  const [offerFormMode, setOfferFormMode] = useState<null | 'code' | 'grant'>(null)

  async function fetchAll() {
    setLoading(true)
    setError(null)
    try {
      const [commRes, driveRes, offerRes] = await Promise.all([
        showPledges ? drivesApi.myCommissions().catch(() => ({ commissions: [] })) : Promise.resolve({ commissions: [] }),
        showPledges ? drivesApi.listByUser(userId).catch(() => ({ drives: [] })) : Promise.resolve({ drives: [] }),
        subscriptionOffers.list().catch(() => ({ offers: [] })),
      ])
      setCommissions(commRes.commissions)
      setDrives(driveRes.drives)
      setOffers(offerRes.offers)
    } catch {
      setError('Failed to load proposals.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void fetchAll() }, [userId])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  if (error) return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>

  const showCommissions = filter === 'all' || filter === 'commissions'
  const showDrives = filter === 'all' || filter === 'drives'
  const showOffers = filter === 'all' || filter === 'offers'

  const totalCount = commissions.length + drives.length + offers.length
  const isEmpty = totalCount === 0 && !showDriveForm && !offerFormMode

  const filters: { key: ProposalFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    ...(showPledges
      ? ([
          { key: 'commissions', label: `Commissions (${commissions.length})` },
          { key: 'drives', label: `Pledge drives (${drives.length})` },
        ] as { key: ProposalFilter; label: string }[])
      : []),
    { key: 'offers', label: `Offers (${offers.length})` },
  ]

  return (
    <div>
      {/* Filter bar + creation actions */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex gap-1">
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`tab-pill ${filter === f.key ? 'tab-pill-active' : 'tab-pill-inactive'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {showPledges && !showDriveForm && (
            <button onClick={() => { setShowDriveForm(true); setFilter('drives') }} className="btn-text underline underline-offset-4">
              New pledge drive
            </button>
          )}
          {!offerFormMode && (
            <>
              <button onClick={() => { setOfferFormMode('code'); setFilter('offers') }} className="btn-text underline underline-offset-4">
                New offer code
              </button>
              <button onClick={() => { setOfferFormMode('grant'); setFilter('offers') }} className="btn-text underline underline-offset-4">
                Gift subscription
              </button>
            </>
          )}
        </div>
      </div>

      {/* Drive creation form — pledge drives parked (showPledges) */}
      {showPledges && showDriveForm && (
        <div className="mb-8">
          <DriveCreateForm onCreated={() => { setShowDriveForm(false); void fetchAll() }} onCancel={() => setShowDriveForm(false)} />
        </div>
      )}

      {/* Offer creation form */}
      {offerFormMode && (
        <div className="mb-8">
          <OfferCreateForm mode={offerFormMode} onCreated={() => { setOfferFormMode(null); void fetchAll() }} onCancel={() => setOfferFormMode(null)} />
        </div>
      )}

      {isEmpty && (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-600 mb-4">No proposals yet.</p>
          <p className="text-ui-xs text-grey-600">
            {showPledges
              ? 'Commission requests from readers, your pledge drives, and subscription offers will appear here.'
              : 'Your subscription offers will appear here.'}
          </p>
        </div>
      )}

      {/* Commissions section — parked (showPledges) */}
      {showPledges && showCommissions && commissions.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-600 mb-4">Commissions</p>
          <div className="space-y-2">
            {commissions.map(c => <CommissionCard key={c.id} commission={c} onUpdate={fetchAll} />)}
          </div>
        </div>
      )}

      {/* Pledge drives section — parked (showPledges) */}
      {showPledges && showDrives && drives.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-600 mb-4">Pledge drives</p>
          <div className="space-y-2">
            {drives.map(d => <DriveCard key={d.id} drive={d} onUpdate={fetchAll} />)}
          </div>
        </div>
      )}

      {/* Offers section */}
      {showOffers && offers.length > 0 && (
        <OffersSection offers={offers} onUpdate={fetchAll} />
      )}
    </div>
  )
}

// =============================================================================
// Offers Section
// =============================================================================

function OffersSection({ offers, onUpdate }: { offers: SubscriptionOffer[]; onUpdate: () => void }) {
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const { copiedId, failedId, failedUrl, copy } = useCopyLink()

  async function handleRevoke(offerId: string) {
    setRevokingId(offerId)
    try {
      await subscriptionOffers.revoke(offerId)
      onUpdate()
    } catch {}
    finally { setRevokingId(null) }
  }

  function copyUrl(code: string, offerId: string) {
    void copy(offerId, `${window.location.origin}/subscribe/${code}`)
  }

  const active = offers.filter(o => !o.revoked)
  const revoked = offers.filter(o => o.revoked)

  return (
    <div className="mb-8">
      <p className="label-ui text-grey-600 mb-4">Offers</p>

      {active.length > 0 && (
        <div className="overflow-x-auto bg-glasshouse-well">
          <table className="w-full text-ui-xs">
            <thead>
              <tr className="border-b-2 border-grey-200">
                <th className="px-4 py-3 text-left label-ui text-grey-400">Label</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">Type</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Discount</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Duration</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Redeemed</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {active.map(offer => (
                <tr key={offer.id} className="border-b-2 border-grey-200 last:border-b-0">
                  <td className="px-4 py-3">{offer.label}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono ${offer.mode === 'code' ? 'bg-grey-100 text-grey-600' : 'bg-grey-100 text-crimson'}`}>
                      {offer.mode === 'code' ? 'code' : `grant → ${offer.recipientUsername ?? '?'}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {offer.discountPct}%{offer.discountPct === 100 ? ' (free)' : ''}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-grey-400">
                    {offer.durationMonths ? `${offer.durationMonths}mo` : 'permanent'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {offer.redemptionCount}{offer.maxRedemptions ? `/${offer.maxRedemptions}` : ''}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3">
                    {/* A refused write reveals the url rather than claiming a
                        copy — this cell is the reader's only route to it. */}
                    {offer.code && failedId === offer.id && failedUrl ? (
                      <input
                        type="text"
                        readOnly
                        value={failedUrl}
                        onFocus={e => e.currentTarget.select()}
                        aria-label="Subscription offer link — copy it by hand"
                        className="w-full bg-glasshouse-well px-2 py-1 font-mono text-[12px] text-black"
                      />
                    ) : offer.code ? (
                      <button onClick={() => copyUrl(offer.code!, offer.id)} className="text-grey-400 hover:text-black">
                        {copiedId === offer.id ? 'Copied!' : 'Copy link'}
                      </button>
                    ) : null}
                    <button onClick={() => handleRevoke(offer.id)} disabled={revokingId === offer.id} className="text-grey-300 hover:text-black disabled:opacity-50">
                      {revokingId === offer.id ? '...' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoked.length > 0 && (
        <details className="text-ui-xs mt-3">
          <summary className="text-grey-300 cursor-pointer hover:text-grey-600">
            {revoked.length} revoked
          </summary>
          <div className="mt-2 space-y-1">
            {revoked.map(offer => (
              <div key={offer.id} className="flex items-center gap-3 text-grey-300 py-1">
                <span className="line-through">{offer.label}</span>
                <span className="font-mono text-mono-xs">{offer.mode}</span>
                <span>{offer.discountPct}%</span>
                <span className="tabular-nums">{offer.redemptionCount} redeemed</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// =============================================================================
// Offer Create Form
// =============================================================================

function OfferCreateForm({ mode, onCreated, onCancel }: { mode: 'code' | 'grant'; onCreated: () => void; onCancel: () => void }) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [discountPct, setDiscountPct] = useState(100)
  const [durationMonths, setDurationMonths] = useState<number | null>(null)
  const [maxRedemptions, setMaxRedemptions] = useState<number | null>(null)
  const [expiresAt, setExpiresAt] = useState('')
  const [recipientUsername, setRecipientUsername] = useState('')

  async function handleCreate() {
    if (!label.trim()) return
    setCreating(true)
    setError(null)
    try {
      await subscriptionOffers.create({
        label: label.trim(),
        mode,
        discountPct,
        durationMonths,
        maxRedemptions: mode === 'code' ? maxRedemptions : 1,
        expiresAt: expiresAt || null,
        recipientUsername: mode === 'grant' ? recipientUsername : undefined,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create offer.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bg-glasshouse-well px-5 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="label-ui text-black">
          {mode === 'code' ? 'New offer code' : 'Gift subscription'}
        </h3>
        <button onClick={onCancel} className="text-ui-xs text-grey-300 hover:text-black">Cancel</button>
      </div>

      {error && <p className="text-ui-xs text-red-600">{error}</p>}

      <div className="space-y-3">
        <div>
          <label className="label-ui text-grey-400 mb-1 block">Label</label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={mode === 'code' ? 'e.g. Launch discount' : 'e.g. Comp for Jane'}
            className="w-full bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-4">
          <div>
            <label className="label-ui text-grey-400 mb-1 block">Discount %</label>
            <input
              type="number"
              min={0}
              max={100}
              value={discountPct}
              onChange={e => setDiscountPct(parseInt(e.target.value, 10) || 0)}
              className="w-20 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
            />
          </div>
          <div>
            <label className="label-ui text-grey-400 mb-1 block">Duration</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={120}
                value={durationMonths ?? ''}
                onChange={e => setDurationMonths(e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder="—"
                className="w-16 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
              />
              <span className="text-ui-xs text-grey-400">months (blank = permanent)</span>
            </div>
          </div>
        </div>

        {mode === 'code' && (
          <div className="flex items-center gap-4">
            <div>
              <label className="label-ui text-grey-400 mb-1 block">Max redemptions</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={maxRedemptions ?? ''}
                  onChange={e => setMaxRedemptions(e.target.value ? parseInt(e.target.value, 10) : null)}
                  placeholder="—"
                  className="w-20 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                />
                <span className="text-ui-xs text-grey-400">blank = unlimited</span>
              </div>
            </div>
            <div>
              <label className="label-ui text-grey-400 mb-1 block">Expires</label>
              <input
                type="date"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
              />
            </div>
          </div>
        )}

        {mode === 'grant' && (
          <div>
            <label className="label-ui text-grey-400 mb-1 block">Recipient username</label>
            <input
              type="text"
              value={recipientUsername}
              onChange={e => setRecipientUsername(e.target.value)}
              placeholder="username"
              className="w-48 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
            />
          </div>
        )}
      </div>

      <button
        onClick={handleCreate}
        disabled={creating || !label.trim() || (mode === 'grant' && !recipientUsername.trim())}
        className="btn disabled:opacity-50"
      >
        {creating ? 'Creating...' : mode === 'code' ? 'Create offer code' : 'Grant subscription'}
      </button>
    </div>
  )
}
