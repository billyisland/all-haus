import type { ReportCategory, ReportPriority } from '../lib/api/admin'

// =============================================================================
// Reporting — the words, in one home for both registers.
//
// The full site's `components/ui/ReportButton.tsx` (a client component) and
// modernhaus's `/modernhaus/report` (bare HTML) offer the same twelve
// categories and promise the same deadlines. They live here because modernhaus
// cannot import a `'use client'` file. The reasoning behind them is in
// `ReportButton.tsx`'s header; the category ORDER is `REPORT_CATEGORIES` in
// `lib/api/admin.ts`, pinned against the gateway's.
// =============================================================================

/**
 * The offer, in the reporter's words rather than the schema's. Keyed by the
 * gateway's array, so a category that exists on one side and not the other is
 * a compile error here and a test failure in `admin-report-wire.test.ts`.
 */
export const REPORT_CATEGORY_LABEL: Record<ReportCategory, string> = {
  csam: 'Child sexual abuse material',
  grooming: 'Grooming, or a child at risk',
  terrorism: 'Terrorism or violent extremism',
  intimate_image_abuse: 'Intimate images shared without consent',
  cyberflashing: 'Unsolicited sexual images',
  hate: 'Hate directed at a protected group',
  harassment: 'Threats, harassment or stalking',
  self_harm_promotion: 'Encouraging suicide, self-harm or an eating disorder',
  fraud: 'Fraud or a scam',
  illegal_content: 'Something else illegal',
  spam: 'Spam or inauthentic behaviour',
  other: 'Something else against the rules',
}

/** D7 §2's promise, said as a length of time rather than a date. */
export const REPORT_TRIAGE_WORDS: Record<ReportPriority, string> = {
  P0: 'within 24 hours',
  P1: 'within 72 hours',
  P2: 'within 7 days',
}

/** The receipt: `Report submitted. A person will look at it within 72 hours.` */
export function reportReceipt(priority: ReportPriority): string {
  return `Report submitted. A person will look at it ${REPORT_TRIAGE_WORDS[priority]}.`
}

export const REPORT_TITLE = 'Report content'
export const REPORT_NOTES_PLACEHOLDER = 'Additional details (optional)'
export const REPORT_SUBMIT = 'Submit report'
export const REPORT_FAILED = 'Something went wrong. Please try again.'
export const REPORT_FOOTNOTE =
  'Reports are reviewed by a human. How quickly depends on what you report. Submitting a report does not automatically remove content.'
