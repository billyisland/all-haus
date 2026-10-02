// =============================================================================
// THE REPORTING VOCABULARY, AND WHAT EACH WORD COMMITS US TO
//
// D1 §9.2 says reporting covers the priority-offence list; D7 §2 turns that
// list into a triage table with deadlines we have published. The two are one
// fact and this file is where it lives: a category is not a label, it is the
// thing that decides whether we owe an answer in 24 hours, 72 hours or 7 days.
//
// WHY THE PRIORITY IS DERIVED AND NOT CHOSEN. A reporter picks the category;
// nobody picks the priority. Letting the client send one would make the
// deadline a thing a stranger sets, and letting the reviewer set it at triage
// would leave every untriaged report — precisely the ones with a deadline
// running — with no priority at all. So the filing route computes it, which is
// also what makes "reports over their deadline" a query rather than a judgement.
//
// IT IS THE CLAIM, NOT THE FINDING. A report filed as `csam` is triaged as P0
// because that is what was ALLEGED; the assessment that follows may find
// nothing. D7 §2's table is explicitly about what a report says. What the
// reviewer concluded goes in `reasoning` and `action`, which is a different
// column for a different reason.
//
// THE FOUR OLD VALUES ARE KEPT, not migrated away. An enum value cannot be
// dropped, and a report filed in 2026 under `illegal_content` said
// `illegal_content`; rewriting history to the finer vocabulary would make the
// record say a reporter chose a word that did not exist. `illegal_content` is
// now D1's "other illegal content" and `harassment` its "threats and
// harassment", which is what both have always meant.
//
// The web carries its own copy of the labels (there is no module path between
// the workspaces) and `web/tests/admin-report-wire.test.ts` reads THIS FILE to
// hold the two together — a category the gateway accepts and the web cannot
// name, or the reverse, is the class of fault that whole test exists for.
// =============================================================================

/**
 * Every value `report_category` can hold, in the order the report dialog offers
 * them: gravest first, the two ToS-only ones last.
 *
 * A runtime `as const` array with the type derived from it, never a bare union
 * — a type cannot be compared against anything at test time, and this one is
 * pinned against `schema.sql`'s enum and against the web's copy.
 */
export const REPORT_CATEGORIES = [
  "csam",
  "grooming",
  "terrorism",
  "intimate_image_abuse",
  "cyberflashing",
  "hate",
  "harassment",
  "self_harm_promotion",
  "fraud",
  "illegal_content",
  "spam",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_PRIORITIES = ["P0", "P1", "P2"] as const;
export type ReportPriority = (typeof REPORT_PRIORITIES)[number];

/**
 * D7 §2's triage table, as hours.
 *
 * P0  CSAM; terrorism; credible threat to life; a report plausibly involving a
 *     child user                                                           24h
 * P1  All other illegal-content categories                                 72h
 * P2  ToS-only breaches; quality/civility complaints                    7 days
 *
 * "Triage" there means reviewed, classified, and either decided or escalated —
 * not merely opened. The deadline this file computes is the triage deadline,
 * which is why it is stamped from `created_at` and stops mattering once
 * `triaged_at` is set.
 */
export const TRIAGE_HOURS: Record<ReportPriority, number> = {
  P0: 24,
  P1: 72,
  P2: 24 * 7,
};

/** D7 §5: "Appeals decided within 7 days". The window a subject has to file one. */
export const APPEAL_WINDOW_DAYS = 7;

/**
 * P0 is the categories, and only the categories, D7 §2 names by name. "Credible
 * threat to life" and "a report plausibly involving a child user" are also P0
 * there and are deliberately NOT here: neither is a box a reporter can tick —
 * both are judgements about the material — so a reviewer raises the priority at
 * triage, through `PATCH /admin/reports/:id/priority` (reason required, the
 * raise on the row; migration 226). Until §0z item 8 that sentence described
 * a route that did not exist, and Terms 9.3's 24 hours for those two had no
 * instrument. A derivation that pretended to make them would be claiming a
 * finding from a click.
 */
const P0: ReadonlySet<string> = new Set(["csam", "grooming", "terrorism"]);

/** D7 §2's bottom row: breaches of our terms that are not illegal-content claims. */
const P2: ReadonlySet<string> = new Set(["spam", "other"]);

export function priorityForCategory(category: ReportCategory): ReportPriority {
  if (P0.has(category)) return "P0";
  if (P2.has(category)) return "P2";
  return "P1";
}

/** The triage deadline for a report filed at `createdAt`. The clock is an
 *  ARGUMENT, never `Date.now()`, so a test can stand either side of it. */
export function triageDeadline(
  priority: ReportPriority,
  createdAt: Date,
): Date {
  return new Date(createdAt.getTime() + TRIAGE_HOURS[priority] * 3_600_000);
}
