'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  adminDashboard,
  type AdminWaitlist,
  type AdminWaitlistAdmitRow,
  type AdminInviteOutcome,
  type AdminWriterApplications,
  type AdminWriterApplicant,
  type AdminWriterGrantEmailed,
} from '../../../lib/api'
import { ApiError } from '../../../lib/api/client'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { ProfileLink } from '../../../components/ui/ProfileLink'

// =============================================================================
// Waitlist panel (CLOSED-BETA-ADR §XI.2, as split by RESHAPE-PLAN-2026-10 §A.2).
//
// The list was write-only from migration 162 until 2026-07-27, when a real
// prospect went unnoticed for eight hours because the only way to look was psql
// on the box. The digest says the count moved; this page says who — and is
// where they stop waiting.
//
// ADMITTING AND INVITING ARE TWO ACTS. *Admit selected* creates accounts and
// adds each new member to the default seed, and SENDS NOTHING; *Invite* sends
// the invitation. So a whole cohort is admitted first and told together, and
// each of them finds the others in their first feed — the seed is a snapshot
// taken at a member's first workspace load, so anyone admitted after that
// load is not in it. Both ask first, through the house `ConfirmDialog`. The
// cohort note is recorded on every seed append (the seed decides what every
// new account sees, so adding to it is an operator act with a reason).
//
// REMOVE IS THE OPPOSITE SHAPE AND ASKS ANYWAY. It touches nothing outside the
// building — no account, no email — but it destroys the row, and the address is
// only on this screen, so a mis-click loses the one copy of it. Offered only
// while a row is still waiting: past admission the row is the record of an
// account that exists.
//
// THE ROW SAYS WHAT HAPPENED, NOT JUST THAT SOMETHING DID. "Not yet invited"
// is now an ordinary state (a cohort waiting to be told), so it is grey; a
// send that FAILED is its own stamp and is the one in red, with the retry. A
// member admitted but NOT in the seed is said in grey, with *Add to seed*
// beside it (admitting an admitted row re-runs the append and nothing else):
// every member admitted before the append existed reads that way, so red
// would call the whole first cohort broken. An append that fails is reported
// in red by the admit press itself. "Not signed in yet" is said because until
// then other members' source lists do not name them.
//
// ABSOLUTE DATES, NOT "3d ago". An operator picking a cohort wants to know
// whether someone has been waiting since the launch post or since this morning.
//
// THE DOMAIN IS THE TRIAGE, AND IT IS ALREADY ON SCREEN. Nothing here filters
// or flags disposable-mail signups: auto-judging a domain is a policy decision
// with false positives that belongs to a person.
//
// TWO LISTS, BECAUSE THEY ARE TWO QUESTIONS. *Still waiting* is the work,
// *Already admitted* is the record (and, until they are told, the second half
// of the work).
//
// THE FILTER IS A TYPED SUBSTRING AND IT IS CLIENT-SIDE, over what was fetched;
// if the response was truncated the note under the list says so.
//
// WRITERS (READER-WRITER-SPLIT-ADR §8, O3) is the second section: members
// already inside who pressed "Apply to write". It loads on its own, so an
// outage in one list never blanks the other. Oldest first, no triage — the
// application carries nothing, so each row links to the profile the operator
// judges from. Granting needs a note, recorded in `config_audit`, and emails
// the member after the grant commits; a failed email is said in red, because
// the grant stands and the member does not know.
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

type Entry = AdminWaitlist['entries'][number]
type Busy = 'admit' | 'invite' | 'remove' | null

function refusalCode(err: unknown): string | null {
  return err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null
}

/** One admitted row's seed outcome, in the operator's words. */
function seedSentence(r: Extract<AdminWaitlistAdmitRow, { seed: unknown }>): string | null {
  switch (r.seed) {
    case 'appended':
      return 'added to the seed'
    case 'already_present':
      return 'already in the seed'
    case 'no_seed':
      return 'NOT added to the seed — nothing is designated'
    case 'seed_full':
      return 'NOT added to the seed — it is full (raise feed_formula_max_sources)'
    case 'error':
      return 'NOT added to the seed — the append failed. Press Add to seed to try again.'
  }
}

function admitSentence(r: AdminWaitlistAdmitRow): { text: string; warn: boolean } {
  switch (r.outcome) {
    case 'admitted':
    case 'already_admitted': {
      const who = r.username ? ` (@${r.username})` : ''
      const head =
        r.outcome === 'already_admitted'
          ? `${r.email}${who} was already admitted`
          : r.accountCreated
            ? `${r.email}${who}: account created`
            : `${r.email}${who}: existing account linked`
      return {
        text: `${head}, ${seedSentence(r)}.`,
        warn: r.seed === 'error' || r.seed === 'seed_full' || r.seed === 'no_seed',
      }
    }
    case 'not_on_list':
      return { text: `${r.email} is not on the list.`, warn: true }
    case 'removed_meanwhile':
      return {
        text: `${r.email} was removed before the admission landed. Nothing was created.`,
        warn: true,
      }
    case 'admit_in_progress':
      return {
        text: `${r.email} is part-way through being admitted. Another press may still be running, or an earlier one failed halfway. Please reload before trying again.`,
        warn: true,
      }
    case 'error':
      return { text: `Couldn’t admit ${r.email}. Nothing was created.`, warn: true }
  }
}

const INVITE_WORDS: Record<AdminInviteOutcome, string> = {
  invited: 'invited',
  send_failed: 'the invitation did not send — they have an account and have not been told',
  already_invited: 'already invited; nothing sent',
  not_admitted: 'not admitted yet; nothing sent',
  admit_in_progress: 'still being admitted; nothing sent',
  not_on_list: 'no longer on the list',
  error: 'couldn’t be invited',
}

function rowStatus(e: Entry): { text: string; warn: boolean } {
  if (!e.admittedAt) return { text: 'Waiting', warn: false }
  const parts: string[] = [e.username ? `@${e.username}` : 'account gone']
  let warn = false
  if (!e.invitedAt) {
    if (e.inviteFailedAt) {
      parts.push('invitation FAILED')
      warn = true
    } else {
      parts.push('not yet invited')
    }
  }
  // A fact, not an alarm: every member admitted before admission appended to
  // the seed (2026-09-30) reads this way, as does one whose append failed —
  // and that failure was already said in red when it happened. The action
  // beside it is the operator's choice either way.
  if (e.inSeed === false) parts.push('not in the seed')
  if (e.arrived === false) parts.push('not signed in yet')
  return { text: `Admitted · ${parts.join(' · ')}`, warn }
}

/**
 * One list of rows, used by both sections. Both lists are the same table
 * because they are the same rows — a second hand-built table would be the
 * point at which the two start disagreeing about how a state reads.
 */
function EntryTable({
  entries,
  busy,
  selected,
  onToggle,
  onToggleAll,
  onInvite,
  onReappend,
  onRemove,
}: {
  entries: Entry[]
  busy: Busy
  /** Present only on the waiting list, where rows are chosen for a batch. */
  selected?: Set<string>
  onToggle?: (email: string) => void
  onToggleAll?: (on: boolean) => void
  onInvite: (anchor: HTMLElement, email: string) => void
  onReappend: (anchor: HTMLElement, email: string) => void
  onRemove: (anchor: HTMLElement, email: string) => void
}) {
  const selectable = selected !== undefined
  const allOn = selectable && entries.length > 0 && entries.every((e) => selected.has(e.email))
  return (
    <div className="bg-glasshouse-well px-6 py-5 overflow-x-auto">
      <table className="w-full text-ui-xs">
        <thead>
          <tr className="border-b-2 border-grey-200">
            {selectable && (
              <th className="pb-2 pr-3 text-left w-6">
                <input
                  type="checkbox"
                  aria-label="Select every row shown"
                  checked={allOn}
                  onChange={(ev) => onToggleAll?.(ev.target.checked)}
                />
              </th>
            )}
            <th className="label-ui text-grey-600 text-left pb-2">Email</th>
            <th className="label-ui text-grey-600 text-right pb-2">Joined</th>
            <th className="label-ui text-grey-600 text-left pb-2 pl-6">Status</th>
            <th className="label-ui text-grey-600 text-right pb-2">Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const status = rowStatus(e)
            const canInvite = Boolean(e.admittedAt) && !e.invitedAt && e.username !== null
            return (
              <tr key={e.email} className="h-11">
                {selectable && (
                  <td className="py-2 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${e.email}`}
                      checked={selected.has(e.email)}
                      onChange={() => onToggle?.(e.email)}
                    />
                  </td>
                )}
                <td className="py-2 text-black break-all">{e.email}</td>
                <td className="py-2 text-right tabular-nums text-grey-600 whitespace-nowrap">
                  {joined(e.joinedAt)}
                </td>
                <td className={`py-2 pl-6 ${status.warn ? 'text-crimson' : 'text-grey-600'}`}>
                  {status.text}
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-4">
                    {/* Only while waiting: an admitted row has an account
                        behind it and the row is its record. */}
                    {!e.admittedAt && (
                      <button
                        type="button"
                        className="btn-text-danger"
                        disabled={busy !== null}
                        onClick={(ev) => onRemove(ev.currentTarget, e.email)}
                      >
                        Remove
                      </button>
                    )}
                    {e.inSeed === false && (
                      <button
                        type="button"
                        className="btn-text"
                        disabled={busy !== null}
                        onClick={(ev) => onReappend(ev.currentTarget, e.email)}
                      >
                        Add to seed
                      </button>
                    )}
                    {canInvite && (
                      <button
                        type="button"
                        className="btn-text"
                        disabled={busy !== null}
                        onClick={(ev) => onInvite(ev.currentTarget, e.email)}
                      >
                        {e.inviteFailedAt ? 'Retry invite' : 'Invite'}
                      </button>
                    )}
                    {e.admittedAt && !canInvite && e.inSeed !== false && (
                      <span className="text-grey-600">—</span>
                    )}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminWaitlistPage() {
  const [data, setData] = useState<AdminWaitlist | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [result, setResult] = useState<{ lines: string[]; warn: boolean } | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // The operator's note for the batch, recorded on every seed append.
  const [note, setNote] = useState('')
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.waitlist())
    } catch {
      setError('Couldn’t load the waiting list. Please reload the page to try again.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runAdmit(emails: string[]) {
    setBusy('admit')
    setResult(null)
    try {
      const r = await adminDashboard.admitWaitlisters(emails, note.trim())
      const lines = r.results.map((row) => admitSentence(row))
      setResult({
        lines: [
          `${r.admitted} admitted${r.skipped > 0 ? `, ${r.skipped} not` : ''} · ${r.seedAppended} added to the seed. Nobody has been emailed.`,
          ...lines.map((l) => l.text),
        ],
        warn: lines.some((l) => l.warn),
      })
      setSelected(new Set())
    } catch (err) {
      setResult({
        lines: [
          refusalCode(err) === 'validation_failed'
            ? 'The admission was refused — check the note is filled in.'
            : 'Couldn’t admit them. Please reload to see whether anyone was.',
        ],
        warn: true,
      })
    } finally {
      await load()
      setBusy(null)
    }
  }

  async function admitSelected(anchor: HTMLElement) {
    const emails = [...selected]
    const ok = await ask(anchor, {
      title: emails.length === 1 ? `Admit ${emails[0]}?` : `Admit ${emails.length} people?`,
      body: 'This creates their accounts and adds each to the default seed. Nobody is emailed — invite them when the cohort is ready. Neither step can be undone from here.',
      confirmLabel: 'Admit',
    })
    if (ok) await runAdmit(emails)
  }

  async function reappend(anchor: HTMLElement, email: string) {
    if (noteMissing) {
      setResult({
        lines: ['Write a cohort note first. It’s recorded with each member added to the seed.'],
        warn: false,
      })
      return
    }
    const ok = await ask(anchor, {
      title: `Add ${email} to the seed?`,
      body: "They are admitted but not in the default seed, so nobody seeded from here on will find them. This adds them, recorded with the note above. Members already seeded don't gain them.",
      confirmLabel: 'Add to seed',
    })
    if (ok) await runAdmit([email])
  }

  async function runInvite(body: { emails: string[] } | { allPending: true }) {
    setBusy('invite')
    setResult(null)
    try {
      const r = await adminDashboard.inviteWaitlisters(body)
      setResult({
        lines: [
          `${r.invited} invited${r.skipped > 0 ? `, ${r.skipped} not` : ''}.`,
          ...r.results.map((row) => `${row.email}: ${INVITE_WORDS[row.outcome]}.`),
        ],
        warn: r.results.some((row) => row.outcome !== 'invited'),
      })
    } catch {
      setResult({ lines: ['Couldn’t send the invitations. Please reload to see who was told.'], warn: true })
    } finally {
      await load()
      setBusy(null)
    }
  }

  async function inviteOne(anchor: HTMLElement, email: string) {
    const ok = await ask(anchor, {
      title: `Invite ${email}?`,
      body: "This emails them that we're ready for them. It cannot be unsent.",
      confirmLabel: 'Invite',
    })
    if (ok) await runInvite({ emails: [email] })
  }

  async function inviteAll(anchor: HTMLElement, n: number) {
    const ok = await ask(anchor, {
      title: `Invite ${n === 1 ? 'the one admitted member' : `all ${n} admitted members`} not yet told?`,
      body: "Each is emailed that we're ready for them. It cannot be unsent. Anyone already told is skipped.",
      confirmLabel: 'Invite all',
    })
    if (ok) await runInvite({ allPending: true })
  }

  async function remove(anchor: HTMLElement, email: string) {
    const ok = await ask(anchor, {
      title: `Remove ${email} from the waiting list?`,
      body: "Nothing is sent and no account is touched — the row is simply deleted. It is not a block: if they sign up again they'll be back on the list.",
      confirmLabel: 'Remove',
    })
    if (!ok) return

    setBusy('remove')
    setResult(null)
    try {
      await adminDashboard.removeWaitlister(email)
      setResult({ lines: [`${email} is off the list.`], warn: false })
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(email)
        return next
      })
    } catch (err: unknown) {
      const code = refusalCode(err)
      setResult({
        lines: [
          code === 'already_admitted'
            ? `${email} has already been admitted, so the row stays — it is the record of an account that exists.`
            : code === 'not_on_list'
              ? `${email} is no longer on the list. Nothing was removed.`
              : `Couldn’t remove ${email}. Nothing was changed.`,
        ],
        warn: true,
      })
    } finally {
      await load()
      setBusy(null)
    }
  }

  const waiting = data ? data.totals.total - data.totals.admitted : 0

  const trimmed = filter.trim()
  const needle = trimmed.toLowerCase()
  const visible = (data?.entries ?? []).filter(
    (e) => needle === '' || e.email.toLowerCase().includes(needle)
  )
  const stillWaiting = visible.filter((e) => !e.admittedAt)
  const admitted = visible.filter((e) => Boolean(e.admittedAt))
  // Counted over everything fetched, not the filter: "invite all" invites
  // every admitted row not yet told, whatever is typed in the box.
  const pendingInvite = (data?.entries ?? []).filter(
    (e) => e.admittedAt && !e.invitedAt && e.username !== null
  ).length
  const selectedCount = selected.size
  const noteMissing = note.trim() === ''

  return (
    <AdminShell title="Site owner">
      {dialog}
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
            <div className="bg-glasshouse-well px-4 py-3 mb-8 space-y-1">
              {result.lines.map((line, i) => (
                <p
                  key={i}
                  className={`text-ui-xs ${result.warn && i > 0 ? 'text-crimson' : 'text-black'}`}
                >
                  {line}
                </p>
              ))}
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
                  data.totals.inviteFailed > 0
                    ? `${data.totals.inviteFailed} of them: the invitation failed`
                    : data.totals.admittedNotInvited > 0
                      ? 'Admitted, not invited yet'
                      : undefined
                }
                warn={data.totals.inviteFailed > 0}
              />
              <StatCard
                label="Last digest"
                value={data.lastDigestAt ? joined(data.lastDigestAt) : 'Never'}
                detail={data.lastDigestAt ? undefined : 'No digest has gone out to the admins yet'}
                warn={!data.lastDigestAt && data.totals.total > 0}
              />
            </StatGrid>
          </StatSection>

          {/* The note sits above both lists because both use it: Admit selected
              below, and Add to seed on an admitted row. */}
          <label className="block mb-4">
            <span className="label-ui text-grey-600">Cohort note</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="e.g. October cohort — recorded with each member added to the seed"
              className="mt-1 w-full bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring"
            />
          </label>

          <div className="mb-4">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter addresses…"
              aria-label="Filter the waiting list"
              className="w-full bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring"
            />
          </div>

          <StatSection
            label="Still waiting"
            helper="Newest first. Tick the cohort, write a note, and admit: that creates their accounts and adds them to the default seed, and emails nobody. Invite them below when the cohort is ready."
          >
            {stillWaiting.length === 0 ? (
              <p className="text-ui-sm text-grey-600">
                {data.totals.total === 0
                  ? 'Nobody has joined yet.'
                  : trimmed
                    ? `Nobody waiting matches “${trimmed}”.`
                    : 'Nobody is waiting — everyone on the list has been admitted.'}
              </p>
            ) : (
              <>
                <EntryTable
                  entries={stillWaiting}
                  busy={busy}
                  selected={selected}
                  onToggle={(email) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(email)) next.delete(email)
                      else next.add(email)
                      return next
                    })
                  }
                  onToggleAll={(on) =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      for (const e of stillWaiting) {
                        if (on) next.add(e.email)
                        else next.delete(e.email)
                      }
                      return next
                    })
                  }
                  onInvite={inviteOne}
                  onReappend={reappend}
                  onRemove={remove}
                />
                <div className="mt-4">
                  <button
                    type="button"
                    className="btn mt-2 sm:mt-0"
                    disabled={busy !== null || selectedCount === 0 || noteMissing}
                    onClick={(ev) => void admitSelected(ev.currentTarget)}
                  >
                    {busy === 'admit'
                      ? 'Working…'
                      : `Admit selected${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
                  </button>
                </div>
                {selectedCount > 0 && noteMissing && (
                  <p className="text-ui-xs text-grey-600 mt-2">
                    Write a cohort note first. It&rsquo;s recorded with each member added to the seed.
                  </p>
                )}
              </>
            )}
          </StatSection>

          <StatSection
            label="Already admitted"
            helper="The record of accounts made from this list, and who has not been told yet. A row here is never removable — the account outlives anything this screen does."
          >
            {pendingInvite > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  className="btn-soft"
                  disabled={busy !== null}
                  onClick={(ev) => void inviteAll(ev.currentTarget, pendingInvite)}
                >
                  {busy === 'invite' ? 'Sending…' : `Invite all admitted, not yet told (${pendingInvite})`}
                </button>
              </div>
            )}
            {admitted.length === 0 ? (
              <p className="text-ui-sm text-grey-600">
                {trimmed && data.totals.admitted > 0
                  ? `Nobody admitted matches “${trimmed}”.`
                  : 'Nobody has been admitted yet.'}
              </p>
            ) : (
              <EntryTable
                entries={admitted}
                busy={busy}
                onInvite={inviteOne}
                onReappend={reappend}
                onRemove={remove}
              />
            )}
            {data.truncated && (
              <p className="text-ui-xs text-grey-600 mt-3">
                Both lists are drawn from the {data.shown} most recent of {data.totals.total},
                and the filter only reaches those. The rest are in the{' '}
                <span className="font-mono">waitlist</span> table.
              </p>
            )}
          </StatSection>

          <p className="text-ui-xs text-grey-600">
            Joining the list sends nothing by design — the first message anyone gets is the
            invitation. A member&rsquo;s first channel includes everyone admitted before they first sign
            in, and nobody admitted afterwards. Until someone signs in, other members&rsquo; channels
            carry them without naming them. Admitting someone who already has an account links
            the two rather than creating a second. Removing is not a block.
          </p>
        </>
      )}
      {/* Outside the waitlist's own load: an outage there must not hide this.
          mt-10 is the sections' own rhythm (StatSection's mb-10), which the
          waitlist's closing note above does not carry. */}
      <div className="mt-10">
        <WritersSection />
      </div>
    </AdminShell>
  )
}

// -----------------------------------------------------------------------------
// Writers — the writers' waiting list (READER-WRITER-SPLIT-ADR §8)
// -----------------------------------------------------------------------------

const EMAILED_WORDS: Record<AdminWriterGrantEmailed, { text: string; warn: boolean }> = {
  sent: { text: 'They have been emailed that they can publish.', warn: false },
  failed: {
    text: 'The email did NOT send — they can publish but have not been told. Tell them another way.',
    warn: true,
  },
  no_address: { text: 'Their account has no email address, so nobody was emailed.', warn: true },
}

function grantRefusal(code: string | null, who: string): string {
  switch (code) {
    case 'already_writer':
      return `${who} can already publish — nothing was recorded.`
    case 'no_application':
      return `${who} has no application. Nothing was changed.`
    case 'no_account':
      return `${who}'s account is gone. Nothing was changed.`
    case 'validation_failed':
      return 'The grant was refused — check the note is filled in.'
    default:
      return `Could not grant ${who} writer access. Nothing was changed.`
  }
}

function applicantName(a: AdminWriterApplicant): string {
  return a.username ? `@${a.username}` : (a.displayName ?? 'this member')
}

function WritersSection() {
  const [data, setData] = useState<AdminWriterApplications | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [result, setResult] = useState<{ lines: string[]; warn: boolean } | null>(null)
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.writerApplications())
      setError(false)
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const noteMissing = note.trim() === ''

  async function grant(anchor: HTMLElement, a: AdminWriterApplicant) {
    const who = applicantName(a)
    const ok = await ask(anchor, {
      title: `Admit ${who} as a writer?`,
      body: 'They will be able to publish articles and sell access to them, and are emailed that they can. It is recorded with the note above, and cannot be undone from here.',
      confirmLabel: 'Grant',
    })
    if (!ok) return
    setBusy(true)
    setResult(null)
    try {
      const r = await adminDashboard.grantWriterAccess(a.accountId, note.trim())
      const mail = EMAILED_WORDS[r.emailed]
      setResult({ lines: [`${who} is now a writer.`, mail.text], warn: mail.warn })
    } catch (err) {
      setResult({ lines: [grantRefusal(refusalCode(err), who)], warn: true })
    } finally {
      await load()
      setBusy(false)
    }
  }

  return (
    <StatSection
      label="Writers"
      helper="Members asking to write, oldest first. The application carries nothing else — open their profile to see what they have posted. Granting lets them publish articles and sell access, and emails them."
    >
      {dialog}
      {error && (
        <div className="bg-glasshouse-well px-4 py-3 mb-4 flex items-center gap-4">
          <p className="text-ui-xs text-crimson">Could not load the writer applications.</p>
          <button type="button" className="btn-text" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {!data && !error && <div className="h-24 animate-pulse bg-white" />}
      {data && (
        <>
          {result && (
            <div className="bg-glasshouse-well px-4 py-3 mb-4 space-y-1">
              {result.lines.map((line, i) => (
                <p
                  key={i}
                  className={`text-ui-xs ${result.warn && i > 0 ? 'text-crimson' : 'text-black'}`}
                >
                  {line}
                </p>
              ))}
            </div>
          )}

          <label className="block mb-4">
            <span className="label-ui text-grey-600">Grant note</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Why — recorded with each grant"
              className="mt-1 w-full bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring"
            />
          </label>

          {data.pending.length === 0 ? (
            <p className="text-ui-sm text-grey-600 mb-6">Nobody is asking to write.</p>
          ) : (
            <div className="bg-glasshouse-well px-6 py-5 overflow-x-auto mb-2">
              <table className="w-full text-ui-xs">
                <thead>
                  <tr className="border-b-2 border-grey-200">
                    <th className="label-ui text-grey-600 text-left pb-2">Member</th>
                    <th className="label-ui text-grey-600 text-right pb-2">Asked</th>
                    <th className="label-ui text-grey-600 text-right pb-2">Member since</th>
                    <th className="label-ui text-grey-600 text-right pb-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pending.map((a) => (
                    <tr key={a.accountId} className="h-11">
                      <td className="py-2 text-black break-all">
                        {a.username ? (
                          <ProfileLink href={`/${a.username}`} className="text-black">
                            {a.displayName ?? a.username}
                            <span className="text-grey-600"> @{a.username}</span>
                          </ProfileLink>
                        ) : (
                          (a.displayName ?? 'No handle')
                        )}
                        {a.status !== 'active' && (
                          <span className="text-crimson"> · {a.status}</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-grey-600 whitespace-nowrap">
                        {joined(a.appliedAt)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-grey-600 whitespace-nowrap">
                        {joined(a.memberSince)}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="btn-text"
                          disabled={busy || noteMissing}
                          onClick={(ev) => void grant(ev.currentTarget, a)}
                        >
                          {busy ? 'Working…' : 'Grant'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.pending.length > 0 && noteMissing && (
            <p className="text-ui-xs text-grey-600 mb-6">
              Write a grant note first — it is recorded with each grant.
            </p>
          )}
          {data.truncated && (
            <p className="text-ui-xs text-grey-600 mb-6">
              Showing the {data.pending.length} oldest of {data.totals.pending} waiting. The rest
              are in the <span className="font-mono">writer_applications</span> table.
            </p>
          )}

          {data.granted.length > 0 && (
            <>
              <p className="label-ui text-grey-600 mt-6 mb-2">
                Granted ({data.totals.granted}
                {data.totals.granted > data.granted.length ? `, latest ${data.granted.length}` : ''})
              </p>
              <div className="bg-glasshouse-well px-6 py-5 overflow-x-auto">
                <table className="w-full text-ui-xs">
                  <tbody>
                    {data.granted.map((g) => (
                      <tr key={g.accountId} className="h-11">
                        <td className="py-2 text-black break-all">{applicantName(g)}</td>
                        <td className="py-2 text-right tabular-nums text-grey-600 whitespace-nowrap">
                          granted {joined(g.grantedAt)}
                          {g.grantedBy ? ` by @${g.grantedBy}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </StatSection>
  )
}
