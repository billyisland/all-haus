'use client'

import React, { useState } from 'react'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { SettingsSection } from './SettingsSection'

export function DangerZone() {
  const { user, logout } = useAuth()
  const router = useRouter()

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  async function handleDeactivate() {
    if (!confirm('Deactivate your account? Your content will be hidden until you log back in.')) return
    try {
      await auth.deactivate()
      await logout()
      router.push('/')
    } catch (err: any) {
      setError(err.message ?? 'Deactivation failed')
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      await auth.deleteAccount(emailInput)
      await logout()
      router.push('/')
    } catch (err: any) {
      setError(err.message ?? 'Deletion failed')
      setDeleting(false)
    }
  }

  const emailMatch = emailInput.toLowerCase() === user.email?.toLowerCase()

  return (
    <>
      <div className="slab-rule-4" />

      <section>
        <h2 className="font-sans text-base font-medium text-crimson tracking-tight mb-5">
          Close your account
        </h2>

        <div className="space-y-6">
          <SettingsSection label="Deactivate">
            <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
              Your profile and content will be hidden. You can reactivate by logging back in.
            </p>
            <button onClick={handleDeactivate} className="btn-soft py-2 px-4 text-sm">
              Deactivate account
            </button>
          </SettingsSection>

          <SettingsSection label="Delete permanently">
            <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
              Your content will be removed and your account data erased. This cannot be undone.
            </p>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="btn py-2 px-4 text-sm"
              style={{ backgroundColor: 'var(--ah-danger-red)', borderColor: 'var(--ah-danger-red)' }}
            >
              Delete account
            </button>
          </SettingsSection>
        </div>

        {error && <p className="text-sm text-red-600 mt-4">{error}</p>}
      </section>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white max-w-md w-full px-8 py-8">
            <h2 className="font-serif text-xl text-black mb-4">Delete your account?</h2>

            <p className="text-sm text-black mb-3">This will:</p>
            <ul className="text-sm text-grey-600 space-y-1 mb-4 list-disc pl-5">
              <li>Cancel all active subscriptions</li>
              <li>Settle your reading tab</li>
              <li>Remove all published articles</li>
              <li>Publish Nostr deletion events</li>
            </ul>
            <p className="text-ui-xs text-grey-600 mb-6">
              Any outstanding earnings will be paid out to your connected Stripe account.
            </p>

            <label className="label-ui text-grey-600 block mb-2">
              Enter your email to confirm:
            </label>
            <input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              placeholder={user.email}
              className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none mb-4"
            />

            {error && <p className="text-ui-xs text-red-600 mb-4">{error}</p>}

            <div className="flex items-center justify-between">
              <button
                onClick={() => { setShowDeleteModal(false); setEmailInput(''); setError(null) }}
                className="btn-soft py-2 px-4 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!emailMatch || deleting}
                className="btn py-2 px-4 text-sm disabled:opacity-50"
                style={{ backgroundColor: 'var(--ah-danger-red)', borderColor: 'var(--ah-danger-red)' }}
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
