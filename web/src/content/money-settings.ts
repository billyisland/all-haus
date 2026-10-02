import { formatPence } from '../lib/format'
import type { PayoutCadence } from '../lib/api/account'

// =============================================================================
// Settings › Payment — the words, in one home for both registers.
//
// The full site's `PaymentSection` and `PayoutPreferences` (client components)
// and modernhaus's `/modernhaus/settings/money` say the same things about a
// card, Stripe Connect and when a Writer is paid. The reasoning is in those
// components' comments — above all why removing a card says it does NOT clear
// what is owed (Reader Terms 2.4).
// =============================================================================

// ---- The card on file ------------------------------------------------------

export const CARD_CONNECTED = 'Card connected'
export const CARD_CONNECTED_HELP = 'Your reading tab settles automatically.'
export const CARD_ACTIVE = 'Active'
export const CARD_REMOVE = 'Remove card'
export const CARD_REMOVE_CONSEQUENCE =
  'Removing your card pauses paid reading until you add another. Anything already on your tab stays owed — settle it first if you would rather leave nothing outstanding.'
export const CARD_REMOVE_CONFIRM = 'Remove my card'
export const CARD_REMOVE_KEEP = 'Keep it'
export const CARD_REMOVE_FAILED = 'Could not remove the card. Try again in a moment.'
export const CARD_ADD_TITLE = 'Add a payment method'
export const CARD_ADD_HELP = 'Required to keep reading after your free allowance.'

// ---- Stripe Connect --------------------------------------------------------

export const CONNECT_TITLE = 'Stripe Connect'
export const CONNECT_VERIFIED = 'Verified — payouts enabled.'
export const CONNECT_VERIFIED_LABEL = 'Verified'
export const CONNECT_NEEDED = 'Connect to receive payouts.'
export const CONNECT_SET_UP = 'Set up'
export const CONNECT_FAILED = 'Failed to start Stripe setup.'

// ---- When a Writer is paid (PayoutPreferences) -----------------------------

export const PAYOUT_CADENCE_LABEL: Record<PayoutCadence, string> = {
  daily: 'As soon as possible',
  weekly: 'At most weekly',
  monthly: 'At most monthly',
}

export const PAYOUT_CADENCE_HELP: Record<PayoutCadence, string> = {
  daily: 'Paid on the next cycle after you pass the threshold.',
  weekly: 'At most one payment every seven days.',
  monthly: 'At most one payment a month.',
}

export const PAYOUT_PREFS_UNAVAILABLE = 'Your payout settings could not be loaded. Reload to try again.'
export const PAYOUT_HOW_OFTEN = 'How often'
export const PAYOUT_THRESHOLD_LABEL = 'Pay me once I have earned'
export function payoutFloorSentence(floorPence: number): string {
  return `Leave it empty to use the platform minimum, ${formatPence(floorPence)}. Each payment costs us a transfer fee, so this cannot be set lower.`
}
export const PAYOUT_MALFORMED = 'That is not an amount — try a number.'
export function payoutBelowFloor(floorPence: number): string {
  return `The minimum is ${formatPence(floorPence)}.`
}
export const PAYOUT_SAVED = 'Saved.'
export const PAYOUT_SAVE_FAILED = 'Could not save. Try again in a moment.'
