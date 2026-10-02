// =============================================================================
// Unlock error mapping — gate-pass failures → honest, actionable copy.
//
// Pure so it's unit-testable. The gate-pass route's typed results arrive as
// {status, body:{error, message?, readEventId?}} via ApiError; each case gets
// a distinct message because the fixes differ:
//   - free_allowance_exhausted → the £5 float can't cover this read: add a card
//   - card_action_required     → the card on file declined: paid reading is
//                                paused until a working one replaces it
//   - tab_ceiling              → the tab is at its cap (Reader Terms 4.4): the
//                                refusal has already fired a charge, so the fix
//                                is to wait a moment, not to do anything
//   - reader_terms_required    → a card-holder who has never seen the Reader
//                                Terms: accept in the gate, then retry
//   - not_for_sale             → the writer's paid access has been withdrawn
//                                (Writer 9.3): not on sale, and nothing the
//                                reader can do about it
//   - article_misconfigured    → broken publish: nothing the reader can do
//   - paid-but-no-key (502 + readEventId) → retry is free, say so
//
// THE THREE FIXES ARE DIFFERENT AND THE FLAGS SAY WHICH. `needsCard` and
// `needsTerms` are not alternatives to each other by accident: the terms
// refusal reaches ONLY readers who already have a card, so offering them
// "add a payment card" would be pointing at a step they finished months ago.
// =============================================================================

/**
 * The gateway's refusal code for a card-holder who has not accepted the
 * current Reader Terms. Sent by the gate pass AND by both subscribe routes
 * (§0z item 5), so the three web surfaces that press those — the paywall gate,
 * the profile pane's subscribe row and the offer page — branch on ONE string,
 * pinned against `gateway/src/lib/terms-gate.ts` by `me-terms-wire.test.ts`.
 */
export const READER_TERMS_REQUIRED_CODE = 'reader_terms_required'

export interface UnlockErrorView {
  message: string
  /** true when adding a payment card is the fix — the gate shows the CTA */
  needsCard: boolean
  /** true when accepting the Reader Terms is the fix — the gate shows the box */
  needsTerms: boolean
}

export function mapUnlockError(status: number | undefined, body: unknown): UnlockErrorView {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; readEventId?: unknown }
  const code = typeof b.error === 'string' ? b.error : null
  const serverMessage = typeof b.message === 'string' ? b.message : null

  // Checked before the 402 branch and independently of it: this is a 403, and
  // it is the one refusal a card does not clear.
  if (code === READER_TERMS_REQUIRED_CODE) {
    return {
      message:
        serverMessage ??
        'Before your next paid read, please accept the all.haus Reader Terms.',
      needsCard: false,
      needsTerms: true,
    }
  }

  if (status === 402) {
    // BOTH OF THESE ARRIVE AS 402 AND NEITHER WANTS THE 402 COPY. The generic
    // "add a payment card" below is right for a reader who has never added one
    // and wrong for both readers here: one HAS a card and needs to replace it,
    // the other has a perfectly good card and needs to wait ten seconds. A
    // refusal whose suggested fix does not apply is worse than none, because
    // the reader does the suggested thing and the refusal does not move.
    if (code === 'card_action_required') {
      return {
        message:
          'The card on file was declined, so paid reading is paused. Add a working card to carry on — anything already on your tab settles then too.',
        needsCard: true,
        needsTerms: false,
      }
    }

    if (code === 'tab_ceiling') {
      return {
        message:
          'Your reading tab is at its limit, so we are charging your card now. Give it a moment and try again — nothing has been charged for this piece.',
        needsCard: false,
        needsTerms: false,
      }
    }

    if (code === 'free_allowance_exhausted') {
      return {
        message:
          'Your free reading allowance can’t cover this article. Add a payment card to keep reading — you only pay for what you read.',
        needsCard: true,
        needsTerms: false,
      }
    }
    return {
      message: serverMessage ?? 'Payment required — add a payment card to keep reading.',
      needsCard: true,
      needsTerms: false,
    }
  }

  // A 403 like the terms refusal, and like it a card does not clear it — but
  // unlike it there is nothing for the reader to DO. The piece is not on sale
  // because we cannot pay its writer (Writer 9.3; L5.6), which is between us
  // and them: the reader is told plainly that it is unavailable and that they
  // have not been charged, and is offered no fix, because offering one that
  // cannot work is worse than offering none.
  if (code === 'not_for_sale') {
    return {
      message:
        serverMessage ??
        'This piece isn’t available to buy at the moment. Nothing has been charged.',
      needsCard: false,
      needsTerms: false,
    }
  }

  if (code === 'article_misconfigured') {
    return {
      message:
        serverMessage ??
        'This article can’t be unlocked right now — the author needs to re-publish it. You have not been charged.',
      needsCard: false,
      needsTerms: false,
    }
  }

  // Paid, but the content key couldn't be delivered. The unlock is already
  // recorded server-side, so retrying is free — tell the reader that.
  if (status === 502 && 'readEventId' in b) {
    return {
      message:
        'Your unlock went through but the content couldn’t be delivered. Try again — you won’t be charged twice.',
      needsCard: false,
      needsTerms: false,
    }
  }

  if (status === 502) {
    return {
      message: 'The reading service is temporarily unreachable. Try again in a moment.',
      needsCard: false,
      needsTerms: false,
    }
  }

  return {
    message:
      serverMessage ??
      (typeof b.error === 'string' ? b.error : 'Something went wrong unlocking this article. Please try again.'),
    needsCard: false,
    needsTerms: false,
  }
}
