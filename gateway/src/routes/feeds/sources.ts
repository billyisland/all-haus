import type { FastifyInstance } from "fastify";
import { accountArrivedSql } from "../../lib/account-arrived.js";
import { z } from "zod";
import {
  isSourceBlocked,
  isSourceUriBlocked,
} from "@platform-pub/shared/lib/platform-blocks.js";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  nostrEngagementCountsEnabled,
  publicationsEnabled,
} from "@platform-pub/shared/lib/env.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../../lib/platform-config.js";
import { markFollowListDirty } from "../../lib/discovery-publish.js";
import { blockExistsBetween } from "../../lib/blocks.js";
import { verifySourceLiveness } from "../../lib/source-liveness.js";
import { mergeNostrRelayUrls } from "@platform-pub/shared/lib/nip65.js";
import { loadFeed, tagged, stepToThroughput } from "./shared.js";
import { isPublicSourceProtocol } from "../../lib/public-source-protocols.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { isUuid } from "../../lib/request-inputs.js";

// Maps an external protocol to its one-shot subscribe-time ingest job.
// rss/activitypub poll; atproto and nostr backfill prior history (steady state
// is owned by the Jetstream listener and the 60s poll scheduler respectively).
// null ⇒ no immediate job.
export function externalFetchTask(protocol: string): string | null {
  switch (protocol) {
    case "rss":
      return "feed_ingest_rss";
    case "nostr_external":
      return "feed_ingest_nostr_backfill";
    case "activitypub":
      return "feed_ingest_activitypub";
    case "atproto":
      return "feed_ingest_atproto_backfill";
    default:
      return null;
  }
}

// Job key for the subscribe-time enqueue. The nostr backfill MUST NOT share
// the poll scheduler's `feed_ingest_<sourceId>` key: a fresh source has
// last_fetched_at IS NULL, so it is due on the very next 60s poll tick, and a
// shared key would let graphile-worker's job-key replacement swap the
// still-queued backfill for a plain poll job — silently skipping the backfill
// almost every time (EXTERNAL-AUTHOR-HISTORY-ADR §2.1; precedent: the atproto
// enrichment job's feed_ingest_enrich_<id>). Other protocols keep the shared
// key deliberately — their subscribe job IS the poll job, so replacement is
// dedup, not loss.
export function externalFetchJobKey(task: string, sourceId: string): string {
  return task === "feed_ingest_nostr_backfill"
    ? `feed_ingest_backfill_${sourceId}`
    : `feed_ingest_${sourceId}`;
}

// Subscribe-time attempt budget. atproto has NO poll fallback while Jetstream
// is healthy (feed-ingest-poll.ts skips the protocol), so its backfill
// re-throws on failure and graphile-worker's retry is the only retry path —
// give it real attempts (2026-07-09 audit F2). Every other protocol recovers
// via the 60s poll scheduler, so one attempt is enough.
export function externalFetchMaxAttempts(task: string): number {
  return task === "feed_ingest_atproto_backfill" ? 5 : 1;
}

// ---------------------------------------------------------------------------
// The shared-row upsert — the first subscriber names a source, later ones only
// fill the blanks (MIRROR-AUDIT §2.11).
//
// `external_sources` is ONE row shared by every subscriber to that
// (protocol, source_uri). This statement used to let the caller's `display_name`
// / `description` / `avatar_url` WIN over what was already stored, so one
// `POST /workspace/feeds/:id/sources` naming a source somebody else had already
// added relabelled it for every subscriber on the platform. The operand order
// is therefore flipped: stored wins, and a caller's value lands only where
// there is nothing there. The insert arm is unchanged — the first subscriber
// to a source may name it — and the liveness probe's metadata backfill still
// works, because it writes through this same path and a probed name still
// fills a NULL. A member who wants their OWN label for a source wants a
// per-feed one (`feed_sources`), which is a different row and not this one.
//
// `relay_urls` is deliberately ABSENT from the DO UPDATE list: replacing it was
// the security half of the same finding (a hostile hint list evicts the relays
// that carry the author's real posts, silencing a shared Nostr source
// site-wide), and the union that replaces it needs ordering the SQL cannot
// express — see the call site, which merges through `mergeNostrRelayUrls`
// while holding this statement's row lock.
//
// Exported so the DB-backed test runs the REAL statement: fill-only-NULL is
// Postgres's evaluation of COALESCE, and a mocked `pool.query` dispatching on
// query text would pin the mock's idea of it.
// ---------------------------------------------------------------------------
export const EXTERNAL_SOURCE_UPSERT_SQL = `
  INSERT INTO external_sources (protocol, source_uri, display_name, description, avatar_url, relay_urls)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (protocol, source_uri) DO UPDATE SET
    display_name = COALESCE(NULLIF(external_sources.display_name, ''), NULLIF($3, '')),
    description  = COALESCE(NULLIF(external_sources.description,  ''), NULLIF($4, '')),
    avatar_url   = COALESCE(NULLIF(external_sources.avatar_url,   ''), NULLIF($5, '')),
    is_active = TRUE,
    orphaned_at = NULL,
    updated_at = now()
  RETURNING id, relay_urls, (xmax = 0) AS created`;

// ---------------------------------------------------------------------------
// A new RSS source's first poll interval — `feed_ingest_rss_interval_seconds`
// (CA-F4, operator ruling 2026-09-29). The dial was seeded in 052 and had no
// reader; the row started from the column DEFAULT instead. RSS polling is
// adaptive after that (the min/max/backoff dials in feed-ingest-rss.ts), so
// this governs only where a source STARTS, and only when the add creates it —
// an existing shared row keeps the interval its polling has earned.
// ---------------------------------------------------------------------------
export const RSS_START_INTERVAL_FALLBACK = 300;
let warnedRssStartInterval = false;

export async function rssStartIntervalSeconds(): Promise<number> {
  const raw = (await getPlatformConfig()).get("feed_ingest_rss_interval_seconds");
  if (raw === undefined) return RSS_START_INTERVAL_FALLBACK;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  // A malformed row falls back, and says so once — an operator's typo must
  // not read as a tuning that took (ops-and-config.md).
  if (!warnedRssStartInterval) {
    warnedRssStartInterval = true;
    logger.warn(
      { key: "feed_ingest_rss_interval_seconds", value: raw, fallback: RSS_START_INTERVAL_FALLBACK },
      "platform_config: malformed dial, using the fallback",
    );
  }
  return RSS_START_INTERVAL_FALLBACK;
}

const patchSourceSchema = z.object({
  step: z.number().int().min(0).max(5).optional(),
  sampling: z.enum(["random", "top"]).optional(),
  muted: z.boolean().optional(),
  excludeReplies: z.boolean().optional(),
});

// POST /feeds/:id/sources — native targets pass an existing UUID, external
// accepts either an existing externalSourceId or a (protocol, sourceUri) pair
// which is upserted, tag passes a name.
//
// Originally a z.discriminatedUnion('sourceType', [...]), but Zod 3.25+
// rejects duplicate discriminator values at schema-construction time and
// our two external_source variants share that value. Plain z.union tries
// each variant in order; the two external_source shapes are disjoint by
// required fields (externalSourceId vs. protocol + sourceUri) so there is
// no ambiguity, and the route handler branches on `'externalSourceId' in
// input` rather than a tagged sub-discriminator. Validation messages are
// slightly less surgical than a discriminated union but the wire shape is
// unchanged.
const addSourceSchema = z.union([
  z.object({
    sourceType: z.literal("account"),
    accountId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal("publication"),
    publicationId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal("tag"),
    tagName: z.string().trim().min(1).max(64),
  }),
  z.object({
    sourceType: z.literal("external_source"),
    externalSourceId: z.string().uuid(),
  }),
  z.object({
    sourceType: z.literal("external_source"),
    protocol: z.enum(["rss", "atproto", "activitypub", "nostr_external"]),
    sourceUri: z.string().min(1).max(2048),
    displayName: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    avatarUrl: z
      .string()
      .max(2048)
      .url()
      .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
        message: "Avatar URL must use http:// or https://",
      })
      .optional(),
    relayUrls: z
      .array(
        z
          .string()
          .min(1)
          .max(2048)
          .url()
          .refine((u) => u.startsWith("ws://") || u.startsWith("wss://"), {
            message: "A relay address must start with ws:// or wss://.",
          }),
      )
      // A HINT list, not a relay set, and it is capped BELOW the persisted cap
      // (`mergeNostrRelayUrls`, 10) on purpose: a caller who could fill that
      // cap would leave NIP-65 discovery no room to append the author's real
      // write relays, which is what turns a hostile hint list from noise into
      // silence (MIRROR-AUDIT §2.11). Five matches what the resolver itself
      // ever produces (`resolver.ts` slices nprofile relays to 5); every other
      // caller sends one.
      .max(5)
      .optional(),
  }),
]);
export type AddSourceInput = z.infer<typeof addSourceSchema>;

// Options bag for programmatic callers (FOLLOW-GRAPH-IMPORT-ADR §11.1). The
// route handler passes none; the follow-import engine passes both.
export interface AddSourceOptions {
  /** Skip the synchronous per-source liveness probe (D6: graph membership is
   *  liveness evidence). The caller MUST supply the canonical stored form
   *  (DID / hex pubkey / actor URI / feed URL) — normalisation is skipped
   *  along with the probe, and nothing backfills display labels, so pass
   *  displayName/avatarUrl through the input. */
  skipProbe?: boolean;
  /** Defer the subscribe-time ingest job to this time instead of "now" —
   *  the §6.4b stampede brake for bulk imports. */
  enqueueRunAt?: Date;
  /** The owner CHOSE this source — it is their own gesture, not something
   *  they were handed. Only then does an `account` source also make a
   *  `follows` row (see *A follow is a CHOSEN source* below). Defaults false,
   *  and that direction is deliberate: a caller who forgets leaves a source
   *  with no follow, which is a state we already tolerate, where a caller who
   *  wrongly opted in would publish a follow nobody made. */
  ownerChose?: boolean;
}

// One feed_sources row with its target's display fields — the shape
// `SourceRow` types and `sourceRowToResponse` maps. LEFT JOINs against each
// potential target type; exactly one is non-null per row (CHECK in migration
// 077). One home for the create, list and update reads (CA-H3); each caller
// appends its own WHERE.
const HYDRATED_SOURCE_SELECT = `SELECT fs.id, fs.source_type, fs.throughput, fs.sampling_mode, fs.muted_at, fs.created_at,
       fs.exclude_replies,
       fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
       acc.username AS account_username, acc.display_name AS account_display_name,
       pub.slug AS publication_slug, pub.name AS publication_name,
       xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
       xs.is_active AS external_is_active,
       xs.display_name AS external_display_name
     FROM feed_sources fs
     LEFT JOIN accounts acc ON acc.id = fs.account_id
     LEFT JOIN publications pub ON pub.id = fs.publication_id
     LEFT JOIN external_sources xs ON xs.id = fs.external_source_id`;

// An account ADMIT created whose owner has not yet arrived is a source like
// any other and is NAMED to nobody (RESHAPE-PLAN-2026-10 §A.2.6). The
// predicate's one home is lib/account-arrived.ts; re-exported here because
// formulas.ts asks it through this module.
export { accountArrivedSql };

interface SourceRow {
  id: string;
  source_type: "account" | "publication" | "external_source" | "tag";
  throughput: string;
  sampling_mode: string;
  muted_at: Date | null;
  created_at: Date;
  exclude_replies: boolean;
  account_id: string | null;
  publication_id: string | null;
  external_source_id: string | null;
  tag_name: string | null;
  account_username: string | null;
  account_display_name: string | null;
  publication_slug: string | null;
  publication_name: string | null;
  external_protocol: string | null;
  external_source_uri: string | null;
  external_display_name: string | null;
  external_is_active: boolean | null;
}

function sourceRowToResponse(row: SourceRow) {
  // The display block is what the UI renders in the source list. Each branch
  // returns a small, self-describing object so the client doesn't have to
  // re-derive labels from foreign keys.
  // `href` is the in-app destination for the source name — the same surface a
  // byline links to on a feed card, so the composer's source names route
  // identically (account → /:username, publication → /pub/:slug, external →
  // /source/:id, tag → /tag/:name). null when the target is deleted — and, for
  // an external source, wherever `GET /sources/:id` would answer 404 (a
  // private protocol such as email, or an inactive row): a link that cannot
  // open is not offered (MODERNHAUS-ADR §E7.3).
  let display: Record<string, string | null> = {};
  if (row.source_type === "account") {
    display = {
      kind: "account",
      label:
        row.account_display_name ?? row.account_username ?? "(deleted account)",
      sublabel: row.account_username ? `@${row.account_username}` : null,
      href: row.account_username ? `/${row.account_username}` : null,
    };
  } else if (row.source_type === "publication") {
    display = {
      kind: "publication",
      label:
        row.publication_name ?? row.publication_slug ?? "(deleted publication)",
      sublabel: row.publication_slug ? `/pub/${row.publication_slug}` : null,
      href: row.publication_slug ? `/pub/${row.publication_slug}` : null,
    };
  } else if (row.source_type === "external_source") {
    display = {
      kind: "external_source",
      label:
        row.external_display_name ??
        row.external_source_uri ??
        "(deleted source)",
      sublabel: row.external_protocol,
      href:
        row.external_source_id &&
        row.external_is_active === true &&
        isPublicSourceProtocol(row.external_protocol)
          ? `/source/${row.external_source_id}`
          : null,
    };
  } else {
    display = {
      kind: "tag",
      label: `#${row.tag_name}`,
      sublabel: null,
      href: row.tag_name ? `/tag/${encodeURIComponent(row.tag_name)}` : null,
    };
  }
  return {
    id: row.id,
    sourceType: row.source_type,
    accountId: row.account_id ?? undefined,
    externalSourceId: row.external_source_id ?? undefined,
    throughput: Number(row.throughput),
    samplingMode: row.sampling_mode === "scored" ? "top" : "random",
    hasEngagementSignal: sourceHasEngagementSignal(
      row.source_type,
      row.external_protocol,
    ),
    excludeReplies: row.exclude_replies,
    mutedAt: row.muted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    display,
  };
}

// Can TOP mean anything for this source?
//
// TOP cuts by the D6 proof term, which needs `feed_items.resonance` —
// engagement measured against that author's own baseline. Some protocols
// cannot produce one:
//
//   rss, email        never. Structurally silent: a feed document carries no
//                     likes, replies or boosts, so there is nothing to measure.
//   nostr_external    only while NOSTR_ENGAGEMENT_COUNTS_ENABLED is on. Relay
//                     REQ latency makes those counts the heaviest to collect,
//                     so they ship dark (external-engagement-refresh.ts).
//   atproto,          yes — counts are polled per item and resonance is written
//   activitypub       by the refresh crons.
//   native            yes — votes, gate passes and replies, read live (D2a).
//
// Where it is absent, selection still honours the THROUGHPUT (the proof floor
// makes unmeasured items tie and the published_at tiebreak orders them), so a
// source at 60% returns the most recent 60% OF EACH WEEK — the promise is
// kept, the word "top" is what degrades. The UI says so rather than letting
// the chip claim a ranking that is really a date sort.
//
// "OF EACH WEEK" IS LOAD-BEARING AND WAS ONCE "of the source". Measured from
// the cursor, a tie group's newest surviving post was always percent_rank 0,
// so the cut admitted everything the moment the reader paged and a silent
// source at 60% delivered 100%. The window is a calendar bucket now precisely
// so the cut is a fact about the post rather than about the page
// (`lib/source-selection.ts` › SOURCE_BUCKET_SQL).
//
// Protocol-derived rather than measured: "does this source have any scored
// items" is a per-source query, and this list endpoint renders every source in
// a feed. It is a statement about what the protocol CAN carry, which is the
// honest thing to tell a reader anyway.
function sourceHasEngagementSignal(
  sourceType: SourceRow["source_type"],
  protocol: string | null,
): boolean {
  if (sourceType !== "external_source") return true;
  switch (protocol) {
    case "rss":
    case "email":
      return false;
    case "nostr_external":
      return nostrEngagementCountsEnabled();
    default:
      return true;
  }
}

export async function addSource(
  feedId: string,
  ownerId: string,
  input: AddSourceInput,
  opts: AddSourceOptions = {},
) {
  // Per source_type, validate the target exists and bind the polymorphic FK.
  // For external_source with a (protocol, sourceUri) pair we additionally
  // upsert the external_sources row and ensure the caller has a subscription
  // — without one, the feed-ingest workers wouldn't poll the source.
  if (input.sourceType === "account") {
    // You are not a source of your own feed. `POST /follows` has always
    // refused a self-follow with a 400, and this path accepted the same pair
    // silently — inert while the two meant different things, a contradiction
    // the moment an account source IS a follow (prod carried two such rows).
    if (input.accountId === ownerId) throw tagged("SELF_SOURCE");

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM accounts WHERE id = $1`,
      [input.accountId],
    );
    if (rows.length === 0) throw tagged("TARGET_NOT_FOUND");

    // Blocks, BOTH ways, through the one home — asked of every caller and not
    // only the gesture. A source whose posts a block will filter out anyway is
    // a card slot that never fills, which reads as a source gone quiet rather
    // than one we decline to carry; and where the source becomes a follow it
    // is `POST /follows`'s own reasoning verbatim (a follow is a message, and
    // it inserts a notification). One neutral refusal both ways, so neither
    // party learns which direction the block runs.
    if (await blockExistsBetween(ownerId, input.accountId)) {
      throw tagged("TARGET_BLOCKED");
    }

    // A FOLLOW IS A CHOSEN SOURCE. The graph row is written HERE, in the same
    // transaction as the source, so the two cannot disagree — and only when
    // the owner chose it (§9.16 as amended 2026-09-18). The seed and redeem
    // paths deliberately pass nothing: prod's default-seed formula carries
    // seven accounts, so under a blanket "a source is a follow" every signup
    // would publish seven follows nobody made, moving follower counts on seven
    // real profiles. The external half has done exactly that harmlessly for
    // months precisely BECAUSE it has no published graph; attach kind-3 to
    // membership and inherited membership starts making public claims.
    const wantFollow = opts.ownerChose === true && rows[0].status === "active";

    const { inserted, followed } = await withTransaction(async (client) => {
      // The same owner-scoped lock the teardown takes, so a concurrent
      // last-source removal cannot decide "no sources left" against a row
      // this transaction is about to add.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `feed_sub:${ownerId}`,
      ]);
      const row = await insertSource(
        feedId,
        "account",
        { account_id: input.accountId },
        client,
      );
      if (!wantFollow) return { inserted: row, followed: false };
      const { rowCount } = await client.query(
        `INSERT INTO follows (follower_id, followee_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [ownerId, input.accountId],
      );
      // `followed` is "this call created it", not "a follow exists" — only a
      // NEW follow is worth a notification, and only a new one needs the
      // kind-3 republish.
      return { inserted: row, followed: (rowCount ?? 0) > 0 };
    });

    if (followed) {
      // Fire-and-forget, after the commit, exactly as `POST /follows` does:
      // neither is worth failing the write for.
      pool
        .query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_follower')
           ON CONFLICT DO NOTHING`,
          [input.accountId, ownerId],
        )
        .catch((err) =>
          logger.warn({ err }, "Failed to insert new_follower notification"));
      markFollowListDirty(ownerId).catch((err) =>
        logger.warn({ err, ownerId }, "Failed to mark follow list dirty"));
    }

    return { source: inserted, ensured: null, following: wantFollow };
  }

  if (input.sourceType === "publication") {
    // Publications suspended 2026-08-31 (shared/src/lib/env.ts). Adding one is a
    // WRITE path to a suspended feature, and the UI route to it is already dark,
    // but this core is reachable directly (POST /workspace/feeds/:id/sources)
    // and by formula redeem — so refuse rather than mint a new feed source
    // pointing at a surface nobody can open. EXISTING publication sources are
    // deliberately left in place: they are the member's own intent, they carry
    // no consequence while quiet, and reinstatement wants them back (§D7).
    if (!publicationsEnabled()) throw tagged("TARGET_NOT_FOUND");
    const { rows } = await pool.query(
      `SELECT id FROM publications WHERE id = $1`,
      [input.publicationId],
    );
    if (rows.length === 0) throw tagged("TARGET_NOT_FOUND");
    const inserted = await insertSource(feedId, "publication", {
      publication_id: input.publicationId,
    });
    return { source: inserted, ensured: null };
  }

  if (input.sourceType === "tag") {
    // Tags are looser than UUID targets — feed_sources stores the name
    // verbatim, so a tag can be added before any article carries it. Mirror
    // it into the tags table so /tag/:name pages and global tag listings
    // behave consistently.
    await pool.query(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [input.tagName],
    );
    const inserted = await insertSource(feedId, "tag", {
      tag_name: input.tagName,
    });
    return { source: inserted, ensured: null };
  }

  // external_source — two shapes
  if ("externalSourceId" in input) {
    const { rows } = await pool.query<{
      id: string;
      protocol: string;
      source_uri: string;
    }>(
      `SELECT id, protocol, source_uri FROM external_sources WHERE id = $1`,
      [input.externalSourceId],
    );
    // The uuid comes from the caller, and this branch does not just READ the
    // row — it mints the caller an `external_subscriptions` row against it. For
    // an `email` source that subscribes them to somebody else's newsletter, in
    // that person's name, off a guessed id (MIRROR-AUDIT §3 *Security*, S16).
    // Same allow-list, same 404-shaped refusal, as `GET /sources/:id`: the
    // caller learns "no such source", not "a source you may not have".
    if (rows.length === 0 || !isPublicSourceProtocol(rows[0].protocol)) {
      throw tagged("TARGET_NOT_FOUND");
    }
    // The operator's refusal (L6.5, D7 SS7). Checked here, on the ADD, and not
    // only at ingest: a blocked source that can still be added mints a
    // subscription, a feed_sources row and a card slot that will never fill,
    // which reads to the member as a source that has gone quiet rather than
    // one we decline to carry.
    if (await isSourceBlocked(input.externalSourceId)) {
      throw tagged("SOURCE_BLOCKED");
    }
    const protocol = rows[0].protocol;
    const canonicalUri = rows[0].source_uri;
    // Adding an existing source by id must also ensure the derived
    // subscription (a feed_sources row without one would let the GC orphan an
    // in-use source) and revive a previously-orphaned source.
    const inserted = await withTransaction(async (client) => {
      // Serialise against a concurrent last-feed teardown (see DELETE handler).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `feed_sub:${ownerId}`,
      ]);
      await client.query(
        `INSERT INTO external_subscriptions (subscriber_id, source_id)
         VALUES ($1, $2)
         ON CONFLICT (subscriber_id, source_id)
           DO UPDATE SET subscriber_id = EXCLUDED.subscriber_id`,
        [ownerId, input.externalSourceId],
      );
      await client.query(
        `UPDATE external_sources
            SET is_active = TRUE, orphaned_at = NULL, updated_at = now()
          WHERE id = $1`,
        [input.externalSourceId],
      );
      const fetchTask = externalFetchTask(protocol);
      if (fetchTask) {
        // run_at is NULL for interactive adds (add_job coalesces to now());
        // bulk imports pass a jittered enqueueRunAt (§6.4b stampede brake).
        await client.query(
          `SELECT graphile_worker.add_job(
             $2,
             json_build_object('sourceId', $1::text),
             job_key := $3,
             max_attempts := $4,
             run_at := $5
           )`,
          [
            input.externalSourceId,
            fetchTask,
            externalFetchJobKey(fetchTask, input.externalSourceId),
            externalFetchMaxAttempts(fetchTask),
            opts.enqueueRunAt ?? null,
          ],
        );
      }
      // Re-adding to an import-bound feed revokes the exclusion (§6.3 — "the
      // user who wants it back re-adds it"), so "Sync now" tracks it again.
      await clearImportExclusion(client, feedId, protocol, canonicalUri);
      return insertSource(
        feedId,
        "external_source",
        { external_source_id: input.externalSourceId },
        client,
      );
    });
    if (protocol === "nostr_external") {
      markFollowListDirty(ownerId).catch((err) =>
        logger.warn({ err, ownerId }, "Failed to mark follow list dirty"));
    }
    return { source: inserted, ensured: null };
  }

  // (protocol, sourceUri) — upsert source + ensure subscription + insert row
  const { protocol, displayName, description, avatarUrl, relayUrls } = input;
  let { sourceUri } = input;

  // Verify the target is real and reachable BEFORE any write (2026-07-09
  // resolver audit F1): this branch used to validate syntax only, so a
  // well-formed dead URL/DID/pubkey got 201 + a live subscription and only
  // ever surfaced as a climbing error_count. verifySourceLiveness normalises
  // the input to its canonical stored form (acct → actor URI, atproto
  // handle → DID, npub/nprofile → hex — omnivorous-input rule) and probes it
  // per protocol, splitting the old collapsed 404 into malformed (400) vs
  // unreachable (422). A (protocol, sourceUri) pair we already hold as a
  // healthy row skips the probe — it re-enters the existing verified row
  // (canonical-form picks from profiles/discovery stay fast). A bulk-import
  // caller skips it per-call instead (opts.skipProbe; D6 — graph membership
  // is liveness evidence, and 500 serial probes at import time is a
  // non-starter), taking on the canonical-form obligation itself.
  let knownHealthy = opts.skipProbe === true;
  if (!knownHealthy) {
    const { rows: knownRows } = await pool.query<{
      is_active: boolean;
      error_count: number;
      last_fetched_at: Date | null;
    }>(
      `SELECT is_active, error_count, last_fetched_at
         FROM external_sources
        WHERE protocol = $1 AND source_uri = $2`,
      [protocol, sourceUri],
    );
    knownHealthy =
      knownRows.length > 0 &&
      knownRows[0].is_active &&
      knownRows[0].error_count === 0 &&
      knownRows[0].last_fetched_at !== null;
  }
  let probed: {
    displayName?: string;
    description?: string;
    avatarUrl?: string;
  } = {};
  if (!knownHealthy) {
    const verdict = await verifySourceLiveness(protocol, sourceUri, relayUrls);
    if (!verdict.ok) {
      throw tagged(
        verdict.reason === "malformed"
          ? "SOURCE_URI_INVALID"
          : "SOURCE_UNREACHABLE",
        verdict.message,
      );
    }
    sourceUri = verdict.sourceUri;
    probed = verdict;
  }

  // AFTER canonicalisation, never before. The probe normalises an acct: to an
  // actor URI, an atproto handle to a DID and an npub to hex, and the block is
  // stored in the canonical form — so asking with the string the member typed
  // would let any alternate spelling of a blocked source walk straight past it.
  if (await isSourceUriBlocked(protocol, sourceUri)) {
    throw tagged("SOURCE_BLOCKED");
  }

  const rssStartInterval =
    protocol === "rss" ? await rssStartIntervalSeconds() : null;

  const { inserted, ensured } = await withTransaction(async (client) => {
    // Serialise against a concurrent last-feed teardown (see DELETE handler).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `feed_sub:${ownerId}`,
    ]);
    const {
      rows: [src],
    } = await client.query<{ id: string; relay_urls: string[] | null; created: boolean }>(
      EXTERNAL_SOURCE_UPSERT_SQL,
      [
        protocol,
        sourceUri,
        // The FIRST subscriber to a source may name it; every later one only
        // fills what is still NULL (see the SQL's own header). The liveness
        // probe's metadata (feed title, profile name, …) backfills direct-API
        // adds that send none, so a probed source never lands with a bare-URI
        // label — and it rides this same path, so it still fills a NULL.
        displayName ?? probed.displayName ?? null,
        description ?? probed.description ?? null,
        avatarUrl ?? probed.avatarUrl ?? null,
        protocol === "nostr_external" && relayUrls && relayUrls.length > 0
          ? relayUrls
          : null,
      ],
    );
    if (rssStartInterval !== null && src.created) {
      await client.query(
        `UPDATE external_sources SET fetch_interval_seconds = $2 WHERE id = $1`,
        [src.id, rssStartInterval],
      );
    }
    // Relay hints UNION onto the stored list, never replace it (MIRROR-AUDIT
    // §2.11). The upsert above leaves `relay_urls` alone on conflict precisely
    // so the merge can happen here, through the one home for the rule
    // (`mergeNostrRelayUrls` — existing entries first, deduped, scheme-checked,
    // capped), which SQL's unordered `SELECT DISTINCT` cannot express: the
    // ordering is the security half, because it is what makes the cap drop the
    // NEWCOMER's entries rather than the author's real write relays. The
    // INSERT arm already stored the hints verbatim, so a fresh row merges to
    // itself and writes nothing. The row is locked by the upsert until commit,
    // so read-then-write here is atomic against a concurrent add.
    if (protocol === "nostr_external" && relayUrls && relayUrls.length > 0) {
      const existing = src.relay_urls ?? [];
      const merged = mergeNostrRelayUrls(existing, relayUrls);
      if (
        merged.length !== existing.length ||
        merged.some((r, i) => r !== existing[i])
      ) {
        await client.query(
          `UPDATE external_sources SET relay_urls = $2, updated_at = now()
            WHERE id = $1`,
          [src.id, merged],
        );
      }
    }
    const {
      rows: [sub],
    } = await client.query<{ id: string }>(
      `INSERT INTO external_subscriptions (subscriber_id, source_id)
       VALUES ($1, $2)
       ON CONFLICT (subscriber_id, source_id)
         DO UPDATE SET subscriber_id = EXCLUDED.subscriber_id
       RETURNING id`,
      [ownerId, src.id],
    );

    const fetchTask = externalFetchTask(protocol);
    if (fetchTask) {
      // run_at as above — NULL means now(), imports pass a jittered time.
      await client.query(
        `SELECT graphile_worker.add_job(
           $2,
           json_build_object('sourceId', $1::text),
           job_key := $3,
           max_attempts := $4,
           run_at := $5
         )`,
        [
          src.id,
          fetchTask,
          externalFetchJobKey(fetchTask, src.id),
          externalFetchMaxAttempts(fetchTask),
          opts.enqueueRunAt ?? null,
        ],
      );
    }

    // Re-adding to an import-bound feed revokes the exclusion (§6.3), so
    // "Sync now" tracks it again. (Sync's own adds are pre-filtered against
    // exclusions, so this only fires for genuine manual re-adds.)
    await clearImportExclusion(client, feedId, protocol, sourceUri);

    const ins = await insertSource(
      feedId,
      "external_source",
      { external_source_id: src.id },
      client,
    );
    return {
      inserted: ins,
      ensured: { externalSourceId: src.id, subscriptionId: sub.id },
    };
  });
  // External Nostr follows belong in the user's published kind-3 list.
  if (protocol === "nostr_external") {
    markFollowListDirty(ownerId).catch((err) =>
      logger.warn({ err, ownerId }, "Failed to mark follow list dirty"));
  }
  return { source: inserted, ensured };
}

async function insertSource(
  feedId: string,
  sourceType: "account" | "publication" | "external_source" | "tag",
  target: {
    account_id?: string;
    publication_id?: string;
    external_source_id?: string;
    tag_name?: string;
  },
  db: { query: typeof pool.query } = pool,
) {
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, publication_id, external_source_id, tag_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        feedId,
        sourceType,
        target.account_id ?? null,
        target.publication_id ?? null,
        target.external_source_id ?? null,
        target.tag_name ?? null,
      ],
    );
    // Re-read the new row through the same join the GET endpoint uses, so the
    // client sees the same shape on create as on list.
    const { rows: hydrated } = await db.query<SourceRow>(
      `${HYDRATED_SOURCE_SELECT} WHERE fs.id = $1`,
      [rows[0].id],
    );
    return sourceRowToResponse(hydrated[0]);
  } catch (err) {
    // Per-type partial unique indexes on (feed_id, target) raise 23505 when
    // the user tries to add the same target twice.
    if ((err as { code?: string } | null)?.code === "23505")
      throw tagged("DUPLICATE");
    throw err;
  }
}

// Record an import exclusion when an external source leaves a bound feed
// (FOLLOW-GRAPH-IMPORT-ADR §6.3): re-sync must never resurrect a source the
// user deliberately removed/moved out here. No-op unless the feed carries a
// feed_import_bindings row whose protocol matches the source's — removals of
// hand-added other-protocol sources from a bound feed are not sync-relevant.
// Runs inside the caller's transaction.
async function recordImportExclusion(
  client: { query: typeof pool.query },
  feedId: string,
  externalSourceId: string,
) {
  await client.query(
    `INSERT INTO feed_import_exclusions (feed_id, protocol, identity)
     SELECT b.feed_id, xs.protocol, xs.source_uri
       FROM feed_import_bindings b
       JOIN external_sources xs ON xs.id = $2
      WHERE b.feed_id = $1 AND xs.protocol = b.protocol
     ON CONFLICT (feed_id, protocol, identity) DO NOTHING`,
    [feedId, externalSourceId],
  );
}

// The inverse: a manual re-add revokes the exclusion (§6.3 — the user's
// evident intent is membership, so "Sync now" resumes tracking it). No-op on
// feeds with no binding / no recorded exclusion. Runs inside the caller's
// transaction.
async function clearImportExclusion(
  client: { query: typeof pool.query },
  feedId: string,
  protocol: string,
  identity: string,
) {
  await client.query(
    `DELETE FROM feed_import_exclusions
      WHERE feed_id = $1 AND protocol = $2 AND identity = $3`,
    [feedId, protocol, identity],
  );
}

// Remove a source from a feed, with the feed-derived-subscription teardown:
// when an external source leaves the owner's *last* feed we drop the derived
// subscription and orphan the shared row (the GC then deactivates/culls it).
// The owner-scoped advisory lock serialises the read-then-write against a
// concurrent addSource of the same source into another feed — without it we
// could under-count and wrongly delete a still-referenced subscription.
// Extracted from the DELETE route handler (FOLLOW-GRAPH-IMPORT-ADR §11.1) so
// the Phase 2 sync engine can call the same invariant-bearing path.
//
// recordExclusion (default true): an exclusion marks a DELIBERATE LOCAL
// removal so re-sync never resurrects it (§6.3). The sync engine's own
// removals mirror a remote unfollow — not local intent — so it passes false;
// otherwise a re-follow at the origin could never sync back in.
export async function removeSource(
  feedId: string,
  ownerId: string,
  sourceId: string,
  opts: { recordExclusion?: boolean } = {},
): Promise<{
  notFound: boolean;
  toreDownNostr: boolean;
  /** Account sources only: what happened to the native follow. `null` means
   *  the removed row was not an account source, so the question does not
   *  arise — distinct from "kept", which is a real answer about a real
   *  follow. A bare boolean here would have the caller reporting a follow
   *  state for a removed RSS feed.
   *
   *  THREE VALUES, NOT TWO (§0ab item 6). "kept" and "dropped" are both facts
   *  about a follow row that EXISTED; "none" is the handed source — seeded,
   *  redeemed, imported — which never had one. All three are distinct to the
   *  two readers: the client needs "am I following" (kept alone), and
   *  `markFollowListDirty` needs "did the published kind-3 list change"
   *  (dropped alone). Folding "none" into either one gets one of them wrong. */
  follow: "kept" | "dropped" | "none" | null;
}> {
  const result = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `feed_sub:${ownerId}`,
    ]);

    const { rows } = await client.query<{
      source_type: string;
      external_source_id: string | null;
      account_id: string | null;
    }>(
      `DELETE FROM feed_sources
         WHERE id = $1 AND feed_id = $2
       RETURNING source_type, external_source_id, account_id`,
      [sourceId, feedId],
    );
    if (rows.length === 0) return { notFound: true as const };

    const { source_type, external_source_id, account_id } = rows[0];

    // THE NATIVE MIRROR OF THE EXTERNAL TEARDOWN BELOW, and deliberately not
    // gated on `ownerChose`: a follow exists because a source does, so a
    // source leaving the owner's LAST feed takes the follow with it whatever
    // put it there. Counted against every feed the owner has, hidden ones
    // included — a hidden feed still ingests, so a source sitting in one is
    // still carrying the writer's posts.
    //
    // TWO QUESTIONS, NOT ONE, BECAUSE `kept` IS ANSWERED TO THE CLIENT AS
    // "still following" (§0ab item 6). Whether a source REMAINS decides whether
    // the graph row is torn down; whether a `follows` row remains is what the
    // route reports back and what every client writes into its store. Those
    // were the same query, and they are not the same fact: a source the member
    // was HANDED — seeded, redeemed, follow-imported — carries no `follows` row
    // by this file's own `ownerChose` rule, so a handed source sitting in two
    // feeds, removed from one, answered `following: true` and painted FOLLOWING
    // on a writer the member had never followed, until a reload said otherwise.
    // So the teardown asks `feed_sources` and the ANSWER asks `follows`.
    if (source_type === "account" && account_id) {
      const {
        rows: [{ remaining }],
      } = await client.query<{ remaining: string }>(
        `SELECT COUNT(*)::int AS remaining
           FROM feed_sources fs
           JOIN feeds f ON f.id = fs.feed_id
          WHERE fs.account_id = $1 AND f.owner_id = $2`,
        [account_id, ownerId],
      );
      if (Number(remaining) === 0) {
        // The DELETE's own rowCount is the answer: a handed source leaving its
        // last feed removes nothing, and calling that "dropped" would republish
        // the kind-3 list over a row that was never in it.
        const { rowCount } = await client.query(
          `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
          [ownerId, account_id],
        );
        return {
          notFound: false as const,
          toreDownNostr: false,
          follow: (rowCount ?? 0) > 0 ? ("dropped" as const) : ("none" as const),
        };
      }
      // A source survives, so nothing is torn down — but whether the member
      // FOLLOWS this writer is a different question from whether a source of
      // theirs remains, and it is the one the answer reports. Asked inside the
      // same transaction and under the same owner lock, so what the client is
      // told cannot be stale by the time it is told.
      const { rowCount } = await client.query(
        `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
        [ownerId, account_id],
      );
      return {
        notFound: false as const,
        toreDownNostr: false,
        follow: (rowCount ?? 0) > 0 ? ("kept" as const) : ("none" as const),
      };
    }

    if (source_type !== "external_source" || !external_source_id) {
      return { notFound: false as const, toreDownNostr: false };
    }

    // A removal from an import-bound feed is a deliberate local edit — record
    // it so "Sync now" never re-adds this source (§6.3).
    if (opts.recordExclusion !== false)
      await recordImportExclusion(client, feedId, external_source_id);

    // Any remaining feed memberships for this source across the owner's feeds?
    const {
      rows: [{ remaining }],
    } = await client.query<{ remaining: string }>(
      `SELECT COUNT(*)::int AS remaining
         FROM feed_sources fs
         JOIN feeds f ON f.id = fs.feed_id
        WHERE fs.external_source_id = $1 AND f.owner_id = $2`,
      [external_source_id, ownerId],
    );
    if (Number(remaining) > 0) {
      return { notFound: false as const, toreDownNostr: false };
    }

    // Last feed — drop this owner's derived subscription…
    await client.query(
      `DELETE FROM external_subscriptions
         WHERE subscriber_id = $1 AND source_id = $2`,
      [ownerId, external_source_id],
    );
    // …and orphan the source iff no subscription anywhere still references it.
    await client.query(
      `UPDATE external_sources
          SET orphaned_at = now()
        WHERE id = $1 AND orphaned_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM external_subscriptions WHERE source_id = $1
          )`,
      [external_source_id],
    );
    const {
      rows: [src],
    } = await client.query<{ protocol: string }>(
      `SELECT protocol FROM external_sources WHERE id = $1`,
      [external_source_id],
    );
    return {
      notFound: false as const,
      toreDownNostr: src?.protocol === "nostr_external",
    };
  });

  if (result.notFound)
    return { notFound: true, toreDownNostr: false, follow: null };

  const follow = ("follow" in result ? result.follow : null) ?? null;

  // A retracted follow must leave the published kind-3 list — external Nostr
  // and native alike, since the one list carries both.
  if (result.toreDownNostr || follow === "dropped") {
    markFollowListDirty(ownerId).catch((err) =>
      logger.warn({ err, ownerId }, "Failed to mark follow list dirty"));
  }
  return { notFound: false, toreDownNostr: result.toreDownNostr, follow };
}

// Source order is ALPHABETICAL BY THE RENDERED LABEL, and that is the one
// order — the composer, the /bootstrap aggregate and a share link's page all
// take it from here (formulas.ts sorts its frozen projection with this same
// comparator), so nobody has to learn a feed's private history to find a
// source in it. A composition is a set, not a log: created_at ordering meant
// the list reshuffled itself as you added to it and the source you wanted was
// wherever you happened to have added it.
//
// Collated the way the eye reads the label rather than the way bytes sort:
// case-insensitive, digits numerically, and a leading sigil skipped so
// `#politics` files under P instead of bunching every tag under the
// punctuation block. The raw label breaks a tie, and the SQL's created_at/id
// order survives underneath it (Array#sort is stable), so the result is total
// — two sources sharing a display name do not swap places between reloads.
const SOURCE_COLLATOR = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});
const LEADING_SIGIL_RE = /^[^\p{L}\p{N}]+/u;

export function compareSourceLabels(a: string, b: string) {
  return (
    SOURCE_COLLATOR.compare(
      a.replace(LEADING_SIGIL_RE, ""),
      b.replace(LEADING_SIGIL_RE, ""),
    ) || SOURCE_COLLATOR.compare(a, b)
  );
}

// Load a feed's source rows with target display info, mapped to the wire shape.
// A member admit created who has not yet arrived is left out (see
// `accountArrivedSql` above); `feeds.source_count`, which branches the items
// query, stays the true row count, because the feed does have that source.
// Shared by GET /feeds/:id/sources and the /bootstrap aggregate (performance
// audit #3). Ownership is the caller's responsibility (both call sites assert it
// via loadFeed before reaching here).
export async function loadFeedSources(feedId: string) {
  const { rows } = await pool.query<SourceRow>(
    `${HYDRATED_SOURCE_SELECT}
     WHERE fs.feed_id = $1 AND ${accountArrivedSql("acc")}
     ORDER BY fs.created_at ASC, fs.id ASC`,
    [feedId],
  );
  // The SQL order is only the stable floor under the label sort above — the
  // label is assembled in JS (fallbacks and the tag's `#`), so it cannot be an
  // ORDER BY without a second, drifting copy of those rules in SQL.
  return rows
    .map(sourceRowToResponse)
    .sort((a, b) =>
      compareSourceLabels(a.display.label ?? "", b.display.label ?? ""),
    );
}

export function registerFeedSourcesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds/:id/sources — list rows with target display info
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/feeds/:id/sources",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      // Import-bound feeds carry their origin binding so the composer can
      // offer "Sync now" (FOLLOW-GRAPH-IMPORT-ADR §6.3/§11.5). Null for the
      // (vast majority of) feeds that were never imported.
      const {
        rows: [binding],
      } = await pool.query<{
        protocol: string;
        origin_identity: string;
        last_synced_at: Date | null;
      }>(
        `SELECT protocol, origin_identity, last_synced_at
           FROM feed_import_bindings WHERE feed_id = $1`,
        [id],
      );

      return reply.send({
        sources: await loadFeedSources(id),
        importBinding: binding
          ? {
              protocol: binding.protocol,
              originIdentity: binding.origin_identity,
              lastSyncedAt: binding.last_synced_at?.toISOString() ?? null,
            }
          : null,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /feeds/:id/sources — add a source
  //
  // The body is a discriminated union on sourceType. Native targets pass an
  // existing UUID; tag passes a name (created on the fly if new); external
  // accepts either an existing externalSourceId OR a (protocol, sourceUri)
  // pair which is upserted into external_sources and gets a subscription
  // ensured for the caller (so the existing fetch-job machinery picks it up).
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id/sources",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const parsed = addSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(zodValidationError(parsed.error));
      }

      try {
        // THIS ROUTE IS THE GESTURE, which is the whole of the distinction: a
        // member typing a name into the composer, pressing Follow, or ticking
        // a feed in the picker all arrive here, and all three mean the same
        // thing. Redeem, the default seed and follow-import reach `addSource`
        // by other doors and pass nothing, so a feed somebody was HANDED
        // makes no follows.
        const result = await addSource(id, ownerId, parsed.data, {
          ownerChose: true,
        });
        return reply.status(201).send({
          source: result.source,
          ensured: result.ensured,
          // Present for an account source only. The client's label reads this
          // rather than assuming the write it asked for is the write that
          // happened — the follow is skipped for an inactive target.
          ...("following" in result ? { following: result.following } : {}),
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        // Every refusal below carries its reason as `message`, the field the
        // web's add-source surfaces read: a sentence left in `error` alone was
        // dropped for the generic "Failed to add source", so a member adding
        // a source already in the channel was never told that it was.
        if (code === "TARGET_NOT_FOUND") {
          return reply.status(404).send({
            error: "source_not_found",
            message: "We couldn't find that source, so nothing was added.",
          });
        }
        // Audit F1 error-space split: input that can never name a source in
        // the protocol (400) vs well-formed but no live target answering
        // (422). `message` is the human-readable probe verdict.
        if (code === "SOURCE_URI_INVALID") {
          return reply.status(400).send({
            error: "invalid_source_uri",
            message: (err as Error).message,
          });
        }
        if (code === "SOURCE_UNREACHABLE") {
          return reply.status(422).send({
            error: "source_unreachable",
            message: (err as Error).message,
          });
        }
        if (code === "DUPLICATE") {
          return reply.status(409).send({
            error: "source_already_in_channel",
            message: "That source is already in this channel.",
          });
        }
        if (code === "SELF_SOURCE") {
          return reply.status(400).send({
            error: "self_source",
            message: "You can't add your own account to a channel.",
          });
        }
        // The neutral both-ways refusal, worded exactly as `POST /follows`'s
        // is: one sentence for either direction, so neither party learns
        // which way the block runs. Distinct from `source_blocked`, which is
        // the OPERATOR's public refusal of a source and says so.
        if (code === "TARGET_BLOCKED") {
          return reply.status(403).send({
            error: "target_blocked",
            message: "You can't add this account to a channel.",
          });
        }
        // A platform block is not "not found" and must not be spelled as one:
        // the caller is being refused something that exists, by us, and the
        // screen says so. 403 rather than 404 because there is nothing to
        // protect here — the operator's refusal is a public fact about the
        // source, not a private one about the caller (D7 SS7).
        if (code === "SOURCE_BLOCKED") {
          return reply.status(403).send({
            error: "source_blocked",
            message:
              "all.haus does not carry this source. If you think that is wrong, write to us.",
          });
        }
        logger.error({ err, feedId: id }, "Add source failed");
        return reply.status(500).send({ error: "internal_error" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /feeds/:id/sources/:sourceId — remove a source
  //
  // External subscriptions are feed-derived: a row in external_subscriptions
  // exists iff the source sits in ≥1 of the owner's feeds. So when an external
  // source leaves its *last* feed we tear down the subscription and orphan the
  // source (the GC then deactivates/culls it). The (owner-scoped) advisory lock
  // serialises this read-then-write against a concurrent addSource of the same
  // source into another feed — without it we could under-count and wrongly
  // delete a still-referenced subscription.
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string; sourceId: string } }>(
    "/feeds/:id/sources/:sourceId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, sourceId } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      if (!isUuid(sourceId))
        return reply.status(404).send({ error: "We couldn't find that source." });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const result = await removeSource(id, ownerId, sourceId);
      if (result.notFound)
        return reply.status(404).send({ error: "We couldn't find that source." });
      // 200 with a body rather than 204, because removing an `account` source
      // can also drop the follow and the client's label must not GUESS which
      // way that went: it knows this feed, the server knows every feed.
      // `following` is the state AFTER the removal and is absent for any
      // source that is not an account, where the question does not arise.
      return reply.status(200).send({
        ok: true,
        ...(result.follow ? { following: result.follow === "kept" } : {}),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /feeds/:id/sources/:sourceId/move — move a source to another feed
  //
  // Relocates a feed_source row from this feed to a target feed. Returns 409
  // if the target already has the same source. Both feeds must be owned by
  // the caller.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string; sourceId: string }; Body: unknown }>(
    "/feeds/:id/sources/:sourceId/move",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, sourceId } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find the channel you're moving it from." });
      if (!isUuid(sourceId))
        return reply.status(404).send({ error: "We couldn't find that source." });

      const parsed = z
        .object({ targetFeedId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(zodValidationError(parsed.error));
      }
      const { targetFeedId } = parsed.data;

      if (targetFeedId === id) {
        return reply
          .status(400)
          .send({ error: "That source is already in this channel." });
      }

      try {
        const sourceFeed = await loadFeed(id, ownerId);
        if (!sourceFeed)
          return reply.status(404).send({ error: "We couldn't find the channel you're moving it from." });
        const targetFeed = await loadFeed(targetFeedId, ownerId);
        if (!targetFeed)
          return reply.status(404).send({ error: "We couldn't find the channel you're moving it to." });

        const moved = await withTransaction(async (client) => {
          const { rows } = await client.query<{
            source_type: string;
            external_source_id: string | null;
          }>(
            `UPDATE feed_sources SET feed_id = $1
             WHERE id = $2 AND feed_id = $3
             RETURNING source_type, external_source_id`,
            [targetFeedId, sourceId, id],
          );
          if (rows.length === 0) return false;
          // Moving a source OUT of an import-bound feed is a deliberate local
          // edit like removal — record the exclusion so re-sync doesn't re-add
          // it to the import feed, duplicating it across two feeds (§6.3).
          const { source_type, external_source_id } = rows[0];
          if (source_type === "external_source" && external_source_id) {
            await recordImportExclusion(client, id, external_source_id);
          }
          return true;
        });
        if (!moved)
          return reply.status(404).send({ error: "We couldn't find that source." });

        return reply.send({ ok: true });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "23505") {
          return reply
            .status(409)
            .send({ error: "That channel already has this source." });
        }
        logger.error({ err }, "Move source failed");
        return reply.status(500).send({ error: "Couldn't move that source. Please try again." });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /feeds/:id/sources/:sourceId — update throughput/sampling/muted
  //
  // Accepts { step?: 0..5, sampling?: 'random'|'top', muted?: boolean }.
  // Step maps to the same throughput scale as the author-volume route so the two
  // surfaces stay consistent. Returns the updated source row.
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string; sourceId: string }; Body: unknown }>(
    "/feeds/:id/sources/:sourceId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, sourceId } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      if (!isUuid(sourceId))
        return reply.status(404).send({ error: "We couldn't find that source." });

      const parsed = patchSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(zodValidationError(parsed.error));
      }
      const { step, sampling, muted, excludeReplies } = parsed.data;
      if (
        step === undefined &&
        sampling === undefined &&
        muted === undefined &&
        excludeReplies === undefined
      ) {
        return reply.status(400).send({ error: "Nothing to update" });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const sets: string[] = [];
      const vals: unknown[] = [];
      let paramIdx = 3; // $1=sourceId, $2=feedId

      // STEP 0 IS MUTE, AND MUTE MUST NOT SPEND THE LEVEL. Step 0 has no
      // throughput of its own — `VOLUME_THROUGHPUT[0]` is the 1.0 placeholder
      // that exists only to satisfy the `throughput > 0` CHECK — so writing it
      // would silently reset a source the reader had set to 20% back to
      // everything, and the reader would find that out on unmute. Mute rides
      // `muted_at` alone; the stored fraction is what the source returns to.
      // FeedComposer's optimistic row already assumed this (it keeps
      // `source.throughput` when muting) and was being overwritten by the
      // authoritative response.
      if (step !== undefined && step > 0) {
        sets.push(`throughput = $${paramIdx}`);
        vals.push(stepToThroughput(step));
        paramIdx++;
      }
      if (sampling !== undefined) {
        sets.push(`sampling_mode = $${paramIdx}`);
        vals.push(sampling === "top" ? "scored" : "random");
        paramIdx++;
      }
      if (muted !== undefined) {
        sets.push(`muted_at = $${paramIdx}`);
        vals.push(muted ? new Date() : null);
        paramIdx++;
      }
      if (excludeReplies !== undefined) {
        sets.push(`exclude_replies = $${paramIdx}`);
        vals.push(excludeReplies);
        paramIdx++;
      }

      // `{ step: 0 }` on its own now sets nothing — and an empty SET list is a
      // syntax error, not an empty update, so it would have been a 500. It is a
      // caller mistake rather than a state to write (mute is `muted: true`), so
      // it answers the same 400 an empty body does.

      if (sets.length === 0) {
        return reply.status(400).send({ error: "Nothing to update" });
      }

      const { rowCount } = await pool.query(
        `UPDATE feed_sources SET ${sets.join(", ")}
         WHERE id = $1 AND feed_id = $2`,
        [sourceId, id, ...vals],
      );
      if (rowCount === 0)
        return reply.status(404).send({ error: "We couldn't find that source." });

      // Re-fetch the full hydrated row for the response.
      const { rows } = await pool.query<SourceRow>(
        `${HYDRATED_SOURCE_SELECT} WHERE fs.id = $1`,
        [sourceId],
      );
      return reply.send({ source: sourceRowToResponse(rows[0]) });
    },
  );
}
