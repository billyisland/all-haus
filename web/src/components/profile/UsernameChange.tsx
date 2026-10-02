'use client'

import React, { useState, useRef, useCallback } from 'react'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import {
  USERNAME_LABEL, USERNAME_PLACEHOLDER, USERNAME_CHECKING, USERNAME_AVAILABLE, USERNAME_TAKEN,
  USERNAME_RESERVED,
  USERNAME_INVALID, USERNAME_REDIRECT_NOTE, USERNAME_UPDATED, USERNAME_CHANGE_FAILED,
  usernameCooldownSentence,
  SETTINGS_SAVE, SETTINGS_SAVING, SETTINGS_CANCEL, SETTINGS_CHANGE,
} from '../../content/settings'
import { failureSentence } from '../../lib/api/client'

export function UsernameChange() {
  const { user, fetchMe } = useAuth()

  const [editing, setEditing] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid'>(
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
        setAvailability(result.available ? 'available' : result.reason === 'Reserved' ? 'reserved' : 'taken')
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
      setError(failureSentence(err, USERNAME_CHANGE_FAILED))
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
        {USERNAME_LABEL}
      </label>

      {editing ? (
        <div>
          <input
            type="text"
            value={newUsername}
            onChange={e => handleInputChange(e.target.value)}
            placeholder={USERNAME_PLACEHOLDER}
            maxLength={30}
            autoFocus
            className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none"
            onKeyDown={e => { if (e.key === 'Enter' && availability === 'available') void handleSave() }}
          />

          {/* Availability feedback */}
          <div className="mt-1">
            {availability === 'checking' && (
              <p className="text-ui-xs text-grey-400">{USERNAME_CHECKING}</p>
            )}
            {availability === 'available' && (
              <p className="text-ui-xs text-black">{USERNAME_AVAILABLE}</p>
            )}
            {availability === 'taken' && (
              <p className="text-ui-xs text-red-600">{USERNAME_TAKEN}</p>
            )}
            {availability === 'reserved' && (
              <p className="text-ui-xs text-red-600">{USERNAME_RESERVED}</p>
            )}
            {availability === 'invalid' && newUsername.length > 0 && (
              <p className="text-ui-xs text-red-600">{USERNAME_INVALID}</p>
            )}
          </div>

          {error && <p className="text-ui-xs text-red-600 mt-1">{error}</p>}

          <div className="flex gap-3 mt-3">
            <button
              onClick={handleSave}
              disabled={saving || availability !== 'available'}
              className="text-ui-xs text-black font-medium disabled:opacity-50"
            >
              {saving ? SETTINGS_SAVING : SETTINGS_SAVE}
            </button>
            <button onClick={handleCancel} className="text-ui-xs text-grey-300 hover:text-black">
              {SETTINGS_CANCEL}
            </button>
          </div>

          <p className="text-ui-xs text-grey-400 mt-3">
            {USERNAME_REDIRECT_NOTE}
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
                {SETTINGS_CHANGE}
              </button>
            )}
          </div>
          {onCooldown && cooldownUntil && (
            <p className="text-[11px] text-grey-400 mt-1">
              {usernameCooldownSentence(
                cooldownUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
              )}
            </p>
          )}
          {saved && (
            <p className="text-ui-xs text-grey-600 mt-1">{USERNAME_UPDATED}</p>
          )}
        </div>
      )}
    </div>
  )
}
