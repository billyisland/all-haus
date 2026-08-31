// =============================================================================
// Unlock error mapping — gate-pass failures → honest, actionable copy.
//
// Pure so it's unit-testable. The gate-pass route's typed results arrive as
// {status, body:{error, message?, readEventId?}} via ApiError; each case gets
// a distinct message because the fixes differ:
//   - free_allowance_exhausted → the £5 float can't cover this read: add a card
//   - article_misconfigured    → broken publish: nothing the reader can do
//   - paid-but-no-key (502 + readEventId) → retry is free, say so
// =============================================================================

export interface UnlockErrorView {
  message: string
  /** true when adding a payment card is the fix — the gate shows the CTA */
  needsCard: boolean
}

export function mapUnlockError(status: number | undefined, body: unknown): UnlockErrorView {
  const b = (body ?? {}) as { error?: unknown; message?: unknown; readEventId?: unknown }
  const code = typeof b.error === 'string' ? b.error : null
  const serverMessage = typeof b.message === 'string' ? b.message : null

  if (status === 402) {
    if (code === 'free_allowance_exhausted') {
      return {
        message:
          'Your free reading credit can’t cover this article. Add a payment card to keep reading — you only pay for what you read.',
        needsCard: true,
      }
    }
    return {
      message: serverMessage ?? 'Payment required — add a payment card to keep reading.',
      needsCard: true,
    }
  }

  if (code === 'article_misconfigured') {
    return {
      message:
        serverMessage ??
        'This article can’t be unlocked right now — the author needs to re-publish it. You have not been charged.',
      needsCard: false,
    }
  }

  // Paid, but the content key couldn't be delivered. The unlock is already
  // recorded server-side, so retrying is free — tell the reader that.
  if (status === 502 && 'readEventId' in b) {
    return {
      message:
        'Your unlock went through but the content couldn’t be delivered. Try again — you won’t be charged twice.',
      needsCard: false,
    }
  }

  if (status === 502) {
    return {
      message: 'The reading service is temporarily unreachable. Try again in a moment.',
      needsCard: false,
    }
  }

  return {
    message:
      serverMessage ??
      (typeof b.error === 'string' ? b.error : 'Something went wrong unlocking this article. Please try again.'),
    needsCard: false,
  }
}
