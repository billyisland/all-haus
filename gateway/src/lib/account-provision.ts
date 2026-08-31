import {
  pool,
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { generateKeypair } from "./key-custody-client.js";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@platform-pub/shared/auth/username-rule.js";
import { randomBytes } from "crypto";

// =============================================================================
// provisionAccount — create an account for an email, WITHOUT a session
//
// The one home for "make this address a member". Two callers, and they must not
// drift:
//
//   • the Google OAuth exchange's unknown-email branch (open-beta only — closed
//     beta refuses before it reaches here, CLOSED-BETA-ADR D1);
//   • the operator's Admit action on the waitlist panel (§XI.2), which is
//     deliberately allowed to bypass that gate — an admission IS the decision
//     the gate exists to reserve to a person.
//
// SEPARATE FROM `signup()` IN shared/auth/accounts.ts ON PURPOSE. That function
// takes a FastifyReply and calls createSession on it, because it serves the
// self-service path where the account holder is the one making the request.
// Neither caller here is: driving it from the admit route would set the NEW
// USER'S session cookie on the ADMIN'S response — logging the operator out of
// their own account and into the prospect's, once per admission. The session is
// the whole difference, so this provisions and stops.
//
// What it does create, matching signup() field for field: the account row with
// its custodial keypair (minted by key-custody, so the gateway never sees the
// account key), status 'active', the 500p free allowance, and the reading tab
// every reader needs. Starter feeds are NOT seeded here — they seed lazily on
// the owner's first feed list (`seedStarterFeeds`, feeds/crud.ts), so a member
// provisioned by either path gets them on first load.
//
// The allowance comes from the `free_allowance_pence` dial (migration 169), not
// a literal — and it is stamped onto BOTH columns: granted (what this reader was
// gifted, a historical fact never restated) and remaining (what is left, which
// starts equal). `signup()` must stay in step; it is the twin of this INSERT.
// =============================================================================

// A collision suffix is "-" + 6 hex characters. The BASE must be short enough
// that base + suffix still fits USERNAME_MAX_LENGTH — the old code sliced the
// base to the full 30 and then appended, minting 37-character handles that
// change-username would refuse.
const SUFFIX_LENGTH = 7;
const MAX_BASE_WITH_SUFFIX = USERNAME_MAX_LENGTH - SUFFIX_LENGTH;

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
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, "");
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
 * keep.
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
  );
  const fromEmail = normaliseUsernamePart(
    email.split("@")[0] ?? "",
    USERNAME_MAX_LENGTH,
  );

  // A base long enough to stand alone. Display name wins; the email's local
  // part is the fallback.
  const standalone = [fromDisplayName, fromEmail].find(
    (c) => c.length >= USERNAME_MIN_LENGTH,
  );

  // Otherwise keep whatever usable characters we have and let the suffix carry
  // it over the minimum. `user` is the floor only when there is nothing at all.
  const shortBase = [fromDisplayName, fromEmail].find((c) => c.length > 0);
  const base = (standalone ?? shortBase ?? "user").slice(
    0,
    standalone ? USERNAME_MAX_LENGTH : MAX_BASE_WITH_SUFFIX,
  );

  // A base that could not stand alone is ALWAYS suffixed — it is under the
  // minimum length, so the bare form is not a legal username at all.
  const mustSuffix = standalone === undefined;

  const { rows: existing } = await pool.query<{ username: string }>(
    `SELECT username FROM accounts WHERE username = $1 OR username LIKE $2 ORDER BY username`,
    [base, `${base}-%`],
  );
  const taken = new Set(existing.map((r) => r.username));

  if (!mustSuffix && !taken.has(base)) return base;

  // Truncate before suffixing so the result still fits. A standalone base can
  // be up to the full 30; adding a suffix to that would overflow.
  const suffixBase = base.slice(0, MAX_BASE_WITH_SUFFIX).replace(/-+$/g, "");
  let username: string;
  do {
    username = `${suffixBase}-${randomBytes(3).toString("hex")}`;
  } while (taken.has(username));

  return username;
}

export interface ProvisionedAccount {
  accountId: string;
  username: string;
}

/**
 * Create an active account for `email` and return it. No session is set.
 *
 * `email` must already be lower-cased and trimmed by the caller (both callers
 * normalise for their own lookups first, and normalising twice in two places
 * is how the two copies drift apart).
 */
export async function provisionAccount(
  email: string,
  displayName: string,
): Promise<ProvisionedAccount> {
  const keypair = await generateKeypair();
  const username = await deriveUsername(email, displayName);

  const { freeAllowancePence } = await loadConfig();

  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         status, free_allowance_granted_pence, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
       RETURNING id`,
      [
        keypair.pubkeyHex,
        keypair.privkeyEncrypted,
        username,
        displayName,
        email,
        freeAllowancePence,
      ],
    );

    const accountId = result.rows[0].id;

    await client.query("INSERT INTO reading_tabs (reader_id) VALUES ($1)", [
      accountId,
    ]);

    return { accountId, username };
  });
}
