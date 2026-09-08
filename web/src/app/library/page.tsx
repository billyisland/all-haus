import { redirect } from 'next/navigation'

// The library is a workspace Glasshouse overlay (opened from the ForallMenu or
// via /reader?overlay=library). This route is retained only as a compatibility
// shim: old links pointing at /library — and the /history and /reading-history
// shims before it — redirect into the workspace with the overlay opened,
// forwarding ?tab. See the deep-link dispatcher in WorkspaceView.
//
// The tab ids are `recent` and `library` since 2026-09-04. The old
// `bookmarks`/`history` pair is deliberately NOT aliased here: `history` mapped
// to a tab whose route had answered 500 for its whole life, and `bookmarks` to
// one that never held a row on any database, so there is no live link to honour
// and no reader to disappoint. An unrecognised ?tab opens the default.
export default function LibraryPage({
  searchParams,
}: {
  searchParams: { tab?: string | string[] }
}) {
  const params = new URLSearchParams({ overlay: 'library' })
  const tab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  if (tab === 'library') params.set('tab', 'library')
  redirect(`/reader?${params.toString()}`)
}
