'use client'

// =============================================================================
// CardActionRequired — the prompt a reader sees when their card has terminally
// declined and their reading tab is frozen.
//
// Spec: STRIPE-INTEGRATION-AUDIT-2026-06-25 S1; CONSOLIDATED-TODO §1.4.
//
// WHY THIS EXISTS. `accounts.card_action_required_at` has been set by settlement
// declines and exposed on `GET /my/tab` since the S1 audit, and until now NOTHING
// consumed it. That is the worst shape a flag can have: the backend correctly
// stops charging a reader whose card has failed — settlement backs off rather
// than retrying a card Stripe has told us is dead — and the reader is told
// nothing at all. From their side the tab simply stops working, with no
// explanation and no way to fix it.
//
// SO THE COPY IS THE FEATURE. It has to say three things in order: what happened,
// what it means right now, and the one action that clears it. Anything vaguer
// ("there was a problem with your payment method") leaves the reader exactly
// where the missing UI left them.
//
// Not a toast and not a dismissible banner: the state persists until a card is
// attached, so an affordance the reader can wave away would misrepresent it.
// =============================================================================

import { useState } from 'react'
import { useAuth } from '../../stores/auth'
import { CardSetup } from '../payment/CardSetup'

export function CardActionRequired({
  since,
}: {
  /** `user.cardActionRequiredAt` from the session; null ⇒ render nothing. */
  since: string | null
}) {
  const { fetchMe } = useAuth()
  const [attaching, setAttaching] = useState(false)

  if (!since) return null

  return (
    <section
      // Assertive, not polite: the tab is frozen, so this is not ambient status.
      role="alert"
      className="mb-8 bg-glasshouse-well/40 p-5"
    >
      <p className="label-ui text-crimson">Card declined</p>

      <p className="text-ui-sm text-black mt-2">
        Your reading tab is paused. We could not take payment with the card on
        file, so nothing further will be charged until you add a working one.
      </p>

      <p className="text-ui-xs text-grey-600 mt-2">
        Anything you have already read stays on your tab and settles once a new
        card is added. Your free allowance is unaffected.
      </p>

      {attaching ? (
        <div className="mt-4">
          <CardSetup
            onSuccess={() => {
              setAttaching(false)
              // connectPaymentMethod clears card_action_required_at in the same
              // UPDATE that sets stripe_customer_id, so one fetchMe both flips
              // hasPaymentMethod and dismisses every instance of this prompt.
              void fetchMe()
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAttaching(true)}
          className="btn-accent mt-4"
        >
          Add a card
        </button>
      )}
    </section>
  )
}
