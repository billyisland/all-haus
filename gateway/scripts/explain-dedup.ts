// =============================================================================
// Slice 8 P1 — EXPLAIN ANALYZE the cross-source dedup path against a large
// seeded linked feed (plan §"Risks / validation": "the candidates self-join is
// a hash join on fp, bounded by the linked_sources guard — verify"; + audit #15
// "EXPLAIN the scored CTE against a large dataset" — same query, one pass).
//
// Builds a realistic feed: a real `feeds` row with N external_source members
// (feed_sources), each carrying items whose canonical_url collides with its
// paired source's (the cross-posted twins). `matched` is built from feed_sources
// exactly as sourceFilteredItems does, so the plan reflects production cardinality
// — not a giant ANY() array. The whole thing runs in a transaction that is ALWAYS
// rolled back.
//
// Runs the faithful dedup path (matched → real DEDUP_CTES → scored with the real
// suppress filter → real provenance lateral → ORDER/LIMIT) at three link
// densities to show the linked_sources guard's effect:
//   1. zero links   — the common production case (guard ⇒ candidates empty)
//   2. a few links  — a handful of asserted pairs
//   3. all linked   — pathological worst case
//
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx tsx scripts/explain-dedup.ts [numSources] [itemsPerSource]
// =============================================================================
import pg from "pg";
import {
  dedupCtes,
  DEDUP_SUPPRESS_FILTER,
  DEDUP_PROVENANCE_LATERAL,
} from "../src/lib/dedup-sql.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("Set TEST_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const NUM_SOURCES = parseInt(process.argv[2] ?? "200", 10);
const ITEMS_PER_SOURCE = parseInt(process.argv[3] ?? "20", 10);

// The faithful dedup query, parameterised on $1 = reader, $2 = feed id. `matched`
// mirrors sourceFilteredItems' external_source membership; `scored` carries the
// chronological effective_score and the real suppress filter; then the real
// provenance lateral and the keyset ORDER/LIMIT.
const DEDUP_QUERY = `
  WITH RECURSIVE matched AS (
    SELECT fi.id AS fi_id, MAX(fs.weight)::float8 AS weight,
           bool_or(NOT fs.exclude_replies) AS allow_replies
      FROM feed_items fi
      JOIN feed_sources fs
        ON fs.feed_id = $2 AND fs.muted_at IS NULL
       AND fs.source_type = 'external_source' AND fs.external_source_id = fi.source_id
      WHERE fi.deleted_at IS NULL
      GROUP BY fi.id
  ),
  ${dedupCtes(3)},
  scored AS (
    SELECT fi.id AS fi_id, fi.source_id, fi.published_at,
           ei.dedup_fingerprint AS fp,
           (EXTRACT(EPOCH FROM fi.published_at)::float8 * m.weight)::float8 AS effective_score
      FROM feed_items fi
      JOIN matched m ON m.fi_id = fi.id
      JOIN external_items ei ON ei.id = fi.external_item_id
      WHERE fi.deleted_at IS NULL
        ${DEDUP_SUPPRESS_FILTER}
  )
  SELECT scored.fi_id, prov.also_on
  FROM (
    SELECT scored.* FROM scored
    ORDER BY effective_score DESC, fi_id DESC
    LIMIT 20
  ) scored
  ${DEDUP_PROVENANCE_LATERAL}
  ORDER BY scored.effective_score DESC, scored.fi_id DESC`;

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query("BEGIN");

    const reader = (
      await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES ('explain-dedup-reader') RETURNING id`,
      )
    ).rows[0].id;

    const feed = (
      await client.query<{ id: string }>(
        `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'explain', 1) RETURNING id`,
        [reader],
      )
    ).rows[0].id;

    const sourceIds: string[] = [];
    for (let i = 0; i < NUM_SOURCES; i++) {
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO external_sources (protocol, source_uri)
           VALUES ('rss', $1) RETURNING id`,
          [`https://explain-${i}.example/feed`],
        )
      ).rows[0].id;
      sourceIds.push(id);
      await client.query(
        `INSERT INTO feed_sources (feed_id, source_type, external_source_id, sampling_mode)
         VALUES ($1, 'external_source', $2, 'chronological')`,
        [feed, id],
      );
    }

    let itemCount = 0;
    for (let i = 0; i < NUM_SOURCES; i++) {
      const pairBase = i - (i % 2); // shared url namespace across the pair
      for (let j = 0; j < ITEMS_PER_SOURCE; j++) {
        const url = `https://explain-shared-${pairBase}.example/post/${j}`;
        const tier = i % 2 === 0 ? "A" : "C"; // pair: A vs C → A wins
        const ext = (
          await client.query<{ id: string }>(
            `INSERT INTO external_items
               (source_id, protocol, tier, source_item_uri, canonical_url, published_at)
             VALUES ($1, 'rss', 'tier4', $2, $3, now() - ($4 || ' minutes')::interval)
             RETURNING id`,
            [sourceIds[i], `uri-${i}-${j}`, url, String(i * 100 + j)],
          )
        ).rows[0].id;
        await client.query(
          `INSERT INTO feed_items
             (item_type, external_item_id, author_name, published_at,
              source_protocol, source_id, biddability_tier, post_id)
           VALUES ('external', $1, 'fixture', now() - ($2 || ' minutes')::interval,
                   'rss', $3, $4, $5)`,
          [ext, String(i * 100 + j), sourceIds[i], tier, `uri-${i}-${j}`],
        );
        itemCount++;
      }
    }
    await client.query("ANALYZE feed_items, external_items, external_sources, feed_sources, external_identity_links");

    console.log(
      `Seeded feed with ${NUM_SOURCES} external sources, ${itemCount} feed_items (${ITEMS_PER_SOURCE}/source).\n`,
    );

    const linkPair = async (p: number) => {
      const a = sourceIds[p];
      const b = sourceIds[p + 1];
      await client.query(
        `INSERT INTO external_identity_links (source_a_id, source_b_id, link_type, owner_id)
         VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), 'user_asserted', $3)`,
        [a, b, reader],
      );
    };

    const explain = async (label: string) => {
      await client.query("ANALYZE external_identity_links");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${DEDUP_QUERY}`,
        [reader, feed],
      );
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      const exec = plan.match(/Execution Time: ([\d.]+) ms/)?.[1];
      const buffers = plan.match(/Buffers: shared hit=(\d+)/)?.[1];
      console.log(`──────── ${label} ────────`);
      console.log(`Execution Time: ${exec} ms   (top-node buffers hit: ${buffers})`);
      // Show whether the dedup CTEs collapsed to nothing (the guard at work).
      const candLine = plan.match(/CTE candidates[\s\S]*?rows=(\d+)/)?.[0]?.split("\n")[0];
      const supLine = plan.split("\n").find((l) => l.includes("CTE suppressed"));
      console.log(`  ${candLine ?? "candidates: (inlined)"}`);
      if (supLine) console.log(`  ${supLine.trim()}`);
      console.log();
      return plan;
    };

    // Scenario 1 — zero links (common production case).
    const p1 = await explain("zero links (common case — guard ⇒ candidates empty)");

    // Scenario 2 — a few asserted pairs.
    await linkPair(0);
    await linkPair(2);
    await explain("a few links (2 asserted pairs)");

    // Scenario 3 — pathological: every pair linked.
    for (let p = 4; p + 1 < NUM_SOURCES; p += 2) await linkPair(p);
    const p3 = await explain("all linked (worst case)");

    // Correctness sanity: worst case suppresses one twin per linked url.
    const { rows: cnt } = await client.query<{ count: string }>(
      `WITH RECURSIVE matched AS (
         SELECT fi.id AS fi_id FROM feed_items fi
         JOIN feed_sources fs ON fs.feed_id = $2 AND fs.external_source_id = fi.source_id
         WHERE fi.deleted_at IS NULL
       ), ${dedupCtes(3)}
       SELECT count(*) FROM suppressed`,
      [reader, feed],
    );
    console.log(
      `Worst-case suppressed rows: ${cnt[0].count} (expect ${(NUM_SOURCES / 2) * ITEMS_PER_SOURCE} — the C twin of each A url).`,
    );

    // Dump the full worst-case plan for the record.
    console.log("\n──────── full worst-case plan ────────\n" + p3);
    void p1;
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
