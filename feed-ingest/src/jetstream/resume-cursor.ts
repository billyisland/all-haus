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
