import { createElement, type ReactElement } from 'react'
import {
  PROFILE_UPLOAD_FAILED,
  PROFILE_SAVE_FAILED,
  USERNAME_CHANGE_FAILED,
  EMAIL_CHANGE_FAILED,
  DELETE_FAILED,
  SETTINGS_TITLE,
} from '../../content/settings'
import { call, must, path, type GatewayAnswer } from '../gateway'
import { documentResponse, loadViewer, loadUnreadCounts } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { filePart, uploadPicture } from '../picture'
import { loadAccountFacts, type FollowImportRun, type PrivacyPrefs } from '../settings-loaders'
import {
  SettingsIndexPage,
  AccountSettingsPage,
  DeleteAccountPage,
  FollowImportStatusPage,
  notificationCategoriesShown,
} from '../pages/settings'
import { doorOwns, offSite, ok, refused, str } from './shared'

// =============================================================================
// modernhaus — Settings writes (MODERNHAUS-ADR §D2.4, E6). Each calls the
// route the full site's panel calls.
//
// A form carrying typed text re-renders with it on a refusal (§D1.3), and
// with the route's own sentence (§D2.5.3) or the panel's own fallback where
// the route sent none. 401 and `age_required` stay the door's.
//
// PREFERENCES ARE WRITTEN BY DIFFERENCE. A switch that did not change is not
// sent: turning discovery "on" again re-arms the discovery backfill, and a
// notification category re-saved is a write nobody asked for. The action
// re-reads the current values rather than trusting the page's.
// =============================================================================

const S = '/modernhaus/settings'
const raw = (v: Input[string]): string => (typeof v === 'string' ? v : '')

/** A settings page re-rendered around a refusal, with what was typed. */
async function again(ctx: ActionContext, title: string, twin: string, body: ReactElement, status: number): Promise<ActionOutcome> {
  const [viewer, counts] = await Promise.all([loadViewer(ctx.gw), loadUnreadCounts(ctx.gw)])
  if (!viewer) return refused(401)
  return {
    kind: 'response',
    response: await documentResponse({
      title,
      viewer,
      csrf: ctx.csrf,
      twin,
      outcome: null,
      body,
      status,
      cookies: ctx.gw.setCookies,
      counts,
    }),
  }
}

/** A refusal's status as the re-rendered page answers it: the route's 4xx, else 400. */
const refusalStatus = (status: number): number => (status >= 400 && status < 500 ? status : 400)

/** The route's own words if it sent any, else the panel's fallback. */
function sentenceOr(answer: GatewayAnswer, fallback: string): string {
  const b = answer.body && typeof answer.body === 'object' ? (answer.body as { message?: unknown; error?: unknown }) : {}
  if (typeof b.message === 'string' && b.message.trim() !== '') return b.message
  if (typeof b.error === 'string' && /\s/.test(b.error)) return b.error
  return fallback
}

// ---------------------------------------------------------------------------
// Profile.
// ---------------------------------------------------------------------------

async function profileSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const values = { displayName: raw(input.displayName), bio: raw(input.bio) }
  const refuse = async (sentence: string, status: number) => {
    const facts = await loadAccountFacts(ctx.gw)
    return again(ctx, SETTINGS_TITLE, '/settings', createElement(SettingsIndexPage, { facts, csrf: ctx.csrf, values, error: sentence }), refusalStatus(status))
  }

  // The picture goes first, as the full site's upload does, and only a
  // stored one reaches the profile.
  const upload = await uploadPicture(ctx, filePart(ctx.form, 'avatar'))
  if (upload.kind === 'refused') {
    if (doorOwns(upload.answer)) return { kind: 'answer', answer: upload.answer }
    return refuse(sentenceOr(upload.answer, PROFILE_UPLOAD_FAILED), upload.answer.status)
  }
  const body: Record<string, unknown> = { displayName: values.displayName.trim(), bio: values.bio }
  if (upload.kind === 'stored') body.avatar = upload.url
  else if (input.removeAvatar === true) body.avatar = null

  const a = must(await call(ctx.gw, 'PATCH', '/auth/profile', { json: body }), 'profile save')
  if (ok(a)) return { kind: 'done', code: 'profile_saved' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return refuse(sentenceOr(a, PROFILE_SAVE_FAILED), a.status)
}

// ---------------------------------------------------------------------------
// Account: username, email, export, deactivate, delete.
// ---------------------------------------------------------------------------

async function accountAgain(ctx: ActionContext, extra: Partial<Parameters<typeof AccountSettingsPage>[0]>, status: number) {
  const facts = await loadAccountFacts(ctx.gw)
  return again(
    ctx,
    SETTINGS_TITLE,
    '/settings',
    createElement(AccountSettingsPage, { facts, csrf: ctx.csrf, now: new Date(), ...extra }),
    refusalStatus(status),
  )
}

async function usernameChange(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const value = str(input.newUsername)
  const a = must(await call(ctx.gw, 'POST', '/auth/change-username', { json: { newUsername: value } }), 'username change')
  if (ok(a)) return { kind: 'done', code: 'username_changed' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return accountAgain(ctx, { username: { value, error: sentenceOr(a, USERNAME_CHANGE_FAILED) } }, a.status)
}

async function emailChange(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const value = str(input.newEmail)
  const a = must(await call(ctx.gw, 'POST', '/auth/change-email', { json: { newEmail: value } }), 'email change')
  if (ok(a)) return { kind: 'done', code: 'email_change_sent' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return accountAgain(ctx, { email: { value, error: sentenceOr(a, EMAIL_CHANGE_FAILED) } }, a.status)
}

async function accountDelete(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const email = str(input.emailConfirmation)
  const a = must(
    await call(ctx.gw, 'POST', '/auth/delete-account', { json: { emailConfirmation: email } }),
    'delete account',
  )
  // The route destroyed the session; its clearing cookie rides the redirect.
  if (ok(a)) return { kind: 'done', code: 'deleted_account', back: '/modernhaus' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  // The two money refusals (a declined final charge, a settlement still in
  // flight) each send a sentence naming what to do; the full site shows it.
  return again(
    ctx,
    'Delete your account?',
    '/settings',
    createElement(DeleteAccountPage, { csrf: ctx.csrf, email, error: sentenceOr(a, DELETE_FAILED) }),
    refusalStatus(a.status),
  )
}

// ---------------------------------------------------------------------------
// Networks: link (off-site), the two consents, and follow import.
// ---------------------------------------------------------------------------

async function networkLink(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const protocol = str(input.protocol)
  const identity = str(input.identity)
  if (!identity) return refused(400)
  let a: GatewayAnswer<{ authorizeUrl?: unknown }>
  if (protocol === 'activitypub') {
    a = await call(ctx.gw, 'POST', '/linked-accounts/mastodon', { json: { instanceUrl: identity } })
  } else if (protocol === 'atproto') {
    a = await call(ctx.gw, 'POST', '/linked-accounts/bluesky', { json: { handle: identity } })
  } else {
    return refused(400)
  }
  // The member's own instance or PDS: no fixed host list is possible, so the
  // URL must come out of the gateway's own answer, https (§D2.5.2).
  if (ok(a)) return offSite(ctx, a.body?.authorizeUrl) ?? { kind: 'error', code: 'network_connect_failed' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  // 502: the instance would not register us. The full site says its fallback.
  if (a.status >= 500) return { kind: 'error', code: 'network_connect_failed' }
  return { kind: 'answer', answer: a }
}

async function followImport(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  // `<protocol> <origin identity>`, as the lookup page wrote it from the
  // resolver's own match; the route validates both.
  const origin = str(input.origin)
  const at = origin.indexOf(' ')
  if (at < 1) return refused(400)
  const a = must(
    await call<{ import?: { id?: unknown } }>(ctx.gw, 'POST', '/follow-imports', {
      json: { protocol: origin.slice(0, at), originIdentity: origin.slice(at + 1) },
    }),
    'follow import',
  )
  if (ok(a) && typeof a.body?.import?.id === 'string') {
    return { kind: 'done', code: 'import_started', back: `${S}/networks/imports?id=${encodeURIComponent(a.body.import.id)}` }
  }
  if (doorOwns(a) || ok(a)) return { kind: 'answer', answer: ok(a) ? { ...a, status: 502 } : a }
  return { kind: 'error', code: 'follow_import_failed' }
}

interface OpmlRun {
  import: FollowImportRun
  feed: { name?: string | null }
}

async function followImportOpml(ctx: ActionContext): Promise<ActionOutcome> {
  const file = filePart(ctx.form, 'opml')
  if (!file) return { kind: 'error', code: 'opml_unreadable' }
  // The route's own cap; a larger file is refused before it is read.
  if (file.size > 2_000_000) return { kind: 'error', code: 'too_large' }
  const opml = await file.text()
  const a = must(
    await call<{ runs?: OpmlRun[]; plan?: Parameters<typeof FollowImportStatusPage>[0]['plan'] }>(
      ctx.gw,
      'POST',
      '/follow-imports/opml',
      { json: { opml } },
    ),
    'opml import',
  )
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  if (!ok(a)) {
    const e = a.body && typeof a.body === 'object' ? (a.body as { error?: unknown }).error : undefined
    return { kind: 'error', code: e === 'opml_invalid' || e === 'empty_opml' ? 'opml_unreadable' : 'opml_failed' }
  }
  const runs = Array.isArray(a.body?.runs) ? a.body.runs : []
  const names: Record<string, string> = {}
  for (const r of runs) names[r.import.id] = r.feed?.name?.trim() || 'Imported feeds'
  // The plan's facts are known only on this answer, so the result RENDERS
  // (as the upload does) rather than crossing a redirect as free text.
  const ids = runs.map((r) => r.import.id)
  return again(
    ctx,
    'Importing your channels',
    '/settings',
    createElement(FollowImportStatusPage, {
      runs: runs.map((r) => r.import),
      names,
      plan: a.body?.plan,
      self: `${S}/networks/imports?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`,
    }),
    200,
  )
}

// ---------------------------------------------------------------------------
// Privacy and notification preferences — written by difference.
// ---------------------------------------------------------------------------

const onOff = (v: Input[string]): boolean | null => (v === 'on' ? true : v === 'off' ? false : null)

async function privacySave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const current = must(await call<PrivacyPrefs>(ctx.gw, 'GET', '/me/privacy-preferences'), 'privacy read')
  if (!ok(current) || !current.body) return { kind: 'answer', answer: current }
  const change: Partial<PrivacyPrefs> = {}
  for (const k of ['discoveryEnabled', 'publishFollowGraph', 'discoverableByEmail'] as const) {
    const want = onOff(input[k])
    if (want !== null && want !== current.body[k]) change[k] = want
  }
  if (Object.keys(change).length === 0) return { kind: 'done', code: 'prefs_saved' }
  const a = must(await call(ctx.gw, 'PUT', '/me/privacy-preferences', { json: change }), 'privacy save')
  if (ok(a)) return { kind: 'done', code: 'prefs_saved' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return { kind: 'error', code: 'prefs_not_saved' }
}

/**
 * One PUT per category that changed. A PARTIAL OUTCOME IS NOT A TOTAL ONE:
 * every change is tried, and one refused is counted and said, never hidden
 * behind the ones that saved.
 */
async function notificationPrefsSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const current = must(
    await call<{ preferences?: Record<string, boolean> }>(ctx.gw, 'GET', '/notifications/preferences'),
    'notification prefs read',
  )
  if (!ok(current) || !current.body?.preferences) return { kind: 'answer', answer: current }
  const prefs = current.body.preferences
  const changes = notificationCategoriesShown().flatMap((c) => {
    const want = onOff(input[c])
    return want !== null && want !== (prefs[c] !== false) ? [{ c, want }] : []
  })
  let saved = 0
  for (const { c, want } of changes) {
    try {
      const a = await call(ctx.gw, 'PUT', path`/notifications/preferences/${c}`, { json: { enabled: want } })
      if (ok(a)) saved++
      else if (doorOwns(a)) return { kind: 'answer', answer: a }
    } catch (err) {
      console.warn('[modernhaus] a notification preference failed', err)
    }
  }
  if (saved === changes.length) return { kind: 'done', code: 'prefs_saved' }
  return { kind: 'error', code: saved === 0 ? 'prefs_not_saved' : 'prefs_saved_partly' }
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

const back = (p: string) => () => `${S}${p}`

export const SETTINGS_ACTIONS: Registry = {
  profile_save: {
    kind: 'orchestrated',
    fields: { displayName: 'string', bio: 'string', removeAvatar: 'boolean' },
    run: profileSave,
    defaultReturn: back(''),
  },
  username_change: {
    kind: 'orchestrated',
    fields: { newUsername: 'string' },
    run: usernameChange,
    defaultReturn: back('/account'),
  },
  email_change: {
    kind: 'orchestrated',
    fields: { newEmail: 'string' },
    run: emailChange,
    defaultReturn: back('/account'),
  },
  // The step-up link lands on the full site (§R2.7), which spends it.
  export_request: {
    kind: 'simple',
    method: 'POST',
    fields: {},
    path: () => '/account/export/request',
    done: 'export_requested',
    defaultReturn: back('/account'),
  },
  deactivate: {
    kind: 'simple',
    method: 'POST',
    fields: { confirm: 'string' },
    path: () => '/auth/deactivate',
    done: 'deactivated',
    // The route ends the session; the member lands signed out.
    defaultReturn: () => '/modernhaus',
  },
  account_delete: {
    kind: 'orchestrated',
    fields: { emailConfirmation: 'string' },
    run: accountDelete,
    defaultReturn: back('/account/delete'),
  },
  network_link: {
    kind: 'orchestrated',
    fields: { protocol: 'string', identity: 'string' },
    run: networkLink,
    defaultReturn: back('/networks'),
  },
  // Both consents are sent, each from its own box: never one folded into the other.
  network_update: {
    kind: 'simple',
    method: 'PATCH',
    fields: { id: 'string', crossPostDefault: 'boolean', showOnProfile: 'boolean' },
    path: (i) => path`/linked-accounts/${str(i.id)}`,
    body: (i) => ({ crossPostDefault: i.crossPostDefault === true, showOnProfile: i.showOnProfile === true }),
    done: 'network_saved',
    defaultReturn: back('/networks'),
  },
  network_unlink: {
    kind: 'simple',
    method: 'DELETE',
    fields: { id: 'string' },
    path: (i) => path`/linked-accounts/${str(i.id)}`,
    done: 'network_unlinked',
    defaultReturn: back('/networks'),
  },
  follow_import: {
    kind: 'orchestrated',
    fields: { origin: 'string' },
    run: followImport,
    defaultReturn: back('/networks/import'),
  },
  follow_import_opml: {
    kind: 'orchestrated',
    fields: {},
    run: followImportOpml,
    defaultReturn: back('/networks'),
  },
  privacy_save: {
    kind: 'orchestrated',
    fields: { discoveryEnabled: 'string', publishFollowGraph: 'string', discoverableByEmail: 'string' },
    run: privacySave,
    defaultReturn: back('/privacy'),
  },
  notification_prefs_save: {
    kind: 'orchestrated',
    // Every category the page can show, by name; the gateway's list is the judge.
    fields: Object.fromEntries(notificationCategoriesShown().map((c) => [c, 'string' as const])),
    run: notificationPrefsSave,
    defaultReturn: back('/notifications'),
  },
  reading_log_toggle: {
    kind: 'simple',
    method: 'PUT',
    fields: { enabled: 'string' },
    path: () => '/me/reading-preferences',
    // Only the one dial: an omitted field leaves the other column alone.
    body: (i) => ({ readingLogEnabled: i.enabled === 'on' }),
    done: 'prefs_saved',
    defaultReturn: () => '/modernhaus/history',
  },
  reading_log_clear: {
    kind: 'orchestrated',
    fields: { confirm: 'string' },
    run: readingLogClear,
    defaultReturn: () => '/modernhaus/history',
  },
}

async function readingLogClear(ctx: ActionContext): Promise<ActionOutcome> {
  const a = must(await call<{ deleted?: unknown }>(ctx.gw, 'DELETE', '/reading-log'), 'reading log clear')
  if (!ok(a)) return { kind: 'answer', answer: a }
  return { kind: 'done', code: Number(a.body?.deleted) > 0 ? 'log_cleared' : 'log_empty' }
}
