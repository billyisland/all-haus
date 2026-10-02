import { requireEnv } from "@platform-pub/shared/lib/env.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Tell the payment service a reader has just connected a card (CA-F16c)
//
// The payment service then converts the reader's provisional reads to accrued
// and makes their provisional unlocks permanent. Until 2026-09-29 this was a
// bare `fetch` whose answer nobody read: a 403 (a drifted token), a 5xx or a
// refused connection all logged nothing and converted nothing, and nothing ever
// came back for the reader — `convertProvisionalReads` had no other caller.
//
// Now: the answer is READ, a transient failure is retried, and a failure that
// outlives the retries is logged at error. It is still not fatal to the
// request — the card IS connected, and the reader must not be told otherwise —
// and the fact it failed is carried by the payment service's own reconcile
// sweep (`sweepProvisionalConversions`), which converts any reader holding a
// card and a provisional read. This call is the prompt path; the sweep is what
// makes a lost call cost a delay rather than a stranded row.
//
// A 4xx is final (the request itself is wrong, and a repeat would be too);
// anything else — a 5xx, a timeout, a refused connection — is retried.
// Env is read at CALL time, for `settlement-client.ts`'s reason: `routes/auth.ts`
// is loaded by tests that carry no payment-service env at all.
// =============================================================================

const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [500, 1_500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves `true` when the payment service confirmed the conversion. Never throws. */
export async function notifyCardConnected(readerId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        `${requireEnv("PAYMENT_SERVICE_URL")}/api/v1/card-connected`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-token": requireEnv("INTERNAL_SERVICE_TOKEN"),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ readerId }),
        },
      );
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) {
        logger.error(
          { readerId, status: res.status },
          "Payment service refused card-connected — provisional reads left for the reconcile sweep",
        );
        return false;
      }
      logger.warn(
        { readerId, status: res.status, attempt },
        "Payment service card-connected answered non-2xx",
      );
    } catch (err) {
      logger.warn(
        { err, readerId, attempt },
        "Payment service card-connected call failed",
      );
    }
    if (attempt < ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1]);
  }
  logger.error(
    { readerId, attempts: ATTEMPTS },
    "Payment service card-connected never confirmed — provisional reads left for the reconcile sweep",
  );
  return false;
}
