import { redirect } from 'next/navigation'

// Profile editing (name / bio / avatar / username) is now a section of the
// account-settings workspace Glasshouse overlay (the ProfileSection in
// SettingsPanel). This route is retained only as a compatibility shim: old
// links and bookmarks pointing at /profile redirect into the workspace with the
// settings overlay opened. See the deep-link dispatcher in WorkspaceView.
export default function ProfilePage() {
  redirect('/reader?overlay=settings')
}
