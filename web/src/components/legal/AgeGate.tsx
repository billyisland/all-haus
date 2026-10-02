'use client'

import { useState } from 'react'
import { auth } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { useAuth } from '../../stores/auth'
import { PublicShell } from '../public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../public/PublicVessel'
import {
  DateOfBirthField,
  PublicButton,
  PublicLink,
  FormError,
} from '../public/Field'
import {
  AGE_TITLE,
  AGE_INTRO,
  AGE_SUBMIT,
  AGE_DECLINE,
  AGE_SAVE_FAILED,
  LINK_SIGN_OUT,
} from '../../content/auth'

// =============================================================================
// The age declaration — the half of signup that two kinds of member missed
//
// L6.1, decision A1. `/auth/signup` asks for a date of birth in its own form.
// Two populations that form cannot reach:
//
//   · somebody who arrived through Google. The provisioner is handed an email
//     and a name by Google and has nowhere to put a question; they are asked
//     on their first landing after the callback.
//   · everybody who was already a member when this shipped, asked once.
//
// ONE SURFACE FOR BOTH, because from here they are the same member: the gate
// is `ageDeclaredAt === null` and nothing else. The web could not tell the two
// apart if it wanted to — "provisioned by Google four seconds ago" and "member
// since 2024" are the same NULL — and it has no reason to.
//
// GATED ON THE MEMBER, NEVER ON A DEVICE KEY. `accounts.age_declared_at` is
// the flag, exactly as `onboarded_at` is for the first-session tour and for
// the same reason (feeds.md): a `localStorage` key asks the same person again
// on every browser, and answers "already asked" on a browser where they have
// never been.
//
// IT BLOCKS, AND THAT IS THE POINT. This is not a nudge that can be dismissed
// into next week — a legal requirement a member can close is not a
// requirement, and a member who closed it would carry NULL for ever, which is
// the state this exists to end. So there is no ✕ and no "later". The overlay
// rule that every floating surface dismisses via a floating ✕ is a rule about
// surfaces the member OPENED; this one they did not, and giving it a ✕ would
// be offering a way out of the one question that has to be answered.
//
// WHICH IS WHY SIGNING OUT IS ON IT. A blocking surface with no exit at all is
// a trap, and the honest exit from a question you do not want to answer is to
// leave. It is the same act as the bar's own sign-out, not a second kind.
//
// IT WEARS THE PUBLIC REGISTER because it is the missing page of signup, and
// `PublicShell` is the register's fitted chassis — one chassis, not a second
// one built here. It covers the ∀, which the stacking table's own rule says
// never to dim; the exception is stated there beside the layer, because the
// mark is the nav affordance and this is the one surface that deliberately
// removes navigation.
//
// A REFUSAL IS THE SERVER'S SENTENCE, not a second copy of the rule. The web
// does not compute anybody's age: `shared/src/lib/age.ts` is the one home, the
// route parses with it, and this renders what comes back. A client-side copy
// would be a second rule to keep in step, and the one that drifts is always
// the one nobody is testing.
// =============================================================================

export function AgeGate() {
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  const fetchMe = useAuth((s) => s.fetchMe)
  const logout = useAuth((s) => s.logout)

  const [dateOfBirth, setDateOfBirth] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Nothing while auth is still resolving: a gate that flashes over a page
  // before the answer arrives is worse than one that appears a beat late.
  if (loading || !user || user.ageDeclaredAt !== null) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await auth.declareAge(dateOfBirth)
      // Re-read rather than patching the store: the server decides whether the
      // declaration was recorded, and `ageDeclaredAt` coming back non-null is
      // what closes this gate. Patching it locally would close the gate on a
      // write we only assume happened.
      await fetchMe()
    } catch (err) {
      setError(
        apiErrorMessage(err) ??
          AGE_SAVE_FAILED,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      // z-80 — above the lightbox, the topmost layer on the site. See the
      // stacking table in `.claude/rules/web-workspace.md`.
      className="fixed inset-0 z-[80]"
      role="dialog"
      aria-modal="true"
      aria-label="Age declaration"
    >
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>{AGE_TITLE}</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                {AGE_INTRO}
              </PublicBody>
            </div>
          </PublicCard>

          {error && <FormError>{error}</FormError>}

          <PublicCard>
            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
            >
              <DateOfBirthField
                idPrefix="age-gate-dob"
                required
                onChange={setDateOfBirth}
              />
              <PublicButton type="submit" full disabled={saving || !dateOfBirth}>
                {saving ? 'Saving…' : AGE_SUBMIT}
              </PublicButton>
            </form>
          </PublicCard>

          <PublicCard>
            <PublicBody>
              {AGE_DECLINE}{' '}
              <PublicLink
                onClick={() => {
                  void logout()
                }}
              >
                {LINK_SIGN_OUT}
              </PublicLink>
              .
            </PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    </div>
  )
}
