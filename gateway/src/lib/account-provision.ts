import {
  withTransaction,
  loadConfig,
} from "@platform-pub/shared/db/client.js";
import { generateKeypair } from "./key-custody-client.js";
import { deriveUsername } from "@platform-pub/shared/auth/username-derive.js";
import { resolveArrivalGift } from "@platform-pub/shared/auth/arrival-gift.js";

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
// account key), status 'active', the free allowance, and the reading tab every
// reader needs. Starter feeds are NOT seeded here — they seed lazily on the
// owner's first feed list (`seedStarterFeeds`, feeds/crud.ts), so a member
// provisioned by either path gets them on first load.
//
// The allowance comes from the `free_allowance_pence` dial (migration 169), not
// a literal — and it is stamped onto BOTH columns: granted (what this reader was
// gifted, a historical fact never restated) and remaining (what is left, which
// starts equal). `signup()` must stay in step; it is the twin of this INSERT.
//
// THE ARRIVAL GIFT IS THE SECOND THING THE TWO MUST AGREE ON (PAYWALL-ARRIVAL
// D2). A reader who made this account from a paywall gets `dial + p`, and the
// arithmetic, the price lookup and the cap live in ONE place —
// `resolveArrivalGift` — precisely because this INSERT and signup()'s are two
// copies in two packages. A gift the Google path doesn't give is worse than no
// gift, because the copy still promises it.
//
// `deriveUsername` MOVED to shared/auth (D9): `signup()` needs it too and
// cannot import from a service. Re-exported here so the existing callers and
// `gateway/tests/derive-username.test.ts` are unchanged by the move.
// =============================================================================

export { deriveUsername };

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
  arrivalDTag?: string | null,
): Promise<ProvisionedAccount> {
  const keypair = await generateKeypair();
  const username = await deriveUsername(email, displayName);

  const { freeAllowancePence } = await loadConfig();
  const arrival = await resolveArrivalGift(arrivalDTag ?? null);

  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         status, free_allowance_granted_pence, free_allowance_remaining_pence,
         arrival_article_id, arrival_gift_pence
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, $8)
       RETURNING id`,
      [
        keypair.pubkeyHex,
        keypair.privkeyEncrypted,
        username,
        displayName,
        email,
        freeAllowancePence + arrival.giftPence,
        arrival.articleId,
        arrival.giftPence,
      ],
    );

    const accountId = result.rows[0].id;

    await client.query("INSERT INTO reading_tabs (reader_id) VALUES ($1)", [
      accountId,
    ]);

    return { accountId, username };
  });
}
