'use client'

// =============================================================================
// ProfileSection — display name, bio, avatar and username editor, folded into
// SettingsPanel (the retired /profile route now shims to the settings overlay).
// Mirrors EmailChange/PaymentSection: a label over a bg-white card, grey-100
// entry fields. Saves via PATCH /auth/profile and refreshes auth state.
// =============================================================================

import { useState, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { auth } from '../../lib/api'
import { uploadImage } from '../../lib/media'
import { UsernameChange } from '../profile/UsernameChange'

export function ProfileSection() {
  const { user, fetchMe } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)

  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [avatar, setAvatar] = useState<string | null>(user?.avatar ?? null)

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const result = await uploadImage(file)
      setAvatar(result.url)
    } catch (err: any) {
      setError(err.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await auth.updateProfile({
        displayName: displayName.trim() || undefined,
        bio: bio.trim(),
        avatar: avatar,
      })
      await fetchMe()
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const initial = (displayName || user.username || '?')[0].toUpperCase()

  return (
    <>
        <form onSubmit={handleSave} className="space-y-8">
          {/* Avatar */}
          <div>
            <label className="block label-ui text-grey-600 mb-3">Photo</label>
            <div className="flex items-center gap-4">
              {avatar ? (
                <img src={avatar} alt="" className="h-16 w-16  object-cover flex-shrink-0" />
              ) : (
                <span
                  className="flex h-16 w-16 items-center justify-center  text-xl font-medium text-black flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, var(--ah-blush), var(--ah-blush-deep))' }}
                >
                  {initial}
                </span>
              )}
              <div className="flex flex-col gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleAvatarUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
                >
                  {uploading ? 'Uploading…' : 'Upload photo'}
                </button>
                {avatar && (
                  <button
                    type="button"
                    onClick={() => setAvatar(null)}
                    className="text-ui-xs text-grey-300 hover:text-grey-400 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Display name */}
          <div>
            <label htmlFor="displayName" className="block label-ui text-grey-600 mb-2">
              Display name
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
              placeholder={user.username ?? ''}
              className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none"
            />
          </div>

          {/* Bio */}
          <div>
            <label htmlFor="bio" className="block label-ui text-grey-600 mb-2">
              Bio
            </label>
            <textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={500}
              rows={4}
              placeholder="A few words about yourself"
              className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none resize-none"
            />
            <p className="text-[11px] text-grey-300 mt-1 text-right">{bio.length}/500</p>
          </div>

          {/* Error */}
          {error && <p className="text-sm text-red-500">{error}</p>}

          {/* Save */}
          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={saving || uploading}
              className="btn py-2 px-6 text-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {saved && <span className="text-sm text-green-600">Saved</span>}
          </div>
        </form>

        {/* Username */}
        <div className="mt-8">
          <UsernameChange />
        </div>

        {/* Public key (read-only) */}
        <div className="mt-8">
          <label className="block label-ui text-grey-600 mb-2">Public key</label>
          <p className="text-ui-xs text-grey-300 truncate">{user.pubkey}</p>
        </div>
    </>
  )
}
