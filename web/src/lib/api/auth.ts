import { request, ApiError } from './client'

// TWO FIELDS (PAYWALL-ARRIVAL-ADR D9). `username` is derived server-side by the
// same `deriveUsername` the Google path has always used, so the two offers on
// the same gate are no longer at visibly different prices — and the one field
// whose failure mode was a REJECTION, at the most fragile moment this reader
// will ever have with us, is gone.
//
// `arrivalDTag` is the carried intent: the article's IDENTITY, never its price
// (which is a free-money endpoint if the client supplies it) and never a path
// (which is an open redirect at the terminus).
interface SignupInput {
  email: string
  displayName: string
  arrivalDTag?: string
}

interface SignupResult {
  accountId: string
  pubkey: string
  username: string
}

export interface MeResponse {
  id: string
  pubkey: string
  username: string | null
  displayName: string | null
  bio: string | null
  avatar: string | null
  email: string
  hasPaymentMethod: boolean
  /**
   * Non-null ⇒ an off-session settlement charge terminally declined and the
   * reader's reading tab is FROZEN: settlement backs off and nothing further is
   * charged until they re-attach a card. Rides the session payload rather than
   * `/my/tab` so any surface can explain the freeze where the reader meets it.
   * Cleared server-side the moment a card is attached. Rendered by
   * `CardActionRequired`. STRIPE audit S1.
   */
  cardActionRequiredAt: string | null
  stripeConnectKycComplete: boolean
  freeAllowanceRemainingPence: number
  defaultArticlePricePence: number | null
  isAdmin: boolean
  usernameChangedAt: string | null
  /**
   * When the first session's introduction was offered and ANSWERED (migration
   * 176). NULL ⇒ never offered. It gated the five-step welcome sheet until that
   * was deleted (2026-09-04); it now arms the Explain tour's auto-entry, which
   * stamps it the moment the tour opens — the same rule the sheet used, since
   * being shown the thing is an answer.
   *
   * Do not read this as "the profile is filled in": a member answers it by
   * closing it, and the two facts are deliberately separate. It is on the
   * account rather than in `localStorage` so a member introduces themselves
   * once, not once per browser.
   */
  onboardedAt: string | null
}

export const auth = {
  signup: (input: SignupInput) =>
    request<SignupResult>('/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (email: string, arrivalDTag?: string) =>
    request<{ message: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, arrivalDTag }),
    }),

  devLogin: (email: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  verify: (token: string) =>
    request<{ id: string; username: string; displayName: string }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<MeResponse>('/auth/me'),

  // Record that the first-session welcome was answered — by completing it or by
  // closing it, which is why the caller fires this from BOTH paths. Idempotent
  // server-side (first-write-wins), so it is safe to call without awaiting and a
  // lost call costs one repeat offer rather than an error.
  markOnboarded: () =>
    request<{ ok: boolean }>('/auth/onboarded', { method: 'POST' }),

  connectStripe: () =>
    request<{ stripeConnectUrl: string }>('/auth/upgrade-writer', { method: 'POST' }),

  // Begin card setup — returns a SetupIntent client_secret the client confirms
  // with Stripe.js (validating the card + authorising off-session use). S2.
  createSetupIntent: () =>
    request<{ clientSecret: string }>('/auth/setup-intent', { method: 'POST' }),

  // Finalise card setup from a succeeded SetupIntent (server verifies status). S2.
  connectCard: (setupIntentId: string) =>
    request<{ ok: boolean; hasPaymentMethod: boolean }>('/auth/connect-card', {
      method: 'POST',
      body: JSON.stringify({ setupIntentId }),
    }),

  updateProfile: (data: { displayName?: string; bio?: string; avatar?: string | null }) =>
    request<{ ok: boolean }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deactivate: () =>
    request<{ ok: boolean }>('/auth/deactivate', { method: 'POST' }),

  deleteAccount: (emailConfirmation: string) =>
    request<{ ok: boolean }>('/auth/delete-account', {
      method: 'POST',
      body: JSON.stringify({ emailConfirmation }),
    }),

  changeEmail: (newEmail: string) =>
    request<{ ok: boolean }>('/auth/change-email', {
      method: 'POST',
      body: JSON.stringify({ newEmail }),
    }),

  verifyEmailChange: (token: string) =>
    request<{ ok: boolean }>('/auth/verify-email-change', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  changeUsername: (newUsername: string) =>
    request<{ ok: boolean; username: string }>('/auth/change-username', {
      method: 'POST',
      body: JSON.stringify({ newUsername }),
    }),

  checkUsername: (username: string) =>
    request<{ available: boolean; reason?: string }>(`/auth/check-username/${encodeURIComponent(username)}`),
}

// =============================================================================
// signupOffer — can an account be made right now, and what does it come with?
//
// The logged-out paywall has two entirely different things to say depending on
// the answer (PAYWALL-ARRIVAL D3/§11.6 vs the closed-beta waiting list), so the
// web genuinely must know. IT ASKS RATHER THAN CARRYING A SECOND COPY OF THE
// FLAG: `CLOSED_BETA` is a server constant, and a `NEXT_PUBLIC_` twin would be
// a second value to flip in lockstep and a half-lit state when somebody didn't.
// Reaching `GET /auth/open` IS the proof, so there is nothing to drift.
//
// ONE CALL, NOT TWO, because the gate needs both halves of the same answer: it
// names the gift in its copy, and the figure has to come from the
// `free_allowance_pence` dial rather than be typed — a literal "£5" is a dial
// with a second, silent copy, and it is wrong for every reader granted under a
// different setting of it.
//
// The three-way split is the same one the Stripe classifiers and the
// internal-parity probe use: 200 is the offer, 404 is dark, and ANYTHING ELSE
// is dark for this render and cached as NOTHING — so a blip cannot switch the
// offer off for the whole session. The cost is that flipping the flag needs a
// new browser session rather than a reload, which is the flag's DEPLOYMENT.md
// row to carry.
// =============================================================================

export interface SignupOffer {
  freeAllowancePence: number
  /** The arrival cap — what a piece's price is TESTED against. Not the figure
   *  above, and not derivable from it (see `resolveArrivalGift` rule 2). */
  arrivalGiftCapPence: number
}

let signupOfferProbe: Promise<SignupOffer | null> | null = null

/** The offer, or null for "no account can be made" — which is also the answer
 *  when we could not find out, deliberately. */
export function signupOffer(): Promise<SignupOffer | null> {
  if (!signupOfferProbe) {
    signupOfferProbe = request<{
      open: boolean
      freeAllowancePence: number
      arrivalGiftCapPence: number
    }>(
      '/auth/open',
    )
      .then((r) => ({
        freeAllowancePence: r.freeAllowancePence,
        arrivalGiftCapPence: r.arrivalGiftCapPence,
      }))
      .catch((err: unknown) => {
        // 404 is the flag, and it is the only definitive negative. Anything
        // else — a 502, a dropped connection, a proxy hiccup — is ambiguous,
        // so it answers "dark" for this render and forgets, rather than
        // pinning a session to an outage's verdict.
        if (err instanceof ApiError && err.status === 404) return null
        signupOfferProbe = null
        return null
      })
  }
  return signupOfferProbe
}
