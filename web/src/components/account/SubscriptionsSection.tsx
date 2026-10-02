'use client'

import React, { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { Avatar } from '../ui/Avatar'
import { account as accountApi, subscriptions as subscriptionsApi, type MySubscription } from '../../lib/api'
import { useConfirm } from '../ui/ConfirmDialog'
import {
  SUBSCRIPTION_CANCEL_TITLE,
  SUBSCRIPTION_CANCEL_BODY,
  SUBSCRIPTION_CANCEL_CONFIRM,
  SUBSCRIPTION_CANCEL_FAILED,
  SUBSCRIPTIONS_HEADING,
  subscriptionTerm,
  subscriptionMonthly,
  SUBSCRIPTION_NOTIFY,
  SUBSCRIPTION_NOTIFY_TITLE,
  SUBSCRIPTION_VISIBILITY,
  SUBSCRIPTION_VISIBILITY_TITLE,
  SUBSCRIPTION_CANCEL,
  SUBSCRIPTION_CANCELLED,
} from '../../content/ledger'

export function SubscriptionsSection() {
  const [subs, setSubs] = useState<MySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [togglingVisibility, setTogglingVisibility] = useState<string | null>(null)
  const [togglingNotify, setTogglingNotify] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const { ask, dialog } = useConfirm()

  useEffect(() => {
    void (async () => {
      try {
        const data = await accountApi.getMySubscriptions()
        setSubs(data.subscriptions)
      } catch {}
      finally { setLoading(false) }
    })()
  }, [])

  // The row must not wear a success's words when the server refused (MIRROR-AUDIT
  // §2.14). `fetch` does not reject on a 4xx/5xx, so the `catch` below only ever
  // caught network errors: a 401 or a 500 fell straight through to the
  // optimistic `setSubs` and the row read "Cancelled" while the tab went on
  // renewing — until a reload contradicted it. So the status is checked, and the
  // local update moved inside the success branch.
  async function handleCancel(e: React.MouseEvent<HTMLElement>, writerId: string) {
    const ok = await ask(e.currentTarget, {
      title: SUBSCRIPTION_CANCEL_TITLE,
      body: SUBSCRIPTION_CANCEL_BODY,
      confirmLabel: SUBSCRIPTION_CANCEL_CONFIRM,
    })
    if (!ok) return
    setCancelError(null)
    setCancellingId(writerId)
    try {
      await subscriptionsApi.unsubscribe(writerId)
      setSubs(prev => prev.map(s => s.writerId === writerId ? { ...s, status: 'cancelled', autoRenew: false } : s))
    } catch { setCancelError(SUBSCRIPTION_CANCEL_FAILED) }
    finally { setCancellingId(null) }
  }

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />
  if (subs.length === 0) return null

  return (
    <div data-explain="ledger.subscriptions" className="mb-10">
      {dialog}
      <p className="label-ui text-grey-400 mb-4">{SUBSCRIPTIONS_HEADING}</p>
      {cancelError && <p className="text-ui-xs text-crimson mb-3">{cancelError}</p>}
      {/* Row separation is the rows' own py-4 rhythm (CLAUDE.md: separation
          is whitespace, never a thin divider) */}
      <div className="bg-glasshouse-well">
        {subs.map(s => (
          <div key={s.id} className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar
                src={s.writerAvatar}
                name={s.writerDisplayName ?? s.writerUsername ?? '?'}
                size={32}
              />
              <div className="min-w-0">
                <ProfileLink href={`/${s.writerUsername}`} className="text-ui-sm font-sans font-medium text-black hover:opacity-70 truncate block">
                  {s.writerDisplayName ?? s.writerUsername}
                </ProfileLink>
                <p className="label-ui text-grey-300">
                  {subscriptionTerm(s)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[12px] text-black tabular-nums">{subscriptionMonthly(s.pricePence)}</span>
              <button
                onClick={async () => {
                  setTogglingNotify(s.id)
                  try {
                    await accountApi.toggleSubscriptionNotifications(s.id, !s.notifyOnPublish)
                    setSubs(prev => prev.map(sub => sub.id === s.id ? { ...sub, notifyOnPublish: !sub.notifyOnPublish } : sub))
                  } catch { alert('Couldn’t change email alerts for this subscription. Please try again.') }
                  finally { setTogglingNotify(null) }
                }}
                disabled={togglingNotify === s.id || s.status !== 'active'}
                className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                title={s.notifyOnPublish ? SUBSCRIPTION_NOTIFY_TITLE.on : SUBSCRIPTION_NOTIFY_TITLE.off}
              >
                {togglingNotify === s.id ? '…' : s.notifyOnPublish ? SUBSCRIPTION_NOTIFY.on : SUBSCRIPTION_NOTIFY.off}
              </button>
              <button
                onClick={async () => {
                  setTogglingVisibility(s.writerId)
                  try {
                    await accountApi.toggleSubscriptionVisibility(s.writerId, !s.hidden)
                    setSubs(prev => prev.map(sub => sub.writerId === s.writerId ? { ...sub, hidden: !sub.hidden } : sub))
                  } catch { alert('Couldn’t change whether this subscription shows on your profile. Please try again.') }
                  finally { setTogglingVisibility(null) }
                }}
                disabled={togglingVisibility === s.writerId}
                className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                title={s.hidden ? SUBSCRIPTION_VISIBILITY_TITLE.hidden : SUBSCRIPTION_VISIBILITY_TITLE.public}
              >
                {togglingVisibility === s.writerId ? '…' : s.hidden ? SUBSCRIPTION_VISIBILITY.hidden : SUBSCRIPTION_VISIBILITY.public}
              </button>
              {s.status === 'active' ? (
                <button
                  onClick={(e) => handleCancel(e, s.writerId)}
                  disabled={cancellingId === s.writerId}
                  className="text-ui-xs font-sans text-grey-300 hover:text-black disabled:opacity-50"
                >
                  {cancellingId === s.writerId ? '…' : SUBSCRIPTION_CANCEL}
                </button>
              ) : (
                <span className="text-ui-xs font-sans text-grey-300">{SUBSCRIPTION_CANCELLED}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
