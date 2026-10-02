import { requireEnv } from "@platform-pub/shared/lib/env.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// The reader's own settlement paths — one home for the call
//
// Two gateway routes ask the payment service to collect a reader's tab because
// the READER said so: `POST /my/tab/settle` (Reader Terms 5.3) and
// `POST /auth/delete-account` (12.1). Both need the same thing — a typed answer
// about what happened to a charge — and neither may treat "we do not know" as
// "nothing happened", which is the one mistake that turns an account deletion
// into a charge nobody can trace.
//
// Hence a module rather than two fetches. The ambiguous case is a single value
// here (`ambiguous`), produced by a non-2xx, a non-JSON body, a timeout or a
// refused connection alike, so a caller cannot accidentally handle one of those
// four and miss the others.
//
// THE TIMEOUT IS LONGER THAN A PROXY HOP'S because this call is not a proxy
// hop: behind it is a synchronous Stripe `paymentIntents.create`, which is the
// slowest thing either service does. A 15s bound would report ambiguity on a
// charge that was merely slow, and every ambiguous answer costs the reader a
// refusal they have to retry.
// =============================================================================

// READ AT CALL TIME, NOT AT MODULE LOAD, and that is a deliberate exception to
// this file's neighbours. Both variables are already proven at boot by
// `services/article-access/gate-pass.ts`, which the gateway loads
// unconditionally and which requires the same two — so a module-level read here
// buys no earlier failure, and it costs something real: this module is imported
// by `routes/auth.ts` and `routes/my-account.ts`, which a dozen tests load for
// reasons that have nothing to do with settlement, and every one of them would
// have to carry two environment variables to import a route file. `requireEnv`
// still throws with the variable's name on the first call if it is genuinely
// missing.
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Mirrors `SettlementAttempt` in payment-service/src/services/settlement.ts,
 * plus the `ambiguous` member this module adds for anything that stopped us
 * learning the answer.
 *
 * A HAND-WRITTEN RESPONSE INTERFACE IS A CLAIM ABOUT A SERVER THAT NOTHING
 * CHECKS, so the two ends are pinned against each other by
 * `gateway/tests/settlement-client-parity.test.ts`, which reads the union out of
 * the payment service's source and fails if the sets differ.
 */
export type SettlementOutcome =
  | { kind: "charged"; settlementId: string; amountPence: number }
  | { kind: "card_declined"; settlementId: string }
  | { kind: "in_flight" }
  | { kind: "below_minimum"; balancePence: number }
  | { kind: "nothing_due" }
  | { kind: "no_card" }
  | { kind: "card_action_required" }
  | { kind: "ambiguous" };

/**
 * Every outcome kind, as a runtime value — a union that must be compared at
 * test time is declared as an `as const` array with the type derived from it,
 * because a bare type can be compared against nothing.
 */
export const SETTLEMENT_OUTCOME_KINDS = [
  "charged",
  "card_declined",
  "in_flight",
  "below_minimum",
  "nothing_due",
  "no_card",
  "card_action_required",
  "ambiguous",
] as const;

export async function requestSettlement(
  readerId: string,
  trigger: "reader_requested" | "account_closure",
): Promise<SettlementOutcome> {
  try {
    const res = await fetch(
      `${requireEnv("PAYMENT_SERVICE_URL")}/api/v1/settlement/now`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": requireEnv("INTERNAL_SERVICE_TOKEN"),
        },
        signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
        body: JSON.stringify({ readerId, trigger }),
      },
    );

    const body = (await res.json().catch(() => null)) as {
      kind?: unknown;
    } | null;

    if (!res.ok || typeof body?.kind !== "string") {
      logger.error(
        { readerId, trigger, status: res.status, body },
        "Settlement request did not return a usable outcome — treating as ambiguous",
      );
      return { kind: "ambiguous" };
    }

    // Anything we do not recognise is ambiguous too, not a pass-through: a
    // future outcome this gateway has never heard of must not reach a caller
    // that will `switch` past it into its success branch.
    if (!(SETTLEMENT_OUTCOME_KINDS as readonly string[]).includes(body.kind)) {
      logger.error(
        { readerId, trigger, kind: body.kind },
        "Settlement request returned an unknown outcome kind — treating as ambiguous",
      );
      return { kind: "ambiguous" };
    }

    return body as SettlementOutcome;
  } catch (err) {
    logger.error(
      { err, readerId, trigger },
      "Settlement request failed to reach the payment service — treating as ambiguous",
    );
    return { kind: "ambiguous" };
  }
}
