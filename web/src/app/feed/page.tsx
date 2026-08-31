import { redirect } from 'next/navigation'

// The legacy global /feed timeline is retired (FEED-RETIREMENT Slice 3): the
// workspace is the entirety of logged-in all.haus. (The interim composable
// `reach:*` sources that replaced it were themselves retired — migration 177.)
// This route is kept only as a compatibility shim so old links, bookmarks and
// post-auth redirects pointing at /feed land on the workspace. The legacy
// FeedView card stack is deleted in Slice 7.
export default function FeedPage() {
  redirect('/reader')
}
