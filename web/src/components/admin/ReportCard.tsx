'use client'

import { useState } from 'react'
import {
  admin as adminApi,
  isResolved,
  type Report,
  type ReportAction,
  type ReportCategory,
  type ReportPriority,
  type ReportStatus,
} from '../../lib/api'
import { ApiError } from '../../lib/api/client'
import { timeAgo } from '../../lib/format'

// =============================================================================
// One report, and what the operator can actually do about it.
//
// A BUTTON THAT CANNOT DO ITS JOB IS NOT OFFERED, and the gateway says the rest.
// The two removing actions are conditional on the report naming something at
// all; whether that something is REMOVABLE — a native event we can tombstone
// rather than an item we merely ingested — only the gateway can answer, because
// it is a fact about the row behind the id. So the card offers the action and
// renders the gateway's specific refusal when it comes (`external_content_not_
// removable` names the remedy: block the source or the identity). What must
// never happen is the old failure, where an action ran, matched nothing, and
// closed the report looking exactly like one where the work had been done.
//
// THE CONFIRM SAYS WHAT IT DESTROYS, not "are you sure" — same discipline as
// the member roster, and for the same reason: removal publishes a kind-5
// tombstone to the relay, which is a statement to other relays that cannot be
// withdrawn, and that is the only part of the press a careful operator cannot
// infer from the button's own label.
//
// TWO SENTENCES ARE COLLECTED, NOT ONE (L6.4). `reason` is what the member
// reads; `reasoning` is the judgement D7 §8 makes mandatory even for an obvious
// call, because the log is the evidence that judgements were made under the
// guidance. They are different fields because they have different readers, and
// one field pretending to be both would be written for whichever reader the
// operator had in mind that day.
// =============================================================================

const CATEGORY_LABEL: Record<ReportCategory, string> = {
  csam: 'CSAM',
  grooming: 'Grooming / child at risk',
  terrorism: 'Terrorism',
  intimate_image_abuse: 'Intimate image abuse',
  cyberflashing: 'Cyberflashing',
  hate: 'Hate',
  harassment: 'Threats / harassment',
  self_harm_promotion: 'Suicide / self-harm / ED',
  fraud: 'Fraud',
  illegal_content: 'Other illegal content',
  spam: 'Spam or inauthentic behaviour',
  other: 'Other',
}

/** What the status word says once a report has left the queue. */
const STATUS_LABEL: Record<ReportStatus, string> = {
  open: 'Open',
  under_review: 'Under review',
  resolved_removed: 'Resolved — content removed',
  resolved_no_action: 'Resolved — no action',
  resolved_actioned: 'Resolved — action taken',
}

/** D7 §2's triage table, in the words the operator is held to. */
const PRIORITY_LABEL: Record<ReportPriority, string> = {
  P0: 'P0 · 24h',
  P1: 'P1 · 72h',
  P2: 'P2 · 7d',
}

/** The six rungs of D7 §5's ladder, each with the sentence its confirm spends
 *  its words on. Ordered as the ladder is: lightest first. */
const ACTIONS: ReadonlyArray<{
  action: ReportAction
  label: string
  className: string
  confirm: string
  done: string
}> = [
  {
    action: 'no_action',
    label: 'Dismiss',
    className: 'btn-text-muted',
    confirm: 'Dismiss this report?\n\nThe content stays and the report is closed. The reporter is not written to; the subject is not either.',
    done: 'The report is closed. Nothing was removed.',
  },
  {
    action: 'warn',
    label: 'Warn',
    className: 'btn-text',
    confirm:
      'Warn this member?\n\nThe content stays up. They are emailed the reason and told a repeat is dealt with further up the ladder. The warning is on the record and an appeal is open to them for 7 days.',
    done: 'The member has been warned, and the report is closed.',
  },
  {
    action: 'remove_content',
    label: 'Remove content',
    className: 'btn-text-danger',
    confirm:
      'Remove this content?\n\nIt goes from every all.haus surface AND is tombstoned on the relay. The tombstone is a statement to other relays and cannot be withdrawn.',
    done: 'Content removed, and the report is closed.',
  },
  {
    action: 'suspend_7d',
    label: 'Suspend 7 days',
    className: 'btn-text-danger',
    confirm:
      'Suspend this account for 7 days?\n\nThey lose access immediately, and every article and note they have published is removed from all.haus AND tombstoned on the relay. The suspension lifts by itself after 7 days; the removal does not come back.',
    done: 'The account is suspended for 7 days, and the report is closed.',
  },
  {
    action: 'suspend',
    label: 'Suspend',
    className: 'btn-text-danger',
    confirm:
      'Suspend this account indefinitely?\n\nThey lose access immediately, and every article and note they have published is removed from all.haus AND tombstoned on the relay. Reinstating them later does not bring any of it back.',
    done: 'The account is suspended, and the report is closed.',
  },
  {
    action: 'terminate',
    label: 'Terminate',
    className: 'btn-text-danger',
    confirm:
      'Terminate this account?\n\nD7 §5 reserves this for CSAM, grooming, credible threats to life, confirmed fraud and ban evasion. They lose access, all their published work is removed and tombstoned, and the account does not come back from this screen.',
    done: 'The account is terminated, and the report is closed.',
  },
]

/** The priorities above a given one — what a raise can be made TO. 'P0' <
 *  'P1' < 'P2' as text, the same order the gateway and the queue use. */
function raisesFrom(current: ReportPriority | null): ReportPriority[] {
  return (['P0', 'P1'] as const).filter((p) => current === null || p < current)
}

/** The gateway's refusals, in the operator's words. */
const REFUSAL: Record<string, string> = {
  not_a_raise:
    'The priority can only be raised, never lowered — it records what was alleged. What you concluded goes in the judgement when you resolve it.',
  not_open: 'This report is already resolved; its priority is no longer a deadline.',
  external_content_not_removable:
    'This item came from another network. We do not host it and cannot tombstone it — block the source or the identity instead (below the queue).',
  no_removable_content: 'There is nothing here we host that can be removed.',
  no_subject_account:
    'This report does not resolve to an all.haus account, so there is nobody to warn, suspend or terminate. If the content came from another network, block the source or the identity instead.',
}

export function ReportCard({
  report,
  onResolved,
}: {
  report: Report
  onResolved: () => void
}) {
  const [acting, setActing] = useState(false)
  const [result, setResult] = useState<{ text: string; warn: boolean } | null>(null)
  // ARMED, THEN SENT (L5.5b). Both sentences are required by the gateway, so
  // the arming step is where they are written — it replaces the `window.confirm`
  // whose sentence is now rendered beside the fields, where it can be read
  // while the reason is written rather than dismissed in a dialog.
  const [armed, setArmed] = useState<(typeof ACTIONS)[number] | null>(null)
  const [reason, setReason] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [appealReasoning, setAppealReasoning] = useState('')
  // THE RAISE (§0z item 8). Terms 9.3 gives 24 hours to "a credible threat to
  // life" and "anything plausibly involving a child", and neither is a box the
  // reporter ticks — the reviewer makes that call here, with a reason the row
  // keeps. Armed like the ladder's actions: the reason is written where the
  // consequence is read.
  const [raising, setRaising] = useState<ReportPriority | null>(null)
  const [raiseReason, setRaiseReason] = useState('')
  const resolved = isResolved(report.status)

  const namesSomething =
    report.targetNostrEventId !== null ||
    report.targetPostId !== null ||
    report.targetAccountId !== null ||
    report.targetProfileId !== null ||
    report.targetConversationId !== null

  /** Whether the gateway could have anything to act on. The finer question —
   *  is the thing behind this id ours to remove? — is the gateway's, and its
   *  refusal is rendered rather than guessed at. */
  function reachable(action: ReportAction): boolean {
    if (action === 'no_action') return true
    return namesSomething
  }

  const overdue =
    !resolved &&
    report.triagedAt === null &&
    report.triageDeadline !== null &&
    new Date(report.triageDeadline) < new Date()

  function say(err: unknown): string {
    if (!(err instanceof ApiError)) return 'Could not take that action. Nothing was changed.'
    const code = typeof err.body?.error === 'string' ? err.body.error : ''
    if (REFUSAL[code]) return REFUSAL[code]
    if (err.status === 409) return 'Somebody has already resolved this report. Nothing was changed.'
    if (err.status === 404) return 'This report no longer exists. Nothing was changed.'
    return 'Could not take that action. Nothing was changed.'
  }

  async function handleAction(spec: (typeof ACTIONS)[number]): Promise<void> {
    if (reason.trim() === '' || reasoning.trim() === '') return
    setActing(true)
    setResult(null)
    try {
      await adminApi.resolveReport(report.id, spec.action, reason.trim(), reasoning.trim())
      setResult({ text: spec.done, warn: false })
      setArmed(null)
      setReason('')
      setReasoning('')
      onResolved()
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : null
      setResult({ text: say(err), warn: true })
      // A 409 or a 404 both mean this screen is out of date — show what is
      // true rather than what the click was refused against. An `external_…`
      // 409 is different: the report is still open and the operator has a
      // different remedy to reach for, so the card stays as it is.
      const code = err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : ''
      if ((status === 409 && !REFUSAL[code]) || status === 404) onResolved()
    } finally {
      setActing(false)
    }
  }

  async function handleRaise(): Promise<void> {
    if (!raising || raiseReason.trim() === '') return
    setActing(true)
    setResult(null)
    try {
      await adminApi.raiseReportPriority(report.id, raising, raiseReason.trim())
      setResult({
        text: `Raised to ${raising}. The ${PRIORITY_LABEL[raising].split(' · ')[1]} deadline now runs from when it was filed.`,
        warn: false,
      })
      setRaising(null)
      setRaiseReason('')
      onResolved()
    } catch (err: unknown) {
      setResult({ text: say(err), warn: true })
      const code = err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : ''
      // `not_open` and a 404 mean this screen is stale; `not_a_raise` means
      // somebody else got there first with a graver value — refresh for both.
      if (code === 'not_open' || code === 'not_a_raise' || (err instanceof ApiError && err.status === 404)) {
        onResolved()
      }
    } finally {
      setActing(false)
    }
  }

  async function handleReview(): Promise<void> {
    setActing(true)
    try {
      await adminApi.reviewReport(report.id)
      onResolved()
    } catch (err: unknown) {
      setResult({ text: say(err), warn: true })
    } finally {
      setActing(false)
    }
  }

  async function handleAppeal(outcome: 'upheld' | 'reversed'): Promise<void> {
    if (appealReasoning.trim() === '') return
    setActing(true)
    try {
      const res = await adminApi.decideAppeal(report.id, outcome, appealReasoning.trim())
      setResult({
        text:
          outcome === 'reversed'
            ? res.accountLifted
              ? 'Appeal allowed. Their account is open again; removed content stays removed and they have been told so.'
              : 'Appeal allowed, and recorded. There was no account state left to lift; removed content stays removed and they have been told so.'
            : 'Appeal refused, and the re-reading is on the record. They have been told.',
        warn: false,
      })
      setAppealReasoning('')
      onResolved()
    } catch (err: unknown) {
      setResult({ text: say(err), warn: true })
    } finally {
      setActing(false)
    }
  }

  return (
    <div className={`bg-glasshouse-well px-6 py-5 ${resolved ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        {report.priority && (
          <span
            className={`label-ui ${
              report.priority === 'P0' ? 'text-crimson' : 'text-grey-400'
            }`}
          >
            {PRIORITY_LABEL[report.priority]}
          </span>
        )}
        <span className="label-ui text-grey-300">{CATEGORY_LABEL[report.category]}</span>
        <span className="font-mono text-mono-xs text-grey-300">·</span>
        <span className="font-mono text-mono-xs text-grey-300">
          {timeAgo(report.createdAt)}
        </span>
        {overdue && (
          <>
            <span className="font-mono text-mono-xs text-grey-300">·</span>
            <span className="label-ui text-crimson">Past its deadline</span>
          </>
        )}
        {report.status !== 'open' && (
          <>
            <span className="font-mono text-mono-xs text-grey-300">·</span>
            <span className="label-ui text-grey-400">{STATUS_LABEL[report.status]}</span>
          </>
        )}
      </div>

      <p className="text-ui-sm text-black mb-1">
        Reported by{' '}
        <span className="font-semibold">
          {report.reporterUsername ? `@${report.reporterUsername}` : 'a deleted account'}
        </span>
      </p>

      {/* What was reported, in whichever identifier the report carries. The
          event id is what a `strfry` query takes, so it is shown whole; the
          post id is what every other surface on the site keys on. */}
      <p className="text-ui-xs text-grey-600 break-all mb-2">
        {report.targetConversationId ? (
          <>Direct messages with {report.targetAccountUsername ? `@${report.targetAccountUsername}` : 'a member'}</>
        ) : report.targetProfileId ? (
          <>
            Profile{' '}
            {report.targetProfileUsername
              ? `@${report.targetProfileUsername}`
              : report.targetProfileId}
          </>
        ) : report.targetAccountId ? (
          <>
            Account{' '}
            {report.targetAccountUsername
              ? `@${report.targetAccountUsername}`
              : report.targetAccountId}
          </>
        ) : report.targetNostrEventId ? (
          <>Event {report.targetNostrEventId}</>
        ) : report.targetPostId ? (
          <>Post {report.targetPostId}</>
        ) : (
          'No target recorded.'
        )}
      </p>

      {/* The raise, where a reviewer made one — the judgement that made 9.3's
          shorter clock apply, on the record beside who made it. */}
      {report.priorityRaisedAt && (
        <p className="text-ui-xs text-grey-600 mb-2">
          <span className="label-ui text-grey-400">
            Raised to {report.priority}
            {report.priorityRaisedByUsername ? ` by @${report.priorityRaisedByUsername}` : ''}{' '}
          </span>
          {report.priorityRaiseReason}
        </p>
      )}

      {/* THE SNAPSHOT (D7 §8), and it is the only thing on this card that
          survives the removal. Rendered as key/value rather than parsed into a
          claim: its shape varies by target kind, and a renderer that assumed
          one shape would show a confident blank for the others. */}
      {report.snapshot !== null && <SnapshotBlock snapshot={report.snapshot} />}

      {/* The reporter's own words, and they are platform copy rather than
          literary prose — the serif the old card set them in belonged to the
          `contentPreview` field, which this response has never carried. */}
      {report.notes && (
        <div className="border-l-2 border-grey-200 pl-3 py-1 mt-2">
          <p className="text-ui-sm text-grey-600 whitespace-pre-wrap">{report.notes}</p>
        </div>
      )}

      {/* The decision, once there is one. Both sentences, labelled by who each
          is for — that is the whole reason there are two. */}
      {resolved && (report.reason || report.reasoning) && (
        <div className="mt-3 space-y-1">
          {report.action && (
            <p className="label-ui text-grey-400">
              {ACTIONS.find((a) => a.action === report.action)?.label ?? report.action}
              {report.subjectUsername ? ` · @${report.subjectUsername}` : ''}
            </p>
          )}
          {report.reasoning && (
            <p className="text-ui-xs text-grey-600">
              <span className="label-ui text-grey-400">Judgement </span>
              {report.reasoning}
            </p>
          )}
          {report.reason && (
            <p className="text-ui-xs text-grey-600">
              <span className="label-ui text-grey-400">Sent to them </span>
              {report.reason}
            </p>
          )}
        </div>
      )}

      {/* THE APPEAL (D7 §5). A filed appeal is the one thing on this screen
          with a deadline of its own — seven days — so it renders above the
          fold of the card's actions and says when it arrived. */}
      {report.appealedAt && (
        <div className="mt-4 bg-white px-4 py-3">
          <p className="label-ui text-grey-400 mb-2">
            Appeal · {timeAgo(report.appealedAt)}
          </p>
          <p className="text-ui-sm text-black whitespace-pre-wrap mb-3">
            {report.appealText}
          </p>
          {report.appealDecidedAt ? (
            <p className="text-ui-xs text-grey-600">
              <span className="label-ui text-grey-400">
                {report.appealOutcome === 'reversed' ? 'Reversed ' : 'Upheld '}
              </span>
              {report.appealReasoning}
            </p>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={appealReasoning}
                onChange={(e) => setAppealReasoning(e.target.value)}
                placeholder="Your re-reading of the material — recorded, and sent to them…"
                aria-label="Appeal reasoning"
                className="w-full bg-glasshouse-well px-3 py-1 text-ui-xs text-black focus-ring"
              />
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => void handleAppeal('upheld')}
                  disabled={acting || appealReasoning.trim() === ''}
                  className="btn-text-muted"
                >
                  Decision stands
                </button>
                <button
                  type="button"
                  onClick={() => void handleAppeal('reversed')}
                  disabled={acting || appealReasoning.trim() === ''}
                  className="btn-text"
                >
                  Reverse it
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <p className={`mt-3 text-ui-xs ${result.warn ? 'text-crimson' : 'text-black'}`}>
          {result.text}
        </p>
      )}

      {!resolved && armed && (
        <div className="mt-4">
          <p className="text-ui-xs text-crimson mb-3 whitespace-pre-line">{armed.confirm}</p>
          <div className="space-y-2">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why — the member is sent this…"
              aria-label={`Reason for ${armed.label}`}
              className="w-full bg-white px-3 py-1 text-ui-xs text-black focus-ring"
            />
            <input
              type="text"
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value)}
              placeholder="Judgement — for the log, not for them…"
              aria-label={`Judgement for ${armed.label}`}
              className="w-full bg-white px-3 py-1 text-ui-xs text-black focus-ring"
            />
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => void handleAction(armed)}
                disabled={acting || reason.trim() === '' || reasoning.trim() === ''}
                className={armed.className}
              >
                {acting ? 'Working…' : armed.label}
              </button>
              <button
                type="button"
                onClick={() => {
                  setArmed(null)
                  setReason('')
                  setReasoning('')
                }}
                disabled={acting}
                className="btn-text-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {!resolved && !armed && raising && (
        <div className="mt-4">
          <p className="text-ui-xs text-crimson mb-3">
            Raise this report to {raising}? The published {PRIORITY_LABEL[raising].split(' · ')[1]} triage
            deadline then runs from when it was filed — a report that is already older than that is
            overdue the moment you press. The reason is kept on the record with your name.
          </p>
          <div className="space-y-2">
            <input
              type="text"
              value={raiseReason}
              onChange={(e) => setRaiseReason(e.target.value)}
              placeholder="Why — a credible threat to life, a child plausibly involved…"
              aria-label={`Reason for raising to ${raising}`}
              className="w-full bg-white px-3 py-1 text-ui-xs text-black focus-ring"
            />
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => void handleRaise()}
                disabled={acting || raiseReason.trim() === ''}
                className="btn-text-danger"
              >
                {acting ? 'Working…' : `Raise to ${raising}`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRaising(null)
                  setRaiseReason('')
                }}
                disabled={acting}
                className="btn-text-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {!resolved && !armed && !raising && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {report.status === 'open' && (
            <button
              type="button"
              onClick={() => void handleReview()}
              disabled={acting}
              className="btn-text-muted"
            >
              Take under review
            </button>
          )}
          {/* Offered only where there is somewhere to raise TO: a P0 has none,
              and the button that cannot do its job is not offered. */}
          {raisesFrom(report.priority).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setRaising(p)
                setRaiseReason('')
                setResult(null)
              }}
              className="btn-text-muted"
            >
              Raise to {p}
            </button>
          ))}
          {ACTIONS.filter((a) => reachable(a.action)).map((a) => (
            <button
              key={a.action}
              type="button"
              onClick={() => {
                setArmed(a)
                setReason('')
                setReasoning('')
                setResult(null)
              }}
              className={a.className}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The snapshot, rendered as what it is.
 *
 * Its shape is the gateway's and varies by target kind — a post carries a
 * title and a preview, a profile a bio, a conversation nothing but its id and
 * a sentence saying why. So this walks the object rather than naming fields: a
 * renderer written against one shape shows a confident blank for the others,
 * and a blank on a moderation record reads as "there was nothing there".
 */
function SnapshotBlock({ snapshot }: { snapshot: Record<string, unknown> }) {
  const item = (snapshot.item ?? null) as Record<string, unknown> | null
  const entries = Object.entries(item ?? snapshot).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  )
  if (entries.length === 0) return null
  return (
    <div className="mt-2 bg-white px-4 py-3">
      <p className="label-ui text-grey-400 mb-2">As reported</p>
      <dl className="space-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="label-ui text-grey-300 shrink-0">{k}</dt>
            <dd className="text-ui-xs text-grey-600 break-words min-w-0">{String(v)}</dd>
          </div>
        ))}
      </dl>
      {snapshot.captured === false && (
        <p className="mt-2 text-ui-xs text-grey-400">
          Nothing was captured at filing — the target did not resolve to a row.
        </p>
      )}
    </div>
  )
}
