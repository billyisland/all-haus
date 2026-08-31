'use client'

import React, { useState, useEffect, useRef } from 'react'
import { publications as pubApi, type PublicationMember } from '../../lib/api'
import { uploadImage } from '../../lib/media'

interface Props {
  publicationId: string
  publicationSlug: string
  isOwner: boolean
}

export function PublicationSettingsTab({ publicationId, publicationSlug, isOwner }: Props) {
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [about, setAbout] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [homepageLayout, setHomepageLayout] = useState<string>('blog')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Danger zone state
  const [members, setMembers] = useState<PublicationMember[]>([])
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showTransferModal, setShowTransferModal] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')
  const [selectedNewOwner, setSelectedNewOwner] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [dangerMsg, setDangerMsg] = useState<string | null>(null)

  useEffect(() => {
    pubApi.get(publicationSlug)
      .then((pub: any) => {
        setName(pub.name ?? '')
        setTagline(pub.tagline ?? '')
        setAbout(pub.about ?? '')
        setLogoUrl(pub.logo_blossom_url ?? null)
        setHomepageLayout(pub.homepage_layout ?? 'blog')
      })
      .catch(() => setMsg('Failed to load settings.'))
      .finally(() => setLoading(false))
  }, [publicationSlug])

  // Load members for transfer modal
  useEffect(() => {
    if (!isOwner) return
    pubApi.getMembers(publicationId)
      .then(res => setMembers(res.members))
      .catch(() => {})
  }, [publicationId, isOwner])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    try {
      await pubApi.update(publicationId, {
        name: name.trim(),
        tagline: tagline.trim() || null,
        about: about.trim() || null,
        logo_blossom_url: logoUrl,
      })
      setMsg('Settings saved.')
    } catch {
      setMsg('Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setMsg(null)
    try {
      const result = await uploadImage(file)
      setLogoUrl(result.url)
    } catch (err: any) {
      setMsg(err.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleLayoutChange(layout: string) {
    const prev = homepageLayout
    setHomepageLayout(layout)
    setMsg(null)
    try {
      await pubApi.update(publicationId, { homepage_layout: layout })
      setMsg('Layout updated.')
    } catch {
      setHomepageLayout(prev)
      setMsg('Failed to update layout.')
    }
  }

  async function handleArchive() {
    if (!confirm(`Archive ${name}? It will be hidden from all readers.`)) return
    setArchiving(true)
    setDangerMsg(null)
    try {
      await pubApi.archive(publicationId)
      window.location.href = '/reader?overlay=dashboard'
    } catch {
      setDangerMsg('Failed to archive.')
      setArchiving(false)
    }
  }

  async function handleTransfer() {
    if (!selectedNewOwner) return
    setTransferring(true)
    setDangerMsg(null)
    try {
      await pubApi.transferOwnership(publicationId, selectedNewOwner)
      window.location.href = '/reader?overlay=dashboard'
    } catch {
      setDangerMsg('Failed to transfer ownership.')
      setTransferring(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setDangerMsg(null)
    try {
      await pubApi.archive(publicationId)
      window.location.href = '/reader?overlay=dashboard'
    } catch {
      setDangerMsg('Failed to delete.')
      setDeleting(false)
    }
  }

  if (loading) return <div className="h-40 animate-pulse bg-glasshouse-well" />

  const eligibleOwners = members.filter(m => m.role === 'editor_in_chief' && !m.is_owner)
  const deleteMatch = deleteInput.toLowerCase() === name.toLowerCase()

  const layouts = [
    { id: 'blog', label: 'Blog', desc: 'Chronological list' },
    { id: 'magazine', label: 'Magazine', desc: 'Grid with featured' },
    { id: 'minimal', label: 'Minimal', desc: 'Headlines only' },
  ]

  return (
    <div className="space-y-6">
      {/* Settings form */}
      <div className="bg-glasshouse-well px-6 py-5 space-y-6">
        <form onSubmit={handleSave} className="space-y-4">
          {/* Logo upload */}
          <div>
            <label className="label-ui text-grey-400 block mb-3">Logo</label>
            <div className="flex items-center gap-4">
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-24 w-24 object-cover flex-shrink-0 bg-grey-100" />
              ) : (
                <span
                  className="flex h-24 w-24 items-center justify-center text-2xl font-medium text-grey-300 flex-shrink-0 bg-grey-100 cursor-pointer hover:bg-grey-200/60 transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  {name[0]?.toUpperCase() ?? '?'}
                </span>
              )}
              <div className="flex flex-col gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleLogoUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
                >
                  {uploading ? 'Uploading...' : 'Upload logo'}
                </button>
                {logoUrl && (
                  <button
                    type="button"
                    onClick={() => setLogoUrl(null)}
                    className="text-ui-xs text-grey-300 hover:text-grey-400 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="label-ui text-grey-400 block mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
            />
          </div>
          <div>
            <label className="label-ui text-grey-400 block mb-1">Tagline</label>
            <input
              type="text"
              value={tagline}
              onChange={e => setTagline(e.target.value)}
              className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
              placeholder="A short description"
            />
          </div>
          <div>
            <label className="label-ui text-grey-400 block mb-1">About</label>
            <textarea
              value={about}
              onChange={e => setAbout(e.target.value)}
              rows={6}
              className="bg-grey-100 px-3 py-1.5 text-sm text-black w-full max-w-md"
              placeholder="Mission statement, editorial focus, etc."
            />
          </div>
          <button type="submit" disabled={saving || uploading} className="btn text-sm disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </form>
        {msg && <p className="text-ui-xs text-grey-600">{msg}</p>}
      </div>

      {/* Layout template picker */}
      <div className="bg-glasshouse-well px-6 py-5">
        <label className="label-ui text-grey-400 block mb-2">Homepage layout</label>
        <p className="text-ui-xs text-grey-600 mb-4">Choose how your publication homepage is arranged.</p>
        <div className="grid grid-cols-3 gap-4 max-w-md">
          {layouts.map(l => (
            <button
              key={l.id}
              type="button"
              onClick={() => handleLayoutChange(l.id)}
              className={`px-4 py-5 text-center cursor-pointer border-2 transition-colors ${
                homepageLayout === l.id
                  ? 'border-black bg-white'
                  : 'border-grey-200 bg-white hover:border-grey-300'
              }`}
            >
              {/* Simplified wireframe */}
              <div className="h-20 mb-3 flex flex-col items-center justify-center gap-1">
                {l.id === 'blog' && (
                  <>
                    <div className="w-full h-1.5 bg-grey-200 rounded" />
                    <div className="w-4/5 h-1.5 bg-grey-200 rounded" />
                    <div className="w-full h-1.5 bg-grey-200 rounded mt-2" />
                    <div className="w-4/5 h-1.5 bg-grey-200 rounded" />
                  </>
                )}
                {l.id === 'magazine' && (
                  <div className="grid grid-cols-3 gap-1 w-full">
                    <div className="h-8 bg-grey-200 rounded" />
                    <div className="h-8 bg-grey-200 rounded" />
                    <div className="h-8 bg-grey-200 rounded" />
                    <div className="h-8 bg-grey-200 rounded" />
                    <div className="h-8 bg-grey-200 rounded" />
                    <div className="h-8 bg-grey-200 rounded" />
                  </div>
                )}
                {l.id === 'minimal' && (
                  <>
                    <div className="w-full flex gap-2">
                      <div className="flex-1 h-1.5 bg-grey-200 rounded" />
                      <div className="flex-1 h-1.5 bg-grey-200 rounded" />
                    </div>
                    <div className="w-full h-0.5 bg-grey-200 my-1" />
                    <div className="w-full flex gap-2">
                      <div className="flex-1 h-1.5 bg-grey-200 rounded" />
                      <div className="flex-1 h-1.5 bg-grey-200 rounded" />
                    </div>
                  </>
                )}
              </div>
              <p className="text-ui-sm text-black">{l.label}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Danger zone — owner only */}
      {isOwner && (
        <>
          <div className="slab-rule-4 my-10" />

          <div className="mb-10">
            <p className="label-ui text-crimson mb-6">Danger zone</p>

            {/* Archive */}
            <div className="bg-glasshouse-well px-6 py-5 mb-6">
              <p className="text-sm text-black font-medium">Archive this publication</p>
              <p className="text-ui-xs text-grey-600 mt-1 mb-4">
                Archiving hides it from readers but preserves all content, members, and subscriber records. You can restore it later.
              </p>
              <button
                onClick={handleArchive}
                disabled={archiving}
                className="btn-soft py-2 px-4 text-sm disabled:opacity-50"
              >
                {archiving ? 'Archiving...' : 'Archive publication'}
              </button>
            </div>

            {/* Transfer ownership */}
            <div className="bg-glasshouse-well px-6 py-5 mb-6">
              <p className="text-sm text-black font-medium">Transfer ownership</p>
              <p className="text-ui-xs text-grey-600 mt-1 mb-4">
                Hand this publication to another member. You will become an editor. Only members with the editor-in-chief role are eligible.
              </p>
              <button
                onClick={() => setShowTransferModal(true)}
                disabled={eligibleOwners.length === 0}
                className="btn-soft py-2 px-4 text-sm disabled:opacity-50"
                title={eligibleOwners.length === 0 ? 'No eligible members' : undefined}
              >
                Transfer ownership
              </button>
            </div>

            {/* Delete */}
            <div className="bg-glasshouse-well px-6 py-5">
              <p className="text-sm text-black font-medium">Delete this publication permanently</p>
              <p className="text-ui-xs text-grey-600 mt-1 mb-4">
                This cannot be undone. All articles will be detached and returned to their authors as personal drafts. Subscribers will be cancelled.
              </p>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="btn py-2 px-4 text-sm"
                style={{ backgroundColor: 'var(--ah-danger-red)', borderColor: 'var(--ah-danger-red)' }}
              >
                Delete publication
              </button>
            </div>

            {dangerMsg && <p className="text-sm text-red-600 mt-4">{dangerMsg}</p>}
          </div>

          {/* Transfer ownership modal */}
          {showTransferModal && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white max-w-md w-full px-8 py-8">
                <h2 className="font-serif text-xl text-black mb-1">Transfer ownership of</h2>
                <p className="font-serif text-xl text-black mb-6">{name}</p>

                <p className="text-sm text-black mb-4">Select the new owner:</p>

                <div className="space-y-2 mb-4">
                  {eligibleOwners.map(m => (
                    <button
                      key={m.account_id}
                      type="button"
                      onClick={() => setSelectedNewOwner(m.account_id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                        selectedNewOwner === m.account_id
                          ? 'bg-black text-white'
                          : 'bg-grey-100 text-black hover:bg-grey-200/60'
                      }`}
                    >
                      <span className="text-sm">{m.display_name || m.username}</span>
                      <span className={`text-ui-xs ${selectedNewOwner === m.account_id ? 'text-grey-300' : 'text-grey-400'}`}>
                        Editor-in-Chief
                      </span>
                    </button>
                  ))}
                </div>

                <p className="text-ui-xs text-grey-600 mb-6">
                  You will become an editor. This cannot be undone without the new owner's help.
                </p>

                {dangerMsg && <p className="text-ui-xs text-red-600 mb-4">{dangerMsg}</p>}

                <div className="flex items-center justify-between">
                  <button
                    onClick={() => { setShowTransferModal(false); setSelectedNewOwner(null); setDangerMsg(null) }}
                    className="btn-soft py-2 px-4 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleTransfer}
                    disabled={!selectedNewOwner || transferring}
                    className="btn py-2 px-4 text-sm disabled:opacity-50"
                  >
                    {transferring ? 'Transferring...' : 'Transfer'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Delete confirmation modal */}
          {showDeleteModal && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white max-w-md w-full px-8 py-8">
                <h2 className="font-serif text-xl text-black mb-4">Delete {name}?</h2>

                <p className="text-sm text-black mb-3">This will:</p>
                <ul className="text-sm text-grey-600 space-y-1 mb-4 list-disc pl-5">
                  <li>Return all articles to their authors as personal drafts</li>
                  <li>Cancel all active subscriptions</li>
                  <li>Remove the publication permanently</li>
                </ul>

                <label className="label-ui text-grey-400 block mb-2">
                  Type the publication name to confirm:
                </label>
                <input
                  type="text"
                  value={deleteInput}
                  onChange={e => setDeleteInput(e.target.value)}
                  placeholder={name}
                  className="w-full bg-grey-100 px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none mb-4"
                />

                {dangerMsg && <p className="text-ui-xs text-red-600 mb-4">{dangerMsg}</p>}

                <div className="flex items-center justify-between">
                  <button
                    onClick={() => { setShowDeleteModal(false); setDeleteInput(''); setDangerMsg(null) }}
                    className="btn-soft py-2 px-4 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={!deleteMatch || deleting}
                    className="btn py-2 px-4 text-sm disabled:opacity-50"
                    style={{ backgroundColor: 'var(--ah-danger-red)', borderColor: 'var(--ah-danger-red)' }}
                  >
                    {deleting ? 'Deleting...' : 'Delete forever'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
