// =============================================================================
// A per-RELAY error budget, process-local (CA-C3, 2026-09-29).
//
// The nostr poll reads a source from every relay in its NIP-65 list and
// swallowed each relay's rejection, so a relay outage was invisible: the
// success UPDATE ran (error_count 0, last_error NULL, interval reset) whatever
// the relays had done. Two fixes were WRONG and are refused here on purpose.
//
//   • Holding the cursor at `since` while any relay failed. NIP-65 lists carry
//     permanently dead URLs — a relay that closed years ago is still in the
//     author's kind-10002 — and a source with one of those would never advance
//     again; under the oldest-N cap it would re-process the same batch for
//     ever (ingest.md's last bullet).
//   • Routing "every relay failed" to the source's error path. The fallback
//     relay set is shared by every source without hints, so one outage there
//     would deactivate the whole cohort after `maxErrors` polls — the 381-row
//     mastodon.social incident on another protocol.
//
// A relay is a fact about the NETWORK, not about a source, so the budget is
// keyed by relay url and shared by every source in the process: three
// consecutive failures DROP the relay for thirty minutes, after which one
// source's next poll tries it again and either clears it or re-drops it. A
// success anywhere clears the count. Process-local by design — a restart
// forgets nothing that matters (a dead relay is re-learned in three polls) and
// it needs no migration; `external_sources.last_error` carries the per-poll
// record of what failed, and the source's DEACTIVATION budget is never spent
// on a relay's failure.
//
// The residue this cannot see: `fetchNostrRelayEvents` rejects on a socket
// ERROR only; a relay that accepts the socket and never sends EOSE resolves
// with whatever arrived by the timeout, which reads as a quiet author. That
// is the primitive's contract (`nostr-relay-req.ts`), not this budget's.
// =============================================================================

export const RELAY_FAILURES_TO_DROP = 3;
export const RELAY_DROP_MS = 30 * 60 * 1000;

interface RelayState {
  failures: number;
  droppedUntil: number;
}

const state = new Map<string, RelayState>();

/** True while the relay is dropped — the caller skips it and says so. */
export function relayOnCooldown(url: string, now = Date.now()): boolean {
  const s = state.get(url);
  if (!s) return false;
  if (s.droppedUntil > now) return true;
  if (s.droppedUntil !== 0) {
    // The cooldown has elapsed: one more failure re-drops it, a success clears it.
    s.droppedUntil = 0;
    s.failures = RELAY_FAILURES_TO_DROP - 1;
  }
  return false;
}

/** Records a failure; returns true when this one crossed the drop threshold. */
export function recordRelayFailure(url: string, now = Date.now()): boolean {
  const s = state.get(url) ?? { failures: 0, droppedUntil: 0 };
  s.failures += 1;
  let dropped = false;
  if (s.failures >= RELAY_FAILURES_TO_DROP) {
    s.droppedUntil = now + RELAY_DROP_MS;
    dropped = true;
  }
  state.set(url, s);
  return dropped;
}

export function recordRelaySuccess(url: string): void {
  state.delete(url);
}

/** Tests only. */
export function resetRelayBudgets(): void {
  state.clear();
}
