// =============================================================================
// The appeal (`/appeal/:reportId`) — the words, in one home for both registers.
//
// The full site's page (`app/appeal/[reportId]/page.tsx`, a client component)
// and modernhaus's bare-HTML twin say the same things to a member appealing a
// moderation decision. They live here because modernhaus cannot import a
// `'use client'` file. The reasoning — why the page never says what it is about,
// and why every refusal reads alike — is in the full site page's header.
// =============================================================================

export const APPEAL_FILED_TITLE = 'We have it.'
export const APPEAL_FILED_BODY =
  'A person will re-read the material against the same guidance we judged it by, and write to you within seven days. Whatever they decide, you will be told why.'

export const APPEAL_INCOMPLETE_TITLE = 'This link is incomplete.'
export const APPEAL_INCOMPLETE_BODY =
  'Open the appeal link from the email we sent you — the whole of it, including everything after the question mark.'

export const APPEAL_FORM_TITLE = 'Tell us what we got wrong.'
export const APPEAL_FORM_BODY =
  'A person will re-read the material against the same guidance and answer you within seven days. You can send this once.'

export const APPEAL_FIELD_LABEL = 'Your appeal'
export const APPEAL_PLACEHOLDER = 'What we have got wrong, and why.'
export const APPEAL_SUBMIT = 'Send it'
export const APPEAL_SENDING = 'Sending…'

/** The one sentence every refusal (403) comes back as — see the page header. */
export const APPEAL_UNUSABLE =
  'This appeal link is no longer usable. It may already have been used, or the seven days may have passed. Write to us and a person will read it.'
export const APPEAL_ERROR = 'Something went wrong. Please try again.'
