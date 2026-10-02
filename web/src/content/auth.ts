// =============================================================================
// Signing in, making an account, the age step and the waiting list — the
// words, in one home for both registers.
//
// The full site's pages (`app/auth/**`, `app/waitlist`, `components/legal/
// AgeGate.tsx`, all client components) and modernhaus's (`/modernhaus/signin`,
// `/auth/verify`, `/signup`, `/age`, `/waitlist`, bare HTML) say the same
// things. They live here because modernhaus cannot import a `'use client'`
// file, and two copies of a door drift apart invisibly. The reasoning behind
// each sentence is in the full site page's comments.
// =============================================================================

/** The generic failure every one of these forms falls back on. */
export const AUTH_TRY_AGAIN = 'Something went wrong. Please try again.'

// --- Sign in -----------------------------------------------------------------

export const SIGNIN_TITLE = 'Welcome back'
export const SIGNIN_INTRO = 'We’ll email you a link to log in with. No password required — or, indeed, allowed.'
export const SIGNIN_SUBMIT = 'Send the link'
export const SIGNIN_NEW_HERE = 'New here?'

export const LINK_SENT_TITLE = 'Check your email'
/** Around the address: `If {email} has an account, a login link is on its way. …` */
export const LINK_SENT_BEFORE = 'If '
export const LINK_SENT_AFTER = ' has an account, a login link is on its way. It works once, within the next fifteen minutes. If it hasn’t arrived in a minute or two, check your spam folder.'
export const LINK_SENT_AGAIN = 'Use a different address'

// --- The emailed link --------------------------------------------------------

export const VERIFY_FAILED_TITLE = 'That link didn’t work'
export const VERIFY_EXPIRED = 'This link has expired or has already been used. Each link works only once, so you’ll need a new one.'
export const VERIFY_NO_TOKEN = 'This link is incomplete, probably because it was cut short on the way here. Try copying the whole link from the email, or request a new one.'
export const VERIFY_REQUEST_NEW = 'Request a new link'

// --- Make an account ---------------------------------------------------------

export const SIGNUP_TITLE = 'Make an account'
export function signupIntro(hasArrival: boolean): string {
  return hasArrival
    ? 'Three things, and then the piece you were reading.'
    : 'Three things, and no password to remember.'
}
export const SIGNUP_NAME_LABEL = 'Your name'
export const SIGNUP_NAME_PLACEHOLDER = 'What people should call you'
export const SIGNUP_SUBMIT = 'Make my account'
export const SIGNUP_BEEN_HERE = 'Been here before?'
/** `email_taken` — the reader's to fix. */
export const SIGNUP_EMAIL_TAKEN = 'There’s already an account with that email address. Log in instead, and we’ll send a link to it.'
/** `account_taken` — the derived handle losing a race; nothing the reader typed. */
export const SIGNUP_ACCOUNT_RACE = 'Something went wrong setting up your account. Please try again.'

// --- The date of birth (three labelled boxes, web-foundations.md) -----------

export const DOB_LABEL = 'Date of birth'
export const DOB_DAY = 'Day'
export const DOB_MONTH = 'Month'
export const DOB_YEAR = 'Year'
export const DOB_HINT = 'For example, 5 3 1978 for 5 March 1978'

// --- The age step ------------------------------------------------------------

export const AGE_TITLE = 'One thing first'
export const AGE_INTRO =
  'all.haus is adults-only. Please tell us your date of birth.'
export const AGE_SUBMIT = 'That’s me'
export const AGE_DECLINE = 'Would rather not?'
export const AGE_SAVE_FAILED = 'That didn’t save. Check the date and try again.'

// --- The waiting list --------------------------------------------------------

export const WAITLIST_TITLE = 'Not open yet.'
export function waitlistIntro(fromBeta: boolean): string {
  return fromBeta
    ? 'You’re not in the beta yet. Join the waiting list and we’ll write when we’re ready for you.'
    : 'all.haus is in closed beta, which is a polite way of saying we’re still fixing things. Join the list and we’ll write when we’re ready for you.'
}
export const WAITLIST_SUBMIT = 'Join the list'
export const WAITLIST_JOINED_TITLE = 'You’re on the list.'
/** Around the address: `We’ll write to {email} when we’re ready for you.` */
export const WAITLIST_JOINED_BEFORE = 'We’ll write to '
export const WAITLIST_JOINED_AFTER = ' when we’re ready for you.'
export const WAITLIST_HAVE_ACCOUNT = 'Already have an account?'

// --- Links between the doors -------------------------------------------------

export const LINK_MAKE_ACCOUNT = 'Make an account'
export const LINK_JOIN_WAITLIST = 'Join the waiting list'
export const LINK_LOG_IN = 'Log in'
export const LINK_SIGN_OUT = 'Sign out'
