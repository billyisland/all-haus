'use client'

import { useState, useEffect, type MouseEvent } from 'react'
import { drives as drivesApi, subscriptionOffers, type Commission, type PledgeDrive, type SubscriptionOffer } from '../../lib/api'
import { CommissionCard } from './CommissionsTab'
import { DriveCard } from './DriveCard'
import { DriveCreateForm } from './DriveCreateForm'
import { pledgesEnabled } from '../../lib/featureFlags'
import { useCopyLink } from '../../hooks/useCopyLink'
import { formatDateInputEcho } from '../../lib/format'
import { apiErrorMessage, failureSentence } from '../../lib/api/client'
import { useConfirm } from '../ui/ConfirmDialog'
import * as C from '../../content/dashboard'

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
      setError(C.PROPOSALS_LOAD_FAILED)
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
    { key: 'all', label: C.PROPOSALS_FILTER_ALL },
    ...(showPledges
      ? ([
          { key: 'commissions', label: `Commissions (${commissions.length})` },
          { key: 'drives', label: `Pledge drives (${drives.length})` },
        ] as { key: ProposalFilter; label: string }[])
      : []),
    { key: 'offers', label: C.proposalsFilterOffers(offers.length) },
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
                {C.OFFER_NEW_CODE}
              </button>
              <button onClick={() => { setOfferFormMode('grant'); setFilter('offers') }} className="btn-text underline underline-offset-4">
                {C.OFFER_GIFT_SUBSCRIPTION}
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
          <p className="text-ui-sm text-grey-600 mb-4">{C.PROPOSALS_EMPTY}</p>
          <p className="text-ui-xs text-grey-600">
            {showPledges
              ? C.PROPOSALS_EMPTY_WITH_PLEDGES
              : C.PROPOSALS_EMPTY_OFFERS_ONLY}
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
  const [revokeError, setRevokeError] = useState<{ id: string; message: string } | null>(null)
  const { copiedId, failedId, failedUrl, copy } = useCopyLink()
  const { ask, dialog } = useConfirm()

  // Confirmed, because it cannot be undone — and the consequence stated is
  // the one the route actually has (walkthrough A16): revoking stops NEW
  // redemptions; a reader already subscribed under the offer keeps their
  // terms. The failure is said on the row; it was `catch {}`.
  async function handleRevoke(e: MouseEvent<HTMLElement>, offerId: string) {
    const ok = await ask(e.currentTarget, {
      title: C.OFFER_REVOKE_CONFIRM_TITLE,
      body: C.OFFER_REVOKE_CONFIRM_BODY,
      confirmLabel: C.OFFER_REVOKE_CONFIRM_LABEL,
    })
    if (!ok) return
    setRevokingId(offerId)
    setRevokeError(null)
    try {
      await subscriptionOffers.revoke(offerId)
      onUpdate()
    } catch (err) {
      setRevokeError({
        id: offerId,
        message: apiErrorMessage(err) ?? C.OFFER_REVOKE_FAILED,
      })
    }
    finally { setRevokingId(null) }
  }

  function copyUrl(code: string, offerId: string) {
    void copy(offerId, `${window.location.origin}/subscribe/${code}`)
  }

  const active = offers.filter(o => !o.revoked)
  const revoked = offers.filter(o => o.revoked)

  return (
    <div className="mb-8">
      <p className="label-ui text-grey-600 mb-4">{C.OFFERS_TITLE}</p>

      {active.length > 0 && (
        <div className="overflow-x-auto ah-scrollbar bg-glasshouse-well">
          <table className="w-full text-ui-xs">
            <thead>
              <tr className="border-b-2 border-grey-200">
                <th className="px-4 py-3 text-left label-ui text-grey-400">{C.OFFER_COL_LABEL}</th>
                <th className="px-4 py-3 text-left label-ui text-grey-400">{C.OFFER_COL_TYPE}</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">{C.OFFER_COL_DISCOUNT}</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">{C.OFFER_COL_DURATION}</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">{C.OFFER_COL_REDEEMED}</th>
                <th className="px-4 py-3 text-right label-ui text-grey-400">{C.OFFER_COL_ACTIONS}</th>
              </tr>
            </thead>
            <tbody>
              {active.map(offer => (
                <tr key={offer.id} className="border-b-2 border-grey-200 last:border-b-0">
                  <td className="px-4 py-3">{offer.label}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-mono ${offer.mode === 'code' ? 'bg-grey-100 text-grey-600' : 'bg-grey-100 text-crimson'}`}>
                      {C.offerTypeLabel(offer.mode, offer.recipientUsername)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {C.offerDiscount(offer.discountPct)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-grey-400">
                    {C.offerDuration(offer.durationMonths)}
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
                        aria-label={C.OFFER_COPY_BY_HAND}
                        className="w-full bg-glasshouse-well px-2 py-1 font-mono text-[12px] text-black"
                      />
                    ) : offer.code ? (
                      <button onClick={() => copyUrl(offer.code!, offer.id)} className="text-grey-400 hover:text-black">
                        {copiedId === offer.id ? C.OFFER_COPIED : C.OFFER_COPY_LINK}
                      </button>
                    ) : null}
                    <button onClick={(e) => handleRevoke(e, offer.id)} disabled={revokingId === offer.id} className="text-grey-300 hover:text-black disabled:opacity-50">
                      {revokingId === offer.id ? '…' : C.OFFER_REVOKE}
                    </button>
                    {revokeError?.id === offer.id && (
                      <p className="text-ui-xs text-crimson mt-1">{revokeError.message}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog}

      {revoked.length > 0 && (
        <details className="text-ui-xs mt-3">
          <summary className="text-grey-300 cursor-pointer hover:text-grey-600">
            {C.revokedCount(revoked.length)}
          </summary>
          <div className="mt-2 space-y-1">
            {revoked.map(offer => (
              <div key={offer.id} className="flex items-center gap-3 text-grey-300 py-1">
                <span className="line-through">{offer.label}</span>
                <span className="font-mono text-mono-xs">{offer.mode}</span>
                <span>{offer.discountPct}%</span>
                <span className="tabular-nums">{C.offerRedeemedCount(offer.redemptionCount)}</span>
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
      setError(failureSentence(err, C.OFFER_CREATE_FAILED))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="bg-glasshouse-well px-5 py-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="label-ui text-black">
          {mode === 'code' ? C.OFFER_NEW_CODE : C.OFFER_GIFT_SUBSCRIPTION}
        </h3>
        <button onClick={onCancel} className="text-ui-xs text-grey-300 hover:text-black">{C.OFFER_FORM_CANCEL}</button>
      </div>

      {error && <p className="text-ui-xs text-red-600">{error}</p>}

      <div className="space-y-3">
        <div>
          <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_LABEL}</label>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={mode === 'code' ? C.OFFER_FORM_LABEL_PLACEHOLDER_CODE : C.OFFER_FORM_LABEL_PLACEHOLDER_GRANT}
            className="w-full bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-4">
          <div>
            <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_DISCOUNT}</label>
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
            <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_DURATION}</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={120}
                value={durationMonths ?? ''}
                onChange={e => setDurationMonths(e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder={C.OFFER_FORM_EMPTY_PLACEHOLDER}
                className="w-16 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
              />
              <span className="text-ui-xs text-grey-400">{C.OFFER_FORM_DURATION_HELP}</span>
            </div>
          </div>
        </div>

        {mode === 'code' && (
          <div className="flex items-center gap-4">
            <div>
              <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_MAX_REDEMPTIONS}</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={maxRedemptions ?? ''}
                  onChange={e => setMaxRedemptions(e.target.value ? parseInt(e.target.value, 10) : null)}
                  placeholder={C.OFFER_FORM_EMPTY_PLACEHOLDER}
                  className="w-20 bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                />
                <span className="text-ui-xs text-grey-400">{C.OFFER_FORM_MAX_REDEMPTIONS_HELP}</span>
              </div>
            </div>
            <div>
              <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_EXPIRES}</label>
              <div className="flex items-center gap-3">
                <input
                  type="date"
                  value={expiresAt}
                  onChange={e => setExpiresAt(e.target.value)}
                  className="bg-grey-100 px-3 py-1.5 text-sm focus:outline-none"
                />
                {/* The widget draws the date in the BROWSER's order; the echo
                    states it in this site's. */}
                {formatDateInputEcho(expiresAt) && (
                  <span className="text-mono-xs text-grey-600">
                    {formatDateInputEcho(expiresAt)}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {mode === 'grant' && (
          <div>
            <label className="label-ui text-grey-400 mb-1 block">{C.OFFER_FORM_RECIPIENT}</label>
            <input
              type="text"
              value={recipientUsername}
              onChange={e => setRecipientUsername(e.target.value)}
              placeholder={C.OFFER_FORM_RECIPIENT_PLACEHOLDER}
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
        {creating ? C.OFFER_FORM_CREATING : mode === 'code' ? C.OFFER_FORM_CREATE_CODE : C.OFFER_FORM_CREATE_GRANT}
      </button>
    </div>
  )
}
