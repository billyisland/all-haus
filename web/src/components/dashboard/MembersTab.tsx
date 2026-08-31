'use client'

import React, { useState, useEffect } from 'react'
import { publications as pubApi, type PublicationMember } from '../../lib/api'
import { useResolverInput } from '../../hooks/useResolverInput'

interface Props {
  publicationId: string
  publicationName: string
  canManageMembers: boolean
  isOwner: boolean
}

export function MembersTab({ publicationId, publicationName, canManageMembers, isOwner }: Props) {
  const [members, setMembers] = useState<PublicationMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Invite form — omnivorous input via useResolverInput (audit F4: the prior
  // hand-rolled debounce had no stale-request guard, so fast typing could land
  // an old match over a newer one; the hook's genRef closes that race).
  const [inviteRole, setInviteRole] = useState<string>('contributor')
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [invitePick, setInvitePick] = useState<{
    id: string
    username: string
    displayName: string
  } | null>(null)
  const ri = useResolverInput({ context: 'invite', maxPolls: 3 })
  const inviteMatches = ri.matches.filter(m => m.account)
  // An unambiguous single match resolves implicitly (the pre-F4 UX); multiple
  // matches render as rows and need an explicit pick. A lone SPECULATIVE fuzzy
  // match is NOT unambiguous — the invite must not silently target a
  // name-similar account instead of falling back to email — and `pending`
  // guards the debounce window where matches still answer the previous query.
  const resolvedAccount =
    invitePick ??
    (inviteMatches.length === 1 &&
    !ri.pending &&
    inviteMatches[0].confidence !== 'speculative'
      ? inviteMatches[0].account!
      : null)

  // Inline role editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<string>('')
  const [savingRole, setSavingRole] = useState(false)

  // Leave
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    pubApi.getMembers(publicationId)
      .then(res => setMembers(res.members))
      .catch(() => setError('Failed to load members.'))
      .finally(() => setLoading(false))
  }, [publicationId])

  function handleInviteQueryChange(value: string) {
    setInvitePick(null)
    setInviteMsg(null)
    ri.onQueryChange(value)
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!ri.query.trim()) return
    setInviting(true)
    setInviteMsg(null)

    try {
      // A resolved account invites by accountId; otherwise fall back to
      // treating the input as an email (the gateway validates it).
      const inviteData: { email?: string; accountId?: string; role?: string } = { role: inviteRole }
      if (resolvedAccount) {
        inviteData.accountId = resolvedAccount.id
      } else {
        inviteData.email = ri.query.trim()
      }

      const result = await pubApi.invite(publicationId, inviteData)
      setInviteMsg(`Invite sent${resolvedAccount ? ` to ${resolvedAccount.displayName}` : ''}. Token: ${result.token}`)
      ri.reset()
      setInvitePick(null)
    } catch {
      setInviteMsg('Failed to send invite.')
    } finally {
      setInviting(false)
    }
  }

  async function handleRemove(memberId: string) {
    try {
      await pubApi.removeMember(publicationId, memberId)
      setMembers(prev => prev.filter(m => m.id !== memberId))
    } catch { setError('Failed to remove member.') }
  }

  function startEditRole(member: PublicationMember) {
    setEditingId(member.id)
    setEditRole(member.role)
  }

  function cancelEditRole() {
    setEditingId(null)
    setEditRole('')
  }

  async function handleSaveRole(memberId: string) {
    setSavingRole(true)
    try {
      await pubApi.updateMember(publicationId, memberId, { role: editRole })
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: editRole } : m))
      setEditingId(null)
    } catch {
      setError('Failed to update role.')
    } finally {
      setSavingRole(false)
    }
  }

  async function handleLeave() {
    if (!confirm(`Leave ${publicationName}? Your articles will remain in the publication but you will lose editorial access.`)) return
    setLeaving(true)
    try {
      await pubApi.leave(publicationId)
      window.location.href = '/reader?overlay=dashboard'
    } catch {
      setError('Failed to leave publication.')
      setLeaving(false)
    }
  }

  if (loading) return <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
  if (error) return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>

  return (
    <div className="space-y-6">
      {/* Member list */}
      <div className="overflow-x-auto bg-glasshouse-well">
        <table className="w-full text-ui-xs">
          <thead>
            <tr className="border-b-2 border-grey-200">
              <th className="px-4 py-3 text-left label-ui text-grey-400">Name</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Role</th>
              <th className="px-4 py-3 text-left label-ui text-grey-400">Title</th>
              <th className="px-4 py-3 text-right label-ui text-grey-400">Share (bps)</th>
              {canManageMembers && <th className="px-4 py-3 text-right label-ui text-grey-400">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id} className="border-b-2 border-grey-200 last:border-b-0">
                <td className="px-4 py-3">
                  <span className="text-black">{m.display_name || m.username}</span>
                  {m.is_owner && <span className="ml-2 text-ui-xs text-grey-300">Owner</span>}
                </td>
                <td className="px-4 py-3">
                  {editingId === m.id ? (
                    <select
                      value={editRole}
                      onChange={e => setEditRole(e.target.value)}
                      className="bg-grey-100 px-3 py-1.5 text-sm text-black"
                    >
                      <option value="contributor">Contributor</option>
                      <option value="editor">Editor</option>
                      <option value="editor_in_chief">Editor-in-Chief</option>
                    </select>
                  ) : (
                    <span className="text-grey-400">{m.role.replace(/_/g, ' ')}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-grey-400">{m.title || '--'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{m.revenue_share_bps ?? '--'}</td>
                {canManageMembers && (
                  <td className="px-4 py-3 text-right">
                    {!m.is_owner && (
                      <div className="flex items-center justify-end gap-3">
                        {editingId === m.id ? (
                          <>
                            <button
                              onClick={() => handleSaveRole(m.id)}
                              disabled={savingRole}
                              className="text-ui-xs text-black font-medium disabled:opacity-50"
                            >
                              {savingRole ? '...' : 'Save'}
                            </button>
                            <button
                              onClick={cancelEditRole}
                              className="text-ui-xs text-grey-300 hover:text-black"
                            >
                              &times;
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => startEditRole(m)}
                              className="text-grey-300 hover:text-black"
                            >
                              Change role
                            </button>
                            <button onClick={() => handleRemove(m.id)} className="text-grey-300 hover:text-black">
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Leave publication — non-owner only */}
      {!isOwner && (
        <button
          onClick={handleLeave}
          disabled={leaving}
          className="text-ui-xs text-grey-300 hover:text-black transition-colors disabled:opacity-50"
        >
          {leaving ? 'Leaving...' : 'Leave this publication'}
        </button>
      )}

      {/* Invite form */}
      {canManageMembers && (
        <div className="bg-glasshouse-well px-6 py-5">
          <p className="label-ui text-grey-400 mb-4">Invite a member</p>
          <form onSubmit={handleInvite} className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="label-ui text-grey-400 block mb-1">Email, username, or npub</label>
              <div className="relative">
                <input
                  type="text"
                  value={ri.query}
                  onChange={e => handleInviteQueryChange(e.target.value)}
                  className="bg-grey-100 px-3 py-1.5 text-sm text-black w-60"
                  placeholder="writer@example.com or @username"
                />
                {ri.resolving && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <div className="w-3 h-3 border-2 border-grey-300 border-t-black rounded-full animate-spin" />
                  </div>
                )}
              </div>
              {resolvedAccount && (
                <p className="text-mono-xs text-black mt-1">
                  Resolved: {resolvedAccount.displayName} (@{resolvedAccount.username})
                </p>
              )}
              {/* Rows render whenever nothing auto-resolved — including a lone
                  speculative fuzzy match, which needs an explicit pick. */}
              {!resolvedAccount && inviteMatches.length > 0 && (
                <div className="mt-1 flex w-60 flex-col gap-0.5">
                  {inviteMatches.map(m => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setInvitePick(m.account!)}
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
              {!resolvedAccount && !ri.resolving && ri.doneEmpty && (
                <p className="text-ui-xs text-grey-600 mt-1">
                  {/@.+\./.test(ri.query)
                    ? 'No account with this email — sending will invite them by email.'
                    : 'No platform account found for this identifier.'}
                </p>
              )}
            </div>
            <div>
              <label className="text-ui-xs text-grey-400 block mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="bg-grey-100 px-3 py-1.5 text-sm text-black"
              >
                <option value="contributor">Contributor</option>
                <option value="editor">Editor</option>
                <option value="editor_in_chief">Editor-in-Chief</option>
              </select>
            </div>
            <button type="submit" disabled={inviting} className="btn text-sm disabled:opacity-50">
              {inviting ? 'Sending...' : 'Send invite'}
            </button>
          </form>
          {inviteMsg && <p className="text-ui-xs text-grey-600 mt-2">{inviteMsg}</p>}
        </div>
      )}
    </div>
  )
}
