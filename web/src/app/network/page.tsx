import { redirect } from 'next/navigation'

// The social graph (following / followers / blocked / muted / vouches) is now a
// workspace Glasshouse overlay (opened from the ForallMenu or via
// /reader?overlay=network). This route is retained only as a compatibility
// shim: old links and bookmarks pointing at /network — and the /followers shim
// before it — redirect into the workspace with the overlay opened, forwarding
// ?tab= (e.g. the /network?tab=vouches trust-graph deep-link). See the deep-link
// dispatcher in WorkspaceView.
const TABS = ['following', 'followers', 'blocked', 'muted', 'vouches']

export default function NetworkPage({
  searchParams,
}: {
  searchParams: { tab?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'network' })
  const tab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  if (tab && TABS.includes(tab)) params.set('tab', tab)
  redirect(`/reader?${params.toString()}`)
}
