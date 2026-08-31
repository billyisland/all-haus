'use client'

import { useCallback, useEffect, useState } from 'react'
import { adminDashboard, type AdminWaitlist } from '../../../lib/api'
import { ApiError } from '../../../lib/api/client'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

// =============================================================================
// Waitlist panel (CLOSED-BETA-ADR §XI.2).
//
// The list was write-only from migration 162 until 2026-07-27, when a real
// prospect went unnoticed for eight hours because the only way to look was psql
// on the box. The digest says the count moved; this page says who — and, since
// the admit action landed, is where they stop waiting.
//
// ADMIT IS ONE CLICK AND TWO CONSEQUENCES: it creates a stranger an account and
// emails them. Both are visible from outside the building and neither is
// undoable from this screen, so it asks first. That is what window.confirm is
// for here, matching the manual triggers on the overview tab.
//
// REMOVE IS THE OPPOSITE SHAPE AND ASKS ANYWAY. It touches nothing outside the
// building — no account, no email — but it destroys the row, and the address is
// only on this screen, so a mis-click loses the one copy of it. The confirm
// therefore spends its words on the two things that aren't obvious: nothing is
// sent, and removal is not a block — a second signup puts them back on the
// list. Offered only while a row is still waiting: past admission the row is
// the record of an account that exists, and deleting it would leave a member
// with no trace of where they came from while this page swore nobody was ever
// admitted.
//
// THE ROW SAYS WHAT HAPPENED, NOT JUST THAT SOMETHING DID. "Admitted" and
// "told" are separate stamps because the email is sent after the account exists
// and can fail on its own — so a row can honestly read "admitted · not emailed"
// and offer the retry, rather than claiming a success nobody received.
//
// ABSOLUTE DATES, NOT "3d ago". An operator picking a cohort wants to know
// whether someone has been waiting since the launch post or since this morning,
// and a relative stamp makes that arithmetic the reader's job.
//
// THE DOMAIN IS THE TRIAGE, AND IT IS ALREADY ON SCREEN. Disposable-mail
// signups will happen (one of the first three real rows was one). Nothing here
// filters or flags them: the address is right there to read, and auto-judging a
// domain is a policy decision with false positives that belongs to a person.
// =============================================================================

/** `27 Jul 2026, 08:55` — the same absolute stamp the digest email uses. */
function joined(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AdminWaitlistPage() {
  const [data, setData] = useState<AdminWaitlist | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One busy key for both actions: a row shows at most one of them working, and
  // the label needs to know WHICH so a Remove click can't read as an admission.
  const [busy, setBusy] = useState<{ email: string; action: 'admit' | 'remove' } | null>(null)
  const [result, setResult] = useState<{ text: string; warn: boolean } | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.waitlist())
    } catch {
      setError('Failed to load the waiting list.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function admit(email: string, resend: boolean) {
    const prompt = resend
      ? `Send the invitation to ${email} again? They already have an account.`
      : `Admit ${email}? This creates their account and emails them that we're ready for them.`
    if (!window.confirm(prompt)) return

    setBusy({ email, action: 'admit' })
    setResult(null)
    try {
      const r = await adminDashboard.admitWaitlister(email)
      const who = r.username ? ` (@${r.username})` : ''
      if (!r.invited) {
        // The half-failure worth spelling out: they ARE a member, they just
        // don't know it. The row will offer the retry.
        setResult({
          text: `${email}${who} is admitted, but the invitation did not send. They have an account and have not been told — try sending it again.`,
          warn: true,
        })
      } else if (r.accountCreated) {
        setResult({ text: `${email}${who} is in — account created and invited.`, warn: false })
      } else {
        setResult({
          text: `${email}${who} already had an account — linked and invited.`,
          warn: false,
        })
      }
      await load()
    } catch (err: unknown) {
      const code: string | null =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null
      setResult({
        text:
          code === 'already_admitted'
            ? `${email} has already been admitted and invited. Nothing was sent.`
            : code === 'removed_meanwhile'
              ? `${email} was removed from the list before the admission landed. No account was created and nothing was sent.`
              : code === 'admit_in_progress'
              ? `${email} is part-way through being admitted — either another click is still running, or one failed and left the row half-done. Reload before trying again.`
              : code === 'not_on_list'
                ? `${email} is not on the list.`
                : `Could not admit ${email}. Nothing was created.`,
        warn: true,
      })
      // Re-read either way: a 409 means someone else's click landed, and the
      // screen should show that rather than the state it was refused against.
      await load()
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Remove — the row goes, and nothing else does.
  //
  // Every refusal here is the route telling us the screen is out of date: the
  // row was admitted, or somebody already removed it. So each one re-reads,
  // rather than leaving the operator looking at the state their click was
  // refused against.
  // ---------------------------------------------------------------------------
  async function remove(email: string) {
    if (
      !window.confirm(
        `Remove ${email} from the waiting list? Nothing is sent and no account is touched — the row is simply deleted. It is not a block: if they sign up again they'll be back on the list.`
      )
    )
      return

    setBusy({ email, action: 'remove' })
    setResult(null)
    try {
      await adminDashboard.removeWaitlister(email)
      setResult({ text: `${email} is off the list.`, warn: false })
      await load()
    } catch (err: unknown) {
      const code: string | null =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null
      setResult({
        text:
          code === 'already_admitted'
            ? `${email} has already been admitted, so the row stays — it is the record of an account that exists. Removing the person means deleting that account, which is not done here.`
            : code === 'not_on_list'
              ? `${email} is no longer on the list. Nothing was removed.`
              : `Could not remove ${email}. Nothing was changed.`,
        warn: true,
      })
      await load()
    } finally {
      setBusy(null)
    }
  }

  const waiting = data ? data.totals.total - data.totals.admitted : 0

  return (
    <AdminShell title="Site owner">
      {error && (
        <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>
      )}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          {result && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className={`text-ui-xs ${result.warn ? 'text-crimson' : 'text-black'}`}>
                {result.text}
              </p>
            </div>
          )}

          <StatSection label="The waiting list">
            <StatGrid>
              <StatCard label="Still waiting" value={waiting} />
              <StatCard label="Admitted" value={data.totals.admitted} />
              <StatCard label="Joined, 7 days" value={data.totals.joinedLast7d} />
              <StatCard
                label="Not yet told"
                value={data.totals.admittedNotInvited}
                detail={
                  data.totals.admittedNotInvited > 0
                    ? 'Admitted, invitation never sent'
                    : undefined
                }
                warn={data.totals.admittedNotInvited > 0}
              />
              <StatCard
                label="Last digest"
                value={data.lastDigestAt ? joined(data.lastDigestAt) : 'Never'}
                detail={data.lastDigestAt ? undefined : 'Nobody has been told yet'}
                warn={!data.lastDigestAt && data.totals.total > 0}
              />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Everyone waiting"
            helper="Newest first. Admitting creates their account and emails them; removing deletes the row and sends nothing. Both ask first."
          >
            {data.totals.total === 0 ? (
              <p className="text-ui-sm text-grey-600">Nobody has joined yet.</p>
            ) : (
              <div className="bg-glasshouse-well px-6 py-5">
                <table className="w-full text-ui-xs">
                  <thead>
                    <tr className="border-b-2 border-grey-200">
                      <th className="label-ui text-grey-600 text-left pb-2">Email</th>
                      <th className="label-ui text-grey-600 text-right pb-2">Joined</th>
                      <th className="label-ui text-grey-600 text-left pb-2 pl-6">Status</th>
                      <th className="label-ui text-grey-600 text-right pb-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => {
                      const working = busy?.email === e.email ? busy.action : null
                      const untold = Boolean(e.admittedAt) && !e.invitedAt
                      return (
                        <tr key={e.email}>
                          <td className="py-2 text-black">{e.email}</td>
                          <td className="py-2 text-right tabular-nums text-grey-600">
                            {joined(e.joinedAt)}
                          </td>
                          <td className={`py-2 pl-6 ${untold ? 'text-crimson' : 'text-grey-600'}`}>
                            {!e.admittedAt
                              ? 'Waiting'
                              : untold
                                ? 'Admitted · not emailed'
                                : `Admitted${e.username ? ` · @${e.username}` : ''}`}
                          </td>
                          <td className="py-2 text-right">
                            {e.admittedAt && e.invitedAt ? (
                              <span className="text-grey-600">—</span>
                            ) : (
                              <span className="inline-flex items-center gap-4">
                                <button
                                  type="button"
                                  className="btn-text"
                                  disabled={working !== null}
                                  onClick={() => void admit(e.email, untold)}
                                >
                                  {working === 'admit'
                                    ? 'Working…'
                                    : untold
                                      ? 'Send invite'
                                      : 'Admit'}
                                </button>
                                {/* Only while they are still waiting. An
                                    admitted row has an account behind it and
                                    the row is its record, so there is nothing
                                    here to drop — the retry is the only action
                                    left on it. */}
                                {!e.admittedAt && (
                                  <button
                                    type="button"
                                    className="btn-text-danger"
                                    disabled={working !== null}
                                    onClick={() => void remove(e.email)}
                                  >
                                    {working === 'remove' ? 'Removing…' : 'Remove'}
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {data.truncated && (
              <p className="text-ui-xs text-grey-600 mt-3">
                Showing the {data.shown} most recent of {data.totals.total}. The rest are in
                the <span className="font-mono">waitlist</span> table.
              </p>
            )}
          </StatSection>

          <p className="text-ui-xs text-grey-600">
            Joining the list still sends nothing by design — the first message anyone gets is
            the invitation, and it goes when you admit them. Admitting someone who already has
            an account links the two rather than creating a second. Removing is not a block:
            it deletes what we know about the address today, and a fresh signup puts it back
            on the list.
          </p>
        </>
      )}
    </AdminShell>
  )
}
