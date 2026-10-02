import { randomUUID } from "node:crypto";
import { nip19 } from "nostr-tools";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  getProfile as atprotoGetProfile,
  resolveHandle as atprotoResolveHandle,
  searchActors as atprotoSearchActors,
  extractFromBskyUrl,
  isDid as isAtprotoDid,
} from "./atproto-resolve.js";
import {
  resolveWebFinger,
  fetchActorProfile,
  extractFromMastodonUrl,
  extractFromThreadiverseUrl,
} from "./activitypub-resolve.js";
import { searchCatalog } from "./discovery-catalog.js";
import { searchApAccounts } from "./ap-account-search.js";
import {
  fetchNostrProfile,
  searchNostrProfiles,
} from "./nostr-search.js";
import {
  mergeMatches,
  type ResolveContext,
  type ResolverMatch,
} from "./resolver-merge.js";
import { isUuid } from "./request-inputs.js";

// Match/context types live in resolver-merge.ts (§8.5 decomposition);
// re-exported for existing callers (routes/resolve.ts).
export type { ResolveContext };

// =============================================================================
// Universal Resolver
//
// Takes an arbitrary string — whatever the user has — and resolves it to one
// or more candidate identities: a native all.haus account, an external source
// (for subscription), or both.
//
// Per ADR §V.5: input classification is deterministic, not probabilistic.
// Supported: URLs (RSS discovery), platform usernames, npub/nprofile, hex
// pubkeys, NIP-05, free-text search, and — via Phase-B async chains backed by
// resolveAtproto / resolveActivityPubHandle / resolveActivityPubByActor —
// Bluesky handles/DIDs and fediverse handles.
// =============================================================================

type InputType =
  | "url"
  | "npub"
  | "nprofile"
  | "hex_pubkey"
  | "did"
  | "bluesky_handle"
  | "fediverse_handle"
  | "ambiguous_at"
  | "dotted_host"
  | "platform_username"
  | "free_text";

interface ResolverResult {
  inputType: InputType;
  matches: ResolverMatch[];
  // Phase A returns 'complete' immediately when there is no async work; otherwise
  // 'pending' until resolveAsync overwrites the row with 'complete'. Lets the
  // poll caller distinguish "still running" from "done, no matches" without
  // inferring from pendingResolutions array length.
  status?: "pending" | "complete";
  error?: string;
  requestId?: string;
  pendingResolutions?: string[];
}

// Phase B results are stored in `resolver_async_results` (migration 061) so
// the initial resolve and the subsequent poll can land on different gateway
// replicas. Each row is bound to the initiator so a leaked request_id can't
// be used by another account to read someone else's lookup output.
const ASYNC_TTL_MS = 60_000;

export async function getAsyncResult(
  requestId: string,
  initiatorId: string,
): Promise<ResolverResult | null> {
  // A malformed id reaches `$1` as a uuid cast and raises, so it is refused
  // here rather than becoming a 500. The old guard was `[0-9a-f-]{36}`, which
  // accepts 36 hyphens: the right length, the right character class, and still
  // `invalid input syntax for type uuid`.
  if (!isUuid(requestId)) return null;
  const { rows } = await pool.query<{ result: ResolverResult }>(
    `SELECT result FROM resolver_async_results
      WHERE request_id = $1 AND initiator_id = $2 AND expires_at > now()`,
    [requestId, initiatorId],
  );
  if (rows.length === 0) return null;
  return rows[0].result;
}

// Cap per-initiator rows so a spammy client can't bloat the table between
// the 5-min prune cycles. 100 is ~100× the normal concurrent-lookup working
// set; anything above that is either abuse or a leaking client.
const MAX_ROWS_PER_INITIATOR = 100;

async function storeAsyncResult(
  requestId: string,
  initiatorId: string,
  result: ResolverResult,
): Promise<void> {
  await pool.query(
    `INSERT INTO resolver_async_results (request_id, initiator_id, result, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4))
     ON CONFLICT (request_id) DO UPDATE SET
       result = EXCLUDED.result,
       expires_at = EXCLUDED.expires_at`,
    [requestId, initiatorId, JSON.stringify(result), ASYNC_TTL_MS / 1000],
  );

  // Trim older rows for this initiator beyond the cap. OFFSET N LIMIT 1
  // returns the Nth-newest row's created_at; rows older than that are
  // dropped. Uses the (initiator_id, created_at DESC) index from
  // migration 064. Best-effort — a failure here shouldn't surface to the
  // resolve caller.
  try {
    await pool.query(
      `DELETE FROM resolver_async_results
        WHERE initiator_id = $1
          AND created_at < (
            SELECT created_at
              FROM resolver_async_results
             WHERE initiator_id = $1
             ORDER BY created_at DESC
             OFFSET $2 LIMIT 1
          )`,
      [initiatorId, MAX_ROWS_PER_INITIATOR],
    );
  } catch (err) {
    logger.warn(
      { err, initiatorId },
      "Failed to enforce resolver_async_results per-initiator cap",
    );
  }
}

// =============================================================================
// Input classification (§V.5.1)
// =============================================================================

const HEX_64 = /^[0-9a-f]{64}$/i;
// AT Protocol handles in the official Bluesky namespace — `.bsky.social`,
// `.bsky.team`. Custom-domain handles (e.g. `paul.gilkes.me`) look identical
// to RSS host names, so we only fast-path the suffixes we know are Bluesky;
// everything else falls into `dotted_host` which tries URL/RSS discovery
// first and atproto only as a fallback. Leading @ is optional.
const BLUESKY_HANDLE = /^@?[\w-]+\.bsky\.(social|team)$/i;
// Generic dotted hostname-shaped string with no scheme — could be an RSS
// host (most common), a custom-domain Bluesky handle, or just a domain. Phase
// B tries URL discovery first, then atproto.
const DOTTED_HOST = /^[\w-]+(\.[\w-]+)+$/;
const FEDIVERSE_HANDLE = /^@[\w.+-]+@[\w.-]+\.[\w.]+$/; // @user@instance.tld
const AMBIGUOUS_AT = /^[\w.+-]+@[\w.-]+\.[\w.]+$/; // user@domain.tld (no @ prefix)
const PLATFORM_USERNAME = /^[\w]+$/; // alphanumeric, no @, no .

export function classifyInput(query: string): InputType {
  const trimmed = query.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://"))
    return "url";
  if (trimmed.startsWith("npub1")) return "npub";
  if (trimmed.startsWith("nprofile1")) return "nprofile";
  if (HEX_64.test(trimmed)) return "hex_pubkey";
  if (trimmed.startsWith("did:plc:") || trimmed.startsWith("did:web:"))
    return "did";
  if (FEDIVERSE_HANDLE.test(trimmed)) return "fediverse_handle";
  if (AMBIGUOUS_AT.test(trimmed)) return "ambiguous_at";
  if (BLUESKY_HANDLE.test(trimmed)) return "bluesky_handle";
  if (DOTTED_HOST.test(trimmed)) return "dotted_host";
  if (PLATFORM_USERNAME.test(trimmed) && trimmed.length >= 2)
    return "platform_username";
  // @username (single @ prefix, no domain) — strip the @ and treat as platform username
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : "";
  if (stripped && PLATFORM_USERNAME.test(stripped) && stripped.length >= 2)
    return "platform_username";

  return "free_text";
}

// =============================================================================
// Phase A — instant local classification + local lookups (< 50ms)
// =============================================================================

export async function resolve(
  query: string,
  context: ResolveContext = "general",
  initiatorId?: string,
  // Discovery fallback (§V.5.8) is opt-in per request: only an explicit submit
  // sets this, never the debounced-keystroke typeahead path. Default false so
  // every existing caller behaves exactly as before.
  discover = false,
): Promise<ResolverResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { inputType: "free_text", matches: [], error: "Empty query" };
  }

  const inputType = classifyInput(trimmed);
  const matches: ResolverMatch[] = [];
  const pendingResolutions: string[] = [];
  // Phase B external chains are pointless for surfaces that only consume
  // native_account matches (publication invite, DM start). Skipping them in
  // Phase A means we don't even open a polling request.
  const skipExternal = context === "invite" || context === "dm";

  // Strip leading @ for username lookups so @someuser resolves like someuser
  const usernameQuery = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  switch (inputType) {
    case "platform_username": {
      const account = await lookupByUsername(usernameQuery);
      if (account) matches.push(account);
      // An exact native hit short-circuits the external world EXCEPT in
      // subscribe context: a username there is often a publication name a
      // native account happens to squat ("guardian"), and an exact native
      // match and subscribable external candidates aren't mutually exclusive —
      // the exact hit still ranks first (exact > probable > speculative).
      // import context gets the same treatment for the inverse reason: it
      // consumes only external sources (a follow-graph read needs the remote
      // account, FOLLOW-GRAPH-IMPORT-ADR §7.4), so a native squatter must not
      // short-circuit the external world. invite/dm/general keep the
      // short-circuit (RESOLVER-DISCOVERY-ADR squatter amendment, 2026-07-10).
      // Fuzzy natives only when there was no exact native hit.
      const runExternal =
        !skipExternal &&
        (!account || context === "subscribe" || context === "import");
      if (!account || runExternal) {
        // Fuzzy native + known-world external (RESOLVER-DISCOVERY-ADR §4) in
        // parallel — both local, both Phase A. invite/dm stay native-only.
        const [fuzzy, knownWorld] = await Promise.all([
          account ? [] : searchPlatform(usernameQuery),
          runExternal ? searchKnownWorld(usernameQuery) : [],
        ]);
        matches.push(...fuzzy, ...knownWorld);
        // External discovery (§V.5.8) so a bare name like "Guardian" can
        // surface subscribable sources.
        if (discover && runExternal) {
          pendingResolutions.push(
            "catalog_discovery",
            "bluesky_discovery",
            "nostr_discovery",
            "activitypub_discovery",
          );
        }
      }
      break;
    }

    case "npub": {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === "npub") {
          const hexPubkey = decoded.data;
          const account = await lookupByPubkey(hexPubkey);
          if (account) matches.push(account);
          // Also offer as external Nostr source
          matches.push({
            type: "external_source",
            confidence: "exact",
            externalSource: {
              protocol: "nostr_external",
              sourceUri: hexPubkey,
            },
          });
          if (!skipExternal) pendingResolutions.push("nostr_profile");
        }
      } catch {
        return { inputType, matches: [], error: "Invalid npub encoding" };
      }
      break;
    }

    case "nprofile": {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === "nprofile") {
          const data = decoded.data as { pubkey: string; relays?: string[] };
          const relayUrls = data.relays?.slice(0, 5);
          const account = await lookupByPubkey(data.pubkey);
          if (account) matches.push(account);
          matches.push({
            type: "external_source",
            confidence: "exact",
            externalSource: {
              protocol: "nostr_external",
              sourceUri: data.pubkey,
              relayUrls,
            },
          });
          if (!skipExternal) pendingResolutions.push("nostr_profile");
        }
      } catch {
        return { inputType, matches: [], error: "Invalid nprofile encoding" };
      }
      break;
    }

    case "hex_pubkey": {
      const account = await lookupByPubkey(trimmed);
      if (account) matches.push(account);
      matches.push({
        type: "external_source",
        confidence: "exact",
        externalSource: {
          protocol: "nostr_external",
          sourceUri: trimmed,
        },
      });
      if (!skipExternal) pendingResolutions.push("nostr_profile");
      break;
    }

    case "did": {
      if (!skipExternal) pendingResolutions.push("atproto_profile");
      break;
    }

    case "bluesky_handle": {
      if (!skipExternal) pendingResolutions.push("atproto_profile");
      break;
    }

    case "fediverse_handle": {
      if (!skipExternal) pendingResolutions.push("activitypub_profile");
      break;
    }

    case "url": {
      // URL resolution requires network I/O — do Phase A classification
      // and kick off Phase B async
      if (!skipExternal) pendingResolutions.push("url_resolution");
      break;
    }

    case "dotted_host": {
      // Could be an RSS host or a custom-domain Bluesky handle. Try URL
      // discovery first (most common); atproto probe runs in parallel as a
      // fallback so custom-domain handles still resolve.
      if (!skipExternal) {
        pendingResolutions.push("url_resolution");
        pendingResolutions.push("atproto_profile");
      }
      break;
    }

    case "ambiguous_at": {
      // Try email lookup locally (instant); NIP-05 + WebFinger are Phase B.
      // NIP-05 can find native accounts (via pubkey lookup) so it runs even
      // for invite/DM contexts; WebFinger only yields external.
      const account = await lookupByEmail(trimmed);
      if (account) matches.push(account);
      pendingResolutions.push("nip05_resolution");
      if (!skipExternal) pendingResolutions.push("webfinger_resolution");
      break;
    }

    case "free_text": {
      const [searchResults, knownWorld] = await Promise.all([
        searchPlatform(usernameQuery),
        skipExternal ? [] : searchKnownWorld(usernameQuery),
      ]);
      matches.push(...searchResults, ...knownWorld);
      // Free-text is never an exact identifier — if discovery is requested,
      // search the external world for candidates (§V.5.8).
      if (discover && !skipExternal) {
        pendingResolutions.push(
          "catalog_discovery",
          "bluesky_discovery",
          "nostr_discovery",
          "activitypub_discovery",
        );
      }
      break;
    }
  }

  // Phase B lookups require DB persistence (see getAsyncResult). Callers that
  // don't have an initiator can't start async work — skip the pending chain
  // and return only the Phase A matches.
  const requestId =
    pendingResolutions.length > 0 && initiatorId ? randomUUID() : undefined;

  // Every emitted match set passes through the merge step (§6.2/§6.3): here it
  // orders Phase A (e.g. probable known-world hits ahead of fuzzy natives in
  // subscribe context) before the seed row / sync return.
  const mergedMatches = mergeMatches([], matches, context);

  const result: ResolverResult = {
    inputType,
    matches: mergedMatches,
    status: requestId ? "pending" : "complete",
    requestId,
    pendingResolutions: requestId ? pendingResolutions : undefined,
  };

  if (requestId && initiatorId) {
    // Seed the initial partial result so a poll arriving before Phase B
    // completes still gets a meaningful response.
    await storeAsyncResult(requestId, initiatorId, { ...result }).catch(
      (err) => {
        logger.warn(
          { err, requestId },
          "Failed to seed resolver_async_results row",
        );
      },
    );

    // Fire-and-forget async Phase B
    resolveAsync(
      requestId,
      initiatorId,
      trimmed,
      inputType,
      mergedMatches,
      context,
      discover,
    ).catch((err) => {
      logger.warn({ err, requestId }, "Async resolution failed");
    });
  }

  return result;
}

// =============================================================================
// Phase B — async remote resolutions
// =============================================================================

// Per-chain failure isolation (§V.5.8): one chain throwing must never abort
// the other chains or leave the async row stuck 'pending' until TTL. The leaf
// resolvers are already fail-soft internally; this wrapper makes the guarantee
// structural at the orchestration seam, so a future chain that forgets an
// internal catch degrades to "no candidates from that chain", not a dead poll.
async function safeChain<T>(
  chain: string,
  work: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await work;
  } catch (err) {
    logger.warn({ err, chain }, "Resolver Phase B chain failed");
    return fallback;
  }
}

async function resolveAsync(
  requestId: string,
  initiatorId: string,
  query: string,
  inputType: InputType,
  existingMatches: ResolverMatch[],
  context: ResolveContext,
  discover = false,
): Promise<void> {
  // Every chain result folds in via mergeMatches (§6.3): alias dedupe,
  // bridge-collision drop, §6.2 re-sort. The read-merge-reassign is
  // synchronous inside each chain's continuation, so concurrent chains can't
  // lose updates; the storePartial closures read the current binding.
  let matches = mergeMatches([], existingMatches, context);
  // External Phase B chains (URL/RSS, atproto, activitypub) only ever produce
  // external_source / rss_feed matches. Surfaces that act on platform accounts
  // — invite a publication member, start a DM — can't use those, so skip the
  // network round-trip. Native lookups in Phase A still run (npub/email/
  // username probe accounts directly) so an npub typed into invite still
  // finds the platform account.
  const skipExternal = context === "invite" || context === "dm";

  if (inputType === "url" && !skipExternal) {
    const urlMatches = await safeChain("url_resolution", resolveUrl(query), []);
    matches = mergeMatches(matches, urlMatches, context);
  }

  if (inputType === "dotted_host" && !skipExternal) {
    // Run URL discovery and atproto probe concurrently. Store partial results
    // as each completes so a fast atproto hit (custom-domain Bluesky handle)
    // isn't held back by a slow URL/RSS probe on a complex site.
    const storePartial = async () => {
      await storeAsyncResult(requestId, initiatorId, {
        inputType,
        matches: [...matches],
        status: "pending",
        pendingResolutions: [],
      }).catch(() => {});
    };
    await Promise.all([
      safeChain("url_resolution", resolveUrl(`https://${query}`), []).then(
        async (urlMatches) => {
          if (urlMatches.length > 0) {
            matches = mergeMatches(matches, urlMatches, context);
            await storePartial();
          }
        },
      ),
      safeChain("atproto_profile", resolveAtproto(query), null).then(
        async (atprotoMatch) => {
          if (atprotoMatch) {
            matches = mergeMatches(matches, [atprotoMatch], context);
            await storePartial();
          }
        },
      ),
    ]);
  }

  if (inputType === "ambiguous_at") {
    const nip05Matches = await safeChain(
      "nip05_resolution",
      resolveNip05(query),
      [],
    );
    matches = mergeMatches(matches, nip05Matches, context);
    if (!skipExternal) {
      // Also try WebFinger — many fediverse accounts take the bare `user@host`
      // form (no @ prefix) and the ambiguous chain is the only place to catch
      // them. mergeMatches dedupes against any existing activitypub match.
      const apMatch = await safeChain(
        "webfinger_resolution",
        resolveActivityPubHandle(query),
        null,
      );
      if (apMatch) matches = mergeMatches(matches, [apMatch], context);
    }
  }

  if (inputType === "fediverse_handle" && !skipExternal) {
    const apMatch = await safeChain(
      "activitypub_profile",
      resolveActivityPubHandle(query),
      null,
    );
    if (apMatch) matches = mergeMatches(matches, [apMatch], context);
  }

  if (
    (inputType === "did" || inputType === "bluesky_handle") &&
    !skipExternal
  ) {
    const atprotoMatch = await safeChain(
      "atproto_profile",
      resolveAtproto(query),
      null,
    );
    if (atprotoMatch) matches = mergeMatches(matches, [atprotoMatch], context);
  }

  if (
    (inputType === "npub" ||
      inputType === "nprofile" ||
      inputType === "hex_pubkey") &&
    !skipExternal
  ) {
    // Enrich the nostr_external match (if any) with displayName/avatar from the
    // pubkey's kind 0 metadata. nprofile carries relay hints; npub/hex_pubkey
    // fall back to NOSTR_PROFILE_RELAYS.
    const target = matches.find(
      (m) => m.externalSource?.protocol === "nostr_external",
    );
    if (target?.externalSource) {
      const profile = await safeChain(
        "nostr_profile",
        fetchNostrProfile(
          target.externalSource.sourceUri,
          target.externalSource.relayUrls,
        ),
        null,
      );
      if (profile) {
        target.externalSource.displayName =
          profile.displayName ?? target.externalSource.displayName;
        target.externalSource.description =
          profile.about ?? target.externalSource.description;
        target.externalSource.avatar =
          profile.picture ?? target.externalSource.avatar;
      }
    }
  }

  // Discovery fallback (§V.5.8): a bare name the deterministic chains couldn't
  // resolve. Each branch returns speculative nominations — selecting one
  // re-enters the exact resolver to mint the real external_source. Gated
  // identically to the other external chains (invite/dm never discover) and
  // only when explicitly asked. Branches persist incrementally so cheap/precise
  // hits render before slow network branches return.
  if (
    discover &&
    !skipExternal &&
    (inputType === "free_text" || inputType === "platform_username")
  ) {
    const storeDiscoveryPartial = async () => {
      await storeAsyncResult(requestId, initiatorId, {
        inputType,
        matches: [...matches],
        status: "pending",
        pendingResolutions: [],
      }).catch(() => {});
    };

    // Branch 3 (curated catalog) is instant and zero-I/O — resolve it
    // synchronously and surface it first, so the head case ("Guardian")
    // renders without waiting on the network branches.
    const catalogMatches = discoverCatalog(query, matches);
    if (catalogMatches.length > 0) {
      matches = mergeMatches(matches, catalogMatches, context);
      await storeDiscoveryPartial();
    }

    // Branches 1 (Bluesky) + 2 (Nostr) + 6 (ActivityPub) do network I/O — run
    // concurrently and persist partials as each returns. Each dedupes against
    // its own protocol's existing matches, so concurrent pushes touch disjoint
    // key-spaces.
    await Promise.all([
      safeChain("bluesky_discovery", discoverBluesky(query, matches), []).then(
        async (candidates) => {
          if (candidates.length > 0) {
            matches = mergeMatches(matches, candidates, context);
            await storeDiscoveryPartial();
          }
        },
      ),
      safeChain("nostr_discovery", discoverNostr(query, matches), []).then(
        async (candidates) => {
          if (candidates.length > 0) {
            matches = mergeMatches(matches, candidates, context);
            await storeDiscoveryPartial();
          }
        },
      ),
      safeChain(
        "activitypub_discovery",
        discoverActivityPub(query, matches),
        [],
      ).then(async (candidates) => {
        if (candidates.length > 0) {
          matches = mergeMatches(matches, candidates, context);
          await storeDiscoveryPartial();
        }
      }),
    ]);
  }

  // Persist the fully-resolved result; overwrites the partial row seeded by resolve().
  await storeAsyncResult(requestId, initiatorId, {
    inputType,
    matches,
    status: "complete",
    pendingResolutions: [],
  });
}

// Bluesky actor search → speculative external_source matches. Dedupes against
// any atproto matches already present (by DID) so a candidate isn't offered
// twice. Caps at 5 per §V.5.8 (the searchActors limit already enforces this).
async function discoverBluesky(
  query: string,
  existing: ResolverMatch[],
): Promise<ResolverMatch[]> {
  const seen = new Set(
    existing
      .filter((m) => m.externalSource?.protocol === "atproto")
      .map((m) => m.externalSource!.sourceUri),
  );
  const profiles = await atprotoSearchActors(query, 5);
  const out: ResolverMatch[] = [];
  for (const p of profiles) {
    if (seen.has(p.did)) continue;
    seen.add(p.did);
    out.push({
      type: "external_source",
      confidence: "speculative",
      // Merge hint (§6.1): a *.ap.brid.gy handle marks a Bridgy Fed
      // fediverse→Bluesky mirror the merge step can collapse.
      handle: p.handle,
      externalSource: {
        protocol: "atproto",
        sourceUri: p.did,
        displayName: p.displayName ?? `@${p.handle}`,
        description: p.description,
        avatar: p.avatar,
      },
    });
  }
  return out;
}

// Curated catalog (§V.5.8, branch 3) → speculative rss_feed matches. Pure,
// instant, no I/O. Dedupes against any rss_feed matches already present by
// feed URL. Selecting one re-enters the exact resolver via its feedUrl.
function discoverCatalog(
  query: string,
  existing: ResolverMatch[],
): ResolverMatch[] {
  const seen = new Set(
    existing
      .filter((m) => m.type === "rss_feed" && m.rssFeed)
      .map((m) => m.rssFeed!.feedUrl),
  );
  const out: ResolverMatch[] = [];
  for (const c of searchCatalog(query, 5)) {
    if (seen.has(c.feedUrl)) continue;
    seen.add(c.feedUrl);
    out.push({
      type: "rss_feed",
      confidence: "speculative",
      rssFeed: {
        feedUrl: c.feedUrl,
        title: c.title,
        description: c.description,
      },
    });
  }
  return out;
}

// Nostr name search (§V.5.8, branch 2) → speculative nostr_external matches.
// Runs NIP-50 full-text search against a search relay and returns candidate
// pubkeys with their kind-0 metadata. Dedupes against any nostr_external
// matches already present (by hex pubkey). Selecting one re-enters the npub /
// hex_pubkey chain to mint the real external_source.
async function discoverNostr(
  query: string,
  existing: ResolverMatch[],
): Promise<ResolverMatch[]> {
  const seen = new Set(
    existing
      .filter((m) => m.externalSource?.protocol === "nostr_external")
      .map((m) => m.externalSource!.sourceUri),
  );
  const candidates = await searchNostrProfiles(query, 5);
  const out: ResolverMatch[] = [];
  for (const c of candidates) {
    if (seen.has(c.pubkey)) continue;
    seen.add(c.pubkey);
    // NIP-48 (§6.1): a kind-0 carrying ["proxy", <origin-id>, <protocol>] is a
    // bridged mirror whose origin key joins the merge collision set.
    // Best-effort — host patterns are the primary signal.
    const proxyTag = c.tags?.find(
      (t) =>
        t[0] === "proxy" &&
        typeof t[1] === "string" &&
        t[1] &&
        typeof t[2] === "string" &&
        t[2],
    );
    out.push({
      type: "external_source",
      confidence: "speculative",
      proxy: proxyTag ? { origin: proxyTag[1], protocol: proxyTag[2] } : undefined,
      externalSource: {
        protocol: "nostr_external",
        sourceUri: c.pubkey,
        displayName: c.displayName,
        description: c.about,
        avatar: c.picture,
      },
    });
  }
  return out;
}

// ActivityPub account search (RESOLVER-DISCOVERY-ADR §5, branch 6) →
// speculative activitypub matches. sourceUri is the canonical acct
// (user@domain) — a pick re-enters addSource, whose AP branch webfingers an
// acct shape to the actor URI (resolveApSourceUri, the §5.2 pick-path fix).
// Dedupes against existing activitypub matches on BOTH key-spaces, lowercased:
// canonical acct (this branch's own identity) and actor URI (known-world
// Phase A hits carry the actor URI as sourceUri; the provider surfaces each
// candidate's Account.uri) — known-world wins, it's 'probable'.
async function discoverActivityPub(
  query: string,
  existing: ResolverMatch[],
): Promise<ResolverMatch[]> {
  const seen = new Set<string>();
  for (const m of existing) {
    if (m.externalSource?.protocol === "activitypub") {
      seen.add(m.externalSource.sourceUri.toLowerCase());
    }
  }
  const candidates = await searchApAccounts(query, 5);
  const out: ResolverMatch[] = [];
  for (const c of candidates) {
    const acct = c.acct.toLowerCase();
    const actorUri = c.url?.toLowerCase();
    if (seen.has(acct) || (actorUri && seen.has(actorUri))) continue;
    seen.add(acct);
    if (actorUri) seen.add(actorUri);
    out.push({
      type: "external_source",
      confidence: "speculative",
      // Merge hint (§6.1): the actor URI is where bridge hosts (bsky.brid.gy,
      // mostr.pub) are detected — the acct alone can't carry a Bridgy DID.
      actorUrl: c.url,
      externalSource: {
        protocol: "activitypub",
        sourceUri: c.acct,
        displayName: c.displayName ?? `@${c.acct}`,
        description: c.note,
        avatar: c.avatar,
      },
    });
  }
  return out;
}

// =============================================================================
// URL resolution (§V.5.2)
// =============================================================================

async function resolveUrl(url: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = [];

  try {
    const parsed = new URL(url);

    // 1. Known social platform patterns
    const bskyIdent = extractFromBskyUrl(parsed);
    if (bskyIdent !== null) {
      const match = await resolveAtproto(bskyIdent);
      return match ? [match] : [];
    }

    const mastoHint = extractFromMastodonUrl(parsed);
    if (mastoHint) {
      const match = mastoHint.acct
        ? await resolveActivityPubHandle(mastoHint.acct)
        : mastoHint.actorUri
          ? await resolveActivityPubByActor(mastoHint.actorUri)
          : null;
      if (match) return [match];
      // Fall through to RSS discovery if AP resolution fails — the URL may
      // still be something we can subscribe to.
    }

    const threadiverseHint = extractFromThreadiverseUrl(parsed);
    if (threadiverseHint) {
      const match = await resolveActivityPubHandle(threadiverseHint.acct);
      if (match) return [match];
    }

    if (parsed.hostname === "twitter.com" || parsed.hostname === "x.com") {
      return []; // Not supported; frontend can show a message
    }

    // 2. Known content platforms with discoverable RSS
    const ytFeed = await resolveYouTubeChannel(parsed);
    if (ytFeed) return [ytFeed];

    const substackFeed = await resolveSubstackFeed(parsed);
    if (substackFeed) return [substackFeed];

    // 3. Try fetching as RSS/Atom directly
    const rssFeed = await tryRssFetch(url);
    if (rssFeed) {
      matches.push(rssFeed);
      return matches;
    }

    // 4. Try HTML link discovery
    const discovered = await discoverRssFromHtml(url);
    if (discovered) {
      matches.push(discovered);
      return matches;
    }

    // 5. Try well-known paths
    const wellKnown = await tryWellKnownPaths(parsed.origin);
    if (wellKnown) {
      matches.push(wellKnown);
      return matches;
    }
  } catch (err) {
    logger.warn({ url, err }, "URL resolution failed");
  }

  return matches;
}

async function tryRssFetch(url: string): Promise<ResolverMatch | null> {
  try {
    const response = await safeFetch(url, {
      headers: {
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html",
      },
    });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    const isXml =
      contentType.includes("xml") ||
      contentType.includes("rss") ||
      contentType.includes("atom");

    if (
      isXml ||
      response.text.trimStart().startsWith("<?xml") ||
      response.text.trimStart().startsWith("<rss") ||
      response.text.trimStart().startsWith("<feed")
    ) {
      // Parse to extract metadata
      const Parser = (await import("rss-parser")).default;
      const parser = new Parser({ timeout: 5000 });
      try {
        const feed = await parser.parseString(response.text);
        return {
          type: "rss_feed",
          confidence: "exact",
          rssFeed: {
            feedUrl: url,
            title: feed.title ?? undefined,
            description: feed.description ?? undefined,
          },
        };
      } catch {
        // Looked like XML but failed to parse as feed
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function discoverRssFromHtml(url: string): Promise<ResolverMatch | null> {
  try {
    const response = await safeFetch(url, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return null;

    // Look for <link rel="alternate" type="application/rss+xml"> or atom+xml
    const rssLink = extractFeedLink(response.text);
    if (!rssLink) return null;

    // Resolve relative URL
    const feedUrl = new URL(rssLink, url).toString();

    // Verify it's actually a feed
    return tryRssFetch(feedUrl);
  } catch {
    return null;
  }
}

function extractFeedLink(html: string): string | null {
  // Match <link> tags with rel="alternate" and RSS/Atom type
  const linkRegex = /<link[^>]*\srel=["']alternate["'][^>]*>/gi;
  const matches = html.match(linkRegex);
  if (!matches) return null;

  for (const tag of matches) {
    const typeMatch = tag.match(
      /type=["'](application\/(?:rss|atom)\+xml)["']/,
    );
    if (!typeMatch) continue;

    const hrefMatch = tag.match(/href=["']([^"']+)["']/);
    if (hrefMatch) return hrefMatch[1];
  }

  return null;
}

const WELL_KNOWN_PATHS = [
  "/feed",
  "/rss",
  "/atom.xml",
  "/feed.xml",
  "/index.xml",
  "/feed/rss",
  "/blog/feed",
];

// Per-origin memo so two users pasting the same URL don't trigger 14 hits to
// a dead host within the same window. ~5 minute TTL — long enough to cover
// debounce + retry, short enough that newly-published feeds appear without an
// admin restart.
const WELL_KNOWN_TTL_MS = 5 * 60_000;
const wellKnownCache = new Map<
  string,
  { expires: number; result: ResolverMatch | null }
>();

async function tryWellKnownPaths(
  origin: string,
): Promise<ResolverMatch | null> {
  const cached = wellKnownCache.get(origin);
  if (cached && cached.expires > Date.now()) {
    wellKnownCache.delete(origin);
    wellKnownCache.set(origin, cached);
    return cached.result;
  }

  // Probe all paths in parallel and pick the first hit by WELL_KNOWN_PATHS
  // order (so /feed wins over /rss when both exist). One concurrent burst
  // beats seven sequential round-trips on dead origins where every probe
  // pays the full timeout.
  const results = await Promise.all(
    WELL_KNOWN_PATHS.map((path) => tryRssFetch(origin + path)),
  );
  const hit = results.find((r) => r !== null) ?? null;

  wellKnownCache.set(origin, {
    expires: Date.now() + WELL_KNOWN_TTL_MS,
    result: hit,
  });
  // Cap the cache so a stream of garbage URLs can't grow it unbounded. 1000
  // origins × small payload = trivial memory.
  if (wellKnownCache.size > 1000) {
    const firstKey = wellKnownCache.keys().next().value;
    if (firstKey) wellKnownCache.delete(firstKey);
  }
  return hit;
}

// =============================================================================
// YouTube channel → RSS feed
//
// YouTube exposes a stable Atom feed per channel at
// /feeds/videos.xml?channel_id=UC... The channel ID is directly available in
// /channel/ URLs; for /@handle, /c/, and /user/ paths we fetch the page and
// extract it from the canonical link or embedded JSON.
// =============================================================================

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

async function resolveYouTubeChannel(
  parsed: URL,
): Promise<ResolverMatch | null> {
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  const channelIdMatch = parsed.pathname.match(/^\/channel\/(UC[\w-]+)/);
  if (channelIdMatch) {
    return tryRssFetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdMatch[1]}`,
    );
  }

  const needsPageFetch =
    /^\/@[\w.-]+\/?$|^\/c\/[\w.-]+\/?$|^\/user\/[\w.-]+\/?$/.test(
      parsed.pathname,
    );
  if (!needsPageFetch) return null;

  try {
    const response = await safeFetch(parsed.toString(), {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return null;

    const channelId =
      response.text.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1] ??
      response.text.match(/itemprop="channelId"\s+content="(UC[\w-]+)"/)?.[1] ??
      response.text.match(/"channelId"\s*:\s*"(UC[\w-]+)"/)?.[1];
    if (!channelId) return null;

    return tryRssFetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    );
  } catch {
    return null;
  }
}

// =============================================================================
// Substack → RSS feed
//
// Every Substack publication exposes /feed at its subdomain. Custom-domain
// Substacks are handled by the generic HTML link discovery path (they carry
// <link rel="alternate" type="application/rss+xml">).
// =============================================================================

async function resolveSubstackFeed(parsed: URL): Promise<ResolverMatch | null> {
  if (
    !parsed.hostname.endsWith(".substack.com") ||
    parsed.hostname === "substack.com"
  ) {
    return null;
  }

  return tryRssFetch(`${parsed.origin}/feed`);
}

// =============================================================================
// NIP-05 resolution
// =============================================================================

async function resolveNip05(identifier: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = [];
  const [name, domain] = identifier.split("@");
  if (!name || !domain) return matches;

  try {
    const response = await safeFetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { timeout: 5000 },
    );
    if (!response.ok) return matches;

    const data = JSON.parse(response.text);
    const pubkey = data?.names?.[name];
    if (typeof pubkey === "string" && HEX_64.test(pubkey)) {
      // Check if this is a platform account
      const account = await lookupByPubkey(pubkey);
      if (account) matches.push(account);

      // Also offer as external Nostr source. The relay list is a HINT and is
      // filtered and capped here the way the nprofile arm above is: it comes
      // off a third party's .well-known/nostr.json, which may list any number
      // of entries in any shape, and `POST /feeds/:id/sources` caps hints at 5
      // ws:// or wss:// URLs (MIRROR-AUDIT §2.11) — an unfiltered list would
      // hand the member a resolver match that then 400s when they add it.
      const relays = data?.relays?.[pubkey];
      const relayUrls = Array.isArray(relays)
        ? relays
            .filter(
              (r: unknown): r is string =>
                typeof r === "string" &&
                (r.startsWith("ws://") || r.startsWith("wss://")),
            )
            .slice(0, 5)
        : undefined;
      matches.push({
        type: "external_source",
        confidence: "exact",
        externalSource: {
          protocol: "nostr_external",
          sourceUri: pubkey,
          displayName: `${name}@${domain}`,
          relayUrls: relayUrls && relayUrls.length > 0 ? relayUrls : undefined,
        },
      });
    }
  } catch (err) {
    logger.warn({ identifier, err }, "NIP-05 resolution failed");
  }

  return matches;
}


// =============================================================================
// AT Protocol (Bluesky) resolution — DIDs, handles, bsky.app URLs all land
// here. We always end up with a DID as the canonical source_uri, plus
// profile metadata from the AppView.
// =============================================================================

async function resolveAtproto(
  identifier: string,
): Promise<ResolverMatch | null> {
  const trimmed = identifier.trim().replace(/^@/, "");
  if (!trimmed) return null;

  // Handles and DIDs both go through getProfile, which accepts either.
  const profile = await atprotoGetProfile(trimmed);
  if (profile) {
    return {
      type: "external_source",
      confidence: "exact",
      handle: profile.handle,
      externalSource: {
        protocol: "atproto",
        sourceUri: profile.did,
        displayName: profile.displayName ?? `@${profile.handle}`,
        description: profile.description,
        avatar: profile.avatar,
      },
    };
  }

  // getProfile failed. If we started with a handle, try resolveHandle as a
  // fallback — some accounts resolve but their profile endpoint 404s.
  if (!isAtprotoDid(trimmed)) {
    const did = await atprotoResolveHandle(trimmed);
    if (did) {
      return {
        type: "external_source",
        confidence: "probable",
        handle: trimmed,
        externalSource: {
          protocol: "atproto",
          sourceUri: did,
          displayName: `@${trimmed}`,
        },
      };
    }
  }

  return null;
}

// =============================================================================
// ActivityPub (fediverse/Mastodon) resolution
// =============================================================================

async function resolveActivityPubHandle(
  handle: string,
): Promise<ResolverMatch | null> {
  const actorUri = await resolveWebFinger(handle);
  if (!actorUri) return null;
  return resolveActivityPubByActor(actorUri);
}

async function resolveActivityPubByActor(
  actorUri: string,
): Promise<ResolverMatch | null> {
  const profile = await fetchActorProfile(actorUri);
  if (!profile) return null;
  return {
    type: "external_source",
    confidence: "exact",
    handle: profile.handle ?? undefined,
    externalSource: {
      protocol: "activitypub",
      sourceUri: profile.actorUri,
      displayName: profile.displayName ?? profile.handle ?? profile.actorUri,
      description: profile.description ?? undefined,
      avatar: profile.avatar ?? undefined,
    },
  };
}

// =============================================================================
// Local lookups
// =============================================================================

async function lookupByUsername(
  username: string,
): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE username = $1 AND status = 'active'`,
    [username],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    type: "native_account",
    confidence: "exact",
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  };
}

async function lookupByPubkey(
  hexPubkey: string,
): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE nostr_pubkey = $1 AND status = 'active'`,
    [hexPubkey],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    type: "native_account",
    confidence: "exact",
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  };
}

/**
 * Confirm that an email address belongs to a member, and name them — but only
 * where that member has said it may (MIRROR-AUDIT §3 *Security*, S16).
 *
 * Unqualified this was an email→account oracle: 30 tries a minute for any
 * member, which against a breach list binds real-world identities to the
 * pseudonyms this platform exists to let writers keep. It also contradicted a
 * rule the codebase had already written down one route over — `POST /auth/login`
 * answers identically whether or not the address has an account, saying so in a
 * comment.
 *
 * `discoverable_by_email` (migration 196) is the member's own answer, default
 * FALSE. Nothing else narrows: every other identifier the resolver accepts —
 * name, username, npub, handle, NIP-05 — is PUBLISHED, and searching by those is
 * untouched. This is only about the address somebody handed us to log in with.
 *
 * The predicate is in the WHERE clause rather than a check on the returned row,
 * so an opted-out account is indistinguishable here from an address with no
 * account at all: the two must produce the same silence, or the column buys
 * nothing.
 */
async function lookupByEmail(email: string): Promise<ResolverMatch | null> {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE email = $1 AND status = 'active'
       AND discoverable_by_email = TRUE`,
    [email],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    type: "native_account",
    confidence: "exact",
    account: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      avatar: row.avatar_blossom_url ?? undefined,
    },
  };
}

async function searchPlatform(query: string): Promise<ResolverMatch[]> {
  const matches: ResolverMatch[] = [];
  // Escape LIKE metacharacters so a `%` in user input isn't treated as wildcard.
  const escaped = query.replace(/[%_\\]/g, "\\$&");
  const pattern = `%${escaped}%`;

  // Search writers
  const { rows: writers } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    avatar_blossom_url: string | null;
  }>(
    `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE status = 'active'
       AND (username ILIKE $1 OR display_name ILIKE $1)
     ORDER BY
       CASE WHEN username ILIKE $2 THEN 0 ELSE 1 END,
       display_name
     LIMIT 5`,
    [pattern, escaped],
  );

  for (const row of writers) {
    matches.push({
      type: "native_account",
      confidence: "speculative",
      account: {
        id: row.id,
        username: row.username,
        displayName: row.display_name ?? row.username,
        avatar: row.avatar_blossom_url ?? undefined,
      },
    });
  }

  return matches;
}

// =============================================================================
// Known-world index (RESOLVER-DISCOVERY-ADR §4) — Phase A, synchronous.
//
// Fuzzy-matches the external identities ingest already holds: external_authors
// (minted by the identity trigger; tier-A/B only, so every hit has a real
// identity) and addSource-able external_sources. Zero network I/O — pg_trgm
// over migration-150 GIN indexes — so it runs next to searchPlatform and lands
// before any Phase B chain. Hits are verified-real identities we hold:
// 'probable' — stronger than a remote speculative guess, weaker than an exact
// identifier. Consent posture (ADR §8): reachable only as ranked candidates
// for a typed query ≥3 chars, capped; never enumerable.
// =============================================================================

const KNOWN_WORLD_LIMIT = 5;

async function searchKnownWorld(query: string): Promise<ResolverMatch[]> {
  // 1–2 char trigram scans are noise and an enumeration surface (ADR §8).
  const q = query.trim();
  if (q.length < 3) return [];

  // Both legs restricted to addSource-able protocols: email (and any future
  // non-subscribable protocol) sources exist but can't re-enter addSource.
  // Tier-A/B author identity is stable_handle (nostr hex pubkey / atproto DID /
  // AP actor URI) — all re-enter addSource verbatim; source identity is
  // source_uri. Over-fetch, then dedupe by (protocol, identity) below.
  //
  // A tier-C author (BYLINE-AND-PROVENANCE-ADR D3/D6, migration 183) is the
  // source-scoped rss/email byline, keyed `<source_id>#<name>` — a string
  // that must never reach addSource as a feed URL. Its hit is PROJECTED onto
  // its backing source (`external_authors.source_id`): typing a journalist's
  // name resolves to their paper, exactly as "you follow sources" says, and the
  // twin-dedupe below then collapses it onto the source row whenever both
  // match. The projection carries the source leg's own liveness filter, so a
  // byline cannot resurface a source that leg would hide.
  const { rows } = await pool.query<{
    protocol: "atproto" | "activitypub" | "rss" | "nostr_external";
    identity: string;
    display_name: string | null;
    handle: string | null;
    avatar: string | null;
    kind: "author" | "source";
  }>(
    `SELECT protocol, identity, display_name, handle, avatar, kind FROM (
       SELECT ea.protocol::text AS protocol,
              CASE WHEN ea.tier = 'C' THEN bs.source_uri ELSE ea.stable_handle END AS identity,
              CASE WHEN ea.tier = 'C' THEN bs.display_name ELSE ea.display_name END AS display_name,
              CASE WHEN ea.tier = 'C' THEN bs.handle ELSE ea.handle END AS handle,
              CASE WHEN ea.tier = 'C' THEN bs.avatar_url ELSE ea.avatar END AS avatar,
              'author' AS kind,
              GREATEST(similarity(ea.display_name, $1), similarity(ea.handle, $1)) AS score
         FROM external_authors ea
         LEFT JOIN external_sources bs
           ON ea.tier = 'C' AND bs.id = ea.source_id
          AND bs.is_active AND bs.orphaned_at IS NULL
        WHERE (ea.display_name % $1 OR ea.handle % $1)
          AND ea.protocol IN ('rss','nostr_external','atproto','activitypub')
          AND ea.deleted_at IS NULL
          -- A tier-C hit with no live backing source has nothing to project onto.
          AND (ea.tier <> 'C' OR bs.id IS NOT NULL)
       UNION ALL
       SELECT s.protocol::text, s.source_uri, s.display_name, s.handle,
              s.avatar_url, 'source',
              GREATEST(similarity(s.display_name, $1), similarity(s.handle, $1))
         FROM external_sources s
        WHERE (s.display_name % $1 OR s.handle % $1)
          AND s.is_active AND s.orphaned_at IS NULL
          AND s.protocol IN ('rss','nostr_external','atproto','activitypub')
          -- Author-level deletion tombstone (§8.3): a deleted author's source
          -- twin must not resurface them through the source leg.
          AND NOT EXISTS (
            SELECT 1 FROM external_authors ea
             WHERE ea.protocol = s.protocol
               AND ea.stable_handle = s.source_uri
               AND ea.deleted_at IS NOT NULL
          )
     ) candidates
     ORDER BY score DESC
     LIMIT $2`,
    [q, KNOWN_WORLD_LIMIT * 2],
  );

  // Dedupe author/source twins on (protocol, stable_handle = source_uri) —
  // the same equivalence identity-link-detect.ts joins on. Prefer the source
  // row (it carries subscription metadata); keep the better-scored position.
  type KnownWorldEntry = ResolverMatch & { kind: "author" | "source" };
  const byIdentity = new Map<string, KnownWorldEntry>();
  for (const row of rows) {
    const key = `${row.protocol}\u0000${row.identity}`;
    const existing = byIdentity.get(key);
    if (existing && !(row.kind === "source" && existing.kind === "author"))
      continue;
    const match: KnownWorldEntry = {
      type: "external_source",
      confidence: "probable",
      kind: row.kind,
      // Merge hint (§6.1): the acct / atproto handle keys the bridge-collision
      // space (an AP author's identity is the actor URI; its acct rides here).
      handle: row.handle ?? undefined,
      externalSource: {
        protocol: row.protocol,
        sourceUri: row.identity,
        displayName: row.display_name ?? row.handle ?? undefined,
        avatar: row.avatar ?? undefined,
      },
    };
    if (existing) {
      // Source row supersedes an author twin in place (order already set).
      existing.kind = match.kind;
      existing.handle = match.handle;
      existing.externalSource = match.externalSource;
    } else if (byIdentity.size < KNOWN_WORLD_LIMIT) {
      byIdentity.set(key, match);
    }
  }
  return [...byIdentity.values()].map(({ kind: _kind, ...m }) => m);
}
