import { redirect } from 'next/navigation'

// Search is now the dock SearchPanel inside the workspace (opened from the
// ForallMenu) — it already covers writers + articles + publications and routes
// every result into an overlay, so the standalone /search page is retired
// (FEED-RETIREMENT Slice 4). This route is kept only as a compatibility shim:
// old links and bookmarks pointing at /search land on the workspace, where the
// search affordance lives.
export default function SearchPage() {
  redirect('/reader')
}
