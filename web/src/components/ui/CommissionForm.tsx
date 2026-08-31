'use client'

import { useState } from 'react'
import { drives } from '../../lib/api'

interface CommissionFormProps {
  targetWriterId: string
  targetWriterName: string
  parentNoteEventId?: string
  parentConversationId?: string
  initialPitch?: string
  onCreated?: (driveId: string) => void
  onClose?: () => void
}

export function CommissionForm({
  targetWriterId,
  targetWriterName,
  parentNoteEventId,
  parentConversationId,
  initialPitch = '',
  onCreated,
  onClose,
}: CommissionFormProps) {
  const [pitch, setPitch] = useState(initialPitch)
  const [amountPounds, setAmountPounds] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const amountPence = Math.round(parseFloat(amountPounds) * 100)
    if (!pitch.trim() || isNaN(amountPence) || amountPence < 1) {
      setError('Please provide a pitch and a valid amount.')
      return
    }

    setSubmitting(true); setError(null)
    try {
      const result = await drives.create({
        origin: 'commission',
        targetWriterId,
        title: pitch.trim(),
        fundingTargetPence: amountPence,
        parentNoteEventId,
        parentConversationId,
      })
      onCreated?.(result.driveId)
    } catch {
      setError('Failed to create commission.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white p-5">
      <p className="label-ui text-grey-400 mb-3">
        Commission {targetWriterName}
      </p>

      <label className="block text-ui-xs font-sans text-grey-600 mb-1">
        What do you want them to write about?
      </label>
      <textarea
        value={pitch}
        onChange={(e) => setPitch(e.target.value)}
        placeholder="Describe the piece you'd like to see…"
        className="w-full bg-grey-100 px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300 mb-4 resize-none"
        rows={3}
      />

      <label className="block text-ui-xs font-sans text-grey-600 mb-1">
        How much are you offering?
      </label>
      <div className="flex items-center gap-1 mb-4">
        <span className="text-ui-sm font-sans text-grey-400">£</span>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={amountPounds}
          onChange={(e) => setAmountPounds(e.target.value)}
          placeholder="0.00"
          className="w-28 bg-grey-100 px-3 py-1.5 text-ui-sm font-sans text-black placeholder-grey-300"
        />
      </div>

      {error && <p className="text-ui-xs font-sans text-crimson mb-3">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="btn text-sm disabled:opacity-50">
          {submitting ? 'Sending…' : 'Send commission'}
        </button>
        {onClose && (
          <button type="button" onClick={onClose} className="text-ui-xs font-sans text-grey-400 hover:text-black transition-colors">
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
