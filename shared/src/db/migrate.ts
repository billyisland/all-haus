import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// =============================================================================
// Migration Runner
//
// Simple, sequential migration runner. Tracks applied migrations in a
// _migrations table. Runs all .sql files in the migrations/ directory
// in numeric-prefix order (lexicographic tiebreak), so 1000_ sorts after
// 999_ — a filename without a numeric prefix is an error.
//
// Usage:
//   npx tsx shared/src/db/migrate.ts
//
// Migration file naming convention:
//   001_initial_schema.sql
//   002_add_email_to_accounts.sql
//   003_create_notifications_table.sql
//
// The initial schema (schema.sql) is applied by docker-compose on first
// boot via the initdb.d volume mount. This runner handles incremental
// migrations after that.
//
// Checksums: each applied migration's sha256 is recorded, and every run
// verifies applied rows against the files on disk — editing an
// already-applied migration is fatal (corrections go in a NEW migration).
// The `checksum` column is runner-owned bootstrap DDL, deliberately NOT a
// migration file: the verify/record code touches the column on every run,
// including runs against DBs that predate it, so it must self-heal before
// any migration is considered. NULL checksums (schema.sql's seed inserts
// filenames only; pre-checksum prod rows) are backfilled from the current
// file contents on first sight.
//
// Config defaults: after the chain, every run applies config-defaults.sql (the
// canonical default of every platform_config tuning dial) with ON CONFLICT DO
// NOTHING. This is NOT a migration and deliberately does NOT live in
// migrations/ — a dial seeded by a migration is skipped forever on any DB
// booted from schema.sql, because schema.sql is structure-only yet seeds
// _migrations with every filename. See that file's header for the full story.
// =============================================================================

const { Pool } = pg;

// Resolved against this module, not process.cwd(): the defaults file is owned
// by the runner and must be found however the runner is invoked.
const CONFIG_DEFAULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config-defaults.sql",
);

/**
 * Seed any platform_config dial that is missing its default.
 *
 * Runs on EVERY invocation, including when no migrations are pending — that is
 * the point: an existing DB that never received a pre-genesis seed is repaired
 * by the next ordinary `migrate.ts` run, with no separate remediation step.
 *
 * Every statement in the file carries ON CONFLICT (key) DO NOTHING, so this can
 * never overwrite a value an operator has tuned. A missing file is FATAL, not a
 * skip: silently proceeding without the defaults is exactly the failure mode
 * this mechanism exists to end.
 */
async function applyConfigDefaults(client: pg.PoolClient): Promise<void> {
  if (!fs.existsSync(CONFIG_DEFAULTS_PATH)) {
    throw new Error(
      `config-defaults.sql not found at ${CONFIG_DEFAULTS_PATH}. ` +
        `It carries the default value of every platform_config dial and must ` +
        `be applied on every run — refusing to continue without it.`,
    );
  }
  const sql = fs.readFileSync(CONFIG_DEFAULTS_PATH, "utf8");
  const count = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM platform_config",
        )
      ).rows[0].n,
    );
  const before = await count();
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("  ✗ config-defaults.sql — rolled back");
    throw err;
  }
  const seeded = (await count()) - before;
  console.log(
    seeded > 0
      ? `Config defaults: seeded ${seeded} missing dial(s).`
      : "Config defaults: all dials already present.",
  );
}

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const client = await pool.connect();

  // A migration that RAISEs must be HEARD. node-postgres discards server
  // notices unless something listens for them, so a `RAISE NOTICE` / `RAISE
  // WARNING` inside a migration was, until this listener, dead plumbing — the
  // migrate output read clean and the message went nowhere. That is the
  // reassuring-absence failure this repo keeps meeting, one level down: the
  // migrations that most want to report (a data reclassification, a backfill
  // that touched rows nobody expected) are exactly the ones whose silence is
  // indistinguishable from success. The listener is on the pooled client the
  // whole run uses, so it covers both the transactional and the
  // no-transaction path.
  client.on("notice", (n) => {
    const label = n.severity ?? "NOTICE";
    console.log(`  [${label}] ${n.message ?? ""}`);
  });

  // Serialise concurrent runners (M24): two simultaneous `migrate.ts` invocations
  // would both read the same applied set and double-apply a pending migration —
  // and for the no-transaction path (ALTER TYPE ADD VALUE / CONCURRENTLY) a
  // partial double-apply cannot be rolled back. A session-level advisory lock on
  // this connection makes the second runner wait for the first. Released
  // implicitly when the connection closes; explicitly in finally for promptness.
  const MIGRATE_LOCK_KEY = 481723; // stable, migrate-runner-owned
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);

  try {
    // Ensure migrations tracking table exists (checksum column is bootstrap
    // DDL too — see header; it must exist before any code below touches it)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT",
    );

    // Get already-applied migrations
    const { rows: applied } = await client.query<{
      filename: string;
      checksum: string | null;
    }>("SELECT filename, checksum FROM _migrations ORDER BY filename");
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Find migration files
    const migrationsDir = path.resolve(process.cwd(), "migrations");

    if (!fs.existsSync(migrationsDir)) {
      console.log("No migrations/ directory found — nothing to run.");
      return;
    }

    // Verify applied migrations against the files on disk. NULL checksum →
    // backfill from current contents (the steady state on every fresh boot:
    // schema.sql's seed inserts filenames only, and a fresh DB never executed
    // the files — its schema came from schema.sql — so trusting them is
    // correct by construction). Mismatch → fatal, no override flag.
    for (const row of applied) {
      const filepath = path.join(migrationsDir, row.filename);
      if (!fs.existsSync(filepath)) continue; // deleted historical file: tolerate
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filepath, "utf8"))
        .digest("hex");

      if (row.checksum === null) {
        await client.query(
          "UPDATE _migrations SET checksum = $1 WHERE filename = $2",
          [hash, row.filename],
        );
      } else if (row.checksum !== hash) {
        throw new Error(
          `Checksum mismatch: ${row.filename} was edited after being applied. ` +
            `Corrections go in a NEW migration. ` +
            `(If the rewrite was deliberate, update the checksum row by hand.)`,
        );
      }
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"));

    // A non-numeric prefix would make the comparator return NaN, and a
    // NaN-returning comparator gives an UNSPECIFIED sort order — silent
    // misordering, the exact bug class the numeric sort exists to fix.
    for (const f of files) {
      if (Number.isNaN(parseInt(f, 10))) {
        throw new Error(`Migration filename lacks numeric prefix: ${f}`);
      }
    }

    // Numeric-prefix sort (lexicographic would run 1000_ before 999_), with a
    // lexicographic tiebreak so two files sharing a number (merge collision)
    // stay deterministic.
    files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));

    const pending = files.filter((f) => !appliedSet.has(f));

    // NOTE: no early return on an empty pending set — config defaults are
    // applied on every run (see applyConfigDefaults), which is how a DB that
    // never received a pre-genesis seed repairs itself without a special step.
    if (pending.length === 0) {
      console.log("All migrations already applied.");
    } else {
      console.log(`Found ${pending.length} pending migration(s):`);
    }

    for (const filename of pending) {
      const filepath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filepath, "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");

      console.log(`  Applying: ${filename}`);

      // Statements that need to run outside an explicit BEGIN/COMMIT, so they
      // cannot be rolled back on failure:
      //   - CREATE/DROP INDEX CONCURRENTLY (e.g. migrations 022, 083) — genuinely
      //     refused inside any transaction block.
      //   - ALTER TYPE … ADD VALUE (new enum members) — permitted inside a
      //     transaction since PG12, but the new value cannot be USED until that
      //     transaction commits, so a file that adds AND uses a value in one go
      //     would fail. Kept on this path conservatively.
      //
      // Detect against a comment-stripped copy: matching the raw file routes a
      // migration whose PROSE merely mentions "CONCURRENTLY" onto the
      // no-transaction path, silently giving up rollback-on-failure for
      // statements that never needed it. This copy is for detection ONLY and is
      // never executed, so the crude stripper (which would mangle a `--` inside
      // a string literal) cannot affect what runs.
      const sqlSansComments = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ");

      const isConcurrent = /\bCONCURRENTLY\b/i.test(sqlSansComments);
      const noTxnReason = /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(sqlSansComments)
        ? "ALTER TYPE ADD VALUE"
        : isConcurrent
          ? "CONCURRENTLY"
          : null;
      const needsNoTxn = noTxnReason !== null;

      // A multi-statement file is sent as one simple query, which Postgres wraps
      // in an IMPLICIT transaction block — the exact thing CONCURRENTLY refuses.
      // Such a file fails mid-deploy with a bare Postgres error, so refuse it
      // here with an actionable one instead. (Nothing has run at this point; the
      // implicit block means the failure would roll back cleanly either way.)
      if (isConcurrent) {
        const statementCount = sqlSansComments
          .split(";")
          .filter((s) => s.trim().length > 0).length;
        if (statementCount > 1) {
          throw new Error(
            `${filename}: a CONCURRENTLY migration must contain exactly one statement ` +
              `(found ${statementCount}). Postgres wraps a multi-statement file in an ` +
              `implicit transaction block, which CONCURRENTLY cannot run inside. ` +
              `Split the other statements into a separate migration file.`,
          );
        }
      }

      if (needsNoTxn) {
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum],
          );
          console.log(`  ✓ ${filename} (no-transaction: ${noTxnReason})`);
        } catch (err) {
          console.error(
            `  ✗ ${filename} — failed (no-transaction, cannot rollback)`,
          );
          throw err;
        }
      } else {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum],
          );
          await client.query("COMMIT");
          console.log(`  ✓ ${filename}`);
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`  ✗ ${filename} — rolled back`);
          throw err;
        }
      }
    }

    if (pending.length > 0) {
      console.log(`\nDone. ${pending.length} migration(s) applied.`);
    }

    // Always last: a dial introduced by a pending migration's own DDL must
    // exist before its default is seeded.
    await applyConfigDefaults(client);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY])
      .catch(() => {});
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
