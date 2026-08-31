'use client'

import { useState } from 'react'
import { drives } from '../../lib/api'

export function DriveCreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [targetAmount, setTargetAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(targetAmount) * 100)
    if (!title.trim() || isNaN(pence) || pence <= 0) {
      setError('Title and a positive target amount are required.')
      return
    }
    setSaving(true); setError(null)
    try {
      await drives.create({ origin: 'crowdfund', title: title.trim(), description: description.trim(), fundingTargetPence: pence })
      onCreated()
    } catch {
      setError('Failed to create drive.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-glasshouse-well px-6 py-5 space-y-4">
      <p className="label-ui text-grey-400">New pledge drive</p>

      <div>
        <label className="block text-ui-xs font-medium text-grey-600 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300"
          placeholder="e.g. Essays on Light"
          required
        />
      </div>

      <div>
        <label className="block text-ui-xs font-medium text-grey-600 mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300 resize-y"
          rows={3}
          placeholder="What will supporters be funding?"
        />
      </div>

      <div>
        <label className="block text-ui-xs font-medium text-grey-600 mb-1">Target amount (£)</label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={targetAmount}
          onChange={(e) => setTargetAmount(e.target.value)}
          className="w-48 bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300"
          placeholder="50.00"
          required
        />
      </div>

      {error && <p className="text-ui-xs text-crimson">{error}</p>}

      <div className="flex gap-3 pt-2">
        <button type="submit" disabled={saving} className="btn text-sm disabled:opacity-50">
          {saving ? 'Creating…' : 'Create drive'}
        </button>
        <button type="button" onClick={onCancel} className="btn-text-muted">
          Cancel
        </button>
      </div>
    </form>
  )
}
