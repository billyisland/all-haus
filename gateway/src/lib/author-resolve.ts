import { pool } from "@platform-pub/shared/db/client.js";
import { nip19 } from "nostr-tools";
import { getProfile } from "./atproto-resolve.js";
import { fetchActorProfile } from "./activitypub-resolve.js";
import { fetchMastodonAccountByActorUri } from "@platform-pub/shared/lib/mastodon-api.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { viewerRelation, type ViewerRelation } from "./blocks.js";

// =============================================================================
// Shared author resolution — UNIVERSAL-POST-ADR §4.4 / §9
//
// The live-origin profile fetchers + the native-author resolver, shared by:
//   • routes/author-card.ts (the legacy hover card, keyed on external_item_id)
//   • routes/author.ts       (Phase 4, keyed on the persistent external_authors.id
//                             — lets a profile aggregate one author across sources)
//
// One definition of "what an origin profile looks like", so the two hover paths
// never drift. No logic change from the original author-card.ts privates.
// =============================================================================

export interface AuthorCardResponse {
  tier: "A" | "B" | "C" | "D";
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  sourceName?: string;
  sourceDescription?: string;
  sourceUrl?: string;
  sourceProtocol?: string;
  // The author's self-declared homepage (Nostr kind-0 `website`). Rendered as a
  // link in the hover bio when present.
  website?: string;
  // Lightning address (Nostr kind-0 `lud16`) — the zap target. Surfaced in the
  // bio as a "⚡ name@host" affordance.
  lightningAddress?: string;
  // Internal all.haus profile route the display name links to (native → /:username,
  // external A/B → /author/:authorId). Absent ⇒ name renders as plain text.
  profilePath?: string;
  // The author's profile page on the ORIGIN platform (Bluesky / Fediverse / Nostr),
  // linked from the @handle. Absent ⇒ handle renders as plain text.
  externalUrl?: string;
  partial?: boolean;
  followTarget?: {
    type: "user" | "source";
    id: string;
    isFollowing: boolean;
    protocol?: string;
    sourceUri?: string;
    // external_sources.id, when the source already exists — lets the client
    // match per-feed membership (feed_sources.external_source_id) for the
    // feed-derived Follow affordance. Null when no source row exists yet.
    sourceId?: string | null;
  };
  // What the VIEWER has done to this author — present exactly when a
  // `followTarget` of type "user" is (a native account, a viewer, not
  // themselves), omitted otherwise. One direction only: `lib/blocks.ts`.
  viewerRelation?: ViewerRelation;
  // Slice 8 P2/P3 — cross-source identity links for THIS author, "the same
  // person, also over there", rendered as unlinkable chips. Two origins, merged:
  // the viewer's own `user_asserted` rows (P2) and global automated links the P3
  // detection task wrote (`detected: true`, bridge/cross_link/domain_match),
  // minus any pair the viewer has tombstoned. Unlinking your own assertion
  // deletes it; unlinking a detected link writes an owner-scoped tombstone.
  // Present only for an external author whose source row exists; absent otherwise.
  linkedSources?: {
    linkId: string;
    protocol: string;
    sourceUri: string;
    displayName?: string;
    sourceId: string;
    detected?: boolean;
  }[];
}

// PROFILE-PANE-REDESIGN-ADR D7 — the `verified` tier of a profile's identity
// row: a network_presence the SUBJECT proved (OAuth grant or key custody), as
// opposed to a link a reader or the platform inferred.
export interface ProfilePresence {
  protocol: string;
  handle?: string;
  /** The presence's profile page on the origin network, when derivable. */
  externalUrl?: string;
}

export function computeTier(
  protocol: string,
  authorUri: string | null,
): "A" | "B" | "C" | "D" {
  switch (protocol) {
    case "nostr_external":
    case "atproto":
      return "A";
    case "activitypub":
      return "B";
    case "rss":
    case "email":
      return authorUri ? "C" : "D";
    default:
      return "D";
  }
}

function extractDid(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.match(/did:(?:plc|web):[a-zA-Z0-9.:_-]+/)?.[0] ?? null;
}

// The author's profile page on the ORIGIN platform, for the @handle link.
// Returns undefined when no browser-resolvable URL can be derived (the handle
// then renders as plain text — the correct, safe default).
export function buildExternalProfileUrl(
  protocol: string,
  opts: {
    handle?: string | null;
    handleUri?: string | null;
    stableHandle?: string | null;
  },
): string | undefined {
  const { handle, handleUri, stableHandle } = opts;
  switch (protocol) {
    case "atproto": {
      // bsky.app/profile/<actor> resolves a human handle or a bare DID; prefer
      // the prettier handle, fall back to the DID embedded in the stored URI.
      const actor =
        handle?.replace(/^@/, "") ||
        extractDid(handleUri ?? stableHandle) ||
        stableHandle ||
        undefined;
      return actor ? `https://bsky.app/profile/${actor}` : undefined;
    }
    case "activitypub": {
      // The stored actor URI is itself a browser-resolvable profile page
      // (Mastodon and friends redirect /users/x → the public profile).
      const uri = handleUri ?? stableHandle ?? undefined;
      return uri && /^https:\/\//.test(uri) ? uri : undefined;
    }
    case "nostr_external": {
      // njump.me renders any nostr profile; encode the stored hex pubkey to npub.
      const hex = (stableHandle ?? "").match(/^[0-9a-f]{64}$/i)?.[0];
      if (!hex) return undefined;
      try {
        return `https://njump.me/${nip19.npubEncode(hex)}`;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

// The `verified` identity row for an account (PROFILE-PANE-REDESIGN-ADR D7).
//
// Three predicates, none of them optional:
//   • `lifecycle_state = 'active' AND is_valid` — mirrors what outbound dispatch
//     will actually target. A deprovisioned or invalid presence displayed as
//     "the subject proved it" is a false claim.
//   • `show_on_profile` — the consent gate (migration 182). A presence was
//     linked for cross-POSTING; display on an SSR'd share/SEO surface is a
//     separate disclosure and is opt-in, default off.
// Provenance is deliberately NOT filtered: linked / assisted / concierge all
// mean the subject proved it, and the tier is about how it was learned.
export async function resolveProfilePresences(
  accountId: string,
): Promise<ProfilePresence[]> {
  const { rows } = await pool.query<{
    protocol: string;
    external_id: string;
    handle: string | null;
    service_url: string | null;
  }>(
    `SELECT protocol::text AS protocol, external_id, handle, service_url
       FROM network_presences
      WHERE account_id = $1
        AND lifecycle_state = 'active'
        AND is_valid = TRUE
        AND show_on_profile = TRUE
      ORDER BY created_at`,
    [accountId],
  );
  return rows.map((r) => ({
    protocol: r.protocol,
    handle: r.handle ?? undefined,
    externalUrl: presenceProfileUrl(r.protocol, {
      handle: r.handle,
      externalId: r.external_id,
      serviceUrl: r.service_url,
    }),
  }));
}

// A presence's origin-platform profile URL. Deliberately a thin adapter onto
// buildExternalProfileUrl rather than a second builder: it only maps the
// presence row's column names onto the shapes that function already knows
// (atproto → handle or DID; activitypub → an https actor-ish URL, which the
// instance origin + local part gives us).
export function presenceProfileUrl(
  protocol: string,
  opts: {
    handle?: string | null;
    externalId?: string | null;
    serviceUrl?: string | null;
  },
): string | undefined {
  const { handle, externalId, serviceUrl } = opts;
  if (protocol === "activitypub") {
    const local = handle?.replace(/^@/, "").split("@")[0];
    return buildExternalProfileUrl("activitypub", {
      handleUri: serviceUrl && local ? `${serviceUrl}/@${local}` : null,
    });
  }
  return buildExternalProfileUrl(protocol, {
    handle,
    stableHandle: externalId,
  });
}

// Native all.haus author: account fields + live follow/article counts.
//
// `viewerId` is NULL for an anonymous reader (2026-09-02, the /author/:id
// widening). Everything above `followTarget` is a fact about the SUBJECT and is
// returned unchanged; `followTarget` is a fact about the RELATIONSHIP between
// two people, so with no viewer there is no relationship to state and the field
// is omitted rather than defaulted. `isFollowing: false` handed to somebody who
// is not logged in is a claim about a relationship that does not exist, and it
// would render as a live "Follow" button that cannot work.
export async function resolveNativeAuthor(
  userId: string,
  viewerId: string | null,
): Promise<AuthorCardResponse> {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    bio: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, bio, avatar_blossom_url
     FROM accounts WHERE id = $1 AND status = 'active'`,
    [userId],
  );

  if (rows.length === 0) {
    return { tier: "A", partial: true };
  }

  const account = rows[0];

  const [followerResult, followingResult, articleResult, isFollowingResult, relation] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM follows WHERE followee_id = $1`,
        [userId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM follows WHERE follower_id = $1`,
        [userId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM articles
       WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL`,
        [userId],
      ),
      // Skipped entirely for an anonymous reader — not run with a NULL param.
      // `follower_id = NULL` is never true, so it would answer `false`, which is
      // exactly the fabricated relationship the comment above refuses.
      viewerId
        ? pool.query<{ exists: boolean }>(
            `SELECT EXISTS(
        SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2
      ) AS exists`,
            [viewerId, userId],
          )
        : null,
      viewerId && viewerId !== userId ? viewerRelation(viewerId, userId) : null,
    ]);

  return {
    tier: "A",
    displayName: account.display_name ?? account.username,
    handle: account.username,
    avatarUrl: account.avatar_blossom_url ?? undefined,
    bio: account.bio ?? undefined,
    profilePath: `/${account.username}`,
    followerCount: parseInt(followerResult.rows[0].count, 10),
    followingCount: parseInt(followingResult.rows[0].count, 10),
    postCount: parseInt(articleResult.rows[0].count, 10),
    // No followTarget for the viewer's own account — POST /follows rejects
    // self-follows, so offering the button would only ever silently revert —
    // and none for an anonymous reader, who has no relationship to state.
    followTarget:
      !viewerId || viewerId === userId
        ? undefined
        : {
            type: "user",
            id: userId,
            isFollowing: isFollowingResult!.rows[0].exists,
          },
    ...(relation ? { viewerRelation: relation } : {}),
  };
}

// Bluesky (atproto) profile via the resolver. `actor` may be a DID, a handle,
// or a bsky.app /profile/<actor> URL — all accepted by getProfile.
export async function fetchBlueskyProfile(
  authorUri: string,
): Promise<Awaited<ReturnType<typeof getProfile>> | null> {
  try {
    const didMatch = authorUri.match(
      /(?:did:(?:plc|web):[A-Za-z0-9._:-]+)|(?:\/profile\/(did:[^/]+))/,
    );
    const handleMatch = authorUri.match(/\/profile\/([^/]+)/);
    const actor = didMatch?.[1] ?? didMatch?.[0] ?? handleMatch?.[1] ?? authorUri;
    if (!actor) return null;

    return await getProfile(actor);
  } catch (err) {
    logger.debug({ err, authorUri }, "Bluesky profile fetch failed");
    return null;
  }
}

// ActivityPub actor profile (+ Mastodon REST count fallback when the actor
// document omits follower/following counts).
export async function fetchAPProfile(authorUri: string): Promise<{
  displayName: string | null;
  handle: string | null;
  avatar: string | null;
  description: string | null;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  partial?: boolean;
} | null> {
  const actorProfile = await fetchActorProfile(authorUri);
  if (actorProfile) {
    if (
      actorProfile.followersCount != null ||
      actorProfile.followingCount != null
    ) {
      return actorProfile;
    }
    const restCounts = await fetchMastodonAccountCounts(authorUri);
    return { ...actorProfile, ...restCounts };
  }

  return null;
}

// The actor's own instance, addressed by whatever the actor URI carries
// (`/@name`, `/users/name`, `/ap/users/<id>`) through the one home — never a
// bare local part looked up on the ITEM's host, which names that host's own
// `name` rather than this author whenever the two hosts differ.
async function fetchMastodonAccountCounts(authorUri: string): Promise<{
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
}> {
  const account = await fetchMastodonAccountByActorUri(authorUri);
  if (!account) return {};
  return {
    followersCount: account.followersCount ?? undefined,
    followingCount: account.followingCount ?? undefined,
    postsCount: account.statusesCount ?? undefined,
  };
}
