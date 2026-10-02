import { request } from './client'

// =============================================================================
// The moderation queue's client — and it says what the gateway says.
//
// Every field and every string below is the gateway's, not an invention of
// this file. It shipped as an invention: the client sent `remove|suspend|
// dismiss` against a zod enum of `no_action|remove_content|suspend_account`
// and `?status=pending` against a route that reads `?all=true`, and read a
// row of `targetType`/`reason`/`contentPreview`/`resolution` off a response
// that has never carried any of them. So every action was a 400 the page
// rendered as "Failed to take action.", the Resolved tab returned the open
// list, and a resolved report kept its buttons (the status it compared
// against, `'resolved'`, is not one of the four the column can hold).
//
// It typechecked throughout, because a hand-written interface is a claim about
// a server that nothing checks. What checks it is `web/tests/admin-report-
// wire.test.ts`, which reads the action names and the query key out of
// `gateway/src/routes/moderation.ts`.
// =============================================================================

/** `report_status` — the four values the column can hold. */
export type ReportStatus =
  | 'open'
  | 'under_review'
  | 'resolved_removed'
  | 'resolved_no_action'
  // `warn` removes nothing and is not "no action" either (migration 222).
  | 'resolved_actioned'

/**
 * `report_category` — what the reporter picked (see `ReportButton`).
 *
 * A runtime array, not a bare union, for this file's own stated reason: a type
 * cannot be compared against anything at test time, and there is no module path
 * between the workspaces, so the only way to know the web and the gateway agree
 * is to READ the gateway's file. `admin-report-wire.test.ts` reads
 * `gateway/src/lib/report-taxonomy.ts` and pins this array against it.
 *
 * Twelve values since L6.3: D1 §9.2's priority-offence list, which is what the
 * published risk assessment says reporting covers. The four originals are kept
 * — an enum value cannot be dropped, and `illegal_content` is now D1's "other
 * illegal content" while `harassment` is its "threats and harassment".
 */
export const REPORT_CATEGORIES = [
  'csam',
  'grooming',
  'terrorism',
  'intimate_image_abuse',
  'cyberflashing',
  'hate',
  'harassment',
  'self_harm_promotion',
  'fraud',
  'illegal_content',
  'spam',
  'other',
] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]

/** `moderation_reports.priority` — derived by the gateway from the category. */
export type ReportPriority = 'P0' | 'P1' | 'P2'

/**
 * The three the gateway's `ResolveReportSchema` accepts. Nothing else.
 *
 * A runtime array rather than a bare union, because a type cannot be compared
 * against anything at test time — and the whole fault this file is fixing was
 * a set of strings nothing ever compared against the server's.
 */
export const REPORT_ACTIONS = [
  'no_action',
  'warn',
  'remove_content',
  'suspend_7d',
  'suspend',
  'terminate',
] as const
export type ReportAction = (typeof REPORT_ACTIONS)[number]

export interface Report {
  id: string
  reporterUsername: string | null
  targetNostrEventId: string | null
  targetAccountUsername: string | null
  targetAccountId: string | null
  targetPostId: string | null
  targetConversationId: string | null
  targetProfileId: string | null
  targetProfileUsername: string | null
  subjectAccountId: string | null
  subjectUsername: string | null
  category: ReportCategory
  priority: ReportPriority | null
  notes: string | null
  /** The content as reported, captured at filing (D7 §8). Shape varies by
   *  target kind and is rendered as what it is, never parsed into a claim. */
  snapshot: Record<string, unknown> | null
  status: ReportStatus
  action: ReportAction | null
  reason: string | null
  reasoning: string | null
  appealDeadline: string | null
  appealedAt: string | null
  appealText: string | null
  appealOutcome: 'upheld' | 'reversed' | null
  appealReasoning: string | null
  appealDecidedAt: string | null
  createdAt: string
  triagedAt: string | null
  reviewedAt: string | null
  /** Derived from priority + createdAt by the gateway (D7 §2's triage table). */
  triageDeadline: string | null
  /** A reviewer's raise (§0z item 8): who, when, why — null when never raised. */
  priorityRaisedAt: string | null
  priorityRaisedByUsername: string | null
  priorityRaiseReason: string | null
}

export interface PlatformBlock {
  id: string
  kind: 'source' | 'npub'
  protocol: string
  target: string
  reason: string
  blockedAt: string
  blockedByUsername: string | null
  /** How many `external_sources` rows this block currently matches — the
   *  difference between a live refusal and a typo. */
  matchedSources: number
}

export interface ReportList {
  reports: Report[]
  /** Open reports across the whole table, not just this page. */
  openCount: number
  /** Reports past their D7 §2 triage deadline and still untriaged. Counted in
   *  SQL over the whole table — a figure about a source is computed from the
   *  source, never from the page a filter left. */
  overdueCount: number
  /** Appeals filed and not yet decided (D7 §5 gives them 7 days). */
  openAppealCount: number
  /** Echoed back so the page can tell a full page from a complete list. */
  limit: number
  offset: number
}

export function isResolved(status: ReportStatus): boolean {
  return (
    status === 'resolved_removed' ||
    status === 'resolved_no_action' ||
    status === 'resolved_actioned'
  )
}

export const admin = {
  /**
   * Default is open + under_review. `all` is the only filter the route has —
   * there is no resolved-only query, so the Resolved tab asks for everything
   * and narrows here.
   */
  listReports: (opts: { all?: boolean; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.all) q.set('all', 'true')
    if (opts.limit !== undefined) q.set('limit', String(opts.limit))
    if (opts.offset !== undefined) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return request<ReportList>(`/admin/reports${qs ? `?${qs}` : ''}`)
  },

  /**
   * TWO SENTENCES, AND NEITHER SUBSTITUTES FOR THE OTHER.
   *
   * `reason` is what the MEMBER reads — emailed to them with the action and
   * written to be answerable (L5.5b; D5 §9, D7 §5). `reasoning` is the
   * judgement, for whoever reads the log afterwards, and D7 §8 makes it
   * mandatory even for an obvious call: "the log is the evidence that
   * judgements were made under this guidance". Both are now STORED (L6.4,
   * migration 223) — this docblock used to say the record did not exist.
   */
  resolveReport: (
    reportId: string,
    action: ReportAction,
    reason: string,
    reasoning: string
  ) =>
    request<{
      reportId: string
      status: ReportStatus
      action: ReportAction
      subjectAccountId: string | null
    }>(`/admin/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, reason, reasoning }),
    }),

  /** Take a report under review — the middle state of D7 §2's triage, which
   *  nothing had ever written. Stamps `triaged_at`, the column the deadline is
   *  measured against. */
  reviewReport: (reportId: string) =>
    request<{ reportId: string; status: ReportStatus }>(
      `/admin/reports/${reportId}/review`,
      { method: 'POST' }
    ),

  /**
   * Raise a report's priority (§0z item 8; Terms 9.3, D7 §2). "A credible
   * threat to life" and "anything plausibly involving a child" are P0 in the
   * published table and are judgements, not boxes — so the reviewer makes
   * them, with a reason the row keeps. A RAISE only: the gateway refuses a
   * lower value (`not_a_raise`) and a resolved report (`not_open`).
   */
  raiseReportPriority: (reportId: string, priority: ReportPriority, reason: string) =>
    request<{ reportId: string; priority: ReportPriority; triageDeadline: string }>(
      `/admin/reports/${reportId}/priority`,
      { method: 'PATCH', body: JSON.stringify({ priority, reason }) }
    ),

  /** Decide an appeal (D7 §5): uphold or reverse, reasoning recorded. */
  decideAppeal: (
    reportId: string,
    outcome: 'upheld' | 'reversed',
    reasoning: string
  ) =>
    request<{ reportId: string; outcome: string; accountLifted: boolean }>(
      `/admin/reports/${reportId}/appeal`,
      { method: 'PATCH', body: JSON.stringify({ outcome, reasoning }) }
    ),

  listBlocks: () => request<{ blocks: PlatformBlock[] }>('/admin/blocks'),

  addBlock: (input: {
    kind: 'source' | 'npub'
    target: string
    protocol?: string
    reason: string
  }) =>
    request<{ id: string; kind: string; protocol: string; target: string }>(
      '/admin/blocks',
      { method: 'POST', body: JSON.stringify(input) }
    ),

  /** Lifting a block is an operator act too: the reason is required, and the
   *  gateway writes it to `config_audit` beside the block's own row (§0z 12). */
  removeBlock: (id: string, reason: string) =>
    request<{ ok: boolean }>(`/admin/blocks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),
}
