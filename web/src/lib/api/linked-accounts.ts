import { request } from './client'

export interface LinkedAccount {
  id: string
  protocol: 'atproto' | 'activitypub' | 'nostr_external' | 'rss'
  externalId: string
  externalHandle: string | null
  instanceUrl: string | null
  isValid: boolean
  crossPostDefault: boolean
  // Consent to DISPLAY this presence on the profile's identity row — separate
  // from crossPostDefault, which consents only to posting through it
  // (PROFILE-PANE-REDESIGN-ADR D7). Default false; absent on a stale gateway.
  showOnProfile?: boolean
  tokenExpiresAt: string | null
  createdAt: string
}

export interface NetworkCapabilities {
  assistedBluesky: boolean
  assistedMastodon: boolean
  // Curated open-registration instances for the Mastodon ASSISTED hand-off
  // (§9); first entry is the default. Empty while the flag is dark.
  assistedMastodonInstances?: string[]
  // Follow-graph import (FOLLOW-GRAPH-IMPORT-ADR §7): protocols whose remote
  // graph the server can read today. Empty/absent while the flag is dark —
  // every import affordance gates on membership here.
  followImportProtocols?: string[]
  // OPML upload (Phase 1d) — separate from followImportProtocols because that
  // list drives the "import this account's follows" resolver affordances, and
  // a plain rss feed URL has no follow graph. Gates the upload surface only.
  followImportOpml?: boolean
}

// Honest framing for the ASSISTED hand-off (NETWORK-CONCIERGE-ADR §6.1.1 S5,
// §10): the user is creating a *real* network account mid-redirect, so this must
// be an explicit acknowledgement, never ambient copy.
export const ASSISTED_BLUESKY_CONSENT =
  'You’re about to create a real Bluesky account on bsky.social. Bluesky holds the keys; all.haus just connects it. You can disconnect anytime.'

// Mastodon's round-trip has two extra steps Bluesky doesn't (email confirmation
// + a first login on the instance), and it only resumes in the same browser —
// the consent copy must set that expectation or the hand-off reads as broken.
// It also lands on the instance's LOGIN page, where the signup affordance is a
// small footer link users genuinely fail to find (first live run, 2026-06-11)
// — so name the link and the direct /auth/sign_up path explicitly.
export const assistedMastodonConsent = (instance: string) =>
  `You’re about to create a real Mastodon account on ${instance}. ${instance} holds the keys; all.haus just connects it. You’ll land on ${instance}’s login page — use its “Sign up” link (or go to ${instance}/auth/sign_up) to create the account, confirm your email, then log in. Finish in this browser and you’ll land back here. You can disconnect anytime.`

export const linkedAccounts = {
  list: () =>
    request<{ accounts: LinkedAccount[]; capabilities?: NetworkCapabilities }>(
      '/linked-accounts',
    ),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/linked-accounts/${id}`, { method: 'DELETE' }),

  // Either consent may be sent alone; the gateway COALESCEs, so an omitted
  // field is left alone rather than reset.
  update: (
    id: string,
    data: { crossPostDefault?: boolean; showOnProfile?: boolean },
  ) =>
    request<{ ok: boolean }>(`/linked-accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  connectMastodon: (instanceUrl: string) =>
    request<{ authorizeUrl: string }>('/linked-accounts/mastodon', {
      method: 'POST',
      body: JSON.stringify({ instanceUrl }),
    }),

  connectBluesky: (handle: string) =>
    request<{ authorizeUrl: string }>('/linked-accounts/bluesky', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    }),

  // ASSISTED — "set one up for me." No handle: the gateway seeds the OAuth flow
  // with the PDS hostname so Bluesky renders native signup mid-redirect.
  assistedBluesky: () =>
    request<{ authorizeUrl: string }>('/linked-accounts/bluesky/assisted', {
      method: 'POST',
    }),

  // ASSISTED Mastodon — instance must come from the curated allowlist the
  // gateway surfaces via capabilities; omitted ⇒ the gateway's default.
  assistedMastodon: (instance?: string) =>
    request<{ authorizeUrl: string }>('/linked-accounts/mastodon/assisted', {
      method: 'POST',
      body: JSON.stringify(instance ? { instance } : {}),
    }),
}

// Session-cached so contextual surfaces (e.g. InlineReplyBox) can gate the
// ASSISTED affordance on the server flag without a fetch each render.
let capabilitiesPromise: Promise<NetworkCapabilities> | null = null
export function getNetworkCapabilities(): Promise<NetworkCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = linkedAccounts
      .list()
      .then(
        (r) =>
          r.capabilities ?? { assistedBluesky: false, assistedMastodon: false },
      )
      .catch(() => {
        capabilitiesPromise = null
        return { assistedBluesky: false, assistedMastodon: false }
      })
  }
  return capabilitiesPromise
}
