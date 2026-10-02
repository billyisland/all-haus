'use client'

import React, { useState, useEffect } from 'react'
import { giftLinks, type GiftLink } from '../../lib/api'
import { useCopyLink } from '../../hooks/useCopyLink'
import { useConfirm } from '../ui/ConfirmDialog'
import * as C from '../../content/dashboard'

interface GiftLinksPanelProps {
  articleId: string
  dTag: string
}

export function GiftLinksPanel({ articleId, dTag }: GiftLinksPanelProps) {
  const [links, setLinks] = useState<GiftLink[]>([])
  const [loading, setLoading] = useState(true)
  // A failed load has no list to show and takes the panel; a failed create or
  // revoke is about one act and is said beside the list, which stays.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [limit, setLimit] = useState(5)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const { copiedId, failedId, failedUrl, copy } = useCopyLink()
  const { ask, dialog } = useConfirm()

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const res = await giftLinks.list(articleId)
        setLinks(res.giftLinks)
      } catch {
        setLoadError(C.GIFT_LINKS_LOAD_FAILED)
      } finally {
        setLoading(false)
      }
    })()
  }, [articleId])

  async function handleCreate() {
    setCreating(true)
    setActionError(null)
    try {
      const result = await giftLinks.create(articleId, limit)
      setLinks(prev => [{
        id: result.id,
        token: result.token,
        maxRedemptions: result.maxRedemptions,
        redemptionCount: 0,
        revoked: false,
        createdAt: new Date().toISOString(),
      }, ...prev])
      setLimit(5)
    } catch {
      setActionError(C.GIFT_LINK_CREATE_FAILED)
    } finally {
      setCreating(false)
    }
  }

  // Confirmed: a revoked link cannot be un-revoked, and the reader holding
  // it has no way of knowing until they try. Mint a new one instead.
  async function handleRevoke(e: React.MouseEvent<HTMLElement>, linkId: string) {
    const ok = await ask(e.currentTarget, {
      title: C.GIFT_LINK_REVOKE_CONFIRM_TITLE,
      body: C.GIFT_LINK_REVOKE_CONFIRM_BODY,
      confirmLabel: C.GIFT_LINK_REVOKE_CONFIRM_LABEL,
    })
    if (!ok) return
    setRevokingId(linkId)
    setActionError(null)
    try {
      await giftLinks.revoke(articleId, linkId)
      setLinks(prev => prev.map(l => l.id === linkId ? { ...l, revoked: true } : l))
    } catch {
      setActionError(C.GIFT_LINK_REVOKE_FAILED)
    } finally {
      setRevokingId(null)
    }
  }

  function copyUrl(token: string, linkId: string) {
    void copy(linkId, `${window.location.origin}/article/${dTag}?gift=${token}`)
  }

  if (loading) return <div className="px-4 py-3"><div className="h-4 w-48 animate-pulse bg-grey-100" /></div>
  if (loadError) return <div className="px-4 py-3 text-ui-xs text-grey-600">{loadError}</div>

  const active = links.filter(l => !l.revoked)
  const revoked = links.filter(l => l.revoked)

  return (
    <div className="px-4 py-4 space-y-4">
      {dialog}
      {/* Create new */}
      <div className="flex items-center gap-3">
        <label className="label-ui text-grey-400">{C.GIFT_LINK_LIMIT}</label>
        <input
          type="number"
          min={1}
          max={1000}
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
          className="w-16 bg-grey-100 px-2 py-1 text-ui-xs font-sans text-black"
        />
        <button
          onClick={() => void handleCreate()}
          disabled={creating}
          className="btn-text underline underline-offset-4"
        >
          {creating ? C.GIFT_LINK_CREATING : C.GIFT_LINK_NEW}
        </button>
      </div>
      {actionError && <p role="alert" className="text-ui-xs text-crimson">{actionError}</p>}

      {/* Active links */}
      {active.length > 0 && (
        <table className="w-full text-ui-xs">
          <thead>
            <tr className="border-b-2 border-grey-200">
              <th className="py-1 text-left label-ui text-grey-400">{C.GIFT_LINK_COL_LINK}</th>
              <th className="py-1 text-right label-ui text-grey-400">{C.GIFT_LINK_COL_REDEEMED}</th>
              <th className="py-1 text-right label-ui text-grey-400">{C.GIFT_LINK_COL_CREATED}</th>
              <th className="py-1 text-right label-ui text-grey-400" />
            </tr>
          </thead>
          <tbody>
            {active.map(link => (
              <tr key={link.id} className="border-b-2 border-grey-100 last:border-b-0">
                <td className="py-1.5">
                  {/* A refused write reveals the url rather than claiming a
                      copy — this cell is the reader's only route to it. */}
                  {failedId === link.id && failedUrl ? (
                    <input
                      type="text"
                      readOnly
                      value={failedUrl}
                      onFocus={e => e.currentTarget.select()}
                      aria-label={C.GIFT_LINK_COPY_BY_HAND}
                      className="w-full bg-glasshouse-well px-2 py-1 font-mono text-[12px] text-black"
                    />
                  ) : (
                    <button
                      onClick={() => copyUrl(link.token, link.id)}
                      className="font-mono text-[12px] text-grey-600 hover:text-black transition-colors"
                    >
                      {copiedId === link.id ? C.GIFT_LINK_COPIED : `…${link.token.slice(-8)}`}
                    </button>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {link.redemptionCount}/{link.maxRedemptions}
                </td>
                <td className="py-1.5 text-right text-grey-400">
                  {new Date(link.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={(e) => handleRevoke(e, link.id)}
                    disabled={revokingId === link.id}
                    className="text-grey-300 hover:text-black disabled:opacity-50"
                  >
                    {revokingId === link.id ? '…' : C.GIFT_LINK_REVOKE}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Revoked links */}
      {revoked.length > 0 && (
        <details className="text-ui-xs">
          <summary className="text-grey-300 cursor-pointer hover:text-grey-600">
            {C.revokedCount(revoked.length)}
          </summary>
          <div className="mt-2 space-y-1">
            {revoked.map(link => (
              <div key={link.id} className="flex items-center justify-between text-grey-300">
                <span className="font-mono text-[12px]">…{link.token.slice(-8)}</span>
                <span className="tabular-nums">{link.redemptionCount}/{link.maxRedemptions}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {links.length === 0 && (
        <p className="text-ui-xs text-grey-300">{C.GIFT_LINKS_EMPTY}</p>
      )}
    </div>
  )
}
