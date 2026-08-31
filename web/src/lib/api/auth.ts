import { request } from './client'

interface SignupInput {
  email: string
  displayName: string
  username: string
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
   * When the first-session welcome was offered and ANSWERED — completed or
   * dismissed alike (migration 176). NULL ⇒ never offered, which is the only
   * gate `Welcome` reads.
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

  login: (email: string) =>
    request<{ message: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
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
