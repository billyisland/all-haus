import { z } from 'zod'
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_RE,
  USERNAME_RULE_MESSAGE,
} from './username-rule.js'
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
//   1. User provides email + display name
//   2. Platform generates a custodial Nostr keypair
//   3. Account created with full capability — free allowance from the
//      `free_allowance_pence` dial (£5 seeded), stamped onto both the granted
//      and remaining columns (migration 169). Twin of provisionAccount's
//      INSERT in gateway/src/lib/account-provision.ts; keep the two in step.
//   4. Reading tab created (one per account)
//   5. Session cookie set
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

export const SignupSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  username: z
    .string()
    .min(USERNAME_MIN_LENGTH)
    .max(USERNAME_MAX_LENGTH)
    .regex(USERNAME_RE, { message: USERNAME_RULE_MESSAGE }),
})

export type SignupInput = z.infer<typeof SignupSchema>

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
  const { freeAllowancePence } = await loadConfig()

  return withTransaction(async (client) => {
    // Create account
    const accountRow = await client.query<{
      id: string
      nostr_pubkey: string
      username: string
    }>(
      `INSERT INTO accounts (
         nostr_pubkey, nostr_privkey_enc, username, display_name, email,
         status, free_allowance_granted_pence, free_allowance_remaining_pence
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
       RETURNING id, nostr_pubkey, username`,
      [keypair.pubkeyHex, keypair.privkeyEncrypted, input.username, input.displayName, input.email.toLowerCase().trim(), freeAllowancePence]
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
      { accountId: account.id, username: input.username },
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
    username_changed_at: Date | null
    card_action_required_at: Date | null
    onboarded_at: Date | null
  }>(
    `SELECT id, nostr_pubkey, username, display_name, bio, avatar_blossom_url,
            email, status, stripe_customer_id, stripe_connect_id,
            stripe_connect_kyc_complete, free_allowance_remaining_pence,
            default_article_price_pence, username_changed_at,
            card_action_required_at, onboarded_at
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
    usernameChangedAt: r.username_changed_at?.toISOString() ?? null,
    cardActionRequiredAt: r.card_action_required_at?.toISOString() ?? null,
    onboardedAt: r.onboarded_at?.toISOString() ?? null,
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
// connectPaymentMethod — records a reader's Stripe customer ID
// Called after Stripe Elements card setup succeeds.
// ---------------------------------------------------------------------------

export async function connectPaymentMethod(
  accountId: string,
  stripeCustomerId: string
): Promise<void> {
  // Clear any prior settlement back-off flag: re-attaching a card is the reader's
  // action that resolves a terminal decline, so settlement may re-attempt (see
  // settlement.ts checkAndSettle / completeSettlement, STRIPE audit S1).
  await pool.query(
    `UPDATE accounts
     SET stripe_customer_id = $1, card_action_required_at = NULL, updated_at = now()
     WHERE id = $2`,
    [stripeCustomerId, accountId]
  )

  logger.info({ accountId }, 'Payment method connected')
}
