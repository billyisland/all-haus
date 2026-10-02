'use client'

import { useEffect, useState } from 'react'
import { PublicShell } from '../../../components/public/PublicShell'
import { request, ApiError } from '../../../lib/api/client'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  TextAreaField,
  PublicButton,
  FormError,
} from '../../../components/public/Field'
import {
  APPEAL_FILED_TITLE,
  APPEAL_FILED_BODY,
  APPEAL_INCOMPLETE_TITLE,
  APPEAL_INCOMPLETE_BODY,
  APPEAL_FORM_TITLE,
  APPEAL_FORM_BODY,
  APPEAL_FIELD_LABEL,
  APPEAL_PLACEHOLDER,
  APPEAL_SUBMIT,
  APPEAL_SENDING,
  APPEAL_UNUSABLE,
  APPEAL_ERROR,
} from '../../../content/appeal'

// =============================================================================
// The appeal (D7 §5; D5 §9; L6.4)
//
// WHY THIS IS A LOGGED-OUT PAGE, which is the whole design and not a shortcut.
// `requireAuth` answers 403 to any account whose status is not 'active', so a
// suspended or terminated member cannot reach a single authenticated surface on
// this platform. Every one of the three actions that carries an appeal —
// removal, suspension, termination — either locks them out or is one step from
// it. An appeal behind a session would therefore have been a right that existed
// only for the members it did not apply to.
//
// So the credential is the single-use token in the notice email, which is the
// one channel that survives a suspension, and this page is in the public
// register with everything else a logged-out person can reach.
//
// IT NEVER SAYS WHAT IT IS ABOUT, and that is deliberate. The URL carries a
// report id and the page is reachable by anyone who has one, so a page that
// rendered the decision, the content or the member's name would be an oracle
// over who has been moderated — readable by anyone who guesses, or by anyone
// looking over a shoulder. The member already knows what this is: they are
// holding the email that says so. The page's job is to take their words.
//
// THE REFUSAL IS UNINFORMATIVE FOR THE SAME REASON. A spent token, an expired
// window, a second appeal and a report that does not exist all come back as one
// sentence — the gateway answers them alike, and the page must not undo that by
// guessing at which one it was.
// =============================================================================

export default function AppealPage({ params }: { params: { reportId: string } }) {
  const [token, setToken] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filed, setFiled] = useState(false)

  // Read from `location` rather than `useSearchParams`, so the page needs no
  // Suspense boundary — the same call the waitlist page makes for the same
  // reason.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setToken(params.get('token'))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token || text.trim() === '') return
    setLoading(true)
    setError(null)
    try {
      await request(`/moderation/appeal/${encodeURIComponent(params.reportId)}`, {
        method: 'POST',
        body: JSON.stringify({ token, text: text.trim() }),
      })
      setFiled(true)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? APPEAL_UNUSABLE : APPEAL_ERROR)
    } finally {
      setLoading(false)
    }
  }

  if (filed) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>{APPEAL_FILED_TITLE}</PublicTitle>
          </PublicCard>
          <PublicCard>
            <PublicBody>{APPEAL_FILED_BODY}</PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  // No token in the address means somebody reached this page without the link
  // — a bookmark, a truncated email, a forward. Say so plainly rather than
  // rendering a form that cannot be sent.
  if (token === null) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>{APPEAL_INCOMPLETE_TITLE}</PublicTitle>
          </PublicCard>
          <PublicCard>
            <PublicBody>{APPEAL_INCOMPLETE_BODY}</PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>{APPEAL_FORM_TITLE}</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>{APPEAL_FORM_BODY}</PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          <form
            onSubmit={submit}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            <TextAreaField
              id="appeal"
              label={APPEAL_FIELD_LABEL}
              value={text}
              onChange={setText}
              required
              rows={8}
              maxLength={4000}
              placeholder={APPEAL_PLACEHOLDER}
            />
            <PublicButton type="submit" full disabled={loading || text.trim() === ''}>
              {loading ? APPEAL_SENDING : APPEAL_SUBMIT}
            </PublicButton>
          </form>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
