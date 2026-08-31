'use client'

import { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { account as accountApi, type MySubscription } from '../../lib/api'

export function SubscriptionsSection() {
  const [subs, setSubs] = useState<MySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [togglingVisibility, setTogglingVisibility] = useState<string | null>(null)
  const [togglingNotify, setTogglingNotify] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const data = await accountApi.getMySubscriptions()
        setSubs(data.subscriptions)
      } catch {}
      finally { setLoading(false) }
    })()
  }, [])

  async function handleCancel(writerId: string) {
    if (!confirm('Cancel this subscription? You\'ll keep access until the end of your current period.')) return
    setCancellingId(writerId)
    try {
      await fetch(`/api/v1/subscriptions/${writerId}`, { method: 'DELETE', credentials: 'include' })
      setSubs(prev => prev.map(s => s.writerId === writerId ? { ...s, status: 'cancelled', autoRenew: false } : s))
    } catch { alert('Failed to cancel subscription.') }
    finally { setCancellingId(null) }
  }

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />
  if (subs.length === 0) return null

  return (
    <div data-explain="ledger.subscriptions" className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Subscriptions</p>
      {/* Row separation is the rows' own py-4 rhythm (CLAUDE.md: separation
          is whitespace, never a thin divider) */}
      <div className="bg-glasshouse-well">
        {subs.map(s => (
          <div key={s.id} className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3 min-w-0">
              {s.writerAvatar ? (
                <img src={s.writerAvatar} alt="" className="h-8 w-8  object-cover flex-shrink-0" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center bg-grey-100 text-[12px] font-mono text-grey-400  flex-shrink-0">
                  {(s.writerDisplayName ?? s.writerUsername ?? '?')[0].toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <ProfileLink href={`/${s.writerUsername}`} className="text-ui-sm font-sans font-medium text-black hover:opacity-70 truncate block">
                  {s.writerDisplayName ?? s.writerUsername}
                </ProfileLink>
                <p className="label-ui text-grey-300">
                  {s.status === 'cancelled'
                    ? `Access until ${new Date(s.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                    : s.autoRenew
                      ? `Renews ${new Date(s.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                      : `Expires ${new Date(s.currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
                  }
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[12px] text-black tabular-nums">£{(s.pricePence / 100).toFixed(2)}/mo</span>
              <button
                onClick={async () => {
                  setTogglingNotify(s.id)
                  try {
                    await accountApi.toggleSubscriptionNotifications(s.id, !s.notifyOnPublish)
                    setSubs(prev => prev.map(sub => sub.id === s.id ? { ...sub, notifyOnPublish: !sub.notifyOnPublish } : sub))
                  } catch { alert('Failed to update notifications.') }
                  finally { setTogglingNotify(null) }
                }}
                disabled={togglingNotify === s.id || s.status !== 'active'}
                className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                title={s.notifyOnPublish ? 'Email me when they publish' : 'Email notifications muted'}
              >
                {togglingNotify === s.id ? '...' : s.notifyOnPublish ? 'Notify' : 'Muted'}
              </button>
              <button
                onClick={async () => {
                  setTogglingVisibility(s.writerId)
                  try {
                    await accountApi.toggleSubscriptionVisibility(s.writerId, !s.hidden)
                    setSubs(prev => prev.map(sub => sub.writerId === s.writerId ? { ...sub, hidden: !sub.hidden } : sub))
                  } catch { alert('Failed to update visibility.') }
                  finally { setTogglingVisibility(null) }
                }}
                disabled={togglingVisibility === s.writerId}
                className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                title={s.hidden ? 'Hidden from your public profile' : 'Visible on your public profile'}
              >
                {togglingVisibility === s.writerId ? '...' : s.hidden ? 'Hidden' : 'Public'}
              </button>
              {s.status === 'active' ? (
                <button
                  onClick={() => handleCancel(s.writerId)}
                  disabled={cancellingId === s.writerId}
                  className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                >
                  {cancellingId === s.writerId ? '...' : 'Cancel'}
                </button>
              ) : (
                <span className="text-ui-xs font-sans text-grey-300">Cancelled</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
