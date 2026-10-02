'use client'

import React, { useState } from 'react'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import {
  EMAIL_PLACEHOLDER, EMAIL_NONE, EMAIL_CHANGE_FAILED, emailVerificationSentSentence,
  SETTINGS_SAVE, SETTINGS_SAVING, SETTINGS_CANCEL, SETTINGS_CHANGE,
} from '../../content/settings'
import { failureSentence } from '../../lib/api/client'

export function EmailChange() {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [sentTo, setSentTo] = useState('')

  if (!user) return null

  async function handleSave() {
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed) return
    setSaving(true)
    setError(null)
    try {
      await auth.changeEmail(trimmed)
      // The address that was actually sent to, kept separately: the field is
      // cleared on the next line, so the confirmation read `newEmail ||
      // 'your new address'` and therefore ALWAYS took the fallback — the one
      // sentence whose whole job is to say which inbox to go and look in.
      setSentTo(trimmed)
      setSent(true)
      setEditing(false)
      setNewEmail('')
      setTimeout(() => setSent(false), 8000)
    } catch (err: any) {
      setError(failureSentence(err, EMAIL_CHANGE_FAILED))
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
              placeholder={EMAIL_PLACEHOLDER}
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
                {saving ? SETTINGS_SAVING : SETTINGS_SAVE}
              </button>
              <button onClick={handleCancel} className="btn-text-muted">
                {SETTINGS_CANCEL}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-black">{user.email ?? EMAIL_NONE}</p>
            <button
              onClick={() => setEditing(true)}
              className="btn-text-muted"
            >
              {SETTINGS_CHANGE}
            </button>
          </div>
        )}
        {sent && (
          <p className="text-ui-xs text-grey-600 mt-3">
            {emailVerificationSentSentence(sentTo)}
          </p>
        )}
    </>
  )
}
