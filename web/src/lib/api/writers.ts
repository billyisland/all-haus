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
  // The profile's button row shows a view's button only when that view has
  // something in it, so it needs every count BEFORE it paints — derived from
  // the logs' own fetches, two buttons would appear a beat after load and move
  // the selected view under the reader. Optional because a stale gateway sends
  // neither; the row treats absent as "unknown, so offer it" rather than as
  // zero, which would hide a log that is actually there.
  noteCount?: number
  replyCount?: number
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
