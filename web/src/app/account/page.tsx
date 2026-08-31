import { redirect } from 'next/navigation'

// The ledger (formerly /account) is now a workspace Glasshouse overlay. Redirect
// straight into it; see the deep-link dispatcher in WorkspaceView.
export default function AccountRedirect() {
  redirect('/reader?overlay=ledger')
}
