import { redirect } from 'next/navigation'

// The dashboard is now a workspace Glasshouse overlay (opened from the ForallMenu
// or via /reader?overlay=dashboard). This route is retained only as a
// compatibility shim: notification/email deep links and old bookmarks pointing
// at /dashboard?tab=…&context=… redirect into the workspace with the overlay
// opened and seeded. See the deep-link effect in WorkspaceView.
export default function DashboardPage({
  searchParams,
}: {
  searchParams: { tab?: string | string[]; context?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'dashboard' })
  const tab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  const context = Array.isArray(searchParams.context) ? searchParams.context[0] : searchParams.context
  if (tab) params.set('tab', tab)
  if (context) params.set('context', context)
  redirect(`/reader?${params.toString()}`)
}
