'use client'

import { useState } from 'react'
import { useAuth } from '../../stores/auth'

interface ReportButtonProps {
  targetNostrEventId?: string
  targetAccountId?: string
}

const CATEGORIES = [
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'harassment', label: 'Targeted harassment or non-consensual intimate imagery' },
  { value: 'spam', label: 'Spam or inauthentic behaviour' },
  { value: 'other', label: 'Other' },
] as const

export function ReportButton({ targetNostrEventId, targetAccountId }: ReportButtonProps) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  async function handleSubmit() {
    if (!category) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/v1/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetNostrEventId,
          targetAccountId,
          category,
          notes: notes.trim() || undefined,
        }),
      })

      if (!res.ok) throw new Error('Report submission failed')

      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="text-xs text-grey-300 py-2">
        Report submitted. We'll review it within 48 hours.
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-grey-300 hover:text-grey-400 transition-colors"
        aria-label="Report this content"
      >
        Report
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-10 w-80 border border-grey-200 bg-white p-4 shadow-lg">
          <h3 className="text-sm font-medium text-black mb-3">Report content</h3>

          <div className="space-y-2 mb-3">
            {CATEGORIES.map((cat) => (
              <label key={cat.value} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="report-category"
                  value={cat.value}
                  checked={category === cat.value}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <span className="text-xs text-grey-600 leading-tight">{cat.label}</span>
              </label>
            ))}
          </div>

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional details (optional)"
            rows={2}
            maxLength={2000}
            className="w-full bg-grey-100 px-2.5 py-1.5 text-xs mb-3"
          />

          {error && (
            <p className="text-xs text-crimson mb-2">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={!category || submitting}
              className="btn-accent px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Submit report'}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="text-xs text-grey-300 hover:text-grey-400 px-2"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-[10px] text-grey-300 leading-snug">
            Reports are reviewed by a human within 48 hours. Submitting a report does not automatically remove content.
          </p>
        </div>
      )}
    </div>
  )
}
