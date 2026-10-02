import { redirect } from 'next/navigation'

// THE NETWORK PAGE IS GONE (2026-09-15) — it dissolved rather than moved. Of
// its four live lists, Following and Followers were the member's own profile
// drawn as row strips (they are two of the five views in `WriterActivity`), and
// blocked/muted were already written in the settings register, so they are now
// two sections of Settings. Vouches went with them, still behind the parked
// trust flag. See the ForallMenu's Profile row, which took Network's seat.
//
// This shim sends each old tab where its content went. It cannot resolve a
// username — a server redirect reads no session — so the profile half goes
// through the dispatcher's `me` sentinel (lib/workspace/overlays.ts).
const TO_SETTINGS = ['blocked', 'muted', 'vouches']
// Network's other two tabs are two of WriterActivity's five views, and they
// keep their names across the move: a link to FOLLOWING must land on following
// rather than on the profile's front door.
const TO_PROFILE_VIEW = ['following', 'followers']

export default function NetworkPage({
  searchParams,
}: {
  searchParams: { tab?: string | string[] }
}) {
  const tab = Array.isArray(searchParams.tab) ? searchParams.tab[0] : searchParams.tab
  if (tab && TO_SETTINGS.includes(tab)) redirect('/reader?overlay=settings')
  if (tab && TO_PROFILE_VIEW.includes(tab))
    redirect(`/reader?overlay=profile&user=me&tab=${tab}`)
  redirect('/reader?overlay=profile&user=me')
}
