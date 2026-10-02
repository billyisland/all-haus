'use client'

import { useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { auth } from '../../../lib/api'
import { failureSentence } from '../../../lib/api/client'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  PublicButton,
  IndeterminateSlab,
} from '../../../components/public/Field'

// =============================================================================
// Undo an email change — /auth/undo-email-change?change=<id>&token=<token>
//
// The link arrives at the address a change REPLACED (gateway
// `POST /auth/verify-email-change` mails it). This page ASKS and the button
// acts: a mail scanner opens every link in a message it screens, and this one
// signs out every device, so a GET that acted would undo genuine changes
// nobody pressed (.claude/rules/security.md › a link in an email is pressed by
// a machine).
//
// No session is needed or used. The holder is the member a stolen session has
// just locked out, and both the change and its undo sign every device out, so
// success sends them to log in with the address they got back.
// =============================================================================

function UndoBody() {
  const params = useSearchParams()
  const change = params.get('change')
  const token = params.get('token')
  const [status, setStatus] = useState<'asking' | 'working' | 'done' | 'error'>('asking')
  const [errorMessage, setErrorMessage] = useState('')

  async function undo() {
    if (!change || !token) return
    setStatus('working')
    try {
      await auth.undoEmailChange(change, token)
      setStatus('done')
    } catch (err) {
      setErrorMessage(
        failureSentence(err, "We couldn't undo the change just now, and nothing has been altered. Please try the link again in a moment."),
      )
      setStatus('error')
    }
  }

  if (!change || !token) {
    return (
      <PublicCard>
        <PublicTitle>This link is incomplete</PublicTitle>
        <div style={{ marginTop: 10 }}>
          <PublicBody>Part of it seems to have gone missing on the way. Please open it again from the email, or copy the whole address across.</PublicBody>
        </div>
      </PublicCard>
    )
  }

  if (status === 'done') {
    return (
      <>
        <PublicCard>
          <PublicTitle>Your address is back</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              Every device has been logged out, including whoever made the change. Log in again with this address. Then write to us, so we can look at what else was done while you were out.
            </PublicBody>
          </div>
        </PublicCard>
        <PublicCard>
          <PublicButton full href="/auth?mode=login">
            Log in
          </PublicButton>
        </PublicCard>
      </>
    )
  }

  return (
    <>
      <PublicCard>
        <PublicTitle>Undo the email change?</PublicTitle>
        <div style={{ marginTop: 10 }}>
          <PublicBody>
            {status === 'error'
              ? errorMessage
              : 'This puts back the address this email was sent to and logs out every device, yours included. Only do it if you did not make the change.'}
          </PublicBody>
        </div>
      </PublicCard>
      {status === 'working' ? (
        <PublicCard style={{ padding: 0 }}>
          <IndeterminateSlab />
        </PublicCard>
      ) : (
        <PublicCard>
          <PublicButton full onClick={() => void undo()}>
            Undo the change
          </PublicButton>
        </PublicCard>
      )}
    </>
  )
}

export default function UndoEmailChangePage() {
  return (
    <PublicShell>
      <PublicVessel>
        <Suspense fallback={null}>
          <UndoBody />
        </Suspense>
      </PublicVessel>
    </PublicShell>
  )
}
