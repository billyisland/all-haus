// =============================================================================
// Mute and block — the words, in one home for both registers.
//
// The full site's `components/social/MuteBlockControls.tsx` (a client
// component) and modernhaus say the same things about muting and blocking a
// person. They live here because modernhaus cannot import a `'use client'`
// file. The reasoning — why a block is confirmed and a mute is not, and why the
// confirm names what the block ends — is in that component's header.
// =============================================================================

export const MUTE_LABEL = 'Mute'
export const UNMUTE_LABEL = 'Unmute'
export const BLOCK_LABEL = 'Block'
export const UNBLOCK_LABEL = 'Unblock'
export const MUTE_BLOCK_UNAVAILABLE = 'Couldn’t load the mute and block controls. Please try again.'

export function blockConfirmTitle(name: string): string {
  return `Block ${name}?`
}
export const BLOCK_CONFIRM_LABEL = 'Block'
/** What a block ends, said BEFORE the press — one paragraph each. */
export const BLOCK_CONSEQUENCES: readonly string[] = [
  'Neither of you will be able to follow, message or reply to the other, and you won’t see their posts, comments or notifications.',
  'You’ll both stop following each other. Any subscription between you stops renewing and runs to the end of the period already paid for — nothing is refunded or charged.',
  'Unblocking later won’t restore the follows or the subscriptions.',
]

export const MUTE_FAILED = 'Couldn’t mute them. Please try again.'
export const UNMUTE_FAILED = 'Couldn’t unmute them. Please try again.'
export const UNBLOCK_FAILED = 'Couldn’t unblock them. Please try again.'
export const BLOCK_FAILED = 'Couldn’t block them. Nothing has changed, so please try again.'
