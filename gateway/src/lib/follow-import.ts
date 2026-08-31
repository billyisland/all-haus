import { nip19 } from "nostr-tools";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { ADVISORY_LOCKS } from "@platform-pub/shared/lib/advisory-locks.js";
import {
  addSource,
  removeSource,
  type AddSourceInput,
} from "../routes/feeds/sources.js";
import { ENQUEUE_SPACING_MS } from "../routes/feeds/shared.js";
import { getProfile as atprotoGetProfile, getFollows } from "./atproto-resolve.js";
import {
  extractFromMastodonUrl,
  fetchActorProfile,
  fetchMastodonFollowing,
  isAcctShape,
  lookupMastodonAccount,
  resolveWebFinger,
  type MastodonApiAccount,
  type MastodonFollowingRead,
} from "./activitypub-resolve.js";
import { decryptJson } from "@platform-pub/shared/lib/crypto.js";
import { fetchNostrContacts } from "./nostr-relay.js";
import { getDefaultProfileRelays } from "./nostr-search.js";

// =============================================================================
// Follow-graph import engine (FOLLOW-GRAPH-IMPORT-ADR §6, §11.3).
//
// "Import my follows from <network>" = create a feed and add each followed
// account as a source, through the same addSource core every interactive add
// uses (D2 — the feed-derived-subscription invariant lives there). The remote
// graph is read ONCE at POST time and persisted on the follow_imports row
// (identities jsonb + cursor), so the sweep is restartable without re-reading
// a graph that may have changed under the run.
//
// The sweep is a gateway scheduler worker (advisory-locked, single-instance,
// same pattern as runDiscoverySweep). It loops batches WITHIN one invocation —
// at one batch per 60s tick a 1000-source import would take ~40 minutes.
//
// Everything ships dark behind the operator master switch
// FOLLOW_IMPORT_ENABLED=1 (house pattern, cf. DISCOVERY_PUBLISH_ENABLED).
// =============================================================================

export function followImportEnabled(): boolean {
  return process.env.FOLLOW_IMPORT_ENABLED === "1";
}

// §6.6 — the per-protocol brake the ADR anticipated for activitypub: 1c is
// gated on the §6.4 poller-fairness work having SOAKED under 1a/1b load (an
// AP import is the one that stresses the per-host outbox-poll budget), so AP
// import stays dark until the operator flips this in addition to the master
// switch.
export function followImportApEnabled(): boolean {
  return (
    followImportEnabled() &&
    process.env.FOLLOW_IMPORT_ACTIVITYPUB_ENABLED === "1"
  );
}

// Per-import cap (§6.5, v1: 1000, most-recently-followed first). Truncation is
// surfaced in the POST response and the run summary — never silent.
export const FOLLOW_IMPORT_CAP = 1000;

// §6.1 — progress-update granularity (NOT lock granularity: addSource takes
// its own short per-call advisory lock inside its own transaction).
const BATCH_SIZE = 25;

// §6.5 — an imported feed above this many sources defaults to sampled volume:
// weight 1.0 = volume step 3 (from the shared VOLUME_WEIGHTS scale) instead of
// the show-everything default 4.0. A 500-source feed at full volume is
// unreadable and would read as a bug.
const VOLUME_SAMPLE_THRESHOLD = 50;
const SAMPLED_WEIGHT = 1.0;

// §6.4b spacing — now shared with formula redemption, the second bulk-add
// path. Defined in routes/feeds/shared.ts, imported below.

// One resolved followed account, as persisted in follow_imports.identities.
// `uri` is the canonical stored form for the protocol (DID / hex pubkey /
// actor URI / feed URL) — addSource is called with skipProbe, so canonical
// form is this module's obligation (D6 amendment). Display metadata rides
// along because with the probe skipped nothing else backfills labels.
export interface ImportIdentity {
  uri: string;
  displayName?: string;
  avatarUrl?: string;
  relayUrls?: string[];
}

export type ImportProtocol = "atproto" | "nostr_external" | "activitypub" | "rss";

// Protocols whose graph reader is live (§8 phasing: 1a atproto + 1b Nostr +
// 1c activitypub behind its §6.6 sub-brake; OPML/rss is 1d, a separate
// capability). Surfaced to the web client via the /linked-accounts
// capabilities block so import affordances appear only for what the server
// can honour.
export function importableProtocols(): ImportProtocol[] {
  const protocols: ImportProtocol[] = ["atproto", "nostr_external"];
  if (followImportApEnabled()) protocols.push("activitypub");
  return protocols;
}

export type FollowGraphResult =
  | {
      ok: true;
      /** Canonical origin identity (handle → DID, npub → hex, acct, …). */
      originIdentity: string;
      /** Human label for the origin (handle etc.), for feed naming/UI. */
      originLabel: string;
      identities: ImportIdentity[];
      /** Remote graph size before the cap (best known). */
      total: number;
      truncated: boolean;
      /** Entries the read couldn't canonicalise (AP WebFinger fallback
       *  failures) — dropped from identities but never silently (§6.5). */
      unresolved?: number;
    }
  | {
      ok: false;
      // "hidden" is AP-only (§5.3): the account hides its follow list from
      // the public endpoint — the fix is linking the account, so the client
      // gets a distinct error to say so.
      reason: "unsupported" | "malformed" | "unreachable" | "hidden";
      message: string;
    };

// Default name for the minted feed, per origin network.
export function importFeedName(protocol: ImportProtocol): string {
  switch (protocol) {
    case "atproto":
      return "Bluesky follows";
    case "nostr_external":
      return "Nostr follows";
    case "activitypub":
      return "Fediverse follows";
    case "rss":
      return "Imported feeds";
  }
}

// -----------------------------------------------------------------------------
// Graph readers (Phase 1a atproto, 1b Nostr, 1c activitypub). rss/OPML is
// Phase 1d (file upload, different liveness policy) — it refuses here.
//
// opts.accountId is the REQUESTING account (both routes pass the session
// owner): the AP reader uses it to find a matching linked presence whose
// token makes the read work even when the account hides its follows (the
// authed self-call bypasses hide_results?, verified against Mastodon source).
// -----------------------------------------------------------------------------

export async function readFollowGraph(
  protocol: ImportProtocol,
  originIdentity: string,
  opts: { accountId?: string } = {},
): Promise<FollowGraphResult> {
  switch (protocol) {
    case "atproto":
      return readAtprotoGraph(originIdentity.trim());
    case "nostr_external":
      return readNostrGraph(originIdentity.trim());
    case "activitypub":
      // §6.6: AP import waits on the poller-fairness soak — behind its own
      // brake even while the master switch is on.
      if (!followImportApEnabled()) {
        return {
          ok: false,
          reason: "unsupported",
          message: "Importing fediverse follows is not enabled yet",
        };
      }
      return readActivityPubGraph(originIdentity.trim(), opts.accountId);
    case "rss":
      // Phase 1d: RSS has no remote graph to read — the artifact is an OPML
      // file, which arrives through POST /follow-imports/opml instead.
      return {
        ok: false,
        reason: "unsupported",
        message: "RSS subscriptions import from an OPML file — upload one instead",
      };
    default:
      return {
        ok: false,
        reason: "unsupported",
        message: `Importing follows is not yet available for ${protocol}`,
      };
  }
}

// atproto (§5.1): DID or handle → public AppView getFollows, no token. The
// AppView returns most-recently-followed first, so the cap keeps the freshest
// slice for free.
async function readAtprotoGraph(input: string): Promise<FollowGraphResult> {
  const profile = await atprotoGetProfile(input);
  if (!profile) {
    return {
      ok: false,
      reason: "unreachable",
      message: "No account found for this identity on the AT Protocol network",
    };
  }
  const read = await getFollows(profile.did, FOLLOW_IMPORT_CAP);
  if (read === null) {
    return {
      ok: false,
      reason: "unreachable",
      message: "Could not read the follow list from the AT Protocol network",
    };
  }
  const identities: ImportIdentity[] = read.follows.map((f) => ({
    uri: f.did,
    // Handle as the label fallback — a DID-only label is the §V.1 trap.
    displayName: f.displayName || `@${f.handle}`,
    avatarUrl: f.avatar,
  }));
  // followsCount is display-only: it counts deactivated accounts the AppView
  // omits from getFollows, so it must never drive `truncated` (which gates
  // sync-removal suppression — deriving it from the count difference disabled
  // removals for nearly every aged account). Truncation is the pager's call.
  const total = Math.max(profile.followsCount ?? 0, identities.length);
  return {
    ok: true,
    originIdentity: profile.did,
    originLabel: `@${profile.handle}`,
    identities,
    total,
    truncated: !read.complete,
  };
}

// Nostr (§5.2): hex / npub / nprofile / NIP-05 → kind-3 contact list from
// relays. p tags are append-ordered oldest-first, so "most recently followed
// first" takes the TAIL under the cap, then reverses. Relay hints seed
// relay_urls metadata only — never the identity (relay-free invariant).
async function readNostrGraph(input: string): Promise<FollowGraphResult> {
  let pubkey: string | null = null;
  let hintRelays: string[] = [];
  let label: string | null = null;

  if (/^[0-9a-f]{64}$/i.test(input)) {
    pubkey = input.toLowerCase();
  } else if (/^n(pub|profile)1/i.test(input)) {
    try {
      const decoded = nip19.decode(input.toLowerCase());
      if (decoded.type === "npub") {
        pubkey = decoded.data;
      } else if (decoded.type === "nprofile") {
        pubkey = decoded.data.pubkey;
        hintRelays = decoded.data.relays ?? [];
      }
    } catch {
      // falls through to malformed
    }
  } else if (input.includes("@")) {
    // NIP-05 (name@domain) — the .well-known/nostr.json lookup.
    const resolved = await resolveNip05Pubkey(input.replace(/^@+/, ""));
    if (resolved === null) {
      return {
        ok: false,
        reason: "unreachable",
        message: `Could not resolve ${input} as a NIP-05 identifier`,
      };
    }
    pubkey = resolved.pubkey;
    hintRelays = resolved.relays;
    label = input.replace(/^@+/, "");
  }

  if (!pubkey) {
    return {
      ok: false,
      reason: "malformed",
      message: "Expected an npub, nprofile, 64-hex pubkey, or NIP-05 address",
    };
  }

  const contacts = await fetchNostrContacts(pubkey, [
    ...hintRelays,
    ...getDefaultProfileRelays(),
  ]);
  if (contacts === null) {
    return {
      ok: false,
      reason: "unreachable",
      message:
        "No contact list (kind 3) found for this key on the queried relays",
    };
  }

  const tail = contacts.slice(-FOLLOW_IMPORT_CAP).reverse();
  const identities: ImportIdentity[] = tail.map((c) => ({
    uri: c.pubkey,
    // No display metadata on kind 3 — labels self-heal via the ingest kind-0
    // fetch within minutes (say so in the summary UI).
    relayUrls: c.relayHint ? [c.relayHint] : undefined,
  }));
  return {
    ok: true,
    originIdentity: pubkey,
    originLabel: label ?? nip19.npubEncode(pubkey),
    identities,
    total: contacts.length,
    truncated: contacts.length > identities.length,
  };
}

async function resolveNip05Pubkey(
  identifier: string,
): Promise<{ pubkey: string; relays: string[] } | null> {
  const [name, domain] = identifier.split("@");
  if (!name || !domain) return null;
  try {
    const res = await safeFetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { timeout: 5000 },
    );
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as {
      names?: Record<string, unknown>;
      relays?: Record<string, unknown>;
    };
    const pubkey = data?.names?.[name];
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey))
      return null;
    const relays = data?.relays?.[pubkey.toLowerCase()] ?? data?.relays?.[pubkey];
    return {
      pubkey: pubkey.toLowerCase(),
      relays: Array.isArray(relays)
        ? relays.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch (err) {
    logger.warn({ identifier, err }, "NIP-05 resolution failed");
    return null;
  }
}

// -----------------------------------------------------------------------------
// ActivityPub (§5.3, Phase 1c): acct / @acct / profile URL / actor URI → the
// origin instance's Mastodon client API. Two legs on one path: a matching
// LINKED presence supplies a bearer token (scope read:accounts authorises the
// endpoint, and the authed self-call works even with hidden follows); anyone
// else's public graph reads unauthenticated (D8), with hidden follows
// detected as empty-list + following_count > 0 and surfaced as "hidden" so
// the client can point at linking. Entries canonicalise to the actor URI —
// free where the Account entity carries `uri` (Mastodon ≥4.2), WebFinger
// per-host-throttled for the rest; unresolvable entries are dropped but
// COUNTED (unresolved — no-silent-caps).
// -----------------------------------------------------------------------------

const WEBFINGER_HOST_CONCURRENCY = 4;

async function readActivityPubGraph(
  input: string,
  accountId?: string,
): Promise<FollowGraphResult> {
  // 1. Whatever the user pasted → a full user@domain acct.
  let acct: string | null = null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") {
      return {
        ok: false,
        reason: "malformed",
        message: "Fediverse profile URLs must use https://",
      };
    }
    const extracted = extractFromMastodonUrl(url);
    if (extracted?.acct) {
      acct = extracted.acct;
    } else {
      // Actor-shaped (or unrecognised) URL — the actor document names its
      // own acct via preferredUsername + host.
      const profile = await fetchActorProfile(
        extracted?.actorUri ?? input,
      );
      if (!profile?.handle) {
        return {
          ok: false,
          reason: "unreachable",
          message: "This URL did not resolve to a fediverse account",
        };
      }
      acct = profile.handle;
    }
  } catch {
    // Not a URL — try the acct shape.
    const clean = input.replace(/^@+/, "");
    if (isAcctShape(clean)) acct = clean;
  }
  if (!acct) {
    return {
      ok: false,
      reason: "malformed",
      message:
        "Expected a fediverse handle (user@instance) or a profile URL",
    };
  }
  acct = acct.toLowerCase();

  // 2. WebFinger pins the canonical host — the acct's identity domain and
  //    the instance's API host can differ (split-domain installs), and the
  //    actor URI's origin is the API host.
  const actorUri = await resolveWebFinger(acct);
  if (!actorUri) {
    return {
      ok: false,
      reason: "unreachable",
      message: `Could not resolve @${acct} via WebFinger`,
    };
  }
  let apiOrigin: string;
  try {
    apiOrigin = new URL(actorUri).origin;
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: `@${acct} resolved to an invalid actor URI`,
    };
  }

  // 3. The requester's own linked presence, when it IS this identity,
  //    supplies the bearer token (always readable, hidden or not).
  let accessToken: string | undefined;
  let presenceExternalId: string | undefined;
  if (accountId) {
    const { rows } = await pool.query<{
      external_id: string;
      handle: string | null;
      service_url: string | null;
      credentials_enc: string | null;
    }>(
      `SELECT external_id, handle, service_url, credentials_enc
         FROM network_presences
        WHERE account_id = $1 AND protocol = 'activitypub'
          AND lifecycle_state = 'active' AND is_valid`,
      [accountId],
    );
    const presence = rows.find((r) => r.handle?.toLowerCase() === acct);
    if (presence?.credentials_enc) {
      try {
        const creds = decryptJson<{ accessToken?: string }>(
          presence.credentials_enc,
        );
        if (creds.accessToken) {
          accessToken = creds.accessToken;
          presenceExternalId = presence.external_id;
          if (presence.service_url) {
            try {
              apiOrigin = new URL(presence.service_url).origin;
            } catch {
              // keep the WebFinger-derived origin
            }
          }
        }
      } catch (err) {
        logger.warn(
          { accountId, acct, err },
          "AP import: presence token decrypt failed — reading public graph",
        );
      }
    }
  }

  // 4. Public lookup for the instance-local account id + following_count
  //    (also the hidden-follows denominator). A linked presence already
  //    carries the id, so lookup failure is fatal only for the public leg.
  const looked = await lookupMastodonAccount(apiOrigin, acct);
  const instanceAccountId = looked?.id ?? presenceExternalId;
  if (!instanceAccountId) {
    return {
      ok: false,
      reason: "unreachable",
      message:
        "This instance doesn't expose a readable follow list (a Mastodon-compatible API is required)",
    };
  }
  const followingCount = looked?.followingCount ?? null;

  const fetched = await fetchMastodonFollowing(
    apiOrigin,
    instanceAccountId,
    FOLLOW_IMPORT_CAP,
    accessToken,
  );
  if (fetched === null) {
    // Bad/expired token: one public retry — the graph may be readable anyway.
    const publicRetry = accessToken
      ? await fetchMastodonFollowing(
          apiOrigin,
          instanceAccountId,
          FOLLOW_IMPORT_CAP,
        )
      : null;
    if (publicRetry === null) {
      return {
        ok: false,
        reason: "unreachable",
        message: "Could not read the follow list from this instance",
      };
    }
    accessToken = undefined;
    return finishActivityPubGraph(acct, apiOrigin, publicRetry, followingCount, false);
  }
  return finishActivityPubGraph(
    acct,
    apiOrigin,
    fetched,
    followingCount,
    accessToken !== undefined,
  );
}

async function finishActivityPubGraph(
  acct: string,
  apiOrigin: string,
  fetched: MastodonFollowingRead,
  followingCount: number | null,
  authed: boolean,
): Promise<FollowGraphResult> {
  // §5.3: hide_collections yields an empty list, not an error — only the
  // count betrays it. The authed self-call bypasses the hide, so this can
  // only fire on the public leg.
  if (fetched.accounts.length === 0 && !authed && (followingCount ?? 0) > 0) {
    return {
      ok: false,
      reason: "hidden",
      message:
        "This account's follows are hidden — link the account under Reach other networks to import them",
    };
  }

  const { identities, unresolved } = await canonicaliseApEntries(
    fetched.accounts,
    apiOrigin,
  );
  // following_count is display-only (it drifts — suspended/moved accounts);
  // truncation is the pager's verdict, same rule as the atproto reader.
  return {
    ok: true,
    originIdentity: acct,
    originLabel: `@${acct}`,
    identities,
    total: Math.max(followingCount ?? 0, fetched.accounts.length),
    truncated: !fetched.complete,
    unresolved,
  };
}

// Actor-URI canonicalisation for entries the origin instance didn't
// serialize a `uri` for (pre-4.2). WebFinger per followed account, grouped
// by host: hosts run in a small parallel pool, requests within one host stay
// sequential (politeness — the "big instance" concentration is per-host).
async function canonicaliseApEntries(
  fetched: MastodonApiAccount[],
  apiOrigin: string,
): Promise<{ identities: ImportIdentity[]; unresolved: number }> {
  const originHost = new URL(apiOrigin).hostname;
  const fullAcct = (a: { acct: string }) =>
    a.acct.includes("@") ? a.acct : `${a.acct}@${originHost}`;

  const missing = fetched.filter((a) => !a.uri);
  const resolvedUris = new Map<string, string>(); // full acct → actor URI
  if (missing.length > 0) {
    const byHost = new Map<string, string[]>();
    for (const a of missing) {
      const full = fullAcct(a);
      const host = full.split("@")[1];
      byHost.set(host, [...(byHost.get(host) ?? []), full]);
    }
    const groups = [...byHost.values()];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const group = groups[next++];
        if (!group) return;
        for (const full of group) {
          const uri = await resolveWebFinger(full);
          if (uri) resolvedUris.set(full, uri);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(WEBFINGER_HOST_CONCURRENCY, groups.length) },
        worker,
      ),
    );
  }

  const seen = new Set<string>();
  const identities: ImportIdentity[] = [];
  let unresolved = 0;
  for (const a of fetched) {
    const uri = a.uri ?? resolvedUris.get(fullAcct(a));
    if (!uri) {
      unresolved++;
      continue;
    }
    if (seen.has(uri)) continue;
    seen.add(uri);
    identities.push({
      uri,
      displayName: a.displayName || `@${fullAcct(a)}`,
      avatarUrl: a.avatar ?? undefined,
    });
  }
  if (unresolved > 0) {
    logger.warn(
      { apiOrigin, unresolved },
      "AP import: entries dropped — no actor URI and WebFinger failed",
    );
  }
  return { identities, unresolved };
}

// -----------------------------------------------------------------------------
// Sync diff (Phase 2, §11.5) — pure: (remote graph − exclusions) diffed
// against the feed's current same-protocol membership.
//
// removalsAllowed=false when the graph read was TRUNCATED: past the cap we
// don't know the full remote set, so a current member outside the
// newest-N window would wrongly read as "unfollowed". Adds still apply;
// the skipped removals are surfaced to the user (no-silent-caps).
// -----------------------------------------------------------------------------

export interface SyncMember {
  uri: string;
  displayName?: string;
}

export function computeSyncDiff(
  desired: ImportIdentity[],
  exclusions: Set<string>,
  members: SyncMember[],
  opts: { removalsAllowed: boolean },
): { toAdd: ImportIdentity[]; toRemove: ImportIdentity[] } {
  // Excluded identities are outside sync's remit ENTIRELY — never re-added
  // (the §6.3 promise) and never removed (an excluded-but-member row means
  // conflicting signals — addSource clears the exclusion on a manual re-add,
  // so this state is residual data; membership is the user's evident intent,
  // so leave it be).
  const wanted = desired.filter((d) => !exclusions.has(d.uri));
  const memberUris = new Set(members.map((m) => m.uri));
  const wantedUris = new Set(wanted.map((w) => w.uri));
  return {
    toAdd: wanted.filter((w) => !memberUris.has(w.uri)),
    toRemove: opts.removalsAllowed
      ? members
          .filter((m) => !wantedUris.has(m.uri) && !exclusions.has(m.uri))
          .map((m) => ({ uri: m.uri, displayName: m.displayName }))
      : [],
  };
}

// -----------------------------------------------------------------------------
// The sweep
// -----------------------------------------------------------------------------

interface FollowImportRow {
  id: string;
  account_id: string;
  protocol: ImportProtocol;
  feed_id: string;
  kind: "import" | "sync";
  identities: ImportIdentity[];
  removals: ImportIdentity[];
  removal_cursor: number;
  removed: number;
  cursor: number;
  imported: number;
  skipped: number;
  failed: number;
}

// Process every unfinished run, oldest first, batches looped within this one
// invocation. Single-instance via the FOLLOW_IMPORT advisory lock (taken by
// the caller — index.ts's withAdvisoryLock or kickFollowImportSweep below).
export async function runFollowImportSweep(): Promise<void> {
  if (!followImportEnabled()) return;

  // GC abandoned sync previews (Phase 2): a preview the user never confirmed
  // or cancelled is a stale plan against a graph that has moved on — and its
  // identities payload is the table's bulk. A fresh "Sync now" mints a fresh
  // preview anyway.
  await pool
    .query(
      `DELETE FROM follow_imports
        WHERE status = 'preview' AND created_at < now() - interval '1 day'`,
    )
    .catch((err) => logger.warn({ err }, "follow import preview GC failed"));

  for (;;) {
    // Claim the oldest unfinished run. 'running' rows are claimed too — a
    // gateway restart mid-run leaves one behind, and cursor/counters make
    // resuming it deterministic (§6.2).
    const { rows } = await pool.query<FollowImportRow>(
      `UPDATE follow_imports
          SET status = 'running'
        WHERE id = (SELECT id FROM follow_imports
                     WHERE status IN ('pending', 'running')
                     ORDER BY created_at ASC, id ASC
                     LIMIT 1)
        RETURNING id, account_id, protocol, feed_id, kind, identities,
                  removals, removal_cursor, removed, cursor,
                  imported, skipped, failed`,
    );
    if (rows.length === 0) return;
    const run = rows[0];
    try {
      await processRun(run);
    } catch (err) {
      logger.error({ err, importId: run.id }, "follow import run failed");
      await pool
        .query(
          `UPDATE follow_imports
              SET status = 'failed', error = $2, finished_at = now()
            WHERE id = $1`,
          [run.id, err instanceof Error ? err.message : String(err)],
        )
        .catch((e) =>
          logger.error(
            { err: e, importId: run.id },
            "failed to mark follow import failed",
          ),
        );
    }
  }
}

async function processRun(run: FollowImportRow): Promise<void> {
  const identities = Array.isArray(run.identities) ? run.identities : [];
  let { cursor, imported, skipped, failed } = run;

  // Phase 2 sync runs apply removals BEFORE adds (§11.5): a remote unfollow
  // leaves the feed before newly-followed sources arrive. Each removal
  // resolves its feed_sources row at apply time (membership may have moved
  // since the preview — an already-gone row is a silent skip) and goes
  // through removeSource WITHOUT recording an exclusion (these mirror remote
  // unfollows, not deliberate local edits — a re-follow at the origin must
  // stay syncable back in).
  if (run.kind === "sync") {
    const removals = Array.isArray(run.removals) ? run.removals : [];
    let { removal_cursor: removalCursor, removed } = run;
    while (removalCursor < removals.length) {
      const batch = removals.slice(removalCursor, removalCursor + BATCH_SIZE);
      for (const identity of batch) {
        try {
          const { rows } = await pool.query<{ id: string }>(
            `SELECT fs.id
               FROM feed_sources fs
               JOIN external_sources xs ON xs.id = fs.external_source_id
              WHERE fs.feed_id = $1 AND xs.protocol = $2 AND xs.source_uri = $3
              LIMIT 1`,
            [run.feed_id, run.protocol, identity.uri],
          );
          if (rows.length === 0) continue; // already gone — nothing to remove
          const result = await removeSource(
            run.feed_id,
            run.account_id,
            rows[0].id,
            { recordExclusion: false },
          );
          if (!result.notFound) removed++;
        } catch (err) {
          failed++;
          logger.warn(
            { err, importId: run.id, uri: identity.uri },
            "follow sync: removeSource failed",
          );
        }
      }
      removalCursor += batch.length;
      const { rowCount } = await pool.query(
        `UPDATE follow_imports
            SET removed = $2, removal_cursor = $3, failed = $4
          WHERE id = $1`,
        [run.id, removed, removalCursor, failed],
      );
      // Feed deleted mid-run (cascade took the row) — stop.
      if (rowCount === 0) return;
    }
  }

  // Sync adds re-check exclusions at apply time: a source the user
  // deliberately removed between preview and confirm must not be re-added by
  // the stale plan (§6.3 — the exclusion always wins).
  const applyExclusions =
    run.kind === "sync" && cursor < identities.length
      ? new Set(
          (
            await pool.query<{ identity: string }>(
              `SELECT identity FROM feed_import_exclusions
                WHERE feed_id = $1 AND protocol = $2`,
              [run.feed_id, run.protocol],
            )
          ).rows.map((r) => r.identity),
        )
      : null;

  while (cursor < identities.length) {
    const batch = identities.slice(cursor, cursor + BATCH_SIZE);
    const mintedSourceIds: string[] = [];
    for (const [i, identity] of batch.entries()) {
      if (applyExclusions?.has(identity.uri)) {
        skipped++;
        continue;
      }
      const input: AddSourceInput = {
        sourceType: "external_source",
        protocol: run.protocol,
        sourceUri: identity.uri,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        relayUrls: identity.relayUrls,
      };
      try {
        const result = await addSource(run.feed_id, run.account_id, input, {
          // D6: graph membership is liveness evidence; identities were
          // canonicalised at graph-read time. The poller's failure handling
          // marks any stragglers dead. EXCEPTION — rss (OPML, Phase 1d):
          // reader exports rot, so the probe runs (addSource normalises the
          // URL and backfills the feed title); dead entries throw
          // SOURCE_UNREACHABLE and land in `failed`, reported in the summary
          // rather than silently dropped.
          skipProbe: run.protocol !== "rss",
          // §6.4b: trickle the subscribe-time ingest jobs instead of dumping
          // N immediate fetches on the worker.
          enqueueRunAt: new Date(
            Date.now() + (i + 1) * ENQUEUE_SPACING_MS +
              Math.floor(Math.random() * ENQUEUE_SPACING_MS),
          ),
        });
        imported++;
        if (result.ensured) mintedSourceIds.push(result.ensured.externalSourceId);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "DUPLICATE") {
          // Already on the feed (idempotent re-import / overlapping runs).
          skipped++;
        } else {
          // Individual failures never fail the run (§6.2) — count + log.
          failed++;
          logger.warn(
            { err, importId: run.id, uri: identity.uri },
            "follow import: addSource failed",
          );
        }
      }
    }
    cursor += batch.length;

    // §6.4a(2): stagger the poll scheduler's first-due times for freshly
    // minted sources — a synthetic last_fetched_at lands first polls uniformly
    // across one fetch interval instead of all-due-now NULLs monopolising the
    // selection window. Only rows never fetched (a shared source another user
    // already polls keeps its real timestamp).
    if (mintedSourceIds.length > 0) {
      await pool.query(
        `UPDATE external_sources
            SET last_fetched_at = now()
                + (floor(random() * fetch_interval_seconds) || ' seconds')::interval
                - (fetch_interval_seconds || ' seconds')::interval
          WHERE id = ANY($1::uuid[]) AND last_fetched_at IS NULL`,
        [mintedSourceIds],
      );
    }

    const { rowCount } = await pool.query(
      `UPDATE follow_imports
          SET imported = $2, skipped = $3, failed = $4, cursor = $5
        WHERE id = $1`,
      [run.id, imported, skipped, failed, cursor],
    );
    // The feed (and, by cascade, this run row) was deleted mid-run — stop.
    // addSource failures from the missing feed were counted above; nothing
    // else to persist.
    if (rowCount === 0) return;
  }

  // Completion. Volume default first (§6.5): above the threshold the feed
  // defaults to sampled volume — a post-import bulk UPDATE, guarded to rows
  // still at the 4.0 default so a re-run never clobbers user tuning. Initial
  // imports only: by sync time the feed's volume character is the user's.
  if (run.kind !== "sync" && identities.length > VOLUME_SAMPLE_THRESHOLD) {
    await pool.query(
      `UPDATE feed_sources
          SET weight = $2
        WHERE feed_id = $1 AND source_type = 'external_source'
          AND weight = 4.0`,
      [run.feed_id, SAMPLED_WEIGHT],
    );
  }
  // The snapshot IS a sync — stamp the binding so "Sync now" (Phase 2) has a
  // baseline even before it ships.
  await pool.query(
    `UPDATE feed_import_bindings SET last_synced_at = now() WHERE feed_id = $1`,
    [run.feed_id],
  );
  await pool.query(
    `UPDATE follow_imports SET status = 'done', finished_at = now()
      WHERE id = $1`,
    [run.id],
  );
  logger.info(
    { importId: run.id, feedId: run.feed_id, imported, skipped, failed },
    "follow import completed",
  );
}

// Fire the sweep immediately (best-effort) after POST /follow-imports creates
// a run, instead of waiting up to 60s for the scheduler tick. Same try-lock
// discipline as index.ts's withAdvisoryLock — if the scheduler (or another
// kick) holds the lock, skip; the pending row is picked up by the running
// sweep's claim loop or the next tick.
export async function kickFollowImportSweep(): Promise<void> {
  if (!followImportEnabled()) return;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCKS.FOLLOW_IMPORT],
    );
    if (!rows[0].locked) return;
    try {
      await runFollowImportSweep();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [
        ADVISORY_LOCKS.FOLLOW_IMPORT,
      ]);
    }
  } finally {
    client.release();
  }
}
