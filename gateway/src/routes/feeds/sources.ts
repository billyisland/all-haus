import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { markFollowListDirty } from "../../lib/discovery-publish.js";
import { verifySourceLiveness } from "../../lib/source-liveness.js";
import { UUID_RE, loadFeed, tagged, stepToWeight } from "./shared.js";

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
            message: "Relay URL must use ws:// or wss:// protocol",
          }),
      )
      .max(10)
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
}

interface SourceRow {
  id: string;
  source_type: "account" | "publication" | "external_source" | "tag";
  weight: string;
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
  account_avatar: string | null;
  publication_slug: string | null;
  publication_name: string | null;
  publication_avatar: string | null;
  external_protocol: string | null;
  external_source_uri: string | null;
  external_display_name: string | null;
  external_avatar: string | null;
}

function sourceRowToResponse(row: SourceRow) {
  // The display block is what the UI renders in the source list. Each branch
  // returns a small, self-describing object so the client doesn't have to
  // re-derive labels from foreign keys.
  // `href` is the in-app destination for the source name — the same surface a
  // byline links to on a feed card, so the composer's source names route
  // identically (account → /:username, publication → /pub/:slug, external →
  // /source/:id, tag → /tag/:name). null when the target is deleted.
  let display: Record<string, string | null> = {};
  if (row.source_type === "account") {
    display = {
      kind: "account",
      label:
        row.account_display_name ?? row.account_username ?? "(deleted account)",
      sublabel: row.account_username ? `@${row.account_username}` : null,
      avatar: row.account_avatar,
      href: row.account_username ? `/${row.account_username}` : null,
    };
  } else if (row.source_type === "publication") {
    display = {
      kind: "publication",
      label:
        row.publication_name ?? row.publication_slug ?? "(deleted publication)",
      sublabel: row.publication_slug ? `/pub/${row.publication_slug}` : null,
      avatar: row.publication_avatar,
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
      avatar: row.external_avatar,
      href: row.external_source_id ? `/source/${row.external_source_id}` : null,
    };
  } else {
    display = {
      kind: "tag",
      label: `#${row.tag_name}`,
      sublabel: null,
      avatar: null,
      href: row.tag_name ? `/tag/${encodeURIComponent(row.tag_name)}` : null,
    };
  }
  return {
    id: row.id,
    sourceType: row.source_type,
    accountId: row.account_id ?? undefined,
    externalSourceId: row.external_source_id ?? undefined,
    weight: Number(row.weight),
    samplingMode: row.sampling_mode === "scored" ? "top" : "random",
    excludeReplies: row.exclude_replies,
    mutedAt: row.muted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    display,
  };
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
    const { rows } = await pool.query(`SELECT id FROM accounts WHERE id = $1`, [
      input.accountId,
    ]);
    if (rows.length === 0) throw tagged("TARGET_NOT_FOUND");
    const inserted = await insertSource(feedId, "account", {
      account_id: input.accountId,
    });
    return { source: inserted, ensured: null };
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
    if (rows.length === 0) throw tagged("TARGET_NOT_FOUND");
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

  const { inserted, ensured } = await withTransaction(async (client) => {
    // Serialise against a concurrent last-feed teardown (see DELETE handler).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `feed_sub:${ownerId}`,
    ]);
    const {
      rows: [src],
    } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, description, avatar_url, relay_urls)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (protocol, source_uri) DO UPDATE SET
         display_name = COALESCE(NULLIF($3, ''), external_sources.display_name),
         description  = COALESCE(NULLIF($4, ''), external_sources.description),
         avatar_url   = COALESCE(NULLIF($5, ''), external_sources.avatar_url),
         relay_urls   = COALESCE($6, external_sources.relay_urls),
         is_active = TRUE,
         orphaned_at = NULL,
         updated_at = now()
       RETURNING id`,
      [
        protocol,
        sourceUri,
        // Caller-provided display fields win; the liveness probe's metadata
        // (feed title, profile name, …) backfills direct-API adds that send
        // none, so a probed source never lands with a bare-URI label.
        displayName ?? probed.displayName ?? null,
        description ?? probed.description ?? null,
        avatarUrl ?? probed.avatarUrl ?? null,
        protocol === "nostr_external" && relayUrls && relayUrls.length > 0
          ? relayUrls
          : null,
      ],
    );
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
    const { rows } = await db.query<SourceRow>(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, publication_id, external_source_id, tag_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, source_type, weight, sampling_mode, muted_at, created_at,
                 account_id, publication_id, external_source_id, tag_name,
                 NULL::text AS account_username, NULL::text AS account_display_name, NULL::text AS account_avatar,
                 NULL::text AS publication_slug, NULL::text AS publication_name, NULL::text AS publication_avatar,
                 NULL::text AS external_protocol, NULL::text AS external_source_uri,
                 NULL::text AS external_display_name, NULL::text AS external_avatar`,
      [
        feedId,
        sourceType,
        target.account_id ?? null,
        target.publication_id ?? null,
        target.external_source_id ?? null,
        target.tag_name ?? null,
      ],
    );
    // The display fields above are NULLs from the bare INSERT — re-hydrate
    // by fetching the row through the same join the GET endpoint uses, so
    // the client sees the same shape on create as on list.
    const { rows: hydrated } = await db.query<SourceRow>(
      `SELECT fs.id, fs.source_type, fs.weight, fs.sampling_mode, fs.muted_at, fs.created_at,
         fs.exclude_replies,
         fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
         acc.username AS account_username, acc.display_name AS account_display_name, acc.avatar_blossom_url AS account_avatar,
         pub.slug AS publication_slug, pub.name AS publication_name, pub.logo_blossom_url AS publication_avatar,
         xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
         xs.display_name AS external_display_name, xs.avatar_url AS external_avatar
       FROM feed_sources fs
       LEFT JOIN accounts acc ON acc.id = fs.account_id
       LEFT JOIN publications pub ON pub.id = fs.publication_id
       LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
       WHERE fs.id = $1`,
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
): Promise<{ notFound: boolean; toreDownNostr: boolean }> {
  const result = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `feed_sub:${ownerId}`,
    ]);

    const { rows } = await client.query<{
      source_type: string;
      external_source_id: string | null;
    }>(
      `DELETE FROM feed_sources
         WHERE id = $1 AND feed_id = $2
       RETURNING source_type, external_source_id`,
      [sourceId, feedId],
    );
    if (rows.length === 0) return { notFound: true as const };

    const { source_type, external_source_id } = rows[0];
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

  if (result.notFound) return { notFound: true, toreDownNostr: false };

  // A retracted external Nostr follow must leave the published kind-3 list.
  if (result.toreDownNostr) {
    markFollowListDirty(ownerId).catch((err) =>
      logger.warn({ err, ownerId }, "Failed to mark follow list dirty"));
  }
  return { notFound: false, toreDownNostr: result.toreDownNostr };
}

// Load a feed's source rows with target display info, mapped to the wire shape.
// Shared by GET /feeds/:id/sources and the /bootstrap aggregate (performance
// audit #3). Ownership is the caller's responsibility (both call sites assert it
// via loadFeed before reaching here).
export async function loadFeedSources(feedId: string) {
  // LEFT JOINs against each potential target type. Exactly one is non-null per
  // row (CHECK in migration 077), so COALESCE picks the populated display
  // fields without ambiguity.
  const { rows } = await pool.query<SourceRow>(
    `SELECT fs.id, fs.source_type, fs.weight, fs.sampling_mode, fs.muted_at, fs.created_at,
       fs.exclude_replies,
       fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
       acc.username AS account_username, acc.display_name AS account_display_name, acc.avatar_blossom_url AS account_avatar,
       pub.slug AS publication_slug, pub.name AS publication_name, pub.logo_blossom_url AS publication_avatar,
       xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
       xs.display_name AS external_display_name, xs.avatar_url AS external_avatar
     FROM feed_sources fs
     LEFT JOIN accounts acc ON acc.id = fs.account_id
     LEFT JOIN publications pub ON pub.id = fs.publication_id
     LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
     WHERE fs.feed_id = $1
     ORDER BY fs.created_at ASC, fs.id ASC`,
    [feedId],
  );
  return rows.map(sourceRowToResponse);
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
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

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
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const parsed = addSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      try {
        const result = await addSource(id, ownerId, parsed.data);
        return reply
          .status(201)
          .send({ source: result.source, ensured: result.ensured });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "TARGET_NOT_FOUND") {
          return reply.status(404).send({ error: "Source target not found" });
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
          return reply.status(409).send({ error: "Source already on feed" });
        }
        logger.error({ err, feedId: id }, "Add source failed");
        return reply.status(500).send({ error: "Add source failed" });
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
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!UUID_RE.test(sourceId))
        return reply.status(400).send({ error: "Invalid source id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const result = await removeSource(id, ownerId, sourceId);
      if (result.notFound)
        return reply.status(404).send({ error: "Source not found" });
      return reply.status(204).send();
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
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!UUID_RE.test(sourceId))
        return reply.status(400).send({ error: "Invalid source id" });

      const parsed = z
        .object({ targetFeedId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { targetFeedId } = parsed.data;

      if (targetFeedId === id) {
        return reply
          .status(400)
          .send({ error: "Source and target feed are the same" });
      }

      try {
        const sourceFeed = await loadFeed(id, ownerId);
        if (!sourceFeed)
          return reply.status(404).send({ error: "Source feed not found" });
        const targetFeed = await loadFeed(targetFeedId, ownerId);
        if (!targetFeed)
          return reply.status(404).send({ error: "Target feed not found" });

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
          return reply.status(404).send({ error: "Source not found" });

        return reply.send({ ok: true });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "23505") {
          return reply
            .status(409)
            .send({ error: "Target feed already has this source" });
        }
        logger.error({ err }, "Move source failed");
        return reply.status(500).send({ error: "Move source failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /feeds/:id/sources/:sourceId — update weight/sampling/muted
  //
  // Accepts { step?: 0..5, sampling?: 'random'|'top', muted?: boolean }.
  // Step maps to the same weight scale as the author-volume route so the two
  // surfaces stay consistent. Returns the updated source row.
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string; sourceId: string }; Body: unknown }>(
    "/feeds/:id/sources/:sourceId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, sourceId } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!UUID_RE.test(sourceId))
        return reply.status(400).send({ error: "Invalid source id" });

      const parsed = patchSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
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
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const sets: string[] = [];
      const vals: unknown[] = [];
      let paramIdx = 3; // $1=sourceId, $2=feedId

      if (step !== undefined) {
        sets.push(`weight = $${paramIdx}`);
        vals.push(stepToWeight(step));
        paramIdx++;
      }
      if (sampling !== undefined) {
        sets.push(`sampling_mode = $${paramIdx}`);
        vals.push(
          sampling === "top"
            ? "scored"
            : sampling === "random"
              ? "chronological"
              : sampling,
        );
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

      const { rowCount } = await pool.query(
        `UPDATE feed_sources SET ${sets.join(", ")}
         WHERE id = $1 AND feed_id = $2`,
        [sourceId, id, ...vals],
      );
      if (rowCount === 0)
        return reply.status(404).send({ error: "Source not found" });

      // Re-fetch the full hydrated row for the response.
      const { rows } = await pool.query<SourceRow>(
        `SELECT fs.id, fs.source_type, fs.weight, fs.sampling_mode, fs.muted_at, fs.created_at,
           fs.exclude_replies,
           fs.account_id, fs.publication_id, fs.external_source_id, fs.tag_name,
           acc.username AS account_username, acc.display_name AS account_display_name, acc.avatar_blossom_url AS account_avatar,
           pub.slug AS publication_slug, pub.name AS publication_name, pub.logo_blossom_url AS publication_avatar,
           xs.protocol AS external_protocol, xs.source_uri AS external_source_uri,
           xs.display_name AS external_display_name, xs.avatar_url AS external_avatar
         FROM feed_sources fs
         LEFT JOIN accounts acc ON acc.id = fs.account_id
         LEFT JOIN publications pub ON pub.id = fs.publication_id
         LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
         WHERE fs.id = $1`,
        [sourceId],
      );
      return reply.send({ source: sourceRowToResponse(rows[0]) });
    },
  );
}
