import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// Recent-reading retention sweep (READING-LOG-AND-LIBRARY-ADR D5 + D8)
//
// Deletes rows past the window from BOTH reading_log and reading_positions,
// and it is the only reader of `reading_log_retention_days`.
//
// WHY reading_positions IS IN HERE AND NOT SOMEWHERE ELSE. Before migration
// 189 that table was keyed on articles.id by an FK ON DELETE CASCADE, so a
// deleted article took its positions with it and nothing else had to. The
// post_id re-key cannot carry an FK (feed_items.post_id has no unique
// constraint), so that cascade is gone and this is the only reaper the table
// has. A position older than the window is worth no more than a log row of the
// same age — and without this the table grows for the life of every account,
// silently, in the one direction nobody looks.
//
// THE WINDOW IS A DIAL, and this is its only consumer. Per the tuning-dials
// invariant a dial with no reader is not a dial: the operator's UPDATE would
// succeed, report nothing and change nothing. If a second consumer ever
// appears, it reads the dial rather than restating the number.
// =============================================================================

// SECOND COPY OF THE NUMBER, and it substitutes silently in exactly the case
// it exists for — the row missing, which is every freshly bootstrapped
// database. Pinned against config-defaults.sql by
// gateway/tests/config-fallback-parity.test.ts.
export const READING_LOG_RETENTION_DAYS_FALLBACK = 7;

/**
 * The retention window in days. Falls back rather than trusting junk in the
 * row: a NaN window makes `now() - interval` NULL, which matches no row and
 * turns the sweep into a silent no-op — the table then grows without bound
 * while everything reports healthy. A zero or negative window is the opposite
 * failure and deletes the log the reader is looking at.
 *
 * AND IT IS FLOORED TO A WHOLE NUMBER, because `make_interval(days => $1)` takes
 * an INTEGER: an operator who types `7.5` into the config editor gets
 * `invalid input syntax for type integer: "7.5"` and the sweep THROWS, hourly,
 * for ever. `Number.isFinite` accepts `7.5` quite happily, so the validation
 * above reads as complete and is not — the value it lets through is well-formed
 * for JavaScript and malformed for the one place it is ever used. Flooring is
 * the right repair rather than falling back: 7.5 days is an unambiguous wish for
 * a week-ish window, and answering it with the 7-day default would be the same
 * number by accident and a different number the moment the default moves.
 *
 * THE BOUND IS TESTED ON THE FLOORED VALUE, NOT THE RAW ONE. `0.5` is finite
 * and positive, so a `n > 0` guard on the raw value waves it through — and
 * floors it to 0, which is the "deletes the log the reader is looking at"
 * failure the guard exists to prevent, reintroduced by the flooring that closed
 * the other one. `make_interval(days => 0)` is `now()`, so every row goes,
 * hourly. Floor first, then require at least one whole day.
 */
export async function readingLogRetentionDays(): Promise<number> {
  const raw = (await getPlatformConfig()).get("reading_log_retention_days");
  const n = raw === undefined ? NaN : Number(raw);
  const days = Number.isFinite(n) ? Math.floor(n) : NaN;
  return days >= 1 ? days : READING_LOG_RETENTION_DAYS_FALLBACK;
}

export async function sweepReadingLog(): Promise<void> {
  const days = await readingLogRetentionDays();

  // `make_interval(days => $1)` rather than string-concatenating an interval
  // literal: the value comes from an operator-editable table, and a parameter
  // is the only version of this that cannot be talked into something else.
  const log = await pool.query(
    `DELETE FROM reading_log WHERE opened_at < now() - make_interval(days => $1)`,
    [days],
  );
  const positions = await pool.query(
    `DELETE FROM reading_positions WHERE updated_at < now() - make_interval(days => $1)`,
    [days],
  );

  if (log.rowCount || positions.rowCount) {
    logger.info(
      {
        retentionDays: days,
        readingLogDeleted: log.rowCount,
        readingPositionsDeleted: positions.rowCount,
      },
      "Reading-log retention sweep",
    );
  }
}
