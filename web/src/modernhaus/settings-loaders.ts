import type { LinkedAccount, NetworkCapabilities } from '../lib/api/linked-accounts'
import type { BlockedUser, MutedUser } from '../lib/api/social'
import type { Post } from '../lib/post/types'
import { call, okBody, path, query, GatewayFault, type GatewayContext } from './gateway'
import { secondary } from './member-loaders'

// =============================================================================
// modernhaus — Settings, Library and Recent reading (MODERNHAUS-ADR §D2.3, E6).
//
// Same contract as the other loaders: a THROW is a fault (the pipeline's 500),
// and a secondary read never throws — its section says it could not be loaded,
// never that it is empty or off (a setting that failed to load asserts nothing).
// =============================================================================

/** The member's own account facts the Settings pages show, off `/auth/me`. */
export interface AccountFacts {
  email: string | null
  bio: string | null
  avatar: string | null
  displayName: string | null
  username: string | null
  pubkey: string | null
  usernameChangedAt: string | null
  subscriptionPricePence: number | null
  annualDiscountPct: number | null
  defaultArticlePricePence: number | null
  /** The writer gate's column; only `true` off the wire counts. */
  canWrite: boolean
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** The primary read of every Settings page. */
export async function loadAccountFacts(gw: GatewayContext): Promise<AccountFacts> {
  const me = okBody(await call<Record<string, unknown>>(gw, 'GET', '/auth/me'), 'auth/me')
  return {
    email: strOrNull(me.email),
    bio: strOrNull(me.bio),
    avatar: strOrNull(me.avatar),
    displayName: strOrNull(me.displayName),
    username: strOrNull(me.username),
    pubkey: strOrNull(me.pubkey),
    usernameChangedAt: strOrNull(me.usernameChangedAt),
    subscriptionPricePence: numOrNull(me.subscriptionPricePence),
    annualDiscountPct: numOrNull(me.annualDiscountPct),
    defaultArticlePricePence: numOrNull(me.defaultArticlePricePence),
    canWrite: me.canWrite === true,
  }
}

// ---------------------------------------------------------------------------
// Networks.
// ---------------------------------------------------------------------------

export interface Networks {
  accounts: LinkedAccount[]
  capabilities: NetworkCapabilities
}

/** The primary read of the networks page. */
export async function loadNetworks(gw: GatewayContext): Promise<Networks> {
  const b = okBody(
    await call<{ accounts?: LinkedAccount[]; capabilities?: NetworkCapabilities }>(gw, 'GET', '/linked-accounts'),
    'linked accounts',
  )
  if (!Array.isArray(b.accounts)) throw new GatewayFault('linked accounts: no list')
  // Absent capabilities are "nothing available", which offers nothing: the
  // import and assisted affordances gate on a positive fact, never a guess.
  return { accounts: b.accounts, capabilities: b.capabilities ?? { assistedBluesky: false, assistedMastodon: false } }
}

export interface FollowImportRun {
  id: string
  protocol: string
  originIdentity: string
  feedId: string
  kind: string
  status: string
  total: number
  imported: number
  skipped: number
  failed: number
  error: string | null
}

/** One import run's progress, or null for a run that is not the viewer's. */
export async function loadFollowImport(gw: GatewayContext, id: string): Promise<FollowImportRun | null> {
  const a = await call<{ import: FollowImportRun }>(gw, 'GET', path`/follow-imports/${id}`)
  if (a.status === 404 || a.status === 400) return null
  return okBody(a, 'follow import').import
}

// ---------------------------------------------------------------------------
// Privacy: the three discovery switches, and the block and mute lists.
// ---------------------------------------------------------------------------

export interface PrivacyPrefs {
  discoveryEnabled: boolean
  publishFollowGraph: boolean
  discoverableByEmail: boolean
}

export interface PrivacyData {
  prefs: PrivacyPrefs | null
  blocks: BlockedUser[] | null
  mutes: MutedUser[] | null
}

function isPrefs(v: unknown): v is PrivacyPrefs {
  const p = v as PrivacyPrefs | null
  return (
    !!p &&
    typeof p.discoveryEnabled === 'boolean' &&
    typeof p.publishFollowGraph === 'boolean' &&
    typeof p.discoverableByEmail === 'boolean'
  )
}

/** All three halves are secondary: each says it could not load, alone. */
export async function loadPrivacy(gw: GatewayContext): Promise<PrivacyData> {
  const [prefs, blocks, mutes] = await Promise.all([
    secondary<PrivacyPrefs>(gw, 'GET', '/me/privacy-preferences', 'privacy preferences'),
    secondary<{ blocks: BlockedUser[] }>(gw, 'GET', '/my/blocks', 'blocks'),
    secondary<{ mutes: MutedUser[] }>(gw, 'GET', '/my/mutes', 'mutes'),
  ])
  return {
    prefs: isPrefs(prefs) ? prefs : null,
    blocks: Array.isArray(blocks?.blocks) ? blocks.blocks : null,
    mutes: Array.isArray(mutes?.mutes) ? mutes.mutes : null,
  }
}

// ---------------------------------------------------------------------------
// Notification preferences.
// ---------------------------------------------------------------------------

/** Category → on, as the route sends it; null when it could not be read. */
export async function loadNotificationPrefs(gw: GatewayContext): Promise<Record<string, boolean> | null> {
  const b = await secondary<{ preferences: Record<string, unknown> }>(
    gw,
    'GET',
    '/notifications/preferences',
    'notification preferences',
  )
  if (!b || !b.preferences || typeof b.preferences !== 'object') return null
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(b.preferences)) {
    if (typeof v !== 'boolean') return null
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Library and Recent reading.
// ---------------------------------------------------------------------------

export const LIBRARY_PAGE = 50

export interface LibraryItem {
  articleId: string
  acquiredAt: string
  title: string | null
  dTag: string | null
  isPaywalled: boolean
  writer: { username: string | null; displayName: string | null }
}

export interface LibraryData {
  items: LibraryItem[]
  /** The route returns no total: a full page is taken to mean there may be more. */
  nextOffset: number | null
}

export async function loadLibrary(gw: GatewayContext, offset: number): Promise<LibraryData> {
  const b = okBody(
    await call<{ items: LibraryItem[] }>(gw, 'GET', '/my/library' + query({ limit: LIBRARY_PAGE, offset })),
    'library',
  )
  if (!Array.isArray(b.items)) throw new GatewayFault('library: no list')
  return { items: b.items, nextOffset: b.items.length === LIBRARY_PAGE ? offset + LIBRARY_PAGE : null }
}

export const HISTORY_PAGE = 50

export interface HistoryData {
  items: Array<{ openedAt: string; post: Post }>
  nextOffset: number | null
  retentionDays: number | null
  /** Whether the member keeps the log at all; null when that could not be read. */
  logEnabled: boolean | null
}

export async function loadHistory(gw: GatewayContext, offset: number): Promise<HistoryData> {
  const [answer, prefs] = await Promise.all([
    call<{ items: HistoryData['items']; hasMore?: unknown; retentionDays?: unknown }>(
      gw,
      'GET',
      '/reading-log' + query({ limit: HISTORY_PAGE, offset }),
    ),
    secondary<{ readingLogEnabled?: unknown }>(gw, 'GET', '/me/reading-preferences', 'reading preferences'),
  ])
  const b = okBody(answer, 'reading log')
  if (!Array.isArray(b.items)) throw new GatewayFault('reading log: no list')
  const days = Number(b.retentionDays)
  return {
    items: b.items,
    nextOffset: b.hasMore === true ? offset + HISTORY_PAGE : null,
    retentionDays: b.retentionDays === null || b.retentionDays === undefined || !Number.isFinite(days) ? null : days,
    logEnabled: typeof prefs?.readingLogEnabled === 'boolean' ? prefs.readingLogEnabled : null,
  }
}
