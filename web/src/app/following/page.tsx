import { redirect } from 'next/navigation'

// FOLLOWING WAS A VIEW, NOT A PAGE — it is one of the five in `WriterActivity`,
// and since the Network page dissolved it lives on the member's own profile.
// So the shim names the view rather than bouncing through bare /network, which
// lands on the profile's front door and drops what the link was about. `me`
// because a server redirect reads no session (see /network's shim).
export default function FollowingRedirect() {
  redirect('/reader?overlay=profile&user=me&tab=following')
}
