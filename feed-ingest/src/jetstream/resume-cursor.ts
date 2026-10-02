// =============================================================================
// Where a Jetstream reconnect resumes from.
//
// THE BUG THIS EXISTS TO FIX (dev, diagnosed 2026-08-12). The listener resumed
// from the OLDEST cursor across all active atproto sources, so that no source
// could miss events. But a source's cursor only advances when THAT ACCOUNT
// POSTS — so the minimum across N sources is the least active account's last
// post, and it gets older every day the platform runs. On dev, 149 of 356
// sources had not posted in over a day and the resume point was a MONTH back.
//
// What that costs, measured rather than reasoned: past 150 DIDs the listener
// drops the server-side filter and takes the whole firehose (WILDCARD_DID_
// THRESHOLD), so a month-old cursor asks Bluesky to replay a month of every
// post on the network. The dev container was pulling 113 MB every 30 seconds —
// ~3.8 MB/s, chewing through history at roughly 50x real time, which still
// needs about fifteen hours to reach live. Every restart began that again from
// July. And because the replayed events are ones we already hold, each one
// inserts nothing (ON CONFLICT DO NOTHING) and cannot raise a cursor (GREATEST)
// — so the database shows no new rows, the cursors do not move, and Bluesky
// ingest looks stone dead while the socket is in fact working perfectly hard.
// That is what "no new Bluesky content for 38 hours" actually was; it was never
// the half-open socket it resembled.
//
// So the resume point is CAPPED. Anything older than the cap is not worth
// replaying: a source silent for longer has, by definition, nothing in that
// window, and the per-source poll fallback (feed_ingest_atproto → getAuthorFeed)
// is the right tool for a genuine backfill anyway — it fetches one account's
// history directly instead of filtering the planet's.
//
// Pure, and its own module, because the decision is the whole of the fix and
// the listener around it needs a socket, a pinned DNS lookup and a database to
// instantiate.
// =============================================================================

export interface ResumePoint {
  /** The `cursor` query param, or null to start from live. */
  cursor: string | null;
  /** True when the stored position was older than the cap and was moved up. */
  clamped: boolean;
  /** How far back the stored position was, in hours — for the log line. */
  storedAgeHours: number | null;
}

/**
 * Choose the Jetstream resume cursor.
 *
 * @param cursors    per-source stored cursors (time_us as text; junk tolerated)
 * @param nowUs      current time in microseconds
 * @param maxReplayUs how far back a resume may reach
 */
export function resumeCursor(
  cursors: Array<string | null | undefined>,
  nowUs: bigint,
  maxReplayUs: bigint,
): ResumePoint {
  let oldest: bigint | null = null;
  for (const raw of cursors) {
    if (!raw) continue;
    let v: bigint;
    try {
      v = BigInt(raw);
    } catch {
      continue; // malformed cursor — skipped, exactly as before
    }
    if (v <= 0n) continue;
    if (oldest === null || v < oldest) oldest = v;
  }

  if (oldest === null) return { cursor: null, clamped: false, storedAgeHours: null };

  const storedAgeHours = Number((nowUs - oldest) / 1_000_000n) / 3600;

  // A cursor in the FUTURE silences the stream completely — Jetstream has
  // nothing to send until wall-clock catches up, while still answering
  // keepalives, so it presents as a healthy connection delivering nothing (the
  // hardest state to diagnose, and one bad time_us away). Start from live
  // instead; the stored value is not evidence of anything we have seen.
  if (oldest > nowUs) return { cursor: null, clamped: true, storedAgeHours };

  const floor = nowUs - maxReplayUs;
  if (oldest < floor)
    return { cursor: floor.toString(), clamped: true, storedAgeHours };

  return { cursor: oldest.toString(), clamped: false, storedAgeHours };
}

// =============================================================================
// ONE STREAM, ONE WATERMARK (CA-C7, 2026-09-29).
//
// The cap above bounds the damage; it does not remove the cause. The resume
// point was still the MIN over per-source cursors, and a source's cursor moves
// only when THAT ACCOUNT posts — so every reconnect (and the listener
// reconnects on every DID-set change, i.e. every new Bluesky follow) replayed
// the full cap: in wildcard mode, 24h of the entire network, ~30 minutes at
// 3.8 MB/s, while `jetstream_healthy` read true.
//
// Jetstream is ONE stream, so the position in it is one number: the newest
// time_us whose ingest SUCCEEDED, persisted by the batched flush as the
// runtime-state key `jetstream_cursor` (read-only in the admin editor, like
// the heartbeat). Two guards keep it honest.
//
//   • Advanced from SUCCESSES only. `recordCursor` is called after the write
//     commits, so the batch the flush sees is the set of successes; its max is
//     the watermark. A failed ingest is not in it.
//   • Held BELOW a failure. A failed event must not be skipped past, and
//     with one global position "the per-source cursor holds and replay
//     recovers it" no longer follows — a later success on another source
//     would carry the watermark over it. So the listener keeps the oldest
//     time_us that FAILED since it last resumed (`failedFloor`), the flush
//     writes min(batch max, floor), and the resume point is min(watermark,
//     floor). A reconnect that resumes at or below the floor clears it: the
//     stream re-delivers the event and either it lands or it re-records.
//
// The per-source cursors are still written (the atproto poll fallback and
// the backfill read them) and are still the FALLBACK resume set when no
// watermark has ever been written — the first boot after this ships resumes
// exactly as before, and writes the key on its first flush.
//
// Pure, for the same reason `resumeCursor` is.
// =============================================================================

export interface ResumeInputs {
  /** The persisted global watermark, or null before the first flush. */
  watermark: string | null;
  /** The oldest time_us whose ingest failed since the last resume, or null. */
  failedFloor: bigint | null;
  /** Per-source cursors — the fallback while no watermark exists. */
  perSourceCursors: Array<string | null | undefined>;
}

export function resumeFrom(
  inputs: ResumeInputs,
  nowUs: bigint,
  maxReplayUs: bigint,
): ResumePoint {
  const candidates: Array<string | null | undefined> =
    inputs.watermark !== null ? [inputs.watermark] : [...inputs.perSourceCursors];
  if (inputs.failedFloor !== null) candidates.push(inputs.failedFloor.toString());
  return resumeCursor(candidates, nowUs, maxReplayUs);
}

/** What the flush writes: the batch's newest success, held below any failure. */
export function watermarkAfterFlush(
  batchCursors: Iterable<bigint>,
  failedFloor: bigint | null,
): bigint | null {
  let max: bigint | null = null;
  for (const c of batchCursors) if (max === null || c > max) max = c;
  if (max === null) return null;
  return failedFloor !== null && failedFloor < max ? failedFloor : max;
}
