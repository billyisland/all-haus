import { redirect } from 'next/navigation'

// External subscriptions are now feed-derived: you "subscribe" to a source by
// adding it to a feed (the FeedComposer "Add a source" field, or the Follow
// affordance on an external byline). The standalone Subscriptions manager was
// retired — this route survives only as a compatibility shim so old links and
// bookmarks resolve into the workspace.
export default function SubscriptionsPage() {
  redirect('/reader')
}
