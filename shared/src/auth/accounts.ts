import { z } from 'zod'
import { deriveUsername } from './username-derive.js'
import { resolveArrivalGift } from './arrival-gift.js'
import { dateOfBirthSchema } from '../lib/age.js'
import { pool, withTransaction, loadConfig } from '../db/client.js'
import { createSession } from './session.js'
import logger from '../lib/logger.js'
import type { FastifyReply } from 'fastify'

// =============================================================================
// Account Service
//
// Handles account creation (signup), authentication, and Stripe wiring.
//
// Signup flow (both paths — magic-link here, Google OAuth in
// gateway/src/routes/google-auth.ts):
//   1. User provides email, display name and date of birth. The username is
//      DERIVED (PAYWALL-ARRIVAL-ADR D9), by the same `deriveUsername` the
//      Google path has always used, from its new home in this package. The
//      date of birth is a DECLARATION (L6.1): asked, dated, and not checked
//      against anything — see `shared/src/lib/age.ts` and migration 212.
//   2. Platform generates a custodial Nostr keypair
//   3. Account created with full capability — free allowance from the
//      `free_allowance_pence` dial (£5 seeded), stamped onto both the granted
//      and remaining columns (migration 169), PLUS the arrival gift when the
//      signup came from a paywall (`resolveArrivalGift`, migration 188). Twin of
//      provisionAccount's INSERT in gateway/src/lib/account-provision.ts; keep
//      the two in step — a gift only one path gives is worse than no gift,
//      because the copy still promises it.
//   4. Reading tab created (one per account)
//   5. Session cookie set — synchronously, inside this request, which is what
//      makes the arrival landing possible at all: the browser never leaves, so
//      the client's own held state is a sufficient carrier for the intent.
//
// There is no reader→writer upgrade: every account can write from signup.
// (The vestigial is_writer/is_reader columns were dropped in migration 145;
// moderation rides accounts.status.) The distinctions that actually gate
// behaviour are Stripe-shaped:
//   - stripe_customer_id — card on file, can settle a tab (*can pay*)
//   - stripe_connect_id + stripe_connect_kyc_complete — Connect onboarded,
//     can receive payouts (*can be paid* — the precondition for paywalling)
//   - default_article_price_pence — has set a price
//
// Authentication:
//   Email + magic link or Google OAuth (passwordless). The Nostr keypair is
//   custodial — we don't ask users to manage keys.
//
// Future: NIP-07 browser extension login for users who self-custody keys.
// =============================================================================

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

// THE USERNAME IS DERIVED, NOT ASKED (PAYWALL-ARRIVAL-ADR D9). It used to be
// required here against USERNAME_RE. A stranger stopped mid-article
// has a fixed amount of patience and has already spent most of it on the piece;
// a username field spends what is left on a decision they have no basis for
// making — they have not seen a profile, a byline or another member — and its
// failure mode is a REJECTION (23505 on a name they typed hopefully) at the one
// moment in this reader's life with us where a rejection costs the most. The
// Google button never showed that field at all, so leaving it here put two
// offers on the same gate at visibly different prices, and the cheaper one
// handed the account to a third party. (The age declaration below is the one
// field that was ADDED, and the asymmetry it creates is closed the other way:
// the Google path asks for it on the first landing rather than not at all.)
//
// Deriving is not taking the decision away: `username_changed_at` starts NULL,
// so the first change is free and immediate. The name is a default, revisable
// the moment they have any basis for revising it. It does NOT yet survive the
// revision — `previous_username` and `username_redirect_until` are written by
// the rename and read by nothing, so old links break on the spot; the gap and
// what closing it would need are stated in full in `username-derive.ts`.
//
// `arrivalDTag` is the carried intent, and it is an IDENTITY rather than a
// price or a path: the price is looked up server-side (`resolveArrivalGift`)
// because a client-supplied one is a free-money endpoint, and the terminus
// reconstructs `/article/<dTag>` rather than navigating to a string it was
// handed, which is what keeps the emailed carrier off the open-redirect shape.
//
// THE THIRD FIELD IS THE AGE DECLARATION (L6.1, decision A1), and it is a
// field rather than a tick-box because a tick-box records that somebody
// pressed a tick-box. It is asked at the gate and not later: the platform runs
// a tab against a card and carries direct messages from the first session, and
// a gate that lets somebody in and asks afterwards has already let them in.
//
// THE REFUSAL IS IN THE SCHEMA, NOT BESIDE IT. There are three doors to this
// value and a check placed at one of them is silently absent from the other
// two -- the same shape as the publish-side preconditions in `posts.md`. So
// the rule rides the schema, and every door gets it by parsing.
//
// WHICH IS WHY THIS IS A FACTORY. A schema built once at module scope would
// close over whatever `new Date()` said when the process booted, and go on
// refusing somebody who turned 18 while it was running. `signupSchema(now)` is
// called per request, and a test can stand it at either side of a birthday.
export function signupSchema(now: Date) {
  return z.object({
    email: z.string().email(),
    displayName: z.string().min(1).max(100),
    // ONE SPELLING OF THE FIELD, shared with the other two doors that write
    // this column (`dateOfBirthSchema`). Not repeated here, because a refusal
    // worded differently at two doors is a rule with two meanings.
    dateOfBirth: dateOfBirthSchema(now),
    arrivalDTag: z.string().min(1).max(200).optional(),
  })
}

export type SignupInput = z.infer<ReturnType<typeof signupSchema>>

// ---------------------------------------------------------------------------
// signup — creates a new account with custodial keypair
// ---------------------------------------------------------------------------

export interface SignupResult {
  accountId: string
  pubkey: string
  username: string
}

export async function signup(
  input: SignupInput,
  reply: FastifyReply,
  keypair: { pubkeyHex: string; privkeyEncrypted: string }
): Promise<SignupResult> {
  const email = input.email.toLowerCase().trim()
  const { freeAllowancePence } = await loadConfig()
  const username = await deriveUsername(email, input.displayName)
  // The enlarged grant. Both figures come from ONE place because this INSERT
  // and provisionAccount's are two copies in two packages (D2).
  const arrival = await resolveArrivalGift(input.arrivalDTag ?? null)

  return withTransaction(async (client) => {
    // Create account
    const accountRow = await client.query<{
      id: string
      nostr_pubkey: string
      username: string
    }>(
      // `age_declared_at` is `now()` and not a value the caller supplies: the
      // column records when WE asked, which is a fact about this request.
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         status, free_allowance_granted_pence, free_allowance_remaining_pence,
         arrival_article_id, arrival_gift_pence,
         date_of_birth, age_declared_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, $8, $9, now())
       RETURNING id, nostr_pubkey, username`,
      [
        keypair.pubkeyHex,
        keypair.privkeyEncrypted,
        username,
        input.displayName,
        email,
        freeAllowancePence + arrival.giftPence,
        arrival.articleId,
        arrival.giftPence,
        input.dateOfBirth,
      ]
    )

    const account = accountRow.rows[0]

    // Create reading tab (one per reader — the tab tracks their running balance)
    await client.query(
      'INSERT INTO reading_tabs (reader_id) VALUES ($1)',
      [account.id]
    )

    // Set session cookie
    await createSession(reply, {
      id: account.id,
      nostrPubkey: account.nostr_pubkey,
    })

    logger.info(
      { accountId: account.id, username, arrival: arrival.articleId !== null },
      'Account created'
    )

    return {
      accountId: account.id,
      pubkey: account.nostr_pubkey,
      username: account.username,
    }
  })
}

// ---------------------------------------------------------------------------
// connectStripeAccount — stores Stripe Connect ID for payouts
// ---------------------------------------------------------------------------

export interface StripeConnectResult {
  stripeConnectUrl: string   // Stripe Connect onboarding URL — redirect the user here
}

export async function connectStripeAccount(
  accountId: string,
  stripeAccountId: string,
  onboardingUrl: string
): Promise<StripeConnectResult> {
  await pool.query(
    `UPDATE accounts
     SET stripe_connect_id = $1,
         updated_at = now()
     WHERE id = $2`,
    [stripeAccountId, accountId]
  )

  logger.info({ accountId, stripeAccountId }, 'Stripe Connect onboarding started')

  return { stripeConnectUrl: onboardingUrl }
}

// ---------------------------------------------------------------------------
// getAccount — fetch account by ID (for session hydration)
// ---------------------------------------------------------------------------

export interface AccountInfo {
  id: string
  nostrPubkey: string
  username: string | null
  displayName: string | null
  bio: string | null
  avatarBlossomUrl: string | null
  email: string
  status: string
  stripeCustomerId: string | null
  stripeConnectId: string | null
  stripeConnectKycComplete: boolean
  freeAllowanceRemainingPence: number
  defaultArticlePricePence: number | null
  /**
   * The writer's own subscription pricing. It rides the session payload for the
   * same reason `defaultArticlePricePence` beside it does — and because without
   * it the dashboard's Pricing tab had NOTHING to read its current values from:
   * `PATCH /settings/subscription-price` has no GET twin, so the form opened
   * with an empty price and a hard-coded 15% discount whatever the writer had
   * actually set, and Save wrote both over the real figures.
   */
  subscriptionPricePence: number
  annualDiscountPct: number
  usernameChangedAt: string | null
  /**
   * Set when an off-session settlement charge terminally declined; the reader's
   * tab is frozen until they re-attach a card. Carried on the account (rather
   * than fetched per-surface from `/my/tab`) so every surface that already has
   * the session — the paywall gate as much as the ledger — can tell the reader
   * why nothing is moving. STRIPE audit S1.
   */
  cardActionRequiredAt: string | null
  /**
   * When the first-session welcome was offered and answered — completed or
   * dismissed alike (migration 176). NULL = never offered, which is the gate
   * `Welcome` reads. It records that the offer was MADE, never that the profile
   * was filled in: a member may answer it by closing it, and nothing may infer
   * a populated display name / bio / avatar from a non-null value here.
   */
  onboardedAt: string | null
  /**
   * The Reader Terms / Writer Agreement version this member accepted, and
   * when (migration 204). NULL = never accepted. The two halves of each pair
   * are CHECK-tied in the schema, so a version without a timestamp — or the
   * reverse — cannot be read from here.
   *
   * Compared through `termsAcceptanceIsCurrent` in
   * `shared/src/lib/terms-versions.ts`, never with `===`: the stored string
   * carries a text sub-version the comparison ignores.
   */
  readerTermsAcceptedAt: string | null
  readerTermsVersion: string | null
  writerTermsAcceptedAt: string | null
  writerTermsVersion: string | null
  /** NULL ⇒ a reader (READER-WRITER-SPLIT-ADR; migration 271). */
  writerAdmittedAt: string | null
  /**
   * When this member declared their date of birth (migration 212, L6.1). NULL
   * = never asked or never answered, and that is the whole of what the age
   * gate reads. The gate is keyed on the MEMBER for `onboarded_at`'s reason:
   * a per-device key asks the same person again on every browser and answers
   * "already asked" for a browser that never was (feeds.md).
   *
   * THE DATE ITSELF IS DELIBERATELY NOT HERE. Nothing on the client needs it —
   * the only question any surface asks is whether the declaration exists — and
   * a value that rides the session payload is a value on every page. L7.1's
   * export reads the column directly, which is the one place a member is
   * entitled to see it back.
   *
   * (A second reason it is the timestamp and not the date: `date` comes off
   * node-postgres as a JS `Date` at LOCAL midnight, so `.toISOString()` on it
   * moves the day in any deployment west of UTC. `timestamptz` does not have
   * that problem, and the pair CHECK makes the two columns answer the same
   * question anyway.)
   */
  ageDeclaredAt: string | null
}

export async function getAccount(accountId: string): Promise<AccountInfo | null> {
  const { rows } = await pool.query<{
    id: string
    nostr_pubkey: string
    username: string | null
    display_name: string | null
    bio: string | null
    avatar_blossom_url: string | null
    email: string
    status: string
    stripe_customer_id: string | null
    stripe_connect_id: string | null
    stripe_connect_kyc_complete: boolean
    free_allowance_remaining_pence: number
    default_article_price_pence: number | null
    subscription_price_pence: number
    annual_discount_pct: number
    username_changed_at: Date | null
    card_action_required_at: Date | null
    onboarded_at: Date | null
    reader_terms_accepted_at: Date | null
    reader_terms_version: string | null
    writer_terms_accepted_at: Date | null
    writer_terms_version: string | null
    age_declared_at: Date | null
    writer_admitted_at: Date | null
  }>(
    `SELECT id, nostr_pubkey, username, display_name, bio, avatar_blossom_url,
            email, status, stripe_customer_id, stripe_connect_id,
            stripe_connect_kyc_complete, free_allowance_remaining_pence,
            default_article_price_pence, subscription_price_pence,
            annual_discount_pct, username_changed_at,
            card_action_required_at, onboarded_at,
            reader_terms_accepted_at, reader_terms_version,
            writer_terms_accepted_at, writer_terms_version,
            age_declared_at, writer_admitted_at
     FROM accounts WHERE id = $1`,
    [accountId]
  )

  if (rows.length === 0) return null

  const r = rows[0]
  return {
    id: r.id,
    nostrPubkey: r.nostr_pubkey,
    username: r.username,
    displayName: r.display_name,
    bio: r.bio,
    avatarBlossomUrl: r.avatar_blossom_url,
    email: r.email,
    status: r.status,
    stripeCustomerId: r.stripe_customer_id,
    stripeConnectId: r.stripe_connect_id,
    stripeConnectKycComplete: r.stripe_connect_kyc_complete,
    freeAllowanceRemainingPence: r.free_allowance_remaining_pence,
    defaultArticlePricePence: r.default_article_price_pence,
    subscriptionPricePence: r.subscription_price_pence,
    annualDiscountPct: r.annual_discount_pct,
    usernameChangedAt: r.username_changed_at?.toISOString() ?? null,
    cardActionRequiredAt: r.card_action_required_at?.toISOString() ?? null,
    onboardedAt: r.onboarded_at?.toISOString() ?? null,
    readerTermsAcceptedAt: r.reader_terms_accepted_at?.toISOString() ?? null,
    readerTermsVersion: r.reader_terms_version,
    writerTermsAcceptedAt: r.writer_terms_accepted_at?.toISOString() ?? null,
    writerAdmittedAt: r.writer_admitted_at?.toISOString() ?? null,
    writerTermsVersion: r.writer_terms_version,
    ageDeclaredAt: r.age_declared_at?.toISOString() ?? null,
  }
}

// ---------------------------------------------------------------------------
// updateProfile — update display name, bio, and/or avatar
// ---------------------------------------------------------------------------

export async function updateProfile(
  accountId: string,
  updates: { displayName?: string; bio?: string; avatarBlossomUrl?: string | null }
): Promise<void> {
  const setParts: string[] = []
  const values: any[] = []
  let i = 1

  if (updates.displayName !== undefined) {
    setParts.push(`display_name = $${i++}`)
    values.push(updates.displayName)
  }
  if (updates.bio !== undefined) {
    setParts.push(`bio = $${i++}`)
    values.push(updates.bio)
  }
  if (updates.avatarBlossomUrl !== undefined) {
    setParts.push(`avatar_blossom_url = $${i++}`)
    values.push(updates.avatarBlossomUrl)
  }

  if (setParts.length === 0) return

  values.push(accountId)
  await pool.query(
    `UPDATE accounts SET ${setParts.join(', ')}, updated_at = now() WHERE id = $${i}`,
    values
  )

  logger.info({ accountId }, 'Profile updated')
}

// ---------------------------------------------------------------------------
// connectPaymentMethod — records a reader's Stripe customer ID, and the Reader
// Terms the reader accepted in order to register it.
//
// ONE STATEMENT, BY DESIGN. Reader acceptance IS card registration (operator
// decision A3, 2026-09-16), so the two facts are one fact and must not be two
// writes: a card recorded without the acceptance is a reading tab running
// against a text nobody agreed to, and an acceptance recorded without the card
// is a record of nothing. A single UPDATE is the smallest thing that cannot
// half-happen — the caller needs no transaction of its own.
//
// THE TIMESTAMP IS FIRST-WRITE-WINS, the same rule POST /auth/accept-terms
// runs on: a reader replacing a card has already accepted this text, and
// moving the timestamp would rewrite WHEN they accepted it. The version column
// is assigned unconditionally because the route has already refused anything
// that is not the current version — so the two can only disagree while the
// reader is moving FORWARD onto a newer text, which is exactly when the
// timestamp should move too.
// ---------------------------------------------------------------------------

export async function connectPaymentMethod(
  accountId: string,
  stripeCustomerId: string,
  readerTermsVersion: string
): Promise<void> {
  // Clear any prior settlement back-off flag: re-attaching a card is the reader's
  // action that resolves a terminal decline, so settlement may re-attempt (see
  // settlement.ts checkAndSettle / completeSettlement, STRIPE audit S1).
  await pool.query(
    `UPDATE accounts
     SET stripe_customer_id = $1,
         card_action_required_at = NULL,
         reader_terms_accepted_at =
           CASE WHEN reader_terms_version IS DISTINCT FROM $3
                THEN now() ELSE reader_terms_accepted_at END,
         reader_terms_version = $3,
         updated_at = now()
     WHERE id = $2`,
    [stripeCustomerId, accountId, readerTermsVersion]
  )

  logger.info({ accountId, readerTermsVersion }, 'Payment method connected')
}
