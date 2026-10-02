import type pg from "pg";

// =============================================================================
// The designated default seed is a SINGLETON (`uq_feed_formulas_default_seed`),
// and two DB-backed suites park it, designate their own and put the incumbent
// back: `feed-seed-formula.test.ts` and `seed-on-admit.test.ts`. Vitest runs
// files in parallel, so without this they interleave — one designates while
// the other's is live, and the unique index answers 23505 (six or seven red
// tests per run from the day seed-on-admit landed, 2026-09-30).
//
// A SESSION advisory lock on the suite's own client, taken before the park and
// held until the client ends: whichever file gets it second waits for the
// first to finish entirely. Session-scoped, so it needs no transaction and is
// released by `client.end()` even when a hook throws.
// =============================================================================

const DEFAULT_SEED_TEST_LOCK = "gateway-tests:default-seed";

export async function holdDefaultSeed(client: pg.Client): Promise<void> {
  await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [DEFAULT_SEED_TEST_LOCK]);
}
