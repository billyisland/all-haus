import { pool } from "@platform-pub/shared/db/client.js";
import type { PoolClient } from "pg";
import { termsAcceptanceIsCurrent } from "@platform-pub/shared/lib/terms-versions.js";

// =============================================================================
// "Has this member accepted the text this act rests on?" — the one home
//
// Two acts on this platform sell paid access, and each rests on a document the
// member agreed to (operator decision A3, 2026-09-16):
//
//   READER  — registering a card. The Reader Terms are what the reading tab
//             runs on, so the acceptance rides the card write itself
//             (`POST /auth/connect-card`). Everyone who registered a card
//             BEFORE the text existed is the cohort the reader refusal below
//             exists for: they are asked once, at the next act that would put
//             money on the tab — a paid read (the gate pass) or a
//             subscription (the writer and publication subscribe routes,
//             §0z item 5, which until 2026-09-18 debited the tab with no
//             acceptance recorded).
//   WRITER  — the first paywalled publish. The code sells paid access before
//             Connect onboarding, so the publish is the acceptance point, not
//             the payout setup.
//
// WHY A SHARED MODULE AND NOT TWO INLINE QUERIES. Three call sites each ask the
// writer question (`POST /articles`, the schedule route, the server-side
// publisher) and three ask the reader one (the gate pass and the two subscribe
// routes), and the comparison is the part that is
// easy to get wrong: a version is `major.text` and ONLY `major` is compared
// (`shared/src/lib/terms-versions.ts`), so a hand-rolled
// `version IS DISTINCT FROM $1` in SQL would re-prompt the entire membership
// for a typo fix. The comparison therefore happens in TypeScript, through
// `termsAcceptanceIsCurrent`, and the SQL only ever reads the column.
//
// THE WRITER QUESTION FAILS CLOSED, THE READER QUESTION DOES NOT, and the
// asymmetry is deliberate. A missing account row on the writer side answers
// "outstanding": the refusal costs a retry, a wrong "accepted" sells paid
// access under a text nobody agreed to. On the reader side the predicate is
// "has a card AND is behind", so a missing row has no card and is not behind —
// answering "outstanding" there would put a terms wall in front of a reader
// whose real problem is that their account is gone, which the gate pass says
// better a few steps later.
// =============================================================================

/** Thrown by the server-side publisher; the scheduler un-schedules on it. */
export class WriterTermsRequiredError extends Error {
  constructor(writerId: string) {
    super(
      `Writer ${writerId} has not accepted the current Writer Agreement — ` +
        `a paywalled publish is refused until they do.`,
    );
    this.name = "WriterTermsRequiredError";
  }
}

/** The refusal code both the gate pass and the publish routes answer with. */
export const WRITER_TERMS_REQUIRED = "writer_terms_required";
export const READER_TERMS_REQUIRED = "reader_terms_required";

/**
 * Is the current Writer Agreement OUTSTANDING for this writer?
 *
 * Asked only where the publish is paywalled — a free article is not a sale and
 * the Writer Agreement is not what it rests on. Takes an optional client so a
 * caller already inside a transaction asks on the same connection.
 */
export async function writerTermsOutstanding(
  writerId: string,
  client: Pick<PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await client.query<{ writer_terms_version: string | null }>(
    `SELECT writer_terms_version FROM accounts WHERE id = $1`,
    [writerId],
  );
  if (rows.length === 0) return true; // fails closed — see the header
  return !termsAcceptanceIsCurrent("writer", rows[0].writer_terms_version);
}

/**
 * Is the current Reader Terms text OUTSTANDING for this reader?
 *
 * TWO TERMS, AND THE CARD IS HALF OF IT. A reader with no card has nothing to
 * accept yet: the free allowance is a gift, not a sale, and the acceptance is
 * collected at card registration where the reader is standing in front of the
 * sentence. So this asks only of a reader who HAS a card — which is exactly the
 * pre-text cohort — and a card-less reader is never turned away from a read
 * that costs them nothing.
 */
export async function readerTermsOutstanding(
  readerId: string,
  client: Pick<PoolClient, "query"> = pool,
): Promise<boolean> {
  const { rows } = await client.query<{
    has_card: boolean;
    reader_terms_version: string | null;
  }>(
    `SELECT (stripe_customer_id IS NOT NULL) AS has_card, reader_terms_version
       FROM accounts WHERE id = $1`,
    [readerId],
  );
  if (rows.length === 0) return false; // no account ⇒ the gate pass fails later anyway
  if (!rows[0].has_card) return false;
  return !termsAcceptanceIsCurrent("reader", rows[0].reader_terms_version);
}
