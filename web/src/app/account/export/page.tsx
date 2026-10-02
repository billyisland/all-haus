'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
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
import {
  EXPORT_WORKING_TITLE,
  EXPORT_WORKING_BODY,
  EXPORT_DONE_TITLE,
  EXPORT_DONE_KEY_WARNING,
  EXPORT_DONE_EMAILED,
  EXPORT_SIGNED_OUT_TITLE,
  EXPORT_SIGNED_OUT_BODY,
  EXPORT_SIGN_IN,
  EXPORT_USED_TITLE,
  EXPORT_USED_BODY,
  EXPORT_BACK_TO_SETTINGS,
  EXPORT_ERROR_TITLE,
  EXPORT_ERROR_BODY,
  EXPORT_LIMITED_TITLE,
  EXPORT_LIMITED_BODY,
} from '../../../content/account-export'

// =============================================================================
// Account export confirmation — /account/export?token=<token>
//
// The far end of the step-up (MIRROR-AUDIT §2.6). The bundle carries the root
// Nostr secret key, which IS the member's identity and cannot be rotated, so it
// no longer ships on the session cookie alone: the member asks, we mail a
// one-use link, and this page spends it.
//
// TWO CREDENTIALS, BOTH REQUIRED, AND THE FAILURES SAY WHICH IS MISSING. The
// gateway wants the session AND the token, so a link opened on a device that is
// not signed in gets a 401 — which is a permissions state, not an outage and
// not a broken link, and the copy has to say so or the member concludes the
// email was bad and asks for another one that will fail exactly the same way.
//
// The confirmation is never a refusal: the export is MANDATED (the custodial
// identity is the member's, and NETWORK-CONCIERGE-ADR §4 makes handing it back
// a duty). Everything here is about making the act deliberate and dated, never
// about standing between a member and their own key.
//
// It runs ONCE — `called` — because the token is single-use and a re-run in
// React's development double-invoke would spend it against a request whose
// result is thrown away, leaving the member holding a link the server has
// already consumed.
// =============================================================================

type Status = 'working' | 'done' | 'signed-out' | 'expired' | 'limited' | 'error'

function AccountExportPageBody() {
  const searchParams = useSearchParams()
  const called = useRef(false)
  const [status, setStatus] = useState<Status>('working')

  useEffect(() => {
    if (called.current) return
    called.current = true

    const token = searchParams.get('token')
    if (!token) {
      setStatus('expired')
      return
    }

    async function run(t: string) {
      try {
        const res = await fetch(
          `/api/v1/account/export?token=${encodeURIComponent(t)}`,
          { credentials: 'include' },
        )
        if (res.status === 401) {
          setStatus('signed-out')
          return
        }
        if (res.status === 403) {
          setStatus('expired')
          return
        }
        if (res.status === 429) {
          setStatus('limited')
          return
        }
        if (!res.ok) {
          setStatus('error')
          return
        }

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'platform-account-export.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        setStatus('done')
      } catch {
        setStatus('error')
      }
    }

    void run(token)
  }, [searchParams])

  return (
    <PublicShell>
      <PublicVessel>
        {status === 'working' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_WORKING_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_WORKING_BODY}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard style={{ padding: 0 }}>
              <IndeterminateSlab />
            </PublicCard>
          </>
        )}

        {status === 'done' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_DONE_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_DONE_KEY_WARNING}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicBody>{EXPORT_DONE_EMAILED}</PublicBody>
            </PublicCard>
          </>
        )}

        {status === 'signed-out' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_SIGNED_OUT_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_SIGNED_OUT_BODY}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/auth?mode=login">
                {EXPORT_SIGN_IN}
              </PublicButton>
            </PublicCard>
          </>
        )}

        {status === 'expired' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_USED_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_USED_BODY}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/reader?overlay=settings">
                {EXPORT_BACK_TO_SETTINGS}
              </PublicButton>
            </PublicCard>
          </>
        )}

        {status === 'limited' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_LIMITED_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_LIMITED_BODY}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/reader?overlay=settings">
                {EXPORT_BACK_TO_SETTINGS}
              </PublicButton>
            </PublicCard>
          </>
        )}

        {status === 'error' && (
          <>
            <PublicCard>
              <PublicTitle>{EXPORT_ERROR_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{EXPORT_ERROR_BODY}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/reader?overlay=settings">
                {EXPORT_BACK_TO_SETTINGS}
              </PublicButton>
            </PublicCard>
          </>
        )}
      </PublicVessel>
    </PublicShell>
  )
}

// useSearchParams() bails this subtree out to client rendering; the boundary
// keeps that bail-out to the page instead of the whole route (CA-F13).
export default function AccountExportPage() {
  return (
    <Suspense fallback={null}>
      <AccountExportPageBody />
    </Suspense>
  )
}
