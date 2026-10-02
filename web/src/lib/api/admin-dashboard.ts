import { ApiError, apiErrorMessage, request } from './client'

// =============================================================================
// Owner dashboard API — gateway /admin/dashboard/* (requireAdmin).
// Types mirror gateway/src/routes/admin-dashboard.ts response shapes.
// =============================================================================

/** One arm of the dead-job surface — see `AdminOverview.jobs`. */
export interface AdminDeadJobArm {
  /** Dead and errored + dead and abandoned: everything that will not run. */
  dead: number
  failed: number
  abandoned: number
  retrying: number
  /** Deaths inside `windowHours` — the pile is cumulative, the rate is signal. */
  recent: number
  tasks: Array<{
    task: string
    failed: number
    abandoned: number
    retrying: number
    recent: number
    lastDeadAt: string | null
    lastError: string | null
  }>
}

export interface AdminOverview {
  accrual: {
    activeTabCount: number
    totalAccruedPence: number
    nearThresholdTabs: number
    settlementThresholdPence: number
    provisionalReadCount: number
    provisionalTotalPence: number
    accruedReadCount: number
    accruedTotalPence: number
  }
  settlement: {
    pendingCount: number
    pendingPence: number
    oldestPendingAt: string | null
    completedCount: number
    completedPence: number
    lastCompletedAt: string | null
    failedCount: number
    chargedBackReadCount: number
    chargedBackPence: number
  }
  payout: {
    writersAwaitingPayout: number
    outstandingEarningsPence: number
    pendingCount: number
    pendingPence: number
    initiatedCount: number
    initiatedPence: number
    completedCount: number
    completedPence: number
    failedCount: number
    failedPence: number
    reversedCount: number
    reversedPence: number
    lastPayoutAt: string | null
    halted: boolean
    haltReason: string | null
    haltedSince: string | null
    /** Per-account freezes (W4) — distinct from the platform-wide `halted`. */
    haltedAccounts: Array<{
      accountId: string
      username: string | null
      displayName: string | null
      mismatchClass: string
      reason: string
      since: string
    }>
  }
  revenue: {
    allTimePlatformFeePence: number
    last30DaysPlatformFeePence: number
    last7DaysPlatformFeePence: number
    todayPlatformFeePence: number
  }
  custody: {
    heldReadCount: number
    totalHeldPence: number
    oldestHeldReadAt: string | null
    holdingDurationDays: number
    holdingWarningDays: number
  }
  /**
   * Shared-secret parity with payment / key-custody / key-service.
   * `ok: false` means a peer PROVABLY holds a different secret, so every call
   * to it is failing silently. `unverified` is neither proven nor disproven —
   * distinct from fine, and never to be rendered as fine.
   */
  parity: {
    ok: boolean
    mismatched: string[]
    unverified: string[]
  }
  /**
   * Is outbound email actually going out (prod incident 2026-08-11 — up to 17
   * days in which every send failed on a rejected Postmark token, with no
   * symptom anywhere: the login route swallows the error and still answers 200
   * so a failure can't be used to probe whether an account exists).
   *
   * `credential` is the probe verdict and `null` is a real THIRD state —
   * NEVER CONFIRMED, which must never render as healthy. `probeSupported`
   * false means nothing was checked at all (a `console` provider sends no mail;
   * Resend has no safe probe), which is also not an all-clear.
   *
   * `attempted` is the denominator and ships with `failed` for the reason the
   * allocation reconciler reports an empty-denominator rate as absent: zero
   * failures out of zero sends is silence, not health. Both are in-process and
   * reset on a gateway restart — hence `sinceBootAt`.
   */
  email: {
    provider: string
    probeSupported: boolean
    credential: 'valid' | 'invalid' | null
    credentialCheckedAt: string | null
    credentialDetail: string | null
    sinceBootAt: string
    attempted: number
    failed: number
    lastFailureAt: string | null
    lastError: string | null
  }
  /**
   * Is content actually arriving (prod incident 2026-08-11 — 21 hours of no
   * ingest with every container green).
   *
   * `worker` is the alarm and is derived from an ABSENCE: the feed-ingest poll
   * stamps a heartbeat every 60s, so a stopped worker cannot report itself
   * healthy. A null `heartbeatAt` is `down`, not "unknown".
   *
   * `protocols` is context, never a threshold: cadences differ by orders of
   * magnitude and two protocols are push-driven (atproto only fetches when a
   * subscribed account posts; email never does), so `lastFetchedAt: null` must
   * render as "never" rather than as stale or as zero.
   *
   * `refusedSources` is the third figure and the one nothing used to carry
   * (§0aa.2): sources that are ACTIVE, polled on schedule, and unreadable —
   * an instance that will not serve us even a signed request. From the
   * outside that is indistinguishable from an author who has stopped posting,
   * which is how 381 dead sources went three months unnoticed. Zero is the
   * ordinary answer; anything else is how much of the fediverse we cannot
   * currently read.
   */
  ingest: {
    worker: {
      heartbeatAt: string | null
      ageSeconds: number | null
      alertSeconds: number
      down: boolean
    }
    protocols: Array<{
      protocol: string
      activeSources: number
      lastFetchedAt: string | null
      refusedSources: number
      /** When the longest-refused of them was first refused. */
      refusedSince: string | null
    }>
  }
  /**
   * The linked-account notification poller (CROSS-NETWORK-ROUNDTRIP-ADR C4).
   * `down` counts every presence it serves whose last SUCCESSFUL poll (or, never
   * polled, whose link) is older than `staleSeconds`; `awaitingReconnect` is the
   * subset whose grant lacks the scopes, which is the member's to fix rather
   * than a fault.
   */
  linkedNotifications: {
    presences: number
    down: number
    awaitingReconnect: number
    staleSeconds: number
    oldestSuccessAt: string | null
  }
  /**
   * Background jobs that will never run again (§8.15) — the third liveness
   * question, and the one nothing answered: the worker can be running and every
   * source fresh while a scheduled task has failed every night for months.
   * `relay_outbox_prune` was red for 84 consecutive nights on prod that way.
   *
   * `readable: false` is a THIRD state, never a zero — this is the one query on
   * the overview that reads past a supported graphile API, and an unreadable
   * table rendering as "no dead jobs" would be this feature's own failure mode.
   *
   * `cron` ALARMS at one: a dead scheduled run is a run that did not happen.
   * `perEntity` (one source among hundreds) never alarms — a threshold on a
   * cumulative pile is red from day one and gets learned past.
   *
   * Within each arm, `failed` ran and threw; `abandoned` was interrupted
   * mid-flight and had no attempts left, so it died having never failed (most
   * of the pile, arriving in spikes on worker restarts). Both mean "will not
   * run". `retrying` is the same fault ARRIVING and is informational — its
   * error can predate a fix that has not been retried yet.
   */
  jobs:
    | { readable: false; windowHours: number }
    | {
        readable: true
        windowHours: number
        cron: AdminDeadJobArm
        perEntity: AdminDeadJobArm
      }
  counts: {
    totalAccounts: number
    activeAccounts: number
    readersWithCard: number
    publishingWriters: number
    readersEver: number
    openReportCount: number
  }
}

export interface AdminUsers {
  totals: {
    accounts: number
    active: number
    suspended: number
    moderated: number
    deactivated: number
    readersWithCard: number
    readersOnFreeAllowance: number
    readersAllowanceExhausted: number
    cardActionRequired: number
    /** Card-holders who have not accepted the current Reader Terms — the
     *  cohort the gate-pass refusal turns away at their next paid read. */
    readerTermsOutstanding: number
    /** Writers with paywalled work who have not accepted the current Writer
     *  Agreement — refused at their next paid publish. */
    writerTermsOutstanding: number
  }
  growth: {
    signupsLast7d: number
    signupsLast30d: number
  }
  kycIncomplete: {
    count: number
    writers: Array<{
      id: string
      username: string
      displayName: string | null
      connectStarted: boolean
      pendingEarningsPence: number
    }>
  }
  conversionFunnel: {
    totalReadersEver: number
    exhaustedAllowance: number
    connectedCard: number
    conversionRate: number | null
  }
}

/**
 * WHAT AN OPERATOR MAY FREEZE AN ACCOUNT'S PAYOUTS UNDER.
 *
 * A runtime array with the type derived from it, not a bare union: a type can
 * be compared against nothing at test time, and this list is a SECOND COPY of
 * the gateway's (which is itself a second copy of the payment service's). There
 * is no module path between the three, so `operator-halt-wire.test.ts` reads
 * the gateway's source and asserts they match — a class this end sends and that
 * end refuses is a 400 on an emergency freeze.
 *
 * One member, because one procedure asks for a freeze the member is not told
 * about: D9 §4.1, a suspected match against the UK sanctions list. Adding a
 * second is a decision about when this platform freezes somebody's money.
 */
export const OPERATOR_HALT_CLASSES = ['sanctions_review'] as const
export type OperatorHaltClass = (typeof OPERATOR_HALT_CLASSES)[number]

/** One of the five `account_status` values, as the roster reports it. */
export type AdminMemberStatus =
  | 'active'
  | 'suspended'
  | 'moderated'
  | 'deactivated'
  | 'deleted'

export interface AdminMember {
  id: string
  username: string | null
  displayName: string | null
  /** NULL means we hold no address for them, never that one is hidden. */
  email: string | null
  status: AdminMemberStatus
  joinedAt: string
  onboardedAt: string | null
  hasCard: boolean
  connectStarted: boolean
  connectKycComplete: boolean
  /**
   * The version of each legal text this member accepted, as stored — NULL if
   * they never have. A version string rather than a boolean, because "accepted
   * an older text" and "accepted nothing" are different facts about a person
   * and the roster must not collapse them.
   */
  readerTermsVersion: string | null
  writerTermsVersion: string | null
  articlesPublished: number
  /**
   * Their outbound payouts, frozen — the `payouts_halted_accounts` row, by the
   * reconciler (a books divergence it could attribute) or by an operator (a
   * legal hold, D9 §4.1). NULL means nothing is frozen. The CLASS is carried
   * rather than a boolean because the two are cleared for different reasons and
   * by different people: releasing a reconciler's halt because you took it for
   * your own is the mistake this field exists to prevent.
   */
  payoutsHalted: { mismatchClass: string; since: string } | null
}

export interface AdminMembers {
  /** Counts over the SEARCH alone, so switching status filters doesn't move
   *  the numbers on the filters you are switching between. */
  byStatus: Record<AdminMemberStatus, number>
  /** How many the current search + status actually match — derived from
   *  `byStatus`, so the two can never disagree. */
  matched: number
  truncated: boolean
  shown: number
  members: AdminMember[]
}

export interface AdminContent {
  articles: {
    totalPublished: number
    publishedLast7d: number
    publishedLast30d: number
    paywalledCount: number
    freeCount: number
    avgPricePence: number | null
  }
  notes: { total: number; last7d: number; last30d: number }
  engagement: {
    totalReadEvents: number
    readEventsLast7d: number
    totalComments: number
    commentsLast7d: number
    totalVotes: number
    votesLast7d: number
  }
  drives: {
    openCount: number
    fundedCount: number
    publishedCount: number
    fulfilledCount: number
    activePledgedPence: number
  }
  health: {
    feedScoresRefreshedAt: string | null
    feedScoresStalenessMinutes: number | null
    jetstreamHealthy: boolean | null
    relayOutboxPending: number
    relayOutboxOldestPendingAt: string | null
    relayOutboxFailed: number
  }
}

export interface AdminConfigRow {
  key: string
  value: string
  description: string | null
  updatedAt: string
  readOnly: boolean
}

export interface AdminRegulatory {
  rolling12MonthRevenuePence: number
  currentMonthRevenuePence: number
  annualisedRunRatePence: number
  thresholds: {
    tradingAllowance: {
      thresholdPence: number
      currentPence: number
      percentUsed: number
      status: 'within' | 'exceeded'
    }
    vatRegistration: {
      thresholdPence: number
      warningPct: number
      currentPence: number
      percentUsed: number
      status: 'clear' | 'approaching' | 'exceeded'
    }
    corporationTax: {
      smallProfitsThresholdPence: number
      mainRateThresholdPence: number
      currentRevenuePence: number
      status: 'below_small_profits' | 'marginal_relief' | 'main_rate'
    }
  }
  custody: {
    totalHeldPence: number
    oldestHeldDays: number
    warningThresholdDays: number
    status: 'normal' | 'warning'
  }
  financialYear: { start: string; end: string; daysRemaining: number }
}

export interface AdminWaitlist {
  totals: {
    total: number
    joinedLast7d: number
    /** Rows with an account behind them. */
    admitted: number
    /** Admitted, invitation not sent — since the admit/invite split this is
     *  also a cohort deliberately waiting to be told, so it is not a failure. */
    admittedNotInvited: number
    /** Of those, the ones whose last send FAILED — the state that wants a retry. */
    inviteFailed: number
  }
  /** When the operator digest last went out; null = never (CLOSED-BETA-ADR §XI.4). */
  lastDigestAt: string | null
  /** True when the list exceeded the route's cap — never a silent truncation. */
  truncated: boolean
  shown: number
  entries: Array<{
    email: string
    joinedAt: string
    /** An account exists for this address (migration 163). */
    admittedAt: string | null
    /** The invitation email went. Separate: the two can fail apart. */
    invitedAt: string | null
    /** The last send failed (cleared by a good one) — the retry cue. */
    inviteFailedAt: string | null
    /** In the designated seed? null = no account, or nothing designated.
     *  false on an admitted row is the repair cue: admitting again re-appends. */
    inSeed: boolean | null
    /** Signed in yet (the age declaration)? null = no account. Until true,
     *  other members' source lists do not name them. */
    arrived: boolean | null
    /** Who they became; null if unadmitted, or if that account was deleted. */
    username: string | null
  }>
}

/**
 * Funds segregation, measured (PAYMENT-PERIMETER-ADR W2).
 *
 * Two DIFFERENT numbers, never to be merged into one "segregation %":
 * `coverage` is charge-side (of what readers paid, how much Stripe held in
 * allocated state); `residual` is payout-side (of what we paid out, how much
 * moved from platform balance). Both are null when the window holds nothing
 * measurable — which is not 0%, and the panel must say so in words.
 */
export interface AdminAllocationCoverage {
  /** The operator brake. False ⇒ nothing is allocated at all, by design. */
  allocatedFundsEnabled: boolean
  coverage: {
    windowDays: number
    measuredCount: number
    measuredPence: number
    allocatedPence: number
    coverageBps: number
    unallocatedCount: number
    unallocatedPence: number
  } | null
  /** Settlements we have not read an allocation for — neither covered nor not. */
  unmeasured: { count: number; pence: number }
  residual: {
    windowDays: number
    totalPence: number
    residualPence: number
    residualBps: number
    thresholdBps: number
    breached: boolean
  } | null
}

/**
 * Money the platform over-collected and owes readers back.
 *
 * A reading tab can no longer hold a credit (migration 206): an over-collection
 * is moved out into a payable the moment it would exist, so no reader has a
 * spendable claim against future reads. Reader Terms 4.3 promises to refund it
 * to the card it came from; the resolution depends on the cause —
 * `docs/runbooks/reader-tab-credit.md`, whose causes have different answers.
 *
 * `count` and `totalCreditPence` are UNCAPPED; `accounts` is a sample capped at
 * `sampleLimit`, deepest first. Render the count, never `accounts.length` — a
 * capped list read as a total is the silence the detector exists to end.
 */
/**
 * One OPEN payable — what the Refund button acts on (L3.1).
 *
 * It carries facts and no verdict, deliberately. Whether a payable CAN be
 * refunded depends on its source settlement still carrying a Stripe charge and
 * not having been reversed, and the payment service is the one home for those
 * rules; asking the same question here would be a second definition of
 * "refundable" that could start disagreeing with what the button does. So the
 * operator presses and the route answers in a sentence.
 */
export interface AdminReaderCreditPayable {
  creditId: string
  /** POSITIVE pence. */
  amountPence: number
  createdAt: string | null
  sourceRefTable: string
  /** A refund is reserved on this payable and has not confirmed. */
  refundInFlight: boolean
  /** Why the last attempt failed, if one did. Null is not "it succeeded". */
  refundFailureReason: string | null
}

/**
 * What one Refund press answers. Every ending is its own member: an operator
 * acts on this, and "could not refund" sends them to the runbook with no idea
 * which page. There is no member meaning "the money may or may not have gone"
 * — the service throws on that and the gateway answers 502, which arrives here
 * as `unknown`.
 */
export type AdminRefundResult =
  | { kind: 'refunded'; refundId: string; amountPence: number }
  | { kind: 'not_found' }
  | { kind: 'not_open'; status: string }
  | { kind: 'in_flight'; since: string }
  | { kind: 'untraceable'; why: string }
  | { kind: 'refund_failed'; reason: string }
  | { kind: 'refunded_raced_release'; refundId: string; amountPence: number }
  | { kind: 'unknown'; error: string }

export interface AdminReaderCredits {
  /** Readers owed money, uncapped. */
  count: number
  /** POSITIVE pence, uncapped: the whole of what is owed back. */
  totalCreditPence: number
  sampleLimit: number
  truncated: boolean
  accounts: Array<{
    accountId: string
    /** POSITIVE. A payable is a quantity; the ledger holds the signs. */
    creditPence: number
    /** How many separate over-collections make it up. */
    payableCount: number
    oldestAt: string | null
    username: string | null
    displayName: string | null
    lastSettlementId: string | null
    lastSettlementPence: number | null
    lastSettlementStatus: string | null
    lastSettlementIntent: string | null
    lastSettlementAt: string | null
    /** Every open payable behind `creditPence`. The figure is their sum. */
    payables: AdminReaderCreditPayable[]
  }>
}

/** What the seed append did for one admitted row (RESHAPE-PLAN-2026-10 §A.2.1). */
export type AdminSeedAppend = 'appended' | 'already_present' | 'no_seed' | 'seed_full' | 'error'

/** One row of an Admit press. Admitting sends nothing — Invite is its own act. */
export type AdminWaitlistAdmitRow =
  | {
      email: string
      outcome: 'admitted' | 'already_admitted'
      /** False when they already had an account and were linked, not created. */
      accountCreated: boolean
      username: string | null
      seed: AdminSeedAppend
    }
  | { email: string; outcome: 'not_on_list' | 'removed_meanwhile' | 'admit_in_progress' | 'error' }

export interface AdminWaitlistAdmitResult {
  results: AdminWaitlistAdmitRow[]
  admitted: number
  /** Rows that did not end with an account — counted, never omitted. */
  skipped: number
  seedAppended: number
}

export type AdminInviteOutcome =
  | 'invited'
  | 'send_failed'
  | 'already_invited'
  | 'not_admitted'
  | 'admit_in_progress'
  | 'not_on_list'
  | 'error'

export interface AdminWaitlistInviteResult {
  results: Array<{ email: string; outcome: AdminInviteOutcome }>
  invited: number
  skipped: number
}

/**
 * The outcome of one Remove click.
 *
 * There is nothing to report but the fact: the row is gone, no account was
 * touched, and nothing was emailed. The refusals are the interesting half and
 * they arrive as errors — 409 for an admitted row, 404 for an address that is
 * no longer there.
 */
export interface AdminWaitlistRemoveResult {
  email: string
  removed: true
}

/**
 * The writers' waiting list (READER-WRITER-SPLIT-ADR §8): readers who pressed
 * "Apply to write", oldest first, and the record of who was granted.
 * `web/tests/admin-writer-applications-wire.test.ts` pins these fields and
 * the refusal codes against `gateway/src/routes/admin-dashboard.ts`.
 */
export interface AdminWriterApplicant {
  accountId: string
  username: string | null
  displayName: string | null
  /** `accounts.status` — a suspended applicant is shown, not hidden. */
  status: string
  memberSince: string
  appliedAt: string
}

export interface AdminWriterApplications {
  totals: { pending: number; granted: number }
  truncated: boolean
  pending: AdminWriterApplicant[]
  granted: Array<AdminWriterApplicant & { grantedAt: string; grantedBy: string | null }>
}

/** Whether the "you can now publish" email went. The grant stands either way. */
export const WRITER_GRANT_EMAILED = ['sent', 'failed', 'no_address'] as const
export type AdminWriterGrantEmailed = (typeof WRITER_GRANT_EMAILED)[number]

export interface AdminWriterGrantResult {
  outcome: 'granted'
  emailed: AdminWriterGrantEmailed
}

/** The grant route's chosen refusals (404, 404, 409). */
export const WRITER_GRANT_REFUSALS = ['no_application', 'no_account', 'already_writer'] as const

/**
 * What every new account is seeded from (FEED-FORMULAS-ADR D6, Phase 2).
 *
 * One mechanism since migration 179 dropped `feeds.is_starter_template`: the
 * operator-designated formula. `designated: null` is a real and legal state —
 * a database where nobody has designated one yet — and the panel says so
 * plainly rather than rendering an empty box, because an operator who cannot
 * see which object is load-bearing is exactly how the flag got deleted twice.
 */
export interface AdminSeedFormula {
  designated: {
    id: string
    name: string
    description: string | null
    sourceCount: number
    excludedCount: number
    createdAt: string
    authorName: string | null
    /** False = a member's formula seeds every signup, and their account can no longer be deleted. */
    authorIsSelf: boolean
    /** The feed it was cut from, or null if that feed has since been deleted.
     *  Present = *Re-cut from this feed* can refresh the seed from its current
     *  state; absent = only a different feed can replace it. */
    sourceFeedId: string | null
    /** Sources in this frozen seed that point at a SUSPENDED system and are
     *  therefore skipped at every signup (§0u.2). A seed is frozen at
     *  designation, so one cut before a suspension keeps carrying rows that can
     *  no longer travel; counted only while the suspension is live, so
     *  reinstating the system clears the warning with no re-cut. */
    suspendedSourceCount: number
    /** Of the seed's members, those a waitlist admission put there. */
    admittedCount: number
    /** Of those, the ones who have not signed in — named to nobody but you. */
    awaitingArrivalCount: number
  } | null
  /** The admin's own feeds — what this panel can cut into a new seed formula.
   *  The only thing it can act on: designating an EXISTING row retired with the
   *  live-link change (a seed is cut, never adopted), so there is no
   *  `candidates` list any more. */
  feeds: Array<{
    id: string
    name: string
    sourceCount: number
    /** Admitted members a re-cut from this feed would carry across (§A.2.7). */
    carryCount: number
  }>
}

export interface AdminSeedFormulaResult {
  designated: {
    id: string
    name: string | null
    sourceCount: number
    authorName: string | null
    authorIsSelf: boolean
  }
  /** Always true — designation always cuts a fresh frozen row. Kept on the wire
   *  because the panel's notice reads differently for a first designation and a
   *  replacement, and `replaced` is what distinguishes those. */
  minted: boolean
  replaced: { id: string; name: string } | null
  /** Admitted members carried from the retired seed, and those the cap refused. */
  carried: number
  carryDropped: number
}

export const adminDashboard = {
  overview: () => request<AdminOverview>('/admin/dashboard/overview'),
  users: () => request<AdminUsers>('/admin/dashboard/users'),
  content: () => request<AdminContent>('/admin/dashboard/content'),
  // The roster behind the Users tab's aggregates. `q` matches a literal
  // substring of the address, handle or display name — the route escapes the
  // ILIKE wildcards, so a typed `%` searches for a `%`. Omitting `status`
  // lists everyone who still exists; `status: 'deleted'` is the one filter
  // that widens rather than narrows.
  members: (opts: { q?: string; status?: AdminMemberStatus } = {}) => {
    const params = new URLSearchParams()
    if (opts.q) params.set('q', opts.q)
    if (opts.status) params.set('status', opts.status)
    const qs = params.toString()
    return request<AdminMembers>(`/admin/dashboard/members${qs ? `?${qs}` : ''}`)
  },
  // Both live in moderation.ts, which is the one home for an account's status
  // — never a second writer of `accounts.status` beside it. Suspending also
  // tombstones every event the account published, and reinstating does NOT
  // bring those back; the surface says so rather than implying a round trip.
  // BOTH TAKE A REASON (L5.5b). The member is emailed what was done and why
  // (D5 §9, D7 §5), so the reason is what the notice carries — required by
  // this call and by the gateway's schema.
  suspendAccount: (accountId: string, reason: string) =>
    request<{ ok: boolean; accountId: string; status: string }>(
      `/admin/suspend/${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),
  reinstateAccount: (accountId: string, reason: string) =>
    request<{ ok: boolean; accountId: string; status: string }>(
      `/admin/reinstate/${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),
  config: () => request<{ config: AdminConfigRow[] }>('/admin/dashboard/config'),
  // A REASON IS REQUIRED (L5.2). A dial edit changes what the platform does
  // with other people's money, and it is now recorded — actor, key, old, new,
  // reason — in `config_audit`, in the same transaction as the change. The
  // gateway's schema and the column's own CHECK refuse a blank one; the form
  // refuses it too, so nobody meets the 400 by accident.
  updateConfig: (updates: Array<{ key: string; value: string }>, reason: string) =>
    request<{ ok: boolean; updated: number }>('/admin/dashboard/config', {
      method: 'PATCH',
      body: JSON.stringify({ updates, reason }),
    }),
  // Releasing a payout halt — the inverse this dashboard displayed and did not
  // offer. Two routes because they are two halts: the platform-wide freeze and
  // one writer's. Same reason discipline as the refund above.
  resumePayouts: (reason: string) =>
    request<{ resumed: boolean }>('/admin/dashboard/resume-payouts', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resumeAccountPayouts: (accountId: string, reason: string) =>
    request<{ resumed: boolean; accountId?: string; error?: string }>(
      `/admin/dashboard/resume-payouts/${encodeURIComponent(accountId)}`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),
  // THE FREEZE, which until now was a psql INSERT written out in a policy
  // document (D9 §4.1). Silent to the member by design — no email, nothing
  // removed, sign-in unchanged — which is what makes it the right instrument
  // for a sanctions review and the wrong one for a moderation decision.
  //
  // `mismatchClass` is sent, never defaulted: it is what separates an
  // operator's legal hold from the reconciler's books divergence in the table
  // they share, and a default would put the choice in three places. The
  // vocabulary is pinned against the gateway's own by
  // `web/tests/operator-halt-wire.test.ts` — there is no module path between
  // the workspaces, so the strings agree only because something reads both.
  haltAccountPayouts: (accountId: string, reason: string, mismatchClass: OperatorHaltClass) =>
    request<{
      halted: boolean
      accountId?: string
      error?: string
      mismatchClass?: string
      reason?: string
      since?: string | null
    }>(`/admin/dashboard/halt-payouts/${encodeURIComponent(accountId)}`, {
      method: 'POST',
      body: JSON.stringify({ reason, mismatchClass }),
    }),
  regulatory: () => request<AdminRegulatory>('/admin/dashboard/regulatory'),
  allocationCoverage: () =>
    request<AdminAllocationCoverage>('/admin/dashboard/allocation-coverage'),
  readerCredits: () => request<AdminReaderCredits>('/admin/dashboard/reader-credits'),
  // The one outward money movement an operator can make (Reader Terms 4.3). The
  // reason is required by this call, by the gateway's schema, by the payment
  // service and by the column's own CHECK — money leaving with nothing said
  // about why is a payment and not a record.
  //
  // It reads the body on a non-2xx as well as a 2xx, because every refusal here
  // is a different thing to do about it and `request`'s generic throw would
  // flatten all six into one.
  refundReaderCredit: async (creditId: string, reason: string): Promise<AdminRefundResult> => {
    try {
      return await request<AdminRefundResult>('/admin/dashboard/refund', {
        method: 'POST',
        body: JSON.stringify({ creditId, reason }),
      })
    } catch (err) {
      // EVERY REFUSAL IS ITS OWN ANSWER, so the non-2xx body is READ rather
      // than collapsed into a thrown error: the service distinguishes six
      // endings precisely because each one is a different thing for the
      // operator to do next.
      if (err instanceof ApiError && err.body && typeof err.body.kind === 'string') {
        return err.body as AdminRefundResult
      }
      // A 400 is this gateway refusing the request shape — deterministic, and
      // nothing was sent to Stripe. Saying "it may have been made" here would
      // send an operator to check Stripe for a request that never left.
      if (err instanceof ApiError && err.status === 400) {
        return { kind: 'refund_failed', reason: apiErrorMessage(err) ?? 'validation_failed' }
      }
      // Anything else — a refused connection, a timeout, an unreadable body —
      // is NOT proof that nothing happened.
      return {
        kind: 'unknown',
        error: 'The refund could not be confirmed. It MAY have been made — reload and check before trying again.',
      }
    }
  },
  seedFormula: () => request<AdminSeedFormula>('/admin/dashboard/seed-formula'),
  // No "clear" call, deliberately: undesignating happens only by designating a
  // replacement (D11), and the schema refuses to revoke or delete the row. One
  // body, because a seed is always CUT from a feed and never adopted from an
  // existing row (FEED-SHARE-LIVE-LINKS-ADR L5).
  designateSeedFormula: (body: { feedId: string; name?: string; carryAdmitted?: boolean }) =>
    request<AdminSeedFormulaResult>('/admin/dashboard/seed-formula', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  waitlist: () => request<AdminWaitlist>('/admin/dashboard/waitlist'),
  // Makes accounts and appends them to the seed; sends NOTHING. `reason` is
  // the operator's note for the batch, recorded on every seed append.
  admitWaitlisters: (emails: string[], reason: string) =>
    request<AdminWaitlistAdmitResult>('/admin/dashboard/waitlist/admit', {
      method: 'POST',
      body: JSON.stringify({ emails, reason }),
    }),
  inviteWaitlisters: (body: { emails: string[] } | { allPending: true }) =>
    request<AdminWaitlistInviteResult>('/admin/dashboard/waitlist/invite', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Deletes the row outright, and only while it is still waiting — an admitted
  // row is the record of an account we made, not a request we can drop. A
  // removed address is not blocked: if they sign up again they reappear.
  removeWaitlister: (email: string) =>
    request<AdminWaitlistRemoveResult>('/admin/dashboard/waitlist/remove', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  writerApplications: () =>
    request<AdminWriterApplications>('/admin/dashboard/writer-applications'),
  // Admits one member as a writer: the column, the application's stamp and a
  // config_audit row carrying `reason`, then the email after commit.
  grantWriterAccess: (accountId: string, reason: string) =>
    request<AdminWriterGrantResult>('/admin/dashboard/writer-applications/grant', {
      method: 'POST',
      body: JSON.stringify({ accountId, reason }),
    }),
  // Nothing reaps dead jobs automatically (§8.15): clearing a row destroys the
  // evidence the surface exists to show. `scope` is required and there is no
  // "clear everything" — reaping a cron row hides a fault, reaping a per-entity
  // one tidies debris.
  reapDeadJobs: (scope: 'cron' | 'per_entity') =>
    request<{ cleared: number }>('/admin/dashboard/dead-jobs/reap', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),
  // Both run a whole cron cycle early, so both take a reason, recorded in
  // `config_audit` before anything runs (walkthrough A17). A refusal carrying
  // `not_recorded` is the one failure that means nothing ran.
  triggerSettlements: (reason: string) =>
    request<{ settlementTriggered: number }>('/admin/dashboard/trigger-settlements', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  triggerPayouts: (reason: string) =>
    request<{ processed: number; totalPaidPence: number }>('/admin/dashboard/trigger-payouts', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
}
