// =============================================================================
// Account export confirmation (`/account/export?token=`) — the words, in one
// home for both registers.
//
// The full site's page (`app/account/export/page.tsx`, a client component) and
// modernhaus's bare-HTML twin say the same things about spending the one-use
// export link. They live here because modernhaus cannot import a `'use client'`
// file. The reasoning — why a signed-out failure must say the link is fine — is
// in the full site page's header.
// =============================================================================

export const EXPORT_WORKING_TITLE = 'Preparing your export'
export const EXPORT_WORKING_BODY = 'Gathering your keys, articles and reading. This can take a moment.'

export const EXPORT_DONE_TITLE = 'Your export has downloaded'
export const EXPORT_DONE_KEY_WARNING =
  'It holds your Nostr secret key. Anyone with that file can be you anywhere on the network, and the key cannot be changed — keep it somewhere only you can reach.'
export const EXPORT_DONE_EMAILED =
  'We’ve emailed you a note that this happened, so an export you didn’t ask for never passes unnoticed.'

export const EXPORT_SIGNED_OUT_TITLE = 'Sign in on this device first'
export const EXPORT_SIGNED_OUT_BODY =
  'The link is fine — it needs your session as well. Sign in here, then open the link from your email again.'
export const EXPORT_SIGN_IN = 'Sign in'

export const EXPORT_USED_TITLE = 'That link has been used'
export const EXPORT_USED_BODY =
  'A confirmation link works once, and for fifteen minutes. Ask for a fresh one from your account settings and nothing is lost.'
export const EXPORT_BACK_TO_SETTINGS = 'Back to settings'

// A 429 is the route's own limit (five an hour per account), not a fault: the
// limiter answers before the handler, so the one-use link was not spent.
export const EXPORT_LIMITED_TITLE = 'Too many exports for now'
export const EXPORT_HELD_TITLE = 'Export paused'
export const EXPORT_LIMITED_BODY =
  'Exports are limited to five an hour, and this account has reached that. Your link was not used up — but it only lasts fifteen minutes, so if it has run out by then, ask for a fresh one from your account settings.'

export const EXPORT_ERROR_TITLE = 'That didn’t come through'
export const EXPORT_ERROR_BODY =
  'Something went wrong at our end, not with your link. Please try again: the link may still work.'
