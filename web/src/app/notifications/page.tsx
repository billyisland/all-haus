import { redirect } from 'next/navigation'

// Notifications is now a workspace Glasshouse overlay (opened from the ForallMenu
// or via /reader?overlay=notifications). This route is retained only as a
// compatibility shim: old links and bookmarks pointing at /notifications
// redirect into the workspace with the overlay opened. See the deep-link
// dispatcher in WorkspaceView.
export default function NotificationsPage() {
  redirect('/reader?overlay=notifications')
}
