import type { Task } from 'graphile-worker'

type Helpers = Parameters<Task>[1]

// =============================================================================
// outbound-retry — the shared control flow for the two outbound delivery
// workers (relay_publish, outbound_cross_post).
//
// What's shared (and lives here): claim → attempt → on-throw the
// increment / compare-to-max / branch retry-vs-abandon / reschedule-a-
// versioned-single-attempt-job plumbing. This is the duplicated machinery the
// two workers each hand-rolled (relay's failAndMaybeRetry ≈ cross-post's catch
// block).
//
// What's deliberately NOT shared (worker-supplied closures, because the two
// genuinely diverge — do not collapse these into the helper):
//   - the claim itself: relay opens a dedicated txn-scoped connection with
//     SELECT FOR UPDATE SKIP LOCKED + a per-entity advisory lock held across
//     the relay round-trip; cross-post does a plain pool.query with no lock and
//     no held connection. The worker owns its client/txn lifecycle entirely
//     (via `claim` + the persist closures + `cleanup`), so neither model is
//     forced onto the other.
//   - the success rule: relay treats partial-success as sent and special-cases
//     discovery events (public-mesh delivery required); cross-post is plain.
//     The success persist lives inside `attempt`, which throws to signal any
//     failure (including relay's "in-house relay only" logical failure).
//   - the status vocab: relay writes sent/failed/abandoned; cross-post writes
//     sent/retrying/failed. Each owns its own UPDATE in `attempt`/`onRetry`/
//     `onAbandon`.
//   - the counter semantics: relay counts `attempts` (completions), cross-post
//     counts `retry_count` (retries). Abstracted behind `attemptsOf`/`maxOf`.
//   - the backoff curve: relay is min(2^n min, 1h) ±jitter; cross-post is
//     delay·2^(n-1) no jitter. Abstracted behind `computeBackoff`.
// =============================================================================

export interface OutboundJobSpec<Row> {
  /** Graphile task name — re-enqueued verbatim for the retry job. */
  taskName: string
  /** Job payload — re-enqueued verbatim for the retry job. */
  payload: Record<string, unknown>
  /** Stable row id — used to version the retry job_key. */
  rowId: string
  helpers: Helpers

  /**
   * Claim the row. The worker owns its SELECT (+ any txn/lock). Return `null`
   * to bail cleanly (not found / wrong status / locked by a peer); `cleanup`
   * still runs.
   */
  claim: () => Promise<Row | null>
  /**
   * Perform the side-effecting delivery AND persist the success state (e.g.
   * UPDATE … status='sent', and COMMIT if the worker opened a txn). Throw on
   * any failure — the helper routes the throw into the retry/abandon machinery.
   */
  attempt: (row: Row) => Promise<void>

  /** Current completed-attempt / retry count of the row. */
  attemptsOf: (row: Row) => number
  /** The row's max before abandoning. */
  maxOf: (row: Row) => number
  /** When to run the next attempt, given the upcoming attempt number. */
  computeBackoff: (nextAttempt: number) => Date

  /**
   * Persist a retry (worker owns its status vocab + COMMIT). Called when
   * `nextAttempt < maxOf(row)`; the helper then reschedules a versioned,
   * single-attempt job at `nextAt`.
   */
  onRetry: (row: Row, nextAttempt: number, nextAt: Date, err: string) => Promise<void>
  /**
   * Persist abandonment (worker owns its status vocab + COMMIT). Called when
   * `nextAttempt >= maxOf(row)`; no job is rescheduled.
   */
  onAbandon: (row: Row, nextAttempt: number, err: string) => Promise<void>

  /** Always-run teardown (release the client; roll back a still-open txn). */
  cleanup?: () => Promise<void>
}

/**
 * Run one outbound delivery job: claim, attempt, and on failure either
 * reschedule a versioned single-attempt retry job (with backoff) or abandon
 * once the per-row max is reached. Unexpected errors (from claim or the persist
 * closures) propagate after `cleanup`, mirroring the workers' prior
 * rollback-and-rethrow.
 */
export async function runOutboundJob<Row>(spec: OutboundJobSpec<Row>): Promise<void> {
  try {
    const row = await spec.claim()
    if (!row) return

    try {
      await spec.attempt(row)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const nextAttempt = spec.attemptsOf(row) + 1

      if (nextAttempt >= spec.maxOf(row)) {
        await spec.onAbandon(row, nextAttempt, msg)
        return
      }

      const nextAt = spec.computeBackoff(nextAttempt)
      await spec.onRetry(row, nextAttempt, nextAt, msg)
      // Schedule the retry outside any claim lock (the persist closure has
      // COMMITted, releasing it). A versioned job_key keeps Graphile's own
      // dedup from collapsing the retry into the still-tracked original and
      // losing the backoff; maxAttempts:1 keeps Graphile's retry loop from
      // racing ours.
      await spec.helpers.addJob(spec.taskName, spec.payload, {
        runAt: nextAt,
        jobKey: `${spec.taskName}_${spec.rowId}_r${nextAttempt}`,
        maxAttempts: 1,
      })
    }
  } finally {
    if (spec.cleanup) await spec.cleanup()
  }
}
