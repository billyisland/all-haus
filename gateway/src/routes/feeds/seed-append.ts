import { pool } from "@platform-pub/shared/db/client.js";
import { recordConfigAudit } from "@platform-pub/shared/lib/config-audit.js";
import { formulaMaxSources } from "./formulas.js";

// =============================================================================
// The default seed's one appending writer (RESHAPE-PLAN-2026-10 §A.2.1, §A.2.7)
//
// A designated seed is FROZEN at designation — what a new account receives is
// a composition an operator has checked (feeds.md › *default seed*). This
// module is the single exception, and it keeps the reason intact: the account
// it appends is one the operator has just admitted by hand, and the admission
// IS the check. It has two doors and nothing else edits a designated
// composition:
//
//   · `appendAccountToSeed` — the waitlist Admit action, once per admitted
//     member, so that a cohort admitted together and then invited finds itself
//     in full in each member's first feed;
//   · `carryAdmittedIntoSeed` — a re-cut, which would otherwise drop every
//     appended member in silence, because designating a replacement is also the
//     panel's ordinary refresh.
//
// What it guarantees, and what it does not: everyone appended BEFORE a member's
// first workspace load is in that member's seed feed; a member who loaded
// earlier does not gain later arrivals, because their feed was a snapshot and
// nothing reaches into it. The replay skips each newcomer's own row
// (`populateFeedFromSources`, skippedSelf), and seeded account sources write no
// follows.
//
// IDEMPOTENT IN THE SCHEMA. `feed_formula_sources_account_uniq` (migration 270)
// is a partial unique index on (formula_id, tag_value) WHERE source_type =
// 'account' — never on tag_kind, which a member shares with publications and
// external Nostr sources — so the insert is `ON CONFLICT DO NOTHING` and the
// count moves only when a row landed. The seed row is locked FOR UPDATE before
// `max(position) + 1` is read, because `UNIQUE (formula_id, position)` would
// otherwise fail one of two concurrent admits that read the same max.
// =============================================================================

type Client = { query: typeof pool.query };

export type SeedAppendOutcome =
  | "appended"
  | "already_present"
  | "no_seed"
  | "seed_full";

/**
 * Append one admitted account to the designated seed, inside the caller's
 * transaction, and leave a `config_audit` row when it lands.
 *
 * The audit row names the actor and the admitted ACCOUNT, never the address:
 * the table is append-only, so an email written there would outlive an
 * erasure. The seed decides what every new account sees, which makes this an
 * operator act on other people's workspaces; the reason is the note the
 * operator typed for the batch.
 *
 * At the cap the append is REFUSED and reported (`seed_full`), never skipped
 * quietly — the admission itself still stands, which is the caller's to say.
 */
export async function appendAccountToSeed(
  client: Client,
  params: { accountId: string; actorId: string; reason: string },
): Promise<SeedAppendOutcome> {
  // Asked twice at most. A designation committing while this waits on the
  // lock leaves the row it waited on no longer designated, and the new seed
  // was not in this statement's snapshot — so the first answer is empty for a
  // platform that does have a seed. A fresh statement sees the new one.
  const lockSeed = () =>
    client.query<{ id: string }>(
      `SELECT id FROM feed_formulas WHERE is_default_seed FOR UPDATE`,
    );
  let {
    rows: [seed],
  } = await lockSeed();
  if (!seed) [seed] = (await lockSeed()).rows;
  if (!seed) return "no_seed";

  const {
    rows: [acct],
  } = await client.query<{ nostr_pubkey: string; display_name: string | null; username: string | null }>(
    `SELECT nostr_pubkey, display_name, username FROM accounts WHERE id = $1`,
    [params.accountId],
  );
  // The caller has just created or linked this account; its absence is a
  // fault of ours, not an outcome to report as one of the four.
  if (!acct) throw new Error(`appendAccountToSeed: account ${params.accountId} not found`);

  // Asked BEFORE the cap, so a member who is already in a full seed is told
  // they are in it rather than that it is full.
  const { rows: present } = await client.query(
    `SELECT 1 FROM feed_formula_sources
      WHERE formula_id = $1 AND source_type = 'account' AND tag_value = $2`,
    [seed.id, acct.nostr_pubkey],
  );
  if (present.length > 0) return "already_present";

  const {
    rows: [{ n }],
  } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM feed_formula_sources WHERE formula_id = $1`,
    [seed.id],
  );
  if (n >= (await formulaMaxSources())) return "seed_full";

  const inserted = await insertAccountRow(client, seed.id, {
    pubkey: acct.nostr_pubkey,
    displayName: acct.display_name ?? acct.username,
  });
  // Under the FOR UPDATE nothing else can have appended since the check, so
  // a conflict here is not expected; it is still answered honestly.
  if (!inserted) return "already_present";

  await recordConfigAudit(client, {
    actorAccountId: params.actorId,
    key: "default_seed:admit_append",
    subjectAccountId: params.accountId,
    newValue: seed.id,
    reason: params.reason,
  });
  return "appended";
}

/**
 * Carry the outgoing seed's ADMITTED members into a freshly cut one, inside
 * the designation transaction (§A.2.7).
 *
 * "Admitted" means an account row whose account a waitlist row admitted —
 * created or linked — so the carry is exactly what the admit door wrote, and
 * never a source the operator put on the feed they are cutting (that feed
 * speaks for itself). Rows the new cut already holds are left where the cut
 * put them. The cap and the index are the same as the admit door's; what the
 * cap refuses is COUNTED (`dropped`), never skipped quietly.
 */
export async function carryAdmittedIntoSeed(
  client: Client,
  params: { fromFormulaId: string; toFormulaId: string },
): Promise<{ carried: number; dropped: number }> {
  const { rows } = await client.query<{ tag_value: string; display_name: string | null }>(
    `${ADMITTED_ROWS_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM feed_formula_sources n
           WHERE n.formula_id = $2 AND n.source_type = 'account'
             AND n.tag_value = s.tag_value)
      ORDER BY s.position ASC`,
    [params.fromFormulaId, params.toFormulaId],
  );
  if (rows.length === 0) return { carried: 0, dropped: 0 };

  const {
    rows: [{ n }],
  } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM feed_formula_sources WHERE formula_id = $1`,
    [params.toFormulaId],
  );
  let room = Math.max(0, (await formulaMaxSources()) - n);
  let carried = 0;
  let dropped = 0;
  for (const r of rows) {
    if (room === 0) {
      dropped++;
      continue;
    }
    if (
      await insertAccountRow(client, params.toFormulaId, {
        pubkey: r.tag_value,
        displayName: r.display_name,
      })
    ) {
      carried++;
      room--;
    }
  }
  return { carried, dropped };
}

/**
 * How many admitted members a re-cut from `feedId` would carry — the number
 * the panel states before the press. The same predicate as the carry, with
 * "already in the new cut" read off the feed's live account sources.
 */
export async function countCarryForFeed(
  client: Client,
  params: { fromFormulaId: string; feedId: string },
): Promise<number> {
  const {
    rows: [{ n }],
  } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (${ADMITTED_ROWS_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM feed_sources fs JOIN accounts fa ON fa.id = fs.account_id
           WHERE fs.feed_id = $2 AND fs.source_type = 'account'
             AND fa.nostr_pubkey = s.tag_value)) c`,
    [params.fromFormulaId, params.feedId],
  );
  return n;
}

/** A seed's account rows whose account a waitlist row admitted. `$1` is the seed. */
const ADMITTED_ROWS_SQL = `SELECT s.tag_value, s.display_name
       FROM feed_formula_sources s
       JOIN accounts a ON a.nostr_pubkey = s.tag_value
      WHERE s.formula_id = $1 AND s.source_type = 'account'
        AND EXISTS (SELECT 1 FROM waitlist w WHERE w.admitted_account_id = a.id)`;

/**
 * The one INSERT both doors share. Returns whether a row landed; the
 * formula's `source_count` moves only then, in the same statement pair.
 */
async function insertAccountRow(
  client: Client,
  formulaId: string,
  src: { pubkey: string; displayName: string | null },
): Promise<boolean> {
  // Column defaults for throughput, sampling and replies: a member appended by
  // admission is tuned like any source a member adds by hand.
  const { rows } = await client.query(
    `INSERT INTO feed_formula_sources
       (formula_id, position, tag_kind, tag_value, source_type, display_name)
     SELECT $1::uuid, COALESCE(MAX(position), -1) + 1, 'p', $2::text, 'account', $3::text
       FROM feed_formula_sources WHERE formula_id = $1::uuid
     ON CONFLICT (formula_id, tag_value) WHERE source_type = 'account' DO NOTHING
     RETURNING id`,
    [formulaId, src.pubkey, src.displayName],
  );
  if (rows.length === 0) return false;
  await client.query(
    `UPDATE feed_formulas SET source_count = source_count + 1 WHERE id = $1`,
    [formulaId],
  );
  return true;
}
