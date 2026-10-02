'use client'

import React, { useRef, useState } from 'react'
import { auth } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { SettingsSection } from './SettingsSection'
import { ConfirmDialog, useConfirm } from '../ui/ConfirmDialog'
import {
  DANGER_HEADING,
  DEACTIVATE_LABEL, DEACTIVATE_HELP, DEACTIVATE_BUTTON,
  DEACTIVATE_CONFIRM_TITLE, DEACTIVATE_CONFIRM_BODY, DEACTIVATE_CONFIRM_LABEL, DEACTIVATE_FAILED,
  DELETE_LABEL, DELETE_HELP, DELETE_BUTTON, DELETE_CONFIRM_TITLE, DELETE_CONFIRM_LABEL,
  DELETE_CONSEQUENCES_INTRO, DELETE_CONSEQUENCES,
  DELETE_EARNINGS_BEFORE, DELETE_EARNINGS_EMPHASIS, DELETE_EARNINGS_AFTER,
  DELETE_EMAIL_CONFIRM_LABEL, DELETE_FAILED,
} from '../../content/settings'

export function DangerZone() {
  const { user, logout } = useAuth()
  const router = useRouter()

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const { ask, dialog } = useConfirm()

  if (!user) return null

  async function handleDeactivate(e: React.MouseEvent<HTMLElement>) {
    const ok = await ask(e.currentTarget, {
      title: DEACTIVATE_CONFIRM_TITLE,
      body: DEACTIVATE_CONFIRM_BODY,
      confirmLabel: DEACTIVATE_CONFIRM_LABEL,
    })
    if (!ok) return
    setError(null)
    try {
      await auth.deactivate()
      await logout()
      router.push('/')
    } catch (err: any) {
      setError(apiErrorMessage(err) ?? DEACTIVATE_FAILED)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await auth.deleteAccount(emailInput)
      await logout()
      router.push('/')
    } catch (err: any) {
      // The two money refusals (a declined final charge, a settlement still in
      // flight) each send a sentence naming what to do about it. `err.message`
      // is the ApiError's own "API error 402: {…}" and would show the reader a
      // JSON blob at the one moment they most need a plain instruction.
      setDeleteError(apiErrorMessage(err) ?? DELETE_FAILED)
      setDeleting(false)
    }
  }

  const emailMatch = emailInput.toLowerCase() === user.email?.toLowerCase()

  return (
    <>
      <div className="slab-rule-4" />

      <section>
        <h2 className="font-sans text-base font-medium text-crimson tracking-tight mb-5">
          {DANGER_HEADING}
        </h2>

        <div className="space-y-6">
          <SettingsSection label={DEACTIVATE_LABEL}>
            <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
              {DEACTIVATE_HELP}
            </p>
            <button onClick={handleDeactivate} className="btn-soft py-2 px-4 text-sm">
              {DEACTIVATE_BUTTON}
            </button>
          </SettingsSection>

          <SettingsSection label={DELETE_LABEL}>
            <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
              {DELETE_HELP}
            </p>
            <button
              ref={deleteRef}
              onClick={() => setShowDeleteModal(true)}
              className="btn py-2 px-4 text-sm"
              style={{ backgroundColor: 'var(--ah-danger-red)', borderColor: 'var(--ah-danger-red)' }}
            >
              {DELETE_BUTTON}
            </button>
          </SettingsSection>
        </div>

        {error && <p className="text-ui-xs text-crimson mt-4">{error}</p>}
      </section>

      {dialog}

      <ConfirmDialog
        anchorRef={deleteRef}
        open={showDeleteModal}
        title={DELETE_CONFIRM_TITLE}
        confirmLabel={DELETE_CONFIRM_LABEL}
        busy={deleting}
        confirmDisabled={!emailMatch}
        error={deleteError}
        width={380}
        onConfirm={handleDelete}
        onCancel={() => { setShowDeleteModal(false); setEmailInput(''); setDeleteError(null) }}
      >
        {/* THIS LIST IS A PROMISE AND MUST MATCH THE ROUTE, and the route
            moved: POST /auth/delete-account now takes the final payment for
            an outstanding reading tab before it deletes anything (Reader
            Terms 12.1), and refuses the deletion if that charge cannot be
            completed. So the first line is a charge the reader is about to
            authorise and belongs at the top, where a charge belongs.
            EARNINGS ARE STILL NOT PAID OUT — Writer Agreement 9.4/13.3 hold
            them — so that half of the old warning stands, on its own, where
            it is true. If either half of the route moves again, this list
            moves with it. */}
        <p className="text-black">{DELETE_CONSEQUENCES_INTRO}</p>
        <ul className="space-y-1 list-disc pl-5">
          {DELETE_CONSEQUENCES.map(item => <li key={item}>{item}</li>)}
        </ul>
        <p>
          {DELETE_EARNINGS_BEFORE}<strong className="text-black">{DELETE_EARNINGS_EMPHASIS}</strong>{DELETE_EARNINGS_AFTER}
        </p>
        <label className="label-ui text-grey-600 block pt-1">
          {DELETE_EMAIL_CONFIRM_LABEL}
          <input
            type="email"
            value={emailInput}
            onChange={e => setEmailInput(e.target.value)}
            placeholder={user.email}
            className="mt-2 w-full bg-glasshouse-well px-3 py-2 text-ui-sm normal-case tracking-normal font-sans text-black placeholder-grey-300 focus:outline-none"
          />
        </label>
      </ConfirmDialog>
    </>
  )
}
