import { redirect } from 'next/navigation'

// The ledger is now a workspace Glasshouse overlay (opened from the ForallMenu
// or via /reader?overlay=ledger). This route is retained only as a
// compatibility shim: old links and bookmarks pointing at /ledger (and the
// /account shim that redirects here) redirect into the workspace with the
// overlay opened. See the deep-link dispatcher in WorkspaceView.
export default function LedgerPage() {
  redirect('/reader?overlay=ledger')
}
