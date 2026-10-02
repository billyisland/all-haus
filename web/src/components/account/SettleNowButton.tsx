'use client'

// =============================================================================
// SettleNowButton — Reader Terms 5.3, "You can settle your tab early at any
// time from your account".
//
// WHAT IT IS FOR. The tab is a debt that collects itself at £8 or at 30 days,
// and a reader who would rather not carry it — because they are leaving, or
// because they simply do not want an open tab — had no way to say so. This is
// that way, and it is the same settlement every other trigger takes: nothing
// about the money is new, only who decided.
//
// WHEN IT IS NOT OFFERED. A button that cannot do its job is not offered, so
// the caller gates it on the two facts the server reads — something owed, and a
// card that has not terminally declined. The declined case has its own standing
// prompt (`CardActionRequired`) carrying the action that would fix it; a second
// control beside it, which could only fail, would be the same press twice.
//
// THE ONE CASE IT DOES OFFER AND CANNOT COMPLETE is a tab under Stripe's 30p
// floor, which the server answers in words. That floor is Stripe's, not ours,
// and it lives in the payment service; a copy of the number here would be a
// second home for a constant that is not even the platform's to set.
// =============================================================================

import { useState } from 'react'
import { account as accountApi } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { settleNowLabel, SETTLE_FAILED } from '../../content/ledger'

export function SettleNowButton({
  balancePence,
  onSettled,
}: {
  /** What the reader owes, in pence — always > 0 where this renders. */
  balancePence: number
  /** Re-fetch the tab: after a charge the reads and the balance both move. */
  onSettled: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  async function handleSettle() {
    setBusy(true)
    setNotice(null)
    setFailed(false)
    try {
      const result = await accountApi.settleTab()
      // The server's own sentence, not one composed here: it knows which of the
      // outcomes happened, and three of them are not failures.
      setNotice(result.message)
      if (result.settled) onSettled()
    } catch (err) {
      // The gateway sends a `message` on every refusal here — each one names a
      // different fix, so the fallback is only for a transport failure.
      setNotice(
        apiErrorMessage(err) ?? SETTLE_FAILED,
      )
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-8">
      <button
        type="button"
        onClick={() => void handleSettle()}
        disabled={busy}
        className="btn-soft py-2 px-4 text-sm disabled:opacity-50"
      >
        {busy ? 'Settling…' : settleNowLabel(balancePence)}
      </button>
      {notice && (
        <p
          role="status"
          className={`text-ui-xs mt-2 ${failed ? 'text-crimson' : 'text-grey-600'}`}
        >
          {notice}
        </p>
      )}
    </div>
  )
}
