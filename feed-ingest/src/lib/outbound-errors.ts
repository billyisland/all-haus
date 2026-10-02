// =============================================================================
// Outbound delivery error classification — terminal vs ambiguous.
//
// The same split the Stripe classifiers hold (`payment-service/src/lib/
// charge-errors.ts`), for the same reason and with the same asymmetry:
//
//   TERMINAL   the far end rejected deterministically and created nothing.
//              Retrying cannot change the answer, so the row is abandoned now
//              rather than burning its whole retry budget on a refusal.
//   AMBIGUOUS  a timeout, a connection error, a 5xx, a rate limit. The record
//              MAY already exist. Retry — never mark it failed, and never
//              re-deliver under a fresh identity, or the member posts twice.
//
// Keyed on a property rather than `instanceof` so it survives a re-thrown or
// structurally-cloned error (charge-errors.ts's rationale, unchanged).
//
// Ambiguity is the DEFAULT: an unclassified error is treated as ambiguous, so
// a new failure shape costs a retry rather than a silently dropped post.
// =============================================================================

export class TerminalDeliveryError extends Error {
  readonly terminalDelivery = true;

  constructor(message: string) {
    super(message);
    this.name = "TerminalDeliveryError";
  }
}

/**
 * A terminal refusal of the CREDENTIAL itself (a Mastodon 401): the far end
 * no longer accepts the member's token, so the presence is invalidated
 * (shared/src/lib/presence-health.ts) as well as the delivery abandoned.
 */
export class CredentialRefusedError extends TerminalDeliveryError {
  readonly credentialRefused = true as const;

  constructor(message: string) {
    super(message);
    this.name = "CredentialRefusedError";
  }
}

export function isTerminalDeliveryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { terminalDelivery?: boolean }).terminalDelivery === true;
}

/**
 * Does an HTTP status from a protocol write mean the request was refused and
 * nothing was created?
 *
 * 4xx yes — except 429, which is the far end asking us to come back and says
 * nothing about whether an earlier attempt landed. 5xx and everything else no.
 */
export function isTerminalHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}
