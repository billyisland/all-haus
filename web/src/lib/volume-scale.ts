// =============================================================================
// The volume bar's scale — the web's copy of the gateway's.
//
// A step is a THROUGHPUT FRACTION: the share of a source's posts that reach a
// feed (migration 202). Step 5 = 1.0 = everything, which is the schema default,
// so a source you have just added arrives at full volume. Step 0 is mute, which
// rides `muted_at` rather than this number.
//
// THIS IS A SECOND COPY AND IT IS PARITY-TESTED. There is no import path from
// `gateway/` into `web/`, so the array is written twice —
// `gateway/src/routes/feeds/shared.ts::VOLUME_THROUGHPUT` is the original, and
// `web/tests/volume-scale-parity.test.ts` reads that file and fails if the two
// disagree. Before this module there were THREE copies (here, FeedComposer and
// SourceVolume) with nothing holding any of them together, which is the repo's
// own second-copy rule applied to a scale rather than a dial: a drifted copy
// never errors, it just makes the bar mean something slightly different from
// what the server stores.
// =============================================================================

export const VOLUME_THROUGHPUT = [1.0, 0.2, 0.4, 0.6, 0.8, 1.0];

/** Nearest committed step for a stored fraction. Read-back only. */
export function throughputToStep(throughput: number): number {
  let best = 5;
  let bestDelta = Infinity;
  for (let s = 1; s <= 5; s++) {
    const d = Math.abs(VOLUME_THROUGHPUT[s] - throughput);
    if (d < bestDelta) {
      bestDelta = d;
      best = s;
    }
  }
  return best;
}

/** "60%" for the bar's readout and its aria-labels. */
export function stepPercent(step: number): string {
  return `${Math.round((VOLUME_THROUGHPUT[Math.max(0, Math.min(5, step))] ?? 1) * 100)}%`;
}
