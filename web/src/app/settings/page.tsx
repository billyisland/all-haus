import { redirect } from 'next/navigation'

// Settings is now a workspace Glasshouse overlay (opened from the ForallMenu or
// via /reader?overlay=settings). This route is retained only as a
// compatibility shim: old links and bookmarks pointing at /settings redirect
// into the workspace with the overlay opened. The gateway's social-account
// OAuth callback returns to /settings?linked=<flag>; that flag is forwarded so
// the panel's connect banner still shows inside the overlay. See the deep-link
// dispatcher in WorkspaceView.
export default function SettingsPage({
  searchParams,
}: {
  searchParams: {
    linked?: string | string[]
    follows?: string | string[]
    onboarding?: string | string[]
    refresh?: string | string[]
  }
}) {
  const params = new URLSearchParams({ overlay: 'settings' })
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const linked = first(searchParams.linked)
  if (linked) params.set('linked', linked)
  // Post-link follow-import offer count (FOLLOW-GRAPH-IMPORT-ADR §7.1) —
  // rides the same channel as the connect flag.
  const follows = first(searchParams.follows)
  if (follows) params.set('follows', follows)

  // Stripe Connect onboarding returns here (gateway auth.ts::upgrade-writer):
  // `?onboarding=complete` on success, `?refresh=true` when the account link
  // expired or was abandoned. Nothing reads them yet — forwarded so the
  // breadcrumb survives the hop rather than being silently dropped.
  const onboarding = first(searchParams.onboarding)
  if (onboarding) params.set('onboarding', onboarding)
  const refresh = first(searchParams.refresh)
  if (refresh) params.set('refresh', refresh)

  redirect(`/reader?${params.toString()}`)
}
