// =============================================================================
// Writing access — the words a READER meets where writing would be, in one home
// for both registers (READER-WRITER-SPLIT-ADR §6).
//
// A reader is offered no writing control (web/CLAUDE.md › *A button that
// cannot do its job is not offered*), so every place one would stand — the ∀
// menu's Dashboard row, a deep link to the dashboard or the editor, `/write`
// reached directly, modernhaus's writing pages — says the same thing instead,
// and offers the one act a reader CAN perform: asking. The full site renders
// it through `WriterAccessPanel`; modernhaus may not import a 'use client'
// file, so the sentences live here and both read them.
//
// The first sentence is the Terms' own (Terms 8.1): the published text and the
// page that stands where writing would be say the same thing.
// =============================================================================

export const WRITER_ACCESS_TITLE = 'Writing articles'

export const WRITER_ACCESS_BODY =
  'Every member can post notes and replies. Publishing articles, and selling access to them, is open to members we have admitted as writers.'

// O4: applying asks nothing. The operator judges from what the member has
// posted, and the grant sends the "you can now publish" email (D3); a refusal
// sends nothing (plan §D.5 Q4 is still open), so the copy promises only the
// email that exists.
export const WRITER_ACCESS_ASK =
  'You can ask to be one. There is nothing to fill in: we look at what you have posted here, and we will email you if we admit you.'

export const WRITER_APPLY = 'Apply to write'
export const WRITER_APPLY_SENDING = 'Sending…'
export const WRITER_APPLY_FAILED = 'Your application was not sent. Try again.'

/** `date` arrives formatted by the caller (British, `'en-GB'`). */
export const writerApplied = (date: string) =>
  `Application sent on ${date}. We will email you if we admit you.`

/** The ∀ menu row that stands where Dashboard stands for a writer. */
export const WRITER_MENU_APPLY = 'Apply to write'
export const WRITER_MENU_APPLIED = 'Application sent'

/** The composers' banner for a reader's over-long note: the article offer is
 *  a writer's, so a reader is told the one way on. */
export const NOTE_TOO_LONG_READER = 'Too long for a note. Shorten it to post.'

/** British, long-form: the only date this surface renders. */
export function formatAppliedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/** modernhaus's `?done=` sentence: a page must say what a press did. The page
 *  it returns to then shows the dated line above. */
export const WRITER_APPLY_DONE = 'Application sent.'
