"use client";

import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { auth } from "../../lib/api";

// =============================================================================
// Card Setup
//
// Stripe Elements integration for readers to connect a payment method.
// Uses a real SetupIntent flow (no immediate charge — the card is validated and
// saved, authorising future off-session charges). STRIPE audit S2: this replaces
// the prior createPaymentMethod call, which attached an unvalidated card that
// only failed weeks later at the first settlement.
//
// After the reader submits:
//   1. POST /auth/setup-intent → gateway creates/reuses the Stripe Customer and
//      returns a SetupIntent client_secret.
//   2. stripe.confirmCardSetup(clientSecret) validates the card and runs any
//      3DS/SCA step inline, while the reader is present.
//   3. POST /auth/connect-card { setupIntentId } → gateway verifies the
//      SetupIntent succeeded, sets the card as the customer default, records the
//      customer, and notifies the payment service → provisional reads accrue.
//   4. Reader can now read paywalled content charged to their tab.
// =============================================================================

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise = stripePublishableKey
  ? loadStripe(stripePublishableKey)
  : null;

interface CardSetupProps {
  onSuccess: () => void;
}

export function CardSetup({ onSuccess }: CardSetupProps) {
  if (!stripePromise) {
    return (
      <p className="text-ui-xs text-grey-400">Payment setup is unavailable.</p>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#1A1A1A",
            colorText: "#1A1A1A",
            fontFamily:
              'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
            borderRadius: "2px",
          },
        },
      }}
    >
      <CardForm onSuccess={onSuccess} />
    </Elements>
  );
}

function CardForm({ onSuccess }: { onSuccess: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSaving(true);
    setError(null);

    try {
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) throw new Error("Card element not found");

      // 1. Ask the gateway for a SetupIntent (creates/reuses the Stripe Customer).
      const { clientSecret } = await auth.createSetupIntent();

      // 2. Confirm it client-side — validates the card and runs any 3DS/SCA step
      //    inline, authorising future off-session settlement charges.
      const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(
        clientSecret,
        { payment_method: { card: cardElement } },
      );

      if (stripeError) {
        setError(stripeError.message ?? "Card setup failed.");
        return;
      }

      if (setupIntent?.status !== "succeeded") {
        setError("Card setup did not complete. Please try again.");
        return;
      }

      // 3. Finalise on the gateway — verifies the SetupIntent succeeded, sets the
      //    card as default, and triggers provisional → accrued conversion.
      await auth.connectCard(setupIntent.id);

      onSuccess();
    } catch (err: any) {
      setError(err.body?.error ?? "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="bg-glasshouse-well px-3 py-3 mb-3">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: "14px",
                color: "#292524",
                "::placeholder": { color: "#a8a29e" },
              },
            },
          }}
        />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      <button
        type="submit"
        disabled={saving || !stripe}
        className="btn px-6 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {saving ? "Saving..." : "Add card"}
      </button>

      <p className="mt-3 text-xs text-grey-300">
        Your card won't be charged now. It will be used when your reading tab
        settles (at £8 or monthly).
      </p>
    </form>
  );
}
