'use client'

import React, { useState, useRef, useCallback } from 'react'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'

export function UsernameChange() {
  const { user, fetchMe } = useAuth()

  const [editing, setEditing] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>(
    'idle'
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!user) return null

  // 30-day cooldown check
  const cooldownUntil = user.usernameChangedAt
    ? new Date(new Date(user.usernameChangedAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    : null
  const onCooldown = cooldownUntil && cooldownUntil > new Date()

  function handleInputChange(value: string) {
    const normalised = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
    setNewUsername(normalised)
    setError(null)

    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!normalised || normalised.length < 3) {
      setAvailability(normalised.length > 0 ? 'invalid' : 'idle')
      return
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(normalised) && normalised.length >= 3) {
      setAvailability('invalid')
      return
    }

    setAvailability('checking')
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await auth.checkUsername(normalised)
        setAvailability(result.available ? 'available' : 'taken')
      } catch {
        setAvailability('idle')
      }
    }, 300)
  }

  async function handleSave() {
    if (availability !== 'available') return
    setSaving(true)
    setError(null)
    try {
      await auth.changeUsername(newUsername)
      await fetchMe()
      setSaved(true)
      setEditing(false)
      setNewUsername('')
      setAvailability('idle')
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message ?? 'Failed to change username')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setEditing(false)
    setNewUsername('')
    setAvailability('idle')
    setError(null)
  }

  return (
    <div>
      <label className="block label-ui text-grey-600 mb-2">
        Username
      </label>

      {editing ? (
        <div>
          <input
            type="text"
            value={newUsername}
            onChange={e => handleInputChange(e.target.value)}
            placeholder="newusername"
            maxLength={30}
            autoFocus
            className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none"
            onKeyDown={e => { if (e.key === 'Enter' && availability === 'available') void handleSave() }}
          />

          {/* Availability feedback */}
          <div className="mt-1">
            {availability === 'checking' && (
              <p className="text-ui-xs text-grey-400">Checking availability...</p>
            )}
            {availability === 'available' && (
              <p className="text-ui-xs text-black">Available</p>
            )}
            {availability === 'taken' && (
              <p className="text-ui-xs text-red-600">Already taken</p>
            )}
            {availability === 'invalid' && newUsername.length > 0 && (
              <p className="text-ui-xs text-red-600">3-30 chars, lowercase alphanumeric and hyphens</p>
            )}
          </div>

          {error && <p className="text-ui-xs text-red-600 mt-1">{error}</p>}

          <div className="flex gap-3 mt-3">
            <button
              onClick={handleSave}
              disabled={saving || availability !== 'available'}
              className="text-ui-xs text-black font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={handleCancel} className="text-ui-xs text-grey-300 hover:text-black">
              Cancel
            </button>
          </div>

          <p className="text-ui-xs text-grey-400 mt-3">
            Requests to your old URL will redirect for 90 days.
          </p>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-3">
            <p className="text-sm text-grey-600">@{user.username}</p>
            {!onCooldown && (
              <button
                onClick={() => setEditing(true)}
                className="text-ui-xs text-grey-300 hover:text-black"
              >
                Change
              </button>
            )}
          </div>
          {onCooldown && cooldownUntil && (
            <p className="text-[11px] text-grey-400 mt-1">
              You can change your username again on{' '}
              {cooldownUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.
            </p>
          )}
          {saved && (
            <p className="text-ui-xs text-grey-600 mt-1">Username updated.</p>
          )}
        </div>
      )}
    </div>
  )
}
