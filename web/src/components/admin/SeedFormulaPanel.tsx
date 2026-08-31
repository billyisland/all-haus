'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminSeedFormula } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'

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
// =============================================================================

export function SeedFormulaPanel() {
  const [data, setData] = useState<AdminSeedFormula | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedChoice, setFeedChoice] = useState('')

  async function load() {
    try {
      const r = await adminDashboard.seedFormula()
      setData(r)
      setError(null)
    } catch {
      setError('Failed to load the default seed.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function designate(body: { feedId: string }, confirmText: string) {
    if (!window.confirm(confirmText)) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await adminDashboard.designateSeedFormula(body)
      setNotice(
        `Cut and designated “${r.designated.name}” — ${r.designated.sourceCount} source(s). ${
          r.replaced ? `Retired “${r.replaced.name}”.` : ''
        }`
      )
      setFeedChoice('')
      await load()
    } catch (err) {
      setNotice(apiErrorMessage(err) ?? 'Designation failed.')
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
          What a brand-new account receives as its first feed. A formula is a frozen composition,
          not a feed — deleting the feed it was cut from leaves it whole, and it cannot be revoked
          or deleted while designated.
        </p>

        {designated ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-ui-sm text-black">
                {designated.name} — {designated.sourceCount} source
                {designated.sourceCount === 1 ? '' : 's'}
                {designated.excludedCount > 0 && (
                  <span className="text-grey-600"> ({designated.excludedCount} not shareable)</span>
                )}
              </p>
              {!designated.authorIsSelf && (
                <p className="text-ui-xs text-crimson max-w-article">
                  Authored by {designated.authorName}. Their account can no longer be deleted while
                  this formula seeds new signups.
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
                onClick={() =>
                  void designate(
                    { feedId: designated.sourceFeedId! },
                    'This cuts a NEW seed from that feed as it stands now, and every account created from here on will be seeded from it. The current seed is retired — members already seeded from it are untouched. Continue?'
                  )
                }
              >
                Re-cut from this feed
              </button>
            ) : (
              <p className="text-ui-xs text-grey-600 max-w-article">
                The feed this was cut from has been deleted, so it can’t be re-cut. The seed itself
                is unaffected — it is a frozen composition and does not need its feed. Designate
                another feed below to replace it.
              </p>
            )}
          </div>
        ) : (
          <p className="text-ui-xs text-crimson max-w-article">
            Nothing seeds a new account. Every signup lands on an empty feed they must fill
            themselves.
          </p>
        )}

        <div className="sm:flex sm:items-center sm:gap-3">
          <select
            value={feedChoice}
            onChange={(e) => setFeedChoice(e.target.value)}
            className="w-full sm:flex-1 bg-glasshouse-well px-3 py-2 text-ui-sm focus-ring"
            aria-label="Feed to cut into a new seed formula"
          >
            <option value="">Cut one of my feeds into a new seed formula…</option>
            {feeds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} — {f.sourceCount} source(s)
              </option>
            ))}
          </select>
          <button
            className="btn mt-2 sm:mt-0"
            disabled={busy || !feedChoice}
            onClick={() =>
              void designate(
                { feedId: feedChoice },
                'This freezes the feed as it stands into a new formula and seeds every new account from it. Later edits to the feed will NOT reach it — re-cut when you want them to. Continue?'
              )
            }
          >
            Cut &amp; designate
          </button>
        </div>

        {notice && <p className="text-ui-xs text-grey-600">{notice}</p>}
      </div>
    </section>
  )
}
