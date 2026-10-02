import { redirect } from 'next/navigation'

// Your followers are a view on your own profile (`WriterActivity`'s FOLLOWERS
// button), reached through the dispatcher's `me` sentinel — a server redirect
// reads no session, so it cannot name the username. See /network's shim.
export default function FollowersPage() {
  redirect('/reader?overlay=profile&user=me&tab=followers')
}
