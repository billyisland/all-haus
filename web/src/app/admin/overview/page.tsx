'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  adminDashboard,
  type AdminOverview,
  type AdminAllocationCoverage,
} from '../../../lib/api'
import { formatPence, timeAgo } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

/** Basis points as a percentage. 10000 bps = 100%. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`
}

export default function AdminOverviewPage() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<string | null>(null)
  // Segregation is its own fetch across a service boundary (gateway → payment
  // service). Kept out of the overview's state so an unreachable payment
  // service costs this panel and not the whole money dashboard.
  const [segregation, setSegregation] = useState<AdminAllocationCoverage | null>(null)
  const [segregationError, setSegregationError] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await adminDashboard.overview())
      setError(null)
    } catch {
      setError('Failed to load the overview.')
    }
    try {
      setSegregation(await adminDashboard.allocationCoverage())
      setSegregationError(false)
    } catch {
      setSegregationError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Clearing dead jobs is an operator act and never automatic (§8.15): the rows
  // ARE the evidence, and a retention window would take the cron banner green a
  // week after a quarterly task failed. For the cron arm the clear IS the
  // acknowledgement, which is why that confirm names what is being thrown away.
  async function reap(scope: 'cron' | 'per_entity') {
    const prompt =
      scope === 'cron'
        ? 'Clear the failed scheduled runs? This deletes the only record that they failed — do it once you have read the error and fixed the cause, not to quieten the banner.'
        : 'Clear the per-source debris? These are individual ingest jobs that will never run again; their sources are unaffected and keep being polled.'
    if (!window.confirm(prompt)) return
    setActing(`reap:${scope}`)
    setActionResult(null)
    try {
      const r = await adminDashboard.reapDeadJobs(scope)
      setActionResult(`Cleared ${r.cleared} dead job${r.cleared === 1 ? '' : 's'}.`)
      await load()
    } catch {
      setActionResult('Failed to clear the dead jobs.')
    } finally {
      setActing(null)
    }
  }

  async function trigger(kind: 'settlements' | 'payouts') {
    const prompt =
      kind === 'settlements'
        ? 'Run the monthly settlement check now? Tabs past the fallback window will be charged.'
        : 'Run a payout cycle now? Writers over the threshold will be paid.'
    if (!window.confirm(prompt)) return
    setActing(kind)
    setActionResult(null)
    try {
      if (kind === 'settlements') {
        const r = await adminDashboard.triggerSettlements()
        setActionResult(`Settlement check complete — ${r.settlementTriggered} settlement(s) triggered.`)
      } else {
        const r = await adminDashboard.triggerPayouts()
        setActionResult(
          `Payout cycle complete — ${r.processed} payout(s), ${formatPence(r.totalPaidPence)} paid.`
        )
      }
      await load()
    } catch {
      setActionResult(kind === 'settlements' ? 'Settlement check failed.' : 'Payout cycle failed.')
    } finally {
      setActing(null)
    }
  }

  return (
    <AdminShell title="Site owner">
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          {/* Shared-secret mismatch. FIRST banner on the page, above even the
              payout halt: a halt is a deliberate control working as designed,
              this is the platform silently not working at all — on prod it meant
              every paywalled unlock failing while every number here looked
              healthy. Rendered from the gateway's live probe state, so it also
              covers a peer redeployed after the gateway last booted. */}
          {!data.parity.ok && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                Shared secret mismatch — {data.parity.mismatched.join(', ')}
              </p>
              <p className="text-ui-xs text-black">
                This gateway holds a different internal secret from the service
                {data.parity.mismatched.length === 1 ? '' : 's'} named, so every call to
                {data.parity.mismatched.length === 1 ? ' it' : ' them'} is failing — paywalled
                unlocks and article publishing among them. Make the env var identical in both
                {' '}<span className="font-mono">.env</span> files and recreate both containers.
              </p>
            </div>
          )}

          {/* NEVER CONFIRMED is a third state, and it is not fine. The banner
              above fires only on a PROVEN mismatch, so a peer the gateway has
              never been able to prove either way — rolled back to an image with
              no /auth-check, or unreachable for every probe since boot — was
              rendered here as a clean bill of health. That is the sticky case
              the whole check exists to end: a peer 404ing forever is never
              definitive, so a simultaneously drifted secret would be silent
              everywhere except one boot log line, on the surface built to show
              it. Quieter than the mismatch banner because it is not yet a known
              fault — it is the absence of the evidence that there isn't one. */}
          {data.parity.unverified.length > 0 && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-grey-600 mb-1">
                Shared secret never confirmed — {data.parity.unverified.join(', ')}
              </p>
              <p className="text-ui-xs text-black">
                The gateway has not been able to prove its internal secret matches
                {data.parity.unverified.length === 1 ? ' this service' : ' these services'}, either
                way — every probe since boot came back unreachable or unrecognised. This is not a
                mismatch, and it is not an all-clear:{' '}
                {data.parity.unverified.length === 1 ? 'that peer' : 'those peers'} could be running
                a drifted secret right now and nothing here would say so. Check{' '}
                <span className="font-mono">docker compose ps</span> and confirm the service is up
                and on a current image.
              </p>
            </div>
          )}

          {/* Outbound email. The third member of the same family as the two
              banners above, and the incident that argues hardest for all of
              them: for up to 17 days every email this platform sent failed on a
              rejected Postmark token — magic links included, so nobody could log
              in — and there was no symptom anywhere. The login route catches the
              send error and still answers 200, deliberately, so that a delivery
              failure can't be used to probe whether an account exists; that
              choice is right and is also what made this invisible. It was found
              by accident, weeks in.

              Two independent faults, one banner: the credential can be rejected
              (nothing sends at all) and sends can fail with a perfectly good
              credential (unconfirmed sender signature, rate limit, suppressed
              recipient). Both are shown when both are true. */}
          {(data.email.credential === 'invalid' || data.email.failed > 0) && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                {data.email.credential === 'invalid'
                  ? 'Email is not being sent — the provider rejected our credential'
                  : `${data.email.failed} email${data.email.failed === 1 ? '' : 's'} failed to send`}
              </p>
              {data.email.credential === 'invalid' && (
                <p className="text-ui-xs text-black">
                  {data.email.credentialDetail} Every outbound email is failing: magic links (so
                  nobody can log in), publish notifications to subscribers, and the waitlist
                  digest. Nothing else reports this — the login route answers 200 whether or not
                  the email went. Put a working token in{' '}
                  <span className="font-mono">gateway/.env</span> and{' '}
                  <span className="font-mono">recreate</span> the container — a restart does not
                  reload <span className="font-mono">env_file</span>.
                </p>
              )}
              {data.email.failed > 0 && (
                <p className="text-ui-xs text-black mt-2">
                  {data.email.failed} of {data.email.attempted} send
                  {data.email.attempted === 1 ? '' : 's'} failed since the gateway started{' '}
                  {timeAgo(data.email.sinceBootAt)}
                  {data.email.lastFailureAt && `, the last ${timeAgo(data.email.lastFailureAt)}`}.
                  {data.email.credential === 'valid' &&
                    ' The credential itself is good, so look past the token: an unconfirmed sender signature, a rate limit, or a suppressed recipient.'}
                </p>
              )}
              {data.email.lastError && (
                <p className="text-ui-xs text-grey-600 mt-2 font-mono break-words">
                  {data.email.lastError}
                </p>
              )}
            </div>
          )}

          {/* NOT CHECKED and NEVER CONFIRMED, the email twins of the parity
              banner above, and quieter for its reason: neither is a known fault,
              each is the absence of the evidence that there isn't one. A
              `console` provider in production is its own silent outage — every
              magic link written to a log file instead of sent — so it is said in
              words here rather than left to be inferred from a missing alarm. */}
          {data.email.credential !== 'invalid' &&
            (!data.email.probeSupported || data.email.credential === null) && (
              <div className="bg-glasshouse-well px-4 py-3 mb-8">
                <p className="label-ui text-grey-600 mb-1">
                  {data.email.provider === 'console'
                    ? 'No email is being sent'
                    : !data.email.probeSupported
                      ? `Email credential not checked — ${data.email.provider}`
                      : 'Email credential never confirmed'}
                </p>
                <p className="text-ui-xs text-black">
                  {data.email.provider === 'console' ? (
                    <>
                      <span className="font-mono">EMAIL_PROVIDER</span> is{' '}
                      <span className="font-mono">console</span>, so every magic link, publish
                      notification and digest is being written to the gateway log instead of sent.
                      Expected in development; in production it means nobody can log in.
                    </>
                  ) : !data.email.probeSupported ? (
                    <>
                      There is no credential probe for this provider, so a revoked key here would
                      show up only as failed sends. That is not a mismatch and it is not an
                      all-clear.
                    </>
                  ) : (
                    <>
                      The gateway has not been able to prove its email credential either way — every
                      probe since boot went unanswered. Not a rejection, and not an all-clear: the
                      token could be dead right now and nothing here would say so. Check that the
                      gateway can reach the provider&rsquo;s API.
                    </>
                  )}
                </p>
              </div>
            )}

          {/* Ingest down. Beside the parity banner and for the same reason:
              this is the platform silently not working, not a control working
              as designed. On 2026-08-11 feed-ingest was stopped by a stray
              SIGTERM and nothing restarted it — every container green, every
              number on this page healthy, and no content ingested for 21 hours
              until the operator noticed their own feeds were stale. The signal
              is the AGE of a heartbeat the worker stamps every 60s, so a
              stopped worker cannot report itself alive. */}
          {data.ingest.worker.down && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                Feed ingest is not running
                {data.ingest.worker.ageSeconds !== null &&
                  ` — last tick ${timeAgo(data.ingest.worker.heartbeatAt!)}`}
              </p>
              <p className="text-ui-xs text-black">
                {data.ingest.worker.heartbeatAt === null
                  ? 'The feed-ingest worker has never stamped its heartbeat. '
                  : `The worker stamps a heartbeat every 60 seconds and has not for over ${Math.round(
                      data.ingest.worker.alertSeconds / 60,
                    )} minutes. `}
                While it is down nothing is ingested from any source, no Nostr events are
                published from the relay outbox, and no scheduled cron runs. Check{' '}
                <span className="font-mono">docker compose ps feed-ingest</span> and start it with{' '}
                <span className="font-mono">docker compose up -d feed-ingest</span>.
              </p>
            </div>
          )}

          {/* A scheduled run that did not happen. Beside the two banners above
              and for their reason: the worker can be running, every source
              fresh, every number here healthy, while a nightly task has failed
              every night since May. `relay_outbox_prune` was red for 84
              consecutive nights on prod and the fault underneath it had
              silently switched off members' feeds — nothing anywhere said
              so, because a job that exhausts its attempts stops being retried
              and simply sits there.

              At one, not at a threshold: these are singleton tasks, so one dead
              row is one run of one job that never ran. (The per-source arm is a
              pile of hundreds and is deliberately quiet — see the Jobs panel.)

              It stays up until an operator clears it, which is the whole design:
              nothing reaps these, so the acknowledgement is a human act rather
              than the passage of time. */}
          {data.jobs.readable && data.jobs.cron.dead > 0 && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                {data.jobs.cron.dead} scheduled{' '}
                {data.jobs.cron.dead === 1 ? 'run has' : 'runs have'} failed for good
              </p>
              <p className="text-ui-xs text-black">
                {data.jobs.cron.tasks
                  .filter((t) => t.failed + t.abandoned > 0)
                  .map((t) => t.task)
                  .join(', ')}
                {' — '}
                {data.jobs.cron.failed > 0 && data.jobs.cron.abandoned > 0
                  ? `${data.jobs.cron.failed} failed, ${data.jobs.cron.abandoned} abandoned mid-run. `
                  : data.jobs.cron.abandoned > 0
                    ? `abandoned mid-run with no attempts left, so ${data.jobs.cron.dead === 1 ? 'it' : 'they'} died without erroring. `
                    : `out of attempts, so nothing will retry ${data.jobs.cron.dead === 1 ? 'it' : 'them'}. `}
                {data.jobs.cron.dead === 1
                  ? 'That is one scheduled run that did not happen and never will. '
                  : 'Each of these is one scheduled run that did not happen and never will. '}
                Check{' '}
                <span className="font-mono">docker compose logs feed-ingest</span>, fix the cause,
                then clear them in the Jobs panel below — clearing is the acknowledgement, so the
                banner stays up until you do.
              </p>
              {data.jobs.cron.tasks.find((t) => t.lastError) && (
                <p className="text-ui-xs text-grey-600 mt-2 font-mono break-words">
                  {data.jobs.cron.tasks.find((t) => t.lastError)!.lastError}
                </p>
              )}
            </div>
          )}

          {data.payout.halted && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">Payouts halted</p>
              <p className="text-ui-xs text-black">
                {data.payout.haltReason ?? 'Ledger reconciliation flagged a mismatch.'}
                {data.payout.haltedSince && ` Since ${timeAgo(data.payout.haltedSince)}.`}
              </p>
            </div>
          )}

          {/* W4 per-account halts. A SEPARATE banner from the platform-wide one
              above, never a merged "payouts halted": these are two different
              controls cleared two different ways, and an operator who read one
              as the other would resume the wrong thing. Rendered whether or not
              the global halt is also up — they can both be in force. */}
          {data.payout.haltedAccounts.length > 0 && (
            <div className="bg-glasshouse-well px-4 py-3 mb-8">
              <p className="label-ui text-crimson mb-1">
                {data.payout.haltedAccounts.length} account
                {data.payout.haltedAccounts.length === 1 ? '' : 's'} frozen — everyone else is being paid
              </p>
              <div className="space-y-1">
                {data.payout.haltedAccounts.map((h) => (
                  <p key={h.accountId} className="text-ui-xs text-black">
                    <span className="font-medium">{h.displayName ?? h.username ?? h.accountId}</span>
                    {' · '}
                    <span className="label-ui text-grey-600">{h.mismatchClass}</span>
                    {' · '}
                    {h.reason}
                    {` Since ${timeAgo(h.since)}.`}
                  </p>
                ))}
              </div>
            </div>
          )}

          <StatSection label="Stage 1 — Accrual" helper="Money owed by readers, not yet charged.">
            <StatGrid>
              <StatCard label="Active tabs" value={data.accrual.activeTabCount} />
              <StatCard label="Accrued on tabs" value={formatPence(data.accrual.totalAccruedPence)} />
              <StatCard
                label="Near threshold"
                value={data.accrual.nearThresholdTabs}
                detail={`≥ 80% of ${formatPence(data.accrual.settlementThresholdPence)}`}
              />
              <StatCard
                label="Reader credit"
                value={formatPence(data.accrual.totalCreditPence)}
                detail="Negative balances (platform owes readers)"
              />
              <StatCard
                label="Provisional reads"
                value={data.accrual.provisionalReadCount}
                detail={formatPence(data.accrual.provisionalTotalPence)}
              />
              <StatCard
                label="Accrued reads"
                value={data.accrual.accruedReadCount}
                detail={formatPence(data.accrual.accruedTotalPence)}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Stage 2 — Settlement" helper="Readers charged; the platform holds the funds.">
            <StatGrid>
              <StatCard
                label="Pending"
                value={data.settlement.pendingCount}
                detail={formatPence(data.settlement.pendingPence)}
                warn={
                  data.settlement.oldestPendingAt !== null &&
                  Date.now() - new Date(data.settlement.oldestPendingAt).getTime() > 3_600_000
                }
              />
              <StatCard
                label="Completed"
                value={data.settlement.completedCount}
                detail={formatPence(data.settlement.completedPence)}
              />
              <StatCard
                label="Failed"
                value={data.settlement.failedCount}
                warn={data.settlement.failedCount > 0}
              />
              <StatCard
                label="Last settlement"
                value={data.settlement.lastCompletedAt ? timeAgo(data.settlement.lastCompletedAt) : '—'}
              />
              <StatCard
                label="Charged back"
                value={data.settlement.chargedBackReadCount}
                detail={formatPence(data.settlement.chargedBackPence)}
                warn={data.settlement.chargedBackReadCount > 0}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Stage 3 — Payout" helper="The platform pays writers.">
            <StatGrid>
              <StatCard
                label="Writers awaiting"
                value={data.payout.writersAwaitingPayout}
                detail={`${formatPence(data.payout.outstandingEarningsPence)} outstanding`}
              />
              <StatCard
                label="In flight"
                value={data.payout.pendingCount + data.payout.initiatedCount}
                detail={formatPence(data.payout.pendingPence + data.payout.initiatedPence)}
              />
              <StatCard
                label="Completed (all time)"
                value={data.payout.completedCount}
                detail={formatPence(data.payout.completedPence)}
              />
              <StatCard
                label="Failed"
                value={data.payout.failedCount}
                detail={data.payout.failedCount > 0 ? formatPence(data.payout.failedPence) : undefined}
                warn={data.payout.failedCount > 0}
              />
              <StatCard
                label="Reversed"
                value={data.payout.reversedCount}
                warn={data.payout.reversedCount > 0}
              />
              <StatCard
                label="Last payout"
                value={data.payout.lastPayoutAt ? timeAgo(data.payout.lastPayoutAt) : '—'}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Platform revenue" helper="Platform fees on completed settlements.">
            <StatGrid>
              <StatCard label="All time" value={formatPence(data.revenue.allTimePlatformFeePence)} />
              <StatCard label="Last 30 days" value={formatPence(data.revenue.last30DaysPlatformFeePence)} />
              <StatCard label="Last 7 days" value={formatPence(data.revenue.last7DaysPlatformFeePence)} />
              <StatCard label="Today" value={formatPence(data.revenue.todayPlatformFeePence)} />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Custodial exposure"
            helper="Settled reader money held before writer payout."
          >
            <StatGrid>
              <StatCard label="Held" value={formatPence(data.custody.totalHeldPence)} />
              <StatCard label="Held reads" value={data.custody.heldReadCount} />
              <StatCard
                label="Oldest holding"
                value={`${data.custody.holdingDurationDays}d`}
                warn={data.custody.holdingDurationDays > data.custody.holdingWarningDays}
              />
            </StatGrid>
          </StatSection>

          {/* W2 — funds segregation as a measured number. The two figures here
              are DIFFERENT measurements and are never to be merged into one
              "segregation %": coverage is charge-side (of what readers paid,
              how much Stripe held allocated), residual is payout-side (of what
              we paid out, how much came from platform balance). Neither is
              derivable from the other. Every absent measurement is rendered in
              WORDS — a fake 0% would assert that none of the platform's reader
              money is segregated, which is the most alarming thing this panel
              can say, and it would say it every day the flag ships dark. */}
          <StatSection
            label="Funds segregation"
            helper="How the settled money is held, measured over 30 days — never asserted."
          >
            {/* Names no culprit on purpose. This read crosses web → gateway →
                payment service, and the browser cannot tell which hop failed —
                the first version said "the payment service did not answer" and
                sent a prod diagnosis chasing the wrong container when the fault
                was a token mismatch at the gateway. The gateway logs the
                upstream status on any non-2xx, so point there instead. */}
            {segregationError && (
              <p className="text-ui-xs text-grey-600">
                Unavailable — the segregation figures could not be read. This is not a coverage
                figure of zero; check the gateway log for the upstream status.
              </p>
            )}
            {/* The overview lands one round trip before this does, so the
                section would otherwise stand empty under its own heading for a
                moment — which reads as "nothing to report". */}
            {!segregation && !segregationError && (
              <p className="text-ui-xs text-grey-600">Measuring…</p>
            )}
            {segregation && !segregation.allocatedFundsEnabled && (
              <p className="text-ui-xs text-grey-600">
                Allocated funds are switched off, so no charge is being segregated and there is
                nothing to measure. Coverage becomes measurable once STRIPE_ALLOCATED_FUNDS is on
                and the allocation sweep has read the charges back.
              </p>
            )}
            {segregation && segregation.allocatedFundsEnabled && (
              <>
                {segregation.coverage === null ? (
                  <p className="text-ui-xs text-grey-600">
                    No measured settlements in the last 30 days
                    {segregation.unmeasured.count > 0
                      ? ` — ${segregation.unmeasured.count} settlement(s) are still awaiting an allocation read.`
                      : '.'}{' '}
                    Not a coverage figure of zero.
                  </p>
                ) : (
                  <StatGrid>
                    <StatCard
                      label="Charge-side coverage"
                      value={pct(segregation.coverage.coverageBps)}
                      detail={`${formatPence(segregation.coverage.allocatedPence)} allocated of ${formatPence(segregation.coverage.measuredPence)} charged`}
                      warn={segregation.coverage.coverageBps < 10000}
                    />
                    <StatCard
                      label="Measured settlements"
                      value={segregation.coverage.measuredCount}
                      detail={`Last ${segregation.coverage.windowDays} days`}
                    />
                    <StatCard
                      label="Unallocated"
                      value={segregation.coverage.unallocatedCount}
                      detail={`${formatPence(segregation.coverage.unallocatedPence)} charged with no allocation`}
                      warn={segregation.coverage.unallocatedCount > 0}
                    />
                    {/* Neither covered nor uncovered — charges we have not read
                        yet. Shown so a coverage figure computed over a partial
                        sample can never read as a figure over all of it. */}
                    <StatCard
                      label="Awaiting a read"
                      value={segregation.unmeasured.count}
                      detail={
                        segregation.unmeasured.count > 0
                          ? `${formatPence(segregation.unmeasured.pence)} not counted either way`
                          : 'Every settlement in the window is measured'
                      }
                      warn={segregation.unmeasured.count > 0}
                    />
                  </StatGrid>
                )}
                <p className="text-ui-xs text-grey-600 mt-3">
                  {segregation.residual === null
                    ? 'Payout-side residual: no payouts in the window, so no measurement — a different number from coverage, and not derivable from it.'
                    : `Payout-side residual: ${pct(segregation.residual.residualBps)} of ${formatPence(segregation.residual.totalPence)} paid out moved from platform balance rather than a charge's allocation (alerts above ${pct(segregation.residual.thresholdBps)}). A different number from coverage, and not derivable from it.`}
                </p>
              </>
            )}
          </StatSection>

          <StatSection label="Counts">
            <StatGrid>
              <StatCard label="Accounts" value={data.counts.totalAccounts} />
              <StatCard label="Active" value={data.counts.activeAccounts} />
              <StatCard label="Publishing writers" value={data.counts.publishingWriters} />
              <StatCard label="Readers ever" value={data.counts.readersEver} />
              <StatCard label="Cards on file" value={data.counts.readersWithCard} />
              <StatCard
                label="Open reports"
                value={data.counts.openReportCount}
                warn={data.counts.openReportCount > 0}
              />
            </StatGrid>
          </StatSection>

          <div className="slab-rule-4 mb-8" />
          <StatSection
            label="Ingest"
            helper="Whether content is arriving. The worker figure is the alarm; the per-protocol times are context, not thresholds — two of these protocols are push-driven, so a quiet night is not a fault."
          >
            <StatGrid>
              <StatCard
                label="Worker"
                value={data.ingest.worker.down ? 'Down' : 'Running'}
                detail={
                  data.ingest.worker.heartbeatAt
                    ? `heartbeat ${timeAgo(data.ingest.worker.heartbeatAt)}`
                    : 'no heartbeat ever recorded'
                }
                warn={data.ingest.worker.down}
              />
              {data.ingest.protocols.map((p) => (
                <StatCard
                  key={p.protocol}
                  label={p.protocol}
                  // "never" rather than 0 or a dash: a source that has never
                  // been fetched and one fetched a second ago are opposite
                  // facts, and email is push-delivered so it never fetches at
                  // all. No measurement is not a good measurement.
                  value={p.lastFetchedAt ? timeAgo(p.lastFetchedAt) : 'never'}
                  detail={`${p.activeSources} active source${p.activeSources === 1 ? '' : 's'}`}
                />
              ))}
            </StatGrid>
          </StatSection>

          <div className="slab-rule-4 mb-8" />
          {/* Email. The numbers stay on the page whether or not anything is
              wrong, which is the point: the banner above fires on a fault, and
              the incident this was built for ran for weeks with no fault anyone
              could see. A count of sends and failures, visible at a glance,
              would have shown it on day one. */}
          {/* "Outbound", because the Ingest panel directly above already has a
              card labelled `email` — inbound newsletter ingest, the opposite
              direction. Two adjacent panels both saying "Email" about different
              things is how an operator reads the wrong number in a hurry. */}
          <StatSection
            label="Outbound email"
            helper="Whether outbound email is authenticating and going out. Counts are since this gateway started — a restart clears them — and Postmark accepting a message is not the same as a human receiving it."
          >
            <StatGrid>
              <StatCard
                label="Credential"
                value={
                  data.email.credential === 'valid'
                    ? 'OK'
                    : data.email.credential === 'invalid'
                      ? 'Rejected'
                      : data.email.probeSupported
                        ? 'Unconfirmed'
                        : 'Unchecked'
                }
                detail={
                  data.email.credentialCheckedAt
                    ? `proven ${timeAgo(data.email.credentialCheckedAt)}`
                    : data.email.probeSupported
                      ? 'never proven either way'
                      : 'no probe for this provider'
                }
                warn={data.email.credential === 'invalid'}
              />
              <StatCard
                label="Sent"
                value={data.email.attempted}
                // The denominator, and it is load-bearing: zero failures out of
                // zero sends is silence, not health, so the detail says which of
                // the two this is rather than leaving the failure count to imply
                // an all-clear.
                detail={
                  data.email.attempted === 0
                    ? 'nothing sent since boot'
                    : `since ${timeAgo(data.email.sinceBootAt)}`
                }
              />
              <StatCard
                label="Failed"
                value={data.email.failed}
                detail={
                  data.email.attempted === 0
                    ? 'nothing has been sent to fail'
                    : data.email.lastFailureAt
                      ? `last ${timeAgo(data.email.lastFailureAt)}`
                      : 'none'
                }
                warn={data.email.failed > 0}
              />
              <StatCard
                label="Provider"
                value={data.email.provider}
                detail={
                  data.email.provider === 'console'
                    ? 'writes to the log, sends nothing'
                    : data.email.probeSupported
                      ? 'credential re-probed every 15 min'
                      : 'credential never probed'
                }
                // Deliberately not `warn`, even though a `console` provider in
                // production is a real outage: this card is crimson on every dev
                // machine every day, and an alarm that is always on is one the
                // operator learns to read past — the failure mode the whole
                // panel exists to avoid. The quiet banner above says it in
                // words, which is the same treatment parity gives its own
                // not-yet-a-known-fault state.
              />
            </StatGrid>
          </StatSection>

          <div className="slab-rule-4 mb-8" />
          {/* Dead jobs. Two arms, and the difference between them is the whole
              design — the same split as Worker vs protocols above, for the same
              reason. A SCHEDULED task's dead row means a run did not happen and
              alarms at one; a PER-SOURCE row is one source among hundreds, so a
              threshold on it would be red from the first day and get learned
              past, which is the failure the alarm would exist to avoid.

              Successful jobs are deleted, so "has this ever worked?" is not a
              question this table can answer. Failures are all there is to see. */}
          <StatSection
            label="Jobs"
            helper={
              data.jobs.readable
                ? `Background jobs that will never run again. Scheduled runs alarm at one — each is a run that did not happen. Per-source jobs are debris and never alarm; their sources keep being polled. Arrivals are counted over ${data.jobs.windowHours}h, because the pile is cumulative and the rate is what means anything.`
                : undefined
            }
          >
            {!data.jobs.readable ? (
              // Not zero. This panel reads past a supported graphile API, so it
              // can fail on its own terms — and "no dead jobs" would be this
              // feature committing precisely the silence it was built to end.
              <div className="bg-glasshouse-well p-4">
                <p className="label-ui text-grey-600 mb-1">Unavailable</p>
                <p className="text-ui-xs text-black">
                  The job queue could not be read, so this is not a report of zero dead jobs — it is
                  no report at all. Most likely graphile-worker moved its tables in an upgrade;
                  check the gateway log for{' '}
                  <span className="font-mono">dead-job query failed</span>.
                </p>
              </div>
            ) : (
              <>
                <StatGrid>
                  <StatCard
                    label="Scheduled runs lost"
                    value={data.jobs.cron.dead}
                    detail={
                      data.jobs.cron.dead === 0
                        ? 'nothing outstanding'
                        : `${data.jobs.cron.recent} in the last ${data.jobs.windowHours}h`
                    }
                    warn={data.jobs.cron.dead > 0}
                  />
                  <StatCard
                    label="Scheduled, retrying"
                    value={data.jobs.cron.retrying}
                    // Never an alarm: a retrying row's error can predate a fix
                    // that has not been retried yet, and one transient failure
                    // of a once-a-minute task would flash red for seconds.
                    detail={
                      data.jobs.cron.retrying === 0
                        ? 'none failing'
                        : 'failing now, attempts left — may be a fixed fault not yet retried'
                    }
                  />
                  <StatCard
                    label="Per-source, dead"
                    value={data.jobs.perEntity.dead}
                    detail={`${data.jobs.perEntity.recent} in the last ${data.jobs.windowHours}h`}
                  />
                  <StatCard
                    label="…of those, errored"
                    value={data.jobs.perEntity.failed}
                    // The distinction the pile hides: on dev only 25 of 1038
                    // rows had errored at all. The rest were interrupted by a
                    // worker restart with no attempts left — dead having never
                    // failed. Reporting them as failures would state a fault
                    // that is not there.
                    detail={
                      data.jobs.perEntity.abandoned > 0
                        ? `${data.jobs.perEntity.abandoned} abandoned by worker restarts`
                        : 'none abandoned'
                    }
                  />
                </StatGrid>

                {(data.jobs.cron.tasks.length > 0 || data.jobs.perEntity.tasks.length > 0) && (
                  <div className="mt-4 space-y-2">
                    {[...data.jobs.cron.tasks, ...data.jobs.perEntity.tasks].map((t) => (
                      <div key={t.task} className="bg-glasshouse-well p-4">
                        <p className="label-ui text-grey-600 mb-1">{t.task}</p>
                        <p className="text-ui-xs text-black">
                          {[
                            t.failed > 0 && `${t.failed} failed`,
                            t.abandoned > 0 && `${t.abandoned} abandoned`,
                            t.retrying > 0 && `${t.retrying} retrying`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          {t.lastDeadAt && ` · last died ${timeAgo(t.lastDeadAt)}`}
                        </p>
                        {t.lastError && (
                          <p className="text-ui-xs text-grey-600 mt-1 font-mono break-words">
                            {t.lastError}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-3 mt-4">
                  <button
                    className="btn-soft"
                    disabled={acting !== null || data.jobs.cron.dead === 0}
                    onClick={() => void reap('cron')}
                  >
                    {acting === 'reap:cron' ? 'Clearing…' : 'Clear scheduled runs'}
                  </button>
                  <button
                    className="btn-soft"
                    disabled={acting !== null || data.jobs.perEntity.dead === 0}
                    onClick={() => void reap('per_entity')}
                  >
                    {acting === 'reap:per_entity' ? 'Clearing…' : 'Clear per-source debris'}
                  </button>
                </div>
              </>
            )}
          </StatSection>

          <div className="slab-rule-4 mb-8" />
          <StatSection
            label="Manual triggers"
            helper="Both run in the payment service exactly as the scheduled crons do."
          >
            <div className="flex flex-wrap gap-3">
              <button
                className="btn-soft"
                disabled={acting !== null}
                onClick={() => void trigger('settlements')}
              >
                {acting === 'settlements' ? 'Running…' : 'Run monthly settlement check'}
              </button>
              <button
                className="btn-soft"
                disabled={acting !== null || data.payout.halted}
                onClick={() => void trigger('payouts')}
              >
                {acting === 'payouts' ? 'Running…' : 'Run payout cycle'}
              </button>
            </div>
            {actionResult && <p className="text-ui-xs text-grey-600 mt-3">{actionResult}</p>}
          </StatSection>
        </>
      )}
    </AdminShell>
  )
}
