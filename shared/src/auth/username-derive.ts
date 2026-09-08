import { pool } from '../db/client.js'
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from './username-rule.js'
import { randomBytes } from 'crypto'

// =============================================================================
// deriveUsername — the one home for MINTING a handle nobody typed.
//
// IT LIVES BESIDE THE RULE IT ENFORCES, and it moved here from
// `gateway/src/lib/account-provision.ts` for exactly the reason `username-rule`
// is its own file (see that header): two account-creation paths need it and one
// of them — `signup()` in this package — cannot import from a service.
//
// PAYWALL-ARRIVAL-ADR D9 is what forced the move. The arrival signup asks a
// stranger for two fields and derives the third, because a username field
// spends the last of a mid-article reader's patience on a decision they have no
// basis for making — they have not seen a profile, a byline or another member —
// and its failure mode is a REJECTION (23505 on a name they typed hopefully) at
// the one moment in this reader's life with us where a rejection costs most.
// The Google path never shows that field at all, so leaving it on the direct
// path put two offers on the same gate at visibly different prices.
//
// One mover, no second copy: the Google path keeps calling this function from
// its new home, and `gateway/src/lib/account-provision.ts` re-exports it so its
// existing test and callers are unchanged.
// =============================================================================

// A collision suffix is "-" + 6 hex characters. The BASE must be short enough
// that base + suffix still fits USERNAME_MAX_LENGTH — the old code sliced the
// base to the full 30 and then appended, minting 37-character handles that
// change-username would refuse.
const SUFFIX_LENGTH = 7
const MAX_BASE_WITH_SUFFIX = USERNAME_MAX_LENGTH - SUFFIX_LENGTH

/**
 * Reduce an arbitrary string to the character set a username may use.
 *
 * Hyphens survive only in the INTERIOR (USERNAME_RE forbids them at either
 * end), so they are trimmed after filtering rather than before — "-ed-" must
 * become "ed", and filtering first is what let a leading hyphen through.
 * Underscores are dropped rather than kept: the old code preserved them from
 * the email's local part, which produced handles like `a_b` that no member
 * could ever have chosen or retyped.
 */
function normaliseUsernamePart(raw: string, maxLength: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '')
}

/**
 * Derive a username from what we know: display name first (it is what a person
 * would have picked), the email's local part second.
 *
 * WHEN NEITHER IS LONG ENOUGH, THE ANSWER KEEPS THE PERSON IN IT. The floor
 * used to be the literal `user`, so every member whose address had a short
 * local part — `ed@all.haus`, `jo@…`, any two-letter initials — was handed
 * `user`, and the next one `user-a1b2c3`. That is not a cosmetic default: the
 * welcome sheet SHOWS a new member their handle and deliberately does not let
 * them change it there (the 30-day cooldown makes a hasty choice expensive), so
 * a derived handle is what someone lives with for a month. `ed` is a perfectly
 * good name that merely fails a length rule, so it is kept and disambiguated —
 * `ed-a1b2c3` — rather than thrown away for a word about nobody. Only a string
 * with no usable characters at all falls back to `user`, and even then it is
 * suffixed, because a bare `user` is a handle we hand out repeatedly.
 *
 * Everything returned satisfies USERNAME_RE, which is the point: a derived
 * handle outside the change-username rule is one its owner could not retype to
 * keep. And it is a DEFAULT, not a decision taken away: the first change is
 * free and immediate (`username_changed_at` starts NULL, so the 30-day cooldown
 * has not started), and `previous_username` keeps the old handle resolving.
 *
 * The uniqueness check is advisory, not a guarantee: two concurrent provisions
 * of the same base can both read "free". The UNIQUE constraint on
 * accounts.username is the real defence, and the caller surfaces a 23505 as a
 * retryable failure rather than pretending it can't happen.
 *
 * Exported for tests — the branch table is the whole behaviour, and it is
 * pure apart from the one availability read.
 */
export async function deriveUsername(
  email: string,
  displayName: string,
): Promise<string> {
  const fromDisplayName = normaliseUsernamePart(
    displayName,
    USERNAME_MAX_LENGTH,
  )
  const fromEmail = normaliseUsernamePart(
    email.split('@')[0] ?? '',
    USERNAME_MAX_LENGTH,
  )

  // A base long enough to stand alone. Display name wins; the email's local
  // part is the fallback.
  const standalone = [fromDisplayName, fromEmail].find(
    (c) => c.length >= USERNAME_MIN_LENGTH,
  )

  // Otherwise keep whatever usable characters we have and let the suffix carry
  // it over the minimum. `user` is the floor only when there is nothing at all.
  const shortBase = [fromDisplayName, fromEmail].find((c) => c.length > 0)
  const base = (standalone ?? shortBase ?? 'user').slice(
    0,
    standalone ? USERNAME_MAX_LENGTH : MAX_BASE_WITH_SUFFIX,
  )

  // A base that could not stand alone is ALWAYS suffixed — it is under the
  // minimum length, so the bare form is not a legal username at all.
  const mustSuffix = standalone === undefined

  const { rows: existing } = await pool.query<{ username: string }>(
    `SELECT username FROM accounts WHERE username = $1 OR username LIKE $2 ORDER BY username`,
    [base, `${base}-%`],
  )
  const taken = new Set(existing.map((r) => r.username))

  if (!mustSuffix && !taken.has(base)) return base

  // Truncate before suffixing so the result still fits. A standalone base can
  // be up to the full 30; adding a suffix to that would overflow.
  const suffixBase = base.slice(0, MAX_BASE_WITH_SUFFIX).replace(/-+$/g, '')
  let username: string
  do {
    username = `${suffixBase}-${randomBytes(3).toString('hex')}`
  } while (taken.has(username))

  return username
}
