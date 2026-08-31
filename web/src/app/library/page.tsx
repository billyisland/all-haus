import { redirect } from 'next/navigation'

// The library (bookmarks + reading history) is now a workspace Glasshouse
// overlay (opened from the ForallMenu or via /reader?overlay=library). This
// route is retained only as a compatibility shim: old links and bookmarks
// pointing at /library — and the /bookmarks, /history, /reading-history shims
// before it — redirect into the workspace with the overlay opened, forwarding
// ?tab=history. See the deep-link dispatcher in WorkspaceView.
export default function LibraryPage({
  searchParams,
}: {
  searchParams: { tab?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'library' })
  const tab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  if (tab === 'history') params.set('tab', 'history')
  redirect(`/reader?${params.toString()}`)
}
