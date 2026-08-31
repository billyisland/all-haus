import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS, parseCursor } from "../lib/feed-sql.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
  commentToPost,
} from "../lib/post-mapper.js";
import {
  type AuthorCardResponse,
  resolveNativeAuthor,
  fetchBlueskyProfile,
  fetchAPProfile,
  buildExternalProfileUrl,
} from "../lib/author-resolve.js";
import { fetchNostrAuthorProfile } from "../lib/nostr-relay.js";
import {
  willHydrateAuthorTimeline,
  hydrateAuthorTimeline,
} from "../lib/author-timeline-hydration.js";
import { encodeTsIdCursor } from "../lib/cursor.js";

// =============================================================================
// Constructed author profile — UNIVERSAL-POST-ADR Phase 4 (§4.4, §9, §VI.3)
//
// Two endpoints keyed on the PERSISTENT author identity (author.id) — native
// accounts.id or the tier-A/B external_authors.id minted in Phase 0b. Keying on
// the identity record (not a single external_item, as the legacy /author-card
// does) is what lets one profile aggregate an author's posts across every source
// that resolves to the same author.id.
//
//   GET /author/:authorId/profile  → AuthorCardResponse (bio + stats | none)
//   GET /author/:authorId/posts    → { items: Post[], nextCursor }
//
// Both share the id-space probe: external_authors by id first, else accounts.
// UUIDs do not collide across the two tables, so the probe is unambiguous.
//
// Tier scope: native + external A/B/C carry an identity record, so they resolve
// here. Tier C (BYLINE-AND-PROVENANCE-ADR D3/D4, migration 183) is the
// SOURCE-SCOPED rss/email byline — `<source_id>#<name>`, "the person this
// source calls X" — and resolves to a log, not a profile: its follow target is
// its backing source (D6), it has no origin profile to fetch, and it is
// unlinkable (D4). Tier-D external authors (no name, ever) have no row — their
// post.author.id is null, so the client never links to /author for them and a
// direct hit 404s.
//
// The /profile response is the SAME AuthorCardResponse shape the legacy
// /author-card emits (a documented, deliberate deviation from §9's literal
// `{ author, bio, stats }`): the shape already carries everything the hover
// modal + profile header need, so the shipped AuthorModal renders it unchanged —
// reuse over a parallel shape.
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// The /posts context filter (EXTERNAL-AUTHOR-HISTORY-ADR §3.3): pure
// thread-hydration context rows stay OUT (they're feed-pipeline pollution
// guards), but profile-hydrated timeline rows are IN — they exist precisely
// for this endpoint. Exported so the filter matrix is testable as SQL.
export const AUTHOR_POSTS_CONTEXT_FILTER =
  "(ei.is_context_only IS NOT TRUE OR ei.is_profile_hydrated IS TRUE)";


interface ExternalAuthorRow {
  id: string;
  protocol: string;
  stable_handle: string;
  tier: "A" | "B" | "C";
  account_id: string | null;
  // The backing external_sources.id — set for tier C only (D6), NULL for A/B,
  // which are cross-source by design.
  source_id: string | null;
  display_name: string | null;
  handle: string | null;
  handle_uri: string | null;
  avatar: string | null;
  bio: string | null;
  website: string | null;
  lightning_address: string | null;
  profile_fetched_at: Date | null;
}

// How long a persisted live-profile snapshot is served straight from the DB
// before the next view re-fetches it from the relay graph (migration 117).
const LIVE_PROFILE_TTL_MS = 30 * 60_000;

export async function loadExternalAuthor(
  id: string,
): Promise<ExternalAuthorRow | null> {
  const { rows } = await pool.query<ExternalAuthorRow>(
    `SELECT id, protocol, stable_handle, tier, account_id, source_id,
            display_name, handle, handle_uri, avatar,
            bio, website, lightning_address, profile_fetched_at
     FROM external_authors WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function isNativeAccount(id: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1 AND status = 'active') AS exists`,
    [id],
  );
  return rows[0]?.exists ?? false;
}

// The value the subscribe API expects as `sourceUri` for this author's own feed
// — and the source_uri an existing subscription to this author carries:
//   atproto        → bare DID (did:plc:… / did:web:…)
//   activitypub    → actor URI (https…)
//   nostr_external → 64-hex pubkey
// The stored handle is usually already in this shape, but hydration-only authors
// can carry a bsky.app profile URL — so for atproto we extract the embedded DID.
// Returns null when no subscribable identity can be derived (⇒ "not followed",
// and no subscribe affordance), which is the correct, safe default.
export function authorFollowUri(xa: ExternalAuthorRow): string | null {
  const h = xa.handle_uri ?? xa.stable_handle;
  switch (xa.protocol) {
    case "atproto":
      return h.match(/did:(?:plc|web):[a-zA-Z0-9.:_-]+/)?.[0] ?? null;
    case "activitypub":
      return /^https:\/\//.test(h) ? h : null;
    case "nostr_external":
      return /^[0-9a-f]{64}$/i.test(xa.stable_handle)
        ? xa.stable_handle
        : null;
    default:
      return null;
  }
}

// The external_sources.id backing an external author — its `source_a_id` in a
// cross-source identity link (Slice 8 P2). Derived from the author's own
// identity (authorFollowUri → the source whose source_uri is that handle), so a
// thread-context participant filed under another author's source never resolves
// here. Null for a native author, an author with no derivable follow handle, or
// one whose source row doesn't exist yet (e.g. tier-C/D RSS reached only as a
// link target). Mirrors the source lookup in resolveExternalAuthorById.
//
// A tier-C author is UNLINKABLE (BYLINE-AND-PROVENANCE-ADR D4), and not merely
// by falling through authorFollowUri's rss default: letting its backing source
// stand in as `source_a` would write a Guardian-source ↔ Bluesky-source edge,
// dedup would then suppress across every Guardian item and that account, and
// the chip would show on every one of the Guardian's journalists. An
// author-level link is a Slice 8 schema change (ADR Q3), not a use of Slice 8.
export async function loadAuthorLinkSource(
  authorId: string,
): Promise<{ sourceId: string; protocol: string } | null> {
  const xa = await loadExternalAuthor(authorId);
  if (!xa) return null;
  if (xa.tier === "C") return null;
  const followUri = authorFollowUri(xa);
  if (!followUri) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM external_sources
      WHERE protocol = $1::external_protocol AND source_uri = $2
      LIMIT 1`,
    [xa.protocol, followUri],
  );
  return rows[0] ? { sourceId: rows[0].id, protocol: xa.protocol } : null;
}

// Tier C — the source-scoped rss/email byline (BYLINE-AND-PROVENANCE-ADR D6).
// A log, not a profile: the author's name and the source it writes in, and a
// follow target that IS the backing source (`external_authors.source_id`) —
// you follow the Guardian, and a byline within it is a filter, not a
// subscription. Deliberately absent: `externalUrl` (there is no origin profile
// to link), live stats (nothing to fetch), and `linkedSources` (D4 — the only
// edge Slice 8's source-only graph could write would merge the whole
// publication). The source is read off the column, never parsed back out of
// the `<uuid>#` key and never inferred from a representative item.
//
// `sourceName`/`sourceDescription` fill the hover modal's existing tier-C
// branch (AuthorModal.tsx), which the legacy item-keyed /author-card route was
// the only producer of; the `type="author"` hover never calls that route.
async function resolveTierCAuthor(
  xa: ExternalAuthorRow,
  viewerId: string,
): Promise<AuthorCardResponse> {
  const base: AuthorCardResponse = {
    tier: "C",
    displayName: xa.display_name ?? undefined,
    sourceProtocol: xa.protocol,
    profilePath: `/author/${xa.id}`,
  };
  if (!xa.source_id) return base;

  const { rows } = await pool.query<{
    source_id: string;
    source_uri: string;
    display_name: string | null;
    description: string | null;
    sub_id: string | null;
  }>(
    `SELECT es.id AS source_id, es.source_uri, es.display_name, es.description,
            sub.id AS sub_id
       FROM external_sources es
       LEFT JOIN external_subscriptions sub
         ON sub.source_id = es.id AND sub.subscriber_id = $1
      WHERE es.id = $2`,
    [viewerId, xa.source_id],
  );
  const src = rows[0];
  if (!src) return base;

  return {
    ...base,
    sourceName: src.display_name ?? undefined,
    sourceDescription: src.description ?? undefined,
    sourceUrl: src.source_uri,
    // Same shape as the A/B branch below: `id` is the unfollow handle (the
    // viewer's subscription row) when following, else the sourceUri the
    // subscribe path keys on; `sourceId` lets the client resolve per-feed
    // membership for the feed-derived Follow.
    followTarget: {
      type: "source",
      id: src.sub_id ?? src.source_uri,
      isFollowing: src.sub_id !== null,
      protocol: xa.protocol,
      sourceUri: src.source_uri,
      sourceId: src.source_id,
    },
  };
}

// Constructed external-author profile: stored identity fields + live-origin
// stats. Follow state is computed from the author's own identity
// (authorFollowUri); a representative external_item is used only for the
// activitypub Mastodon-REST host fallback.
async function resolveExternalAuthorById(
  xa: ExternalAuthorRow,
  viewerId: string,
): Promise<AuthorCardResponse> {
  if (xa.tier === "C") return resolveTierCAuthor(xa, viewerId);

  const { rows: repRows } = await pool.query<{
    source_id: string | null;
    source_item_uri: string | null;
    author_uri: string | null;
  }>(
    `SELECT ei.source_id, ei.source_item_uri, ei.author_uri
     FROM feed_items fi
     JOIN external_items ei ON ei.id = fi.external_item_id
     WHERE fi.external_author_id = $1 AND fi.deleted_at IS NULL
     ORDER BY fi.published_at DESC
     LIMIT 1`,
    [xa.id],
  );
  // `rep` is kept ONLY for the activitypub host fallback below (Mastodon REST
  // counts). It must NOT drive follow state: thread-context hydration files
  // every participant's post under the FOCAL author's source_id (see
  // routes/external-items.ts), so the representative item's source is the focal
  // author's source for anyone who appears only inside an expanded conversation.
  // Keying isFollowing off it made every participant in an external thread
  // inherit the focal author's "FOLLOWING" state.
  const rep = repRows[0] ?? null;

  // Follow state keys on the AUTHOR'S OWN IDENTITY, not where their items happen
  // to be stored. An external author is "followed" iff the viewer subscribes to
  // a source whose source_uri is this author's stable handle (the DID / actor
  // URI / pubkey — the exact value the subscribe API expects as sourceUri).
  const followUri = authorFollowUri(xa);
  let followTarget: AuthorCardResponse["followTarget"];
  // The author's backing source — `source_a_id` for any cross-source identity
  // link (set alongside followTarget below; both read the same source lookup).
  let linkSourceId: string | null = null;
  if (followUri) {
    // `id` is the unfollow handle — the viewer's subscription-row id, since
    // DELETE /feeds/:id keys on external_subscriptions.id. Emit it when
    // subscribed so "FOLLOWING" → unsubscribe deletes the right row; when not
    // subscribed there's no row, so fall back to followUri — only the subscribe
    // path runs then, and it keys off protocol + sourceUri.
    //
    // `sourceId` is the external_sources.id (whenever the source row exists,
    // subscribed or not). The client matches it against per-feed membership
    // (feed_sources.external_source_id via listSources) to resolve the
    // feed-derived external Follow state — without it the hover card can never
    // see itself as already-followed in THIS feed.
    const { rows: subRows } = await pool.query<{
      source_id: string;
      sub_id: string | null;
    }>(
      `SELECT es.id AS source_id, sub.id AS sub_id
         FROM external_sources es
         LEFT JOIN external_subscriptions sub
           ON sub.source_id = es.id AND sub.subscriber_id = $1
        WHERE es.protocol = $2::external_protocol
          AND es.source_uri = $3
        LIMIT 1`,
      [viewerId, xa.protocol, followUri],
    );
    const subId = subRows[0]?.sub_id ?? null;
    const sourceId = subRows[0]?.source_id ?? null;
    linkSourceId = sourceId;
    followTarget = {
      type: "source",
      id: subId ?? followUri,
      isFollowing: subId !== null,
      protocol: xa.protocol,
      sourceUri: followUri,
      sourceId,
    };
  }

  // Cross-source identity links for this author (Slice 8 P2/P3): the viewer's
  // own `user_asserted` rows PLUS global automated links (owner NULL — P3
  // detection) touching the author's backing source, minus any pair the viewer
  // has tombstoned (`user_unlinked`). The OTHER side of each pair is the linked
  // identity, surfaced as an unlinkable chip; `detected` distinguishes a global
  // link (unlink ⇒ tombstone) from the viewer's own (unlink ⇒ delete). Only
  // computable once source_a exists; empty otherwise.
  let linkedSources: AuthorCardResponse["linkedSources"];
  if (linkSourceId) {
    const { rows: linkRows } = await pool.query<{
      link_id: string;
      source_id: string;
      protocol: string;
      source_uri: string;
      display_name: string | null;
      detected: boolean;
    }>(
      `SELECT l.id AS link_id,
              os.id AS source_id, os.protocol::text AS protocol,
              os.source_uri, os.display_name,
              (l.owner_id IS NULL) AS detected
         FROM external_identity_links l
         JOIN external_sources os
           ON os.id = CASE WHEN l.source_a_id = $2 THEN l.source_b_id
                           ELSE l.source_a_id END
        WHERE (l.source_a_id = $2 OR l.source_b_id = $2)
          AND l.link_type <> 'user_unlinked'
          AND (l.owner_id = $1 OR l.owner_id IS NULL)
          -- Subtract pairs the viewer has tombstoned (the negative override).
          AND NOT EXISTS (
            SELECT 1 FROM external_identity_links t
             WHERE t.link_type = 'user_unlinked'
               AND t.owner_id = $1
               AND t.source_a_id = l.source_a_id
               AND t.source_b_id = l.source_b_id
          )
        ORDER BY (l.owner_id IS NULL), l.created_at`,
      [viewerId, linkSourceId],
    );
    if (linkRows.length > 0) {
      // A pair can carry both the viewer's own assertion and a global detected
      // link; ORDER puts own first, so keep the first chip per linked source.
      const seen = new Set<string>();
      const chips = linkRows
        .filter((r) => !seen.has(r.source_id) && seen.add(r.source_id))
        .map((r) => ({
          linkId: r.link_id,
          protocol: r.protocol,
          sourceUri: r.source_uri,
          displayName: r.display_name ?? undefined,
          sourceId: r.source_id,
          detected: r.detected,
        }));
      if (chips.length > 0) linkedSources = chips;
    }
  }

  // Stored fields are the always-present base; live origin data overlays them.
  // profilePath is the internal constructed-profile route (the display-name link);
  // externalUrl is the origin-platform profile page (the @handle link).
  const base: AuthorCardResponse = {
    tier: xa.tier,
    displayName: xa.display_name ?? undefined,
    handle: xa.handle ?? undefined,
    avatarUrl: xa.avatar ?? undefined,
    // Persisted live-profile fields (migration 117) — shown even when a fresh
    // live fetch isn't run/available, so the failure path keeps last-known data
    // rather than dropping the bio. Overwritten below when we re-fetch.
    bio: xa.bio ?? undefined,
    website: xa.website ?? undefined,
    lightningAddress: xa.lightning_address ?? undefined,
    sourceProtocol: xa.protocol,
    profilePath: `/author/${xa.id}`,
    externalUrl: buildExternalProfileUrl(xa.protocol, {
      handle: xa.handle,
      handleUri: xa.handle_uri,
      stableHandle: xa.stable_handle,
    }),
    followTarget,
    linkedSources,
  };

  if (xa.protocol === "atproto") {
    const actor = xa.handle_uri ?? xa.stable_handle; // DID
    const profile = await fetchBlueskyProfile(actor);
    if (profile) {
      return {
        ...base,
        displayName: profile.displayName ?? profile.handle ?? base.displayName,
        handle: profile.handle ?? base.handle,
        avatarUrl: profile.avatar ?? base.avatarUrl,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followsCount,
        postCount: profile.postsCount,
        // Live handle yields the prettier bsky.app/profile/<handle> URL.
        externalUrl: buildExternalProfileUrl("atproto", {
          handle: profile.handle,
          handleUri: xa.handle_uri,
          stableHandle: xa.stable_handle,
        }),
      };
    }
    return { ...base, partial: true };
  }

  if (xa.protocol === "activitypub") {
    const actor = xa.handle_uri ?? xa.stable_handle; // actor URI
    const profile = await fetchAPProfile(actor, rep?.source_item_uri ?? actor);
    if (profile) {
      return {
        ...base,
        displayName: profile.displayName ?? base.displayName,
        handle: profile.handle ?? base.handle,
        avatarUrl: profile.avatar ?? base.avatarUrl,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followingCount,
        postCount: profile.postsCount,
        partial: profile.partial,
      };
    }
    return { ...base, partial: true };
  }

  if (xa.protocol === "nostr_external") {
    // Nostr has no profile REST API, but kind-0 metadata is reachable on the
    // relay graph. Read it through live (source relay hints first, then the
    // broad fallbacks) so the hover bio shows the real bio / verified handle /
    // homepage / lightning address rather than just name + avatar. Follower /
    // post counts aren't cheaply countable on Nostr, so stats stay absent
    // (§4.4 "no stats available ⇒ show no stats").
    //
    // A successful fetch is persisted to external_authors (migration 117) and
    // served straight from the DB until it goes stale, so we don't pay a
    // multi-second relay round-trip on every cache miss. `base` already carries
    // the stored bio/website/lightning fields, so the fresh path needs no fetch.
    const fresh =
      xa.profile_fetched_at != null &&
      Date.now() - xa.profile_fetched_at.getTime() < LIVE_PROFILE_TTL_MS;
    if (fresh) return base;

    let hintRelays: string[] = [];
    if (rep?.source_id) {
      const { rows } = await pool.query<{ relay_urls: string[] | null }>(
        `SELECT relay_urls FROM external_sources WHERE id = $1`,
        [rep.source_id],
      );
      hintRelays = rows[0]?.relay_urls ?? [];
    }
    const profile = await fetchNostrAuthorProfile(xa.stable_handle, hintRelays);
    // Fetch failed/empty — keep whatever was last persisted (already in base).
    if (!profile) return base;

    // Persist the snapshot. name/handle/avatar COALESCE so a missing live field
    // doesn't blank an existing stored one; bio/website/lud reflect the current
    // kind-0 verbatim (a cleared field clears here too).
    await pool
      .query(
        `UPDATE external_authors
            SET display_name      = COALESCE(NULLIF($2, ''), display_name),
                handle            = COALESCE(NULLIF($3, ''), handle),
                avatar            = COALESCE(NULLIF($4, ''), avatar),
                bio               = $5,
                website           = $6,
                lightning_address = $7,
                profile_fetched_at = now(),
                last_seen_at      = now()
          WHERE id = $1`,
        [
          xa.id,
          profile.name ?? null,
          profile.nip05 ?? null,
          profile.picture ?? null,
          profile.about ?? null,
          profile.website ?? null,
          profile.lud16 ?? null,
        ],
      )
      .catch((err) =>
        logger.warn({ err, authorId: xa.id }, "live-profile persist failed"),
      );

    return {
      ...base,
      // base.externalUrl (njump, derived from the pubkey) is already correct —
      // the @handle still routes there; only its label gains the nip05.
      displayName: profile.name ?? base.displayName,
      handle: profile.nip05 ?? base.handle,
      avatarUrl: profile.picture ?? base.avatarUrl,
      bio: profile.about ?? base.bio,
      website: profile.website ?? base.website,
      lightningAddress: profile.lud16 ?? base.lightningAddress,
    };
  }

  return base;
}

export async function authorRoutes(app: FastifyInstance) {
  // GET /author/:authorId/profile — hover modal + profile header.
  app.get<{ Params: { authorId: string } }>(
    "/author/:authorId/profile",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      const viewerId = req.session!.sub;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }

      try {
        const xa = await loadExternalAuthor(authorId);
        if (xa) {
          return reply.send(await resolveExternalAuthorById(xa, viewerId));
        }
        if (await isNativeAccount(authorId)) {
          return reply.send(await resolveNativeAuthor(authorId, viewerId));
        }
        return reply.status(404).send({ error: "Author not found" });
      } catch (err) {
        logger.error({ err, authorId }, "Author profile fetch failed");
        return reply.status(500).send({ error: "Author profile fetch failed" });
      }
    },
  );

  // GET /author/:authorId/posts — chronological log, full-view Post[] (§9).
  //
  // ?kind=article|note narrows the native log to one item_type (the native
  // profile's Work / Social tabs consume it that way). Ignored for external
  // authors (no article/note distinction on the firehose).
  app.get<{
    Params: { authorId: string };
    Querystring: { cursor?: string; limit?: string; kind?: string };
  }>(
    "/author/:authorId/posts",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }

      const cursor = parseCursor(req.query.cursor);
      const limit = Math.min(
        parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
        MAX_LIMIT,
      );
      const kind =
        req.query.kind === "article" || req.query.kind === "note"
          ? req.query.kind
          : null;

      try {
        // id-space probe → the author filter. external_author_id aggregates the
        // author across every source; native filters by author_id.
        const xa = await loadExternalAuthor(authorId);
        let authorFilter: string;
        let hydrating = false;
        if (xa) {
          authorFilter = "fi.external_author_id = $1";
          // §3.1 — profile-view timeline hydration: first page only, whenever
          // the TTL guard is clear (not only when the log is empty — a stale
          // cache should refresh on view; the guard bounds cost). Background,
          // never awaited: the client refetches once shortly after.
          if (!cursor) {
            const followUri = authorFollowUri(xa);
            if (followUri && willHydrateAuthorTimeline(xa.id, xa.protocol)) {
              hydrating = true;
              void hydrateAuthorTimeline({
                authorId: xa.id,
                protocol: xa.protocol,
                followUri,
                stableHandle: xa.stable_handle,
              });
            }
          }
        } else if (await isNativeAccount(authorId)) {
          authorFilter = kind
            ? `fi.author_id = $1 AND fi.item_type = '${kind}'`
            : "fi.author_id = $1 AND fi.item_type IN ('article', 'note')";
        } else {
          return reply.status(404).send({ error: "Author not found" });
        }

        const cursorClause = cursor
          ? `AND (fi.published_at, fi.id) < (to_timestamp($3), $4::uuid)`
          : "";
        const params: any[] = cursor
          ? [authorId, limit, cursor.ts, cursor.id]
          : [authorId, limit];

        const result = await pool.query<any>(
          `
          SELECT ${FEED_SELECT}${POST_SELECT},
            -- Fractional epoch for the cursor (M13) — published_at_epoch is
            -- whole seconds, but the ORDER BY / to_timestamp() filter are
            -- full-precision, so a whole-second cursor skips/duplicates rows
            -- sharing a second.
            EXTRACT(EPOCH FROM fi.published_at) AS published_at_secs
          FROM feed_items fi
          ${FEED_JOINS}
          ${POST_JOINS}
          WHERE fi.deleted_at IS NULL
            AND ${authorFilter}
            AND ${AUTHOR_POSTS_CONTEXT_FILTER}
            ${cursorClause}
          ORDER BY fi.published_at DESC, fi.id DESC
          LIMIT $2
          `,
          params,
        );

        const items = result.rows.map(feedItemToPost);
        // Only hand out a cursor when the page was full — a short page is the
        // last page, so emitting one there would cost the client one extra
        // round-trip that returns nothing.
        const lastRow =
          result.rows.length === limit
            ? result.rows[result.rows.length - 1]
            : undefined;
        const nextCursor = lastRow
          ? encodeTsIdCursor(lastRow.published_at_secs, lastRow.fi_id)
          : undefined;

        return reply.send({
          items,
          nextCursor,
          ...(hydrating ? { hydrating: true } : {}),
        });
      } catch (err) {
        logger.error({ err, authorId }, "Author posts fetch failed");
        return reply.status(500).send({ error: "Author posts fetch failed" });
      }
    },
  );

  // GET /author/:authorId/replies — the native author's replies (kind-1111
  // comments) as full-view Post[] (§2.2 via commentToPost). Comments live in the
  // `comments` table, NOT feed_items, so they're outside /posts; this is their
  // chronological log. Each reply carries the deterministic derived post_id, so a
  // PostCard expands it into the unified thread (parent context above) exactly as
  // the workspace does. Native-only — external authors have no all.haus comments.
  app.get<{
    Params: { authorId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/author/:authorId/replies",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { authorId } = req.params;
      if (!UUID_RE.test(authorId)) {
        return reply.status(400).send({ error: "Invalid author id" });
      }
      if (!(await isNativeAccount(authorId))) {
        // External authors have no native comments; empty log (not a 404 — the
        // identity is valid, it just has no replies on all.haus).
        return reply.send({ items: [], nextCursor: undefined });
      }

      const cursor = parseCursor(req.query.cursor);
      const limit = Math.min(
        parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
        MAX_LIMIT,
      );

      try {
        const cursorClause = cursor
          ? `AND (c.published_at, c.id) < (to_timestamp($3), $4::uuid)`
          : "";
        const params: any[] = cursor
          ? [authorId, limit, cursor.ts, cursor.id]
          : [authorId, limit];

        // root_post_id is the comment's root THING (derived from its
        // target_event_id) — commentToPost's rootPostId fallback for inReplyTo.
        const result = await pool.query<any>(
          `
          SELECT c.id,
                 feed_items_derive_post_id('nostr', c.nostr_event_id) AS derived_post_id,
                 c.nostr_event_id,
                 c.parent_comment_id,
                 feed_items_derive_post_id('nostr', p.nostr_event_id) AS parent_post_id,
                 feed_items_derive_post_id('nostr', c.target_event_id) AS root_post_id,
                 c.content,
                 EXTRACT(EPOCH FROM c.published_at)::bigint AS published_at_epoch,
                 -- Fractional epoch for the cursor only (M13); published_at_epoch
                 -- stays whole-seconds for display.
                 EXTRACT(EPOCH FROM c.published_at) AS published_at_secs,
                 c.deleted_at,
                 c.author_id,
                 acc.display_name AS acc_display_name,
                 acc.username AS acc_username,
                 acc.avatar_blossom_url AS acc_avatar,
                 acc.nostr_pubkey AS nostr_pubkey,
                 tl.pip_status AS pip_status,
                 vt.upvote_count AS vt_up, vt.downvote_count AS vt_down
            FROM comments c
            JOIN accounts acc ON acc.id = c.author_id
            LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
            LEFT JOIN comments p ON p.id = c.parent_comment_id
            LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = c.nostr_event_id
           WHERE c.author_id = $1
             AND c.deleted_at IS NULL
             ${cursorClause}
           ORDER BY c.published_at DESC, c.id DESC
           LIMIT $2
          `,
          params,
        );

        const items = result.rows.map((c) =>
          commentToPost(c, c.root_post_id, new Set<string>()),
        );
        const lastRow =
          result.rows.length === limit
            ? result.rows[result.rows.length - 1]
            : undefined;
        const nextCursor = lastRow
          ? encodeTsIdCursor(lastRow.published_at_secs, lastRow.id)
          : undefined;

        return reply.send({ items, nextCursor });
      } catch (err) {
        logger.error({ err, authorId }, "Author replies fetch failed");
        return reply.status(500).send({ error: "Author replies fetch failed" });
      }
    },
  );
}
