'use client'

import React, { useState } from 'react'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'

export function EmailChange() {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  if (!user) return null

  async function handleSave() {
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed) return
    setSaving(true)
    setError(null)
    try {
      await auth.changeEmail(trimmed)
      setSent(true)
      setEditing(false)
      setNewEmail('')
      setTimeout(() => setSent(false), 8000)
    } catch (err: any) {
      setError(err.message ?? 'Failed to send verification email')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setEditing(false)
    setNewEmail('')
    setError(null)
  }

  return (
    <>
        {editing ? (
          <div>
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              placeholder="new@example.com"
              autoFocus
              className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
              onKeyDown={e => { if (e.key === 'Enter') void handleSave() }}
            />
            {error && <p className="text-ui-xs text-red-600 mt-2">{error}</p>}
            <div className="flex gap-3 mt-3">
              <button
                onClick={handleSave}
                disabled={saving || !newEmail.trim()}
                className="btn-text"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={handleCancel} className="btn-text-muted">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-black">{user.email ?? '(no email)'}</p>
            <button
              onClick={() => setEditing(true)}
              className="btn-text-muted"
            >
              Change
            </button>
          </div>
        )}
        {sent && (
          <p className="text-ui-xs text-grey-600 mt-3">
            Verification email sent to {newEmail || 'your new address'}. Check your inbox.
          </p>
        )}
    </>
  )
}
