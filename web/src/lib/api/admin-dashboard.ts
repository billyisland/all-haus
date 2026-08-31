import { request } from './client'

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
    totalCreditPence: number
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
    }>
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
    /** Admitted but the invitation never went — the state that wants a retry. */
    admittedNotInvited: number
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

/** The outcome of one Admit click — what the operator needs told back. */
export interface AdminWaitlistAdmitResult {
  email: string
  admitted: true
  /** False when they already had an account and were linked, not created. */
  accountCreated: boolean
  username: string | null
  /** False = admitted, but the invitation didn't send. Retry with the same call. */
  invited: boolean
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
  } | null
  /** The admin's own feeds — what this panel can cut into a new seed formula.
   *  The only thing it can act on: designating an EXISTING row retired with the
   *  live-link change (a seed is cut, never adopted), so there is no
   *  `candidates` list any more. */
  feeds: Array<{ id: string; name: string; sourceCount: number }>
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
}

export const adminDashboard = {
  overview: () => request<AdminOverview>('/admin/dashboard/overview'),
  users: () => request<AdminUsers>('/admin/dashboard/users'),
  content: () => request<AdminContent>('/admin/dashboard/content'),
  config: () => request<{ config: AdminConfigRow[] }>('/admin/dashboard/config'),
  updateConfig: (updates: Array<{ key: string; value: string }>) =>
    request<{ ok: boolean; updated: number }>('/admin/dashboard/config', {
      method: 'PATCH',
      body: JSON.stringify({ updates }),
    }),
  regulatory: () => request<AdminRegulatory>('/admin/dashboard/regulatory'),
  allocationCoverage: () =>
    request<AdminAllocationCoverage>('/admin/dashboard/allocation-coverage'),
  seedFormula: () => request<AdminSeedFormula>('/admin/dashboard/seed-formula'),
  // No "clear" call, deliberately: undesignating happens only by designating a
  // replacement (D11), and the schema refuses to revoke or delete the row. One
  // body, because a seed is always CUT from a feed and never adopted from an
  // existing row (FEED-SHARE-LIVE-LINKS-ADR L5).
  designateSeedFormula: (body: { feedId: string; name?: string }) =>
    request<AdminSeedFormulaResult>('/admin/dashboard/seed-formula', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  waitlist: () => request<AdminWaitlist>('/admin/dashboard/waitlist'),
  admitWaitlister: (email: string) =>
    request<AdminWaitlistAdmitResult>('/admin/dashboard/waitlist/admit', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  // Deletes the row outright, and only while it is still waiting — an admitted
  // row is the record of an account we made, not a request we can drop. A
  // removed address is not blocked: if they sign up again they reappear.
  removeWaitlister: (email: string) =>
    request<AdminWaitlistRemoveResult>('/admin/dashboard/waitlist/remove', {
      method: 'POST',
      body: JSON.stringify({ email }),
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
  triggerSettlements: () =>
    request<{ settlementTriggered: number }>('/admin/dashboard/trigger-settlements', {
      method: 'POST',
    }),
  triggerPayouts: () =>
    request<{ processed: number; totalPaidPence: number }>('/admin/dashboard/trigger-payouts', {
      method: 'POST',
    }),
}
