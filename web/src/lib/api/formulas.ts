import { request, ApiError } from './client'

// =============================================================================
// Feed sharing — a feed's composition as a transmissible object
// (FEED-FORMULAS-ADR; amended by FEED-SHARE-LIVE-LINKS-ADR).
//
// A share link is a POINTER to a feed, not a snapshot of one: the recipient
// gets the feed as it stands when they click, and their copy freezes at the
// moment they add it. Never its contents — nobody's items appear on the link's
// page, which is why nothing in this module carries a Post.
//
// The routes live on two prefixes, deliberately (ADR §12): mint and status are
// genuinely feed-scoped and sit under /workspace, while the page a stranger
// opens is public and would be a lie about its audience if served from a path
// called "workspace".
// =============================================================================

/** One source as a recipient reads it. Display-only, by construction. */
export interface FormulaSource {
  position: number
  kind: 'account' | 'publication' | 'external_source' | 'tag'
  protocol: string | null
  label: string
  avatar: string | null
}

// The one-word kind a source is filed under, shown beside its name on the
// public page. ONE home so two surfaces cannot describe the same composition
// differently.
const PROTOCOL_LABELS: Record<string, string> = {
  rss: 'RSS',
  atproto: 'BLUESKY',
  activitypub: 'FEDIVERSE',
  nostr_external: 'NOSTR',
}

export function formulaSourceKind(s: FormulaSource): string {
  if (s.kind === 'account') return 'WRITER'
  if (s.kind === 'publication') return 'PUBLICATION'
  if (s.kind === 'tag') return 'TAG'
  return (s.protocol && PROTOCOL_LABELS[s.protocol]) ?? 'EXTERNAL'
}

/** Why nobody can add this link right now. Reported rather than thrown, so the
 *  author reads it in words instead of pressing something and meeting a 410. */
export type FormulaRefusal = 'empty' | 'too_large'

/**
 * A share link, as both its author and its recipients see it.
 *
 * Everything except `id`/`token`/`url`/`createdAt` is projected LIVE from the
 * feed the link points at, so `name` and `sources` are the feed as it is now.
 * `name` is null when `gone` — the author deleted or merged away the feed, and
 * the link row survives as a dangling one rather than being deleted (a delete
 * would erase the provenance of every feed already redeemed from it).
 */
export interface FeedLink {
  id: string
  token: string
  url: string
  createdAt: string
  name: string | null
  /** The author's colour scheme travels with the composition (§5) — the feed
   *  ARRIVES styled and the recipient restyles it afterwards like any feed. */
  appearance: { scheme?: string; density?: string }
  /** D7 — attribution travels, adoption counts do not. There is deliberately no
   *  add count on this object, public or private. */
  author: { displayName: string | null; username: string | null }
  sourceCount: number
  /** Named out loud, never silently omitted (D5): an author who shares a feed
   *  holding three email sources must be able to see that three did not
   *  travel. Live, so it is true NOW rather than at some moment in the past. */
  excludedCount: number
  refusal: FormulaRefusal | null
  revoked: boolean
  /** Always false on a link — the schema forbids otherwise (a designated seed
   *  is a different kind of row, and cutting one no longer adopts a link).
   *  Read rather than assumed, because Stop is hidden on it. */
  isDefaultSeed: boolean
  /** The feed this points at has been deleted or merged away. */
  gone: boolean
  sources: FormulaSource[]
}

/** The composer's read: this feed's link if it has one, plus what a recipient
 *  would get right now either way. `link: null` is the ordinary un-shared
 *  state, not an error. */
export interface FeedLinkStatus {
  link: FeedLink | null
  sourceCount: number
  excludedCount: number
  refusal: FormulaRefusal | null
  maxSources: number
}

/** Sources that did not resolve at redeem. A partial redeem is a real outcome
 *  (§6), so this is reported rather than swallowed — a redeem that quietly
 *  dropped four sources would read to the recipient as the author's own
 *  composition. */
export interface RedeemFailure {
  position: number
  label: string
  reason: 'unresolvable' | 'unreachable' | 'invalid' | 'error'
}

export interface RedeemResult {
  feedId: string
  added: number
  failed: RedeemFailure[]
}

export const formulas = {
  /** This feed's link and live projection. */
  status: (feedId: string) =>
    request<FeedLinkStatus>(`/workspace/feeds/${feedId}/formula`),

  /** Create the link — or hand back the one that already exists. Idempotent by
   *  design (L2), which is what lets the composer be one button: it never has
   *  to know whether it is creating or fetching. It never refuses, either — a
   *  link to a feed nobody can add YET is still a link, and it starts working
   *  the moment the author adds a source. */
  mint: (feedId: string) =>
    request<{ link: FeedLink }>(`/workspace/feeds/${feedId}/formula`, {
      method: 'POST',
    }).then((r) => r.link),

  /** The public page's data. Works logged-out — only redeeming needs an
   *  account. */
  get: (token: string) =>
    request<{ formula: FeedLink }>(
      `/formulas/${encodeURIComponent(token)}`,
    ).then((r) => r.formula),

  redeem: (token: string) =>
    request<RedeemResult>(`/formulas/${encodeURIComponent(token)}/redeem`, {
      method: 'POST',
    }),

  listMine: () =>
    request<{ formulas: Array<FeedLink & { feedId: string | null }> }>(
      '/my/formulas',
    ).then((r) => r.formulas),

  /** D10 — stopping cannot un-add. It stops FUTURE copies and nothing else; no
   *  feed anywhere is touched. That is also why it does not confirm. */
  revoke: (id: string) =>
    request<void>(`/formulas/${id}`, { method: 'DELETE' }),
}

// ---------------------------------------------------------------------------
// The dark-ship gate
//
// FEED_FORMULAS_ENABLED is a SERVER flag and stays the only one: the brake
// rule says put it at the narrowest server-side choke point and add a
// NEXT_PUBLIC twin only when the web must change LAYOUT rather than omit data
// — and the composer's share section is exactly that layout case, since an
// action that 404s on press is worse than an action that is absent.
//
// So rather than a second flag to flip in lockstep, the web ASKS. Every share
// route 404s while the flag is dark, and `/my/formulas` is the one that needs
// no arguments and no side effects, so reaching it IS the proof — the same
// shape as the gateway's internal-parity probe.
//
// TERMINAL VS AMBIGUOUS, and the distinction is why this is cached at all:
//   200 → live, cache true.
//   404 → dark, cache false. A definitive answer from a route that exists.
//   anything else (401 mid-logout, 5xx, offline) → treat as dark for THIS
//     render but cache NOTHING, so a network blip cannot switch the feature off
//     for the rest of the session.
// ---------------------------------------------------------------------------

let availability: Promise<boolean> | null = null

export function formulasAvailable(): Promise<boolean> {
  if (!availability) {
    availability = formulas
      .listMine()
      .then(() => true)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return false
        availability = null
        return false
      })
  }
  return availability
}

/** Drop the cached verdict. The answer is a property of the SERVER flag and not
 *  of the viewer, so this deliberately does NOT hang off logout the way
 *  `useFollows` does — it exists for an operator flipping the flag under a live
 *  tab in dev. */
export function resetFormulaAvailability() {
  availability = null
}
