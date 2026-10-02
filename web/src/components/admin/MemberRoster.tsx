'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adminDashboard,
  OPERATOR_HALT_CLASSES,
  type AdminMembers,
  type AdminMemberStatus,
} from '../../lib/api'
import { ApiError } from '../../lib/api/client'
import { StatSection } from './Stat'

// =============================================================================
// The member roster — who is actually here, and the two things the operator
// can do about it.
//
// The Users tab was aggregates from the day it shipped: it could say four
// accounts were suspended and nothing whatever about which four. Its own
// closing line admitted the gap ("a standalone account search is a follow-on"),
// and the gap had a sharper edge than a missing screen — `POST
// /admin/suspend/:accountId` takes an account UUID, and no surface in the
// dashboard has ever rendered one, so suspending somebody the operator found
// herself meant psql on the box.
//
// SEARCH IS TYPED, NEVER INFERRED. The box matches a literal substring of the
// address, handle or display name and does nothing else — no scoring, no
// "looks like a test account" flag. Same rule the waitlist panel is built on
// (CLOSED-BETA-ADR §XI.2, triage not policy): a judgement about a person
// belongs to a person reading a screen.
//
// SUSPEND SAYS WHAT IT DESTROYS, AND REINSTATE SAYS WHAT IT DOES NOT BRING
// BACK. Suspension publishes a kind-5 tombstone for every event the account
// ever signed — that is a statement to other relays and it has left the
// building. Reinstating flips a status and nothing more: they can sign in,
// read and post again, and what they wrote before is gone. Both confirms spend
// their words on that asymmetry rather than on "are you sure", because it is
// the only part a careful operator cannot infer from the button.
//
// THE COUNTS ON THE FILTERS ARE COMPUTED FROM THE SEARCH ALONE, so switching
// between Active and Suspended does not rewrite the numbers on the two buttons
// you are switching between.
//
// AND THERE IS A THIRD ACT NOW, WHICH IS NOT A MODERATION ONE (L8.6 residual,
// D9 §4.1). Freezing a member's payouts stops every cycle paying them and does
// nothing else — no email, nothing removed, sign-in unchanged. It is here for
// the same reason suspension is: the capability existed and was reachable only
// from psql, and D9 §4.1 shipped with the INSERT statement written out in it.
// It is deliberately NOT spelled like its neighbours — its confirm says it
// tells them nothing, and the warning says a suspension is the wrong tool for
// a payment question, because the one failure this adjacency could cause is an
// operator reaching for the loud instrument in a hurry.
// =============================================================================

type Filter = AdminMemberStatus | 'all'

/**
 * THE THREE ACTS THIS TABLE CAN TAKE, AND THEY ARE NOT NEIGHBOURS BY ACCIDENT.
 *
 * `suspend`/`reinstate` write `accounts.status` through moderation's one home:
 * loud by design — the member's published work comes down, they are emailed the
 * reason and offered an appeal (D7 §5).
 *
 * `freeze` writes a `payouts_halted_accounts` row and nothing else: their
 * outbound payouts stop and they are told NOTHING. That silence is the whole
 * point of it (D9 §4.1 — a suspected sanctions match, frozen while OFSI is
 * asked) and it is why suspension is the wrong instrument for a payment
 * question, which the warning beneath the table says in as many words.
 *
 * There is no `unfreeze` here. A halt is released on the Overview tab, where
 * the class, the reason and the age are rendered beside it — this table would
 * offer the release with none of that, and the row an operator is most likely
 * to clear by mistake is one the RECONCILER wrote about books that do not
 * balance.
 */
type RosterAction = 'suspend' | 'reinstate' | 'freeze'

/**
 * `label` is the chip; `empty` is what the list says when that filter found
 * nothing; `noun` names the group inside a "nobody <noun> matches …" line.
 * All three are written out rather than derived from the label, because
 * "Nobody is closed by them." is what deriving them produces.
 */
const FILTERS: ReadonlyArray<{
  key: Filter
  label: string
  empty: string
  noun: string
}> = [
  { key: 'all', label: 'Everyone', empty: 'Nobody here yet.', noun: '' },
  { key: 'active', label: 'Active', empty: 'Nobody is active.', noun: 'active' },
  {
    key: 'suspended',
    label: 'Suspended',
    empty: 'Nobody is suspended.',
    noun: 'suspended',
  },
  {
    key: 'moderated',
    label: 'Moderated',
    empty: 'Nobody is moderated.',
    noun: 'moderated',
  },
  {
    key: 'deactivated',
    label: 'Closed',
    empty: 'Nobody has closed their account.',
    noun: 'who closed their account',
  },
  {
    key: 'deleted',
    label: 'Deleted',
    empty: 'Nothing has been deleted.',
    noun: 'deleted',
  },
]

/** `27 Jul 2026` — absolute, like every other date on the dashboard. */
function joined(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** What the status word says, and whether it is a warning. */
const STATUS_COPY: Record<AdminMemberStatus, { text: string; warn: boolean }> = {
  active: { text: 'Active', warn: false },
  suspended: { text: 'Suspended', warn: true },
  moderated: { text: 'Moderated', warn: true },
  // The member's own choice, not ours — never rendered as a fault.
  deactivated: { text: 'Closed by them', warn: false },
  deleted: { text: 'Deleted', warn: false },
}

/**
 * What kind of member this is, said in the facts we hold rather than in a label
 * we invented: there is no is_writer column and there should not be one. Empty
 * when we hold none of them, which the cell renders as a dash — unless the
 * freeze line below it has something to say.
 */
function signals(m: AdminMembers['members'][number]): string {
  return [
    m.articlesPublished > 0 ? `${m.articlesPublished} published` : null,
    m.hasCard ? 'card' : null,
    m.connectKycComplete ? 'payable' : m.connectStarted ? 'connect incomplete' : null,
    m.onboardedAt ? null : 'never arrived',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How the list came to be empty, said in whichever narrowing did it. */
function emptyBecause(needle: string, filter: Filter): string {
  const f = FILTERS.find((x) => x.key === filter)!
  if (needle) return `Nobody ${f.noun ? `${f.noun} ` : ''}matches “${needle}”.`
  return f.empty
}

export function MemberRoster() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [data, setData] = useState<AdminMembers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ id: string; action: RosterAction } | null>(null)
  // Which row is armed, and what the operator has typed (L5.5b). One at a time:
  // a reason belongs to one decision about one person, and two open fields
  // would let the wrong one be sent.
  const [armed, setArmed] = useState<{ id: string; action: RosterAction } | null>(null)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<{ text: string; warn: boolean } | null>(null)

  // The search the last completed fetch was for. A slow response for an
  // abandoned search must not land on top of a newer one — without this, typing
  // "test" and deleting it can leave the screen showing the results for "tes".
  const latest = useRef(0)

  const load = useCallback(async (q: string, status: Filter) => {
    const ticket = ++latest.current
    try {
      const next = await adminDashboard.members({
        q: q.trim() || undefined,
        status: status === 'all' ? undefined : status,
      })
      if (ticket !== latest.current) return
      setData(next)
      setError(null)
    } catch {
      if (ticket !== latest.current) return
      setError('Couldn’t load the member list. Please reload the page to try again.')
    }
  }, [])

  // Debounced on the query, immediate on the filter: a click is a decision and
  // should not feel like a keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(query, filter), query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query, filter, load])

  // ARMED, THEN SENT (L5.5b). The member is now TOLD what happened to them and
  // why (D5 §9, D7 §5), so the operator has to say why — and a reason asked for
  // in the same gesture as the decision is a reason somebody actually gives.
  // This replaces the `window.confirm`, which is where the warning below used
  // to live: the warning is still the point, so it is rendered beside the field
  // rather than dropped along with the dialog.
  async function act(
    id: string,
    who: string,
    action: RosterAction,
    reason: string
  ): Promise<void> {
    if (reason.trim() === '') return

    setBusy({ id, action })
    setResult(null)
    try {
      if (action === 'freeze') {
        // ONE CLASS TODAY, and it is sent rather than defaulted — the row it
        // writes is what tells an operator's legal hold from the reconciler's
        // books divergence in the table they share.
        await adminDashboard.haltAccountPayouts(id, reason.trim(), OPERATOR_HALT_CLASSES[0])
        setResult({
          text: `${who} will not be paid by any cycle until the freeze is lifted on the Overview tab. They have not been told, nothing of theirs has been removed, and they can still sign in, read and publish.`,
          warn: false,
        })
      } else if (action === 'suspend') {
        await adminDashboard.suspendAccount(id, reason.trim())
        setResult({
          text: `${who} is suspended, their published content has been removed, and they have been emailed the reason.`,
          warn: false,
        })
      } else {
        await adminDashboard.reinstateAccount(id, reason.trim())
        setResult({
          text: `${who} is active again. Their earlier content was not restored. They have been emailed.`,
          warn: false,
        })
      }
    } catch (err: unknown) {
      const body = err instanceof ApiError ? err.body : null
      const code: string | null = typeof body?.error === 'string' ? body.error : null
      const nowIs: string | null = typeof body?.status === 'string' ? body.status : null
      // The class the EXISTING freeze was written under, when the press lost a
      // race with the reconciler or with another tab. An operator told only
      // "already frozen" would go on to lift a halt somebody else put there,
      // believing they were undoing their own.
      const heldClass: string | null =
        typeof body?.mismatchClass === 'string' ? body.mismatchClass : null
      const sentence = (): string => {
        if (code === 'already_halted') {
          return `${who}'s payouts were ALREADY frozen${
            heldClass ? ` under ${heldClass}` : ''
          } — nothing changed. That freeze is not yours: its reason is on the Overview tab, and it is not yours to lift.`
        }
        if (code === 'no_such_account' || code === 'account_not_found') {
          return `${who} no longer exists. Nothing was changed.`
        }
        if (code === 'standing_decision') {
          // A later, lesser decision never downgrades a standing one: the
          // suspend route refuses a terminated member (a suspension would
          // soften it) and a member's own closure (not ours to act on).
          if (nowIs === 'moderated') {
            return `${who} is already terminated. A suspension would soften that decision, so nothing was changed.`
          }
          if (nowIs === 'deactivated' || nowIs === 'deleted') {
            return `${who} closed their own account. That is not a moderation state, and this screen does not act on it. Nothing was changed.`
          }
          return `${who} is ${nowIs ?? 'in a state'} a suspension cannot be applied from. Nothing was changed.`
        }
        if (code === 'not_reinstatable') {
          if (nowIs === 'active') return `${who} is already active — there was no suspension to lift.`
          if (nowIs === 'deactivated') {
            return `${who} closed their own account. That is theirs to reverse by signing back in, not ours from here.`
          }
          return `${who} is ${nowIs ?? 'in a state'} this screen does not govern. Nothing was changed.`
        }
        return `Could not ${action} ${who}. Nothing was changed.`
      }
      setResult({ text: sentence(), warn: true })
    } finally {
      setBusy(null)
      setArmed(null)
      setReason('')
      // Re-read either way: a refusal means the screen was out of date, and it
      // should show what is true rather than what the click was refused against.
      await load(query, filter)
    }
  }

  return (
    <StatSection
      label="Everyone here"
      helper="Search an address, handle or display name. Suspending removes their published content from all.haus and the relay; reinstating does not bring it back."
    >
      {result && (
        <div className="bg-glasshouse-well px-4 py-3 mb-4">
          <p className={`text-ui-xs ${result.warn ? 'text-crimson' : 'text-black'}`}>
            {result.text}
          </p>
        </div>
      )}

      <div className="mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members…"
          aria-label="Search members"
          className="w-full bg-glasshouse-well px-3 py-2 text-ui-sm text-black focus-ring"
        />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => {
          const count =
            f.key === 'all'
              ? data
                ? data.byStatus.active +
                  data.byStatus.suspended +
                  data.byStatus.moderated +
                  data.byStatus.deactivated
                : null
              : (data?.byStatus[f.key] ?? null)
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`toggle-chip label-ui ${
                filter === f.key ? 'toggle-chip-active' : 'toggle-chip-inactive'
              }`}
            >
              {f.label}
              {count !== null && <span className="ml-2 tabular-nums">{count}</span>}
            </button>
          )
        })}
      </div>

      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black">{error}</div>}

      {!data && !error && <div className="h-24 animate-pulse bg-white" />}

      {data && !error && (
        <>
          {data.members.length === 0 ? (
            // The empty state names BOTH narrowings, because either can be the
            // one that emptied it. Saying "nobody here yet" while Suspended is
            // selected reads as *the site has no members* — it shipped that way
            // for as long as it took to look at it, which is the argument for
            // looking.
            <p className="text-ui-sm text-grey-600">
              {emptyBecause(query.trim(), filter)}
            </p>
          ) : (
            <div className="bg-glasshouse-well px-6 py-5 overflow-x-auto">
              <table className="w-full text-ui-xs">
                <thead>
                  <tr className="border-b-2 border-grey-200">
                    <th className="label-ui text-grey-600 text-left pb-2">Member</th>
                    <th className="label-ui text-grey-600 text-left pb-2 pl-6">Email</th>
                    <th className="label-ui text-grey-600 text-right pb-2 pl-6">Joined</th>
                    <th className="label-ui text-grey-600 text-left pb-2 pl-6">Signals</th>
                    <th className="label-ui text-grey-600 text-left pb-2 pl-6">Terms</th>
                    <th className="label-ui text-grey-600 text-left pb-2 pl-6">Status</th>
                    <th className="label-ui text-grey-600 text-right pb-2 pl-6">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => {
                    const who = m.username ? `@${m.username}` : (m.email ?? m.id)
                    const working = busy?.id === m.id ? busy.action : null
                    const status = STATUS_COPY[m.status]
                    const canSuspend = m.status === 'active' || m.status === 'moderated'
                    const canReinstate = m.status === 'suspended' || m.status === 'moderated'
                    // Offered on every status, and gated only on the freeze not
                    // already being there. It is not a moderation act, so it
                    // does not key on `status`: a member who closed their own
                    // account or whose account is soft-deleted is still paid by
                    // the cycles (the freeze allow-list keeps both, because
                    // leaving is not a reason to keep somebody's money), which
                    // is exactly the population a sanctions freeze has to be
                    // able to reach. Withheld where a halt already exists —
                    // a press could only be a no-op, and the honest place to
                    // act on an existing halt is where its reason is rendered.
                    const canFreeze = m.payoutsHalted === null
                    return (
                      <tr key={m.id} className="h-11">
                        {/* The uuid is on the title rather than on screen: the
                            point of this table is that nobody needs to read one
                            any more, but the one moment somebody does — a query
                            on the box — it is a hover away. */}
                        <td className="py-2 text-black" title={m.id}>
                          {m.displayName ?? m.username ?? '—'}
                          {m.username && m.displayName && (
                            <span className="text-grey-600"> @{m.username}</span>
                          )}
                        </td>
                        <td className="py-2 pl-6 text-grey-600 break-all">
                          {m.email ?? <span className="text-grey-400">none</span>}
                        </td>
                        <td className="py-2 pl-6 text-right tabular-nums text-grey-600 whitespace-nowrap">
                          {joined(m.joinedAt)}
                        </td>
                        <td className="py-2 pl-6 text-grey-600">
                          {signals(m) ||
                            // The dash means "nothing to say about this
                            // member", so it is withheld when the freeze below
                            // is saying something — an em dash sitting above
                            // `payouts frozen` reads as a third fact.
                            (m.payoutsHalted ? '' : '—')}
                          {/* A FROZEN MEMBER LOOKS ORDINARY EVERYWHERE ELSE —
                              that is what silent means — so the one screen an
                              operator searches from has to say it, or the next
                              person to look them up sees a payable writer who
                              is not being paid and nothing anywhere explaining
                              why. The class is shown because the two kinds of
                              halt are cleared by different people for different
                              reasons. */}
                          {m.payoutsHalted && (
                            <span className="block text-crimson">
                              payouts frozen · {m.payoutsHalted.mismatchClass}
                            </span>
                          )}
                        </td>
                        {/* The two versions, and only the versions. Whether a
                            member is BEHIND the current text is a comparison
                            this table deliberately does not make: it would need
                            a second copy of the version constants over here,
                            and the roster's job is to say what was accepted,
                            not to judge it. */}
                        <td className="py-2 pl-6 text-grey-600 whitespace-nowrap">
                          {[
                            m.readerTermsVersion ? `reader ${m.readerTermsVersion}` : null,
                            m.writerTermsVersion ? `writer ${m.writerTermsVersion}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || <span className="text-grey-400">none</span>}
                        </td>
                        <td className={`py-2 pl-6 ${status.warn ? 'text-crimson' : 'text-grey-600'}`}>
                          {status.text}
                        </td>
                        <td className="py-2 pl-6 text-right whitespace-nowrap">
                          {!canSuspend && !canReinstate && !canFreeze ? (
                            <span className="text-grey-600">—</span>
                          ) : armed?.id === m.id ? (
                            <span className="inline-flex flex-wrap items-center justify-end gap-3">
                              <input
                                type="text"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder={
                                  armed.action === 'suspend'
                                    ? 'Why they are being suspended…'
                                    : armed.action === 'freeze'
                                      ? 'Which listing, which reference…'
                                      : 'Why they are being reinstated…'
                                }
                                aria-label={`Reason for ${armed.action}`}
                                className="bg-white px-3 py-1 text-ui-xs text-black focus-ring min-w-[16rem]"
                              />
                              <button
                                type="button"
                                className={
                                  armed.action === 'reinstate' ? 'btn-text' : 'btn-text-danger'
                                }
                                disabled={reason.trim() === '' || working !== null}
                                onClick={() => void act(m.id, who, armed.action, reason)}
                              >
                                {working !== null
                                  ? 'Working…'
                                  : armed.action === 'suspend'
                                    ? 'Suspend and tell them'
                                    : armed.action === 'freeze'
                                      ? // The label says the part that is easy
                                        // to forget: this one tells them
                                        // nothing, which is the whole reason it
                                        // is not a suspension.
                                        'Freeze payouts, tell them nothing'
                                      : 'Reinstate and tell them'}
                              </button>
                              <button
                                type="button"
                                className="btn-text-muted"
                                disabled={working !== null}
                                onClick={() => {
                                  setArmed(null)
                                  setReason('')
                                }}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-4">
                              {canFreeze && (
                                <button
                                  type="button"
                                  className="btn-text-danger"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    setArmed({ id: m.id, action: 'freeze' })
                                    setReason('')
                                    setResult(null)
                                  }}
                                >
                                  Freeze payouts
                                </button>
                              )}
                              {canReinstate && (
                                <button
                                  type="button"
                                  className="btn-text"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    setArmed({ id: m.id, action: 'reinstate' })
                                    setReason('')
                                    setResult(null)
                                  }}
                                >
                                  Reinstate
                                </button>
                              )}
                              {canSuspend && (
                                <button
                                  type="button"
                                  className="btn-text-danger"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    setArmed({ id: m.id, action: 'suspend' })
                                    setReason('')
                                    setResult(null)
                                  }}
                                >
                                  Suspend
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

          {/* The warning the `window.confirm` used to carry. Stated ONCE for
              the page rather than repeated down the rows — it is a fact about
              what these two actions do, not about any one member. */}
          {armed && (
            <p className="text-ui-xs text-crimson mt-3">
              {armed.action === 'suspend'
                ? 'Suspending removes every article and note they have published from all.haus AND tombstones it on the relay. Reinstating them later does not bring any of it back. They are emailed the reason you give.'
                : armed.action === 'freeze'
                  ? 'Freezing stops every payout cycle paying them and does nothing else: they are not emailed, nothing of theirs comes down, and they can still sign in, read and publish. The money stays theirs and is paid when the freeze is lifted. This is the instrument for a suspected sanctions match (D9 §4.1) — a suspension is not, because a suspension is loud. Lift it on the Overview tab; the reason you give is recorded against your name.'
                  : 'They can sign in, read and post again. Content removed while they were suspended stays gone — the tombstones have already been published and cannot be withdrawn. They are emailed the reason you give.'}
            </p>
          )}

          {data.truncated && (
            <p className="text-ui-xs text-grey-600 mt-3">
              Showing the {data.shown} most recent of {data.matched}. Narrow the search to
              reach the rest.
            </p>
          )}
        </>
      )}

      <p className="text-ui-xs text-grey-600 mt-3">
        Deleted accounts are hidden unless you ask for them. “Closed by them” is a member’s own
        deactivation and is theirs to reverse by signing back in — it is not a suspension and
        there is nothing to lift.
      </p>
    </StatSection>
  )
}
