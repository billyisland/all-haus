import { request } from './client'

export interface WriterProfile {
  id: string
  pubkey: string
  username: string
  displayName: string | null
  bio: string | null
  avatar: string | null
  hostingType: string
  subscriptionPricePence: number
  annualDiscountPct: number
  showCommissionButton: boolean
  articleCount: number
  hasPaywalledArticle: boolean
  followerCount: number
  followingCount: number
  // The `verified` tier of the profile's identity row (PROFILE-PANE-REDESIGN-
  // ADR D7): network identities the SUBJECT proved, filtered server-side to
  // active + valid + show_on_profile. Absent on a stale gateway.
  presences?: ProfilePresence[]
}

export interface ProfilePresence {
  protocol: string
  handle?: string
  /** The presence's profile page on the origin network, when derivable. */
  externalUrl?: string
}

// GET /writers/:username → native writer profile header. The /[username] page
// fetches this server-side; the profile overlay (NativeProfilePanel) needs it
// client-side.
export function getWriter(username: string): Promise<WriterProfile> {
  return request<WriterProfile>(`/writers/${encodeURIComponent(username)}`)
}
