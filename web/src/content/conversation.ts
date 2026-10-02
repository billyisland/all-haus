// =============================================================================
// A conversation's acts — the words, in one home for both registers.
//
// The full site's card (`components/post/PostCardInteractive.tsx`, a client
// component) asks before deleting a reply with a `ConfirmDialog`; modernhaus
// asks on its own confirm page. Same question, same consequence.
// =============================================================================

export const DELETE_REPLY_TITLE = 'Delete this reply?'
export const DELETE_REPLY_BODY = 'It will disappear from the conversation for everyone. Any replies to it will stay where they are.'
export const DELETE_LABEL = 'Delete'
export const DELETE_REPLY_FAILED = 'Couldn’t delete this reply. Please try again.'

/** A network as a member would name it in a sentence, by the `protocol`
 *  a post or linked account carries; absent for one we cannot name. */
const NETWORK_NAMES: Record<string, string> = {
  atproto: 'Bluesky',
  activitypub: 'Mastodon',
  nostr_external: 'Nostr',
}

export function networkName(protocol: string): string | undefined {
  return NETWORK_NAMES[protocol]
}

/** The hover on a like, reply or repost button that cannot work until the
 *  member links an account on the post's own network. */
export function linkAccountToAct(protocol: string, act: 'like' | 'reply' | 'repost'): string {
  const network = networkName(protocol)
  const doIt = act === 'reply' ? 'reply here' : `${act} this`
  return network
    ? `Link your own ${network} account to all.haus in Settings to ${doIt}`
    : `Link your own account on this network to all.haus in Settings to ${doIt}`
}

/** An external reply published here but never queued for its network
 *  (CROSS-NETWORK-ROUNDTRIP-ADR A7). `network` is the name a member would use,
 *  or absent where it is not known. */
export function externalReplyNotSent(network?: string | null): string {
  return `Your reply is on all.haus, but we couldn’t send it to ${network ?? 'the other network'}.`
}
