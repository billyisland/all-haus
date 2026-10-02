'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminSeedFormula } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { useConfirm } from '../ui/ConfirmDialog'

// =============================================================================
// Default seed — what every new account is seeded from.
//
// This panel replaced a hand-run `UPDATE feeds SET is_starter_template = true`
// (FEED-FORMULAS-ADR D6/D11, Phase 2). Its whole job is to make the
// load-bearing object VISIBLE: the flagged template it supersedes was destroyed
// twice by an operator who could not tell it from an ordinary feed, and both
// times the damage landed silently on the next signup.
//
// So it always states what is in force — the designated formula, or plainly
// that NOTHING seeds a new account — rather than only offering the controls.
// That second state is not an error to hide: it is where a fresh database sits
// until an operator designates one, and it is the only warning anyone gets.
// There is no "clear" control, deliberately: undesignating happens only by
// designating a replacement.
//
// THE SEED IS FROZEN AND THAT IS THE POINT (FEED-SHARE-LIVE-LINKS-ADR L3).
// Share links went live in that change; the seed deliberately did not. What
// every new account receives must be a composition a person has looked at —
// making it track a feed would move the empty/too-large refusal from HERE,
// where an operator is present and can be told, to signup, where a stranger is
// present and nobody is; and there it is not a retryable error but a permanent
// un-seeding of every account created in the window.
//
// So refreshing the seed is an operator act, and *Re-cut from this feed* is it:
// the same designation call with the standing seed's source feed pre-filled,
// which cuts a NEW frozen row from that feed's current state and retires the
// old one. There is no way to designate a row that already exists (L5) — a seed
// is cut, never adopted, which is what stops an operator turning a member's
// share link into the one row nobody is allowed to withdraw.
//
// The legacy-template arm retired with the flag itself in migration 179.
//
// ADMISSION IS THE ONE APPENDING WRITER (RESHAPE-PLAN-2026-10 §A.2). Admitting
// a waitlister adds them to the designated seed, so the panel says how many of
// its members came in that way and how many have not signed in yet — those
// are carried by other members' feeds but named only here. A re-cut would
// drop every one of them in silence, so it CARRIES them into the new seed,
// states the number before the press, and offers the one opt-out: starting
// the new seed without them, which is a legitimate act too.
// =============================================================================

export function SeedFormulaPanel() {
  const [data, setData] = useState<AdminSeedFormula | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedChoice, setFeedChoice] = useState('')
  // Carry the admitted members into a re-cut (§A.2.7). On unless turned off.
  const [carry, setCarry] = useState(true)
  const { ask, dialog } = useConfirm()

  async function load() {
    try {
      const r = await adminDashboard.seedFormula()
      setData(r)
      setError(null)
    } catch {
      setError('Couldn’t load the default seed. Please reload the page to try again.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function designate(
    anchor: HTMLElement,
    body: { feedId: string },
    title: string,
    confirmText: string,
  ) {
    // The carry, stated before the press: how many admitted members the new
    // seed will take across from this one, or leave behind.
    const carryCount = data?.feeds.find((f) => f.id === body.feedId)?.carryCount ?? 0
    const carryText =
      carryCount === 0
        ? ''
        : carry
          ? ` ${carryCount} admitted member${carryCount === 1 ? '' : 's'} not on that channel will be carried into the new seed.`
          : ` ${carryCount} admitted member${carryCount === 1 ? '' : 's'} not on that channel will be LEFT OUT of the new seed.`
    const ok = await ask(anchor, {
      title,
      body: confirmText + carryText,
      confirmLabel: 'Cut & designate',
      width: 360,
    })
    if (!ok) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await adminDashboard.designateSeedFormula({ ...body, carryAdmitted: carry })
      setNotice(
        `Cut and designated “${r.designated.name}” — ${r.designated.sourceCount} source${r.designated.sourceCount === 1 ? '' : 's'}. ${
          r.replaced ? `Retired “${r.replaced.name}”.` : ''
        }${r.carried > 0 ? ` Carried ${r.carried} admitted member${r.carried === 1 ? '' : 's'}.` : ''}${
          r.carryDropped > 0
            ? ` ${r.carryDropped} could not be carried — the new seed is full.`
            : ''
        }`
      )
      setFeedChoice('')
      await load()
    } catch (err) {
      setNotice(apiErrorMessage(err) ?? 'Couldn’t designate the new seed. Please reload to see which seed is in force.')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>
  }
  if (!data) return <div className="h-32 animate-pulse bg-white mb-10" />

  const { designated, feeds } = data

  return (
    <section className="mb-10">
      <p className="label-ui text-grey-600 mb-3">Default seed</p>
      <div className="bg-glasshouse-well/40 px-6 py-5 space-y-5">
        <p className="text-ui-xs text-grey-600 max-w-article">
          What a brand-new account receives as its first channel. A formula is a frozen composition,
          not a channel — deleting the channel it was cut from leaves it whole, and it cannot be revoked
          or deleted while designated.
        </p>

        {designated ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-ui-sm text-black">
                {/* No fallback needed here and that is deliberate: a DESIGNATED
                    FORMULA always has a name. `feed_formulas_name_check` is 1..80
                    and the route refuses to cut an untitled feed into a seed
                    (400 `seed_feed_unnamed`), the operator's `name` override
                    being the way through. The list of FEEDS to cut from, below,
                    is the opposite case — see its note. */}
                {designated.name} — {designated.sourceCount} source
                {designated.sourceCount === 1 ? '' : 's'}
                {designated.excludedCount > 0 && (
                  <span className="text-grey-600"> ({designated.excludedCount} not shareable)</span>
                )}
              </p>
              {designated.suspendedSourceCount > 0 && (
                <p className="text-ui-xs text-crimson max-w-article">
                  {designated.suspendedSourceCount === 1
                    ? 'One source in this seed points at a suspended system'
                    : `${designated.suspendedSourceCount} sources in this seed point at a suspended system`}{' '}
                  and {designated.suspendedSourceCount === 1 ? 'is' : 'are'} skipped at every
                  sign-up. Re-cut the seed from a channel without them, or reinstate the system — the
                  rows travel again the moment it comes back.
                </p>
              )}
              {designated.admittedCount > 0 && (
                <p className="text-ui-xs text-grey-600 max-w-article">
                  {designated.admittedCount} of these came in by admission from the waiting list
                  {designated.awaitingArrivalCount > 0
                    ? `; ${designated.awaitingArrivalCount} ${
                        designated.awaitingArrivalCount === 1 ? 'hasn’t' : 'haven’t'
                      } signed in yet, and other members’ channels carry them without naming them until they do`
                    : ''}
                  .
                </p>
              )}
              {!designated.authorIsSelf && (
                <p className="text-ui-xs text-crimson max-w-article">
                  Authored by {designated.authorName}. Their account can no longer be deleted while
                  this formula seeds new accounts.
                </p>
              )}
            </div>
            {/* Refresh: the same designation call with the source feed
                pre-filled (L5). It says in WORDS what it replaces, because the
                thing it changes is what every future signup receives and
                nothing else on this page would report it. */}
            {designated.sourceFeedId ? (
              <button
                className="btn-soft"
                disabled={busy}
                onClick={(e) =>
                  void designate(
                    e.currentTarget,
                    { feedId: designated.sourceFeedId! },
                    'Re-cut the default seed?',
                    'This cuts a NEW seed from that channel as it stands now, and every account created from here on will be seeded from it. The current seed is retired — members already seeded from it are untouched.'
                  )
                }
              >
                Re-cut from this channel
              </button>
            ) : (
              <p className="text-ui-xs text-grey-600 max-w-article">
                The channel this was cut from has been deleted, so it can’t be re-cut. The seed itself
                is unaffected — it is a frozen composition and does not need its channel. Designate
                another channel below to replace it.
              </p>
            )}
          </div>
        ) : (
          <p className="text-ui-xs text-crimson max-w-article">
            No seed is designated, so every new account starts with one empty channel to fill
            itself.
          </p>
        )}

        {designated && designated.admittedCount > 0 && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={`label-ui toggle-chip ${carry ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
              aria-pressed={carry}
              onClick={() => setCarry((c) => !c)}
            >
              {carry ? 'Carry admitted members' : 'Start without them'}
            </button>
            <span className="text-ui-xs text-grey-600">
              {carry
                ? 'A re-cut keeps everyone admission added.'
                : 'The next cut starts fresh; admitted members not on the channel are left out.'}
            </span>
          </div>
        )}

        <div className="sm:flex sm:items-center sm:gap-3">
          <select
            value={feedChoice}
            onChange={(e) => setFeedChoice(e.target.value)}
            className="w-full sm:flex-1 bg-glasshouse-well px-3 py-2 text-ui-sm focus-ring"
            aria-label="Channel to cut into a new seed formula"
          >
            <option value="">Cut one of my channels into a new seed formula…</option>
            {/* A FEED's name is optional (migration 190 dropped the floor) and the
                create schema is `z.string().trim().default("")`, so an untitled
                feed is `""` and never null — `??` would walk straight past it and
                this option would read " — 3 sources" with nothing in front of
                it. Same rule the workspace already follows everywhere; this list
                and the public share page were the two places that had not caught
                up. */}
            {feeds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name.trim() || 'Unnamed channel'} — {f.sourceCount} source{f.sourceCount === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <button
            className="btn mt-2 sm:mt-0"
            disabled={busy || !feedChoice}
            onClick={(e) =>
              void designate(
                e.currentTarget,
                { feedId: feedChoice },
                'Designate a new default seed?',
                'This freezes the channel as it stands into a new formula and seeds every new account from it. Later edits to the channel will NOT reach it — re-cut when you want them to.'
              )
            }
          >
            Cut &amp; designate
          </button>
        </div>

        {notice && <p className="text-ui-xs text-grey-600">{notice}</p>}
      </div>
      {dialog}
    </section>
  )
}
