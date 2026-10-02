// Live external-thread hydration → DB. Extracted from routes/external-items.ts
// (item 4a) because its two public entrypoints — willHydrateThread and
// hydrateExternalThreadContext — are consumed outside the route file (by
// routes/post-thread.ts's unified /thread projector), so they belong in lib/,
// not a route module. Behaviour-preserving move; the shared row/interface types
// and Bluesky/Mastodon extractors live in external-items-shared.ts.
import {
  decodeNostrEventId,
  nostrRootId,
  nostrReplyTargetId,
  parseNostrProfile,
  normaliseNostrThreadNode,
  type RawNostrEvent,
  type NostrProfile,
} from "./nostr-thread.js";
import { fetchNostrEvents } from "./nostr-relay.js";
import { relayCandidates } from "@platform-pub/shared/lib/nostr-relay-req.js";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { blueskyInteractionData } from "@platform-pub/shared/lib/atproto-reply-refs.js";
import {
  httpUrlOrNull,
  sanitizeContent,
} from "@platform-pub/shared/lib/sanitize.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  persistHydratedThreadNodes,
  type HydratedNode,
} from "@platform-pub/shared/lib/context-persist.js";
import {
  APPVIEW,
  CACHE_MAX_ENTRIES,
  NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  type ExternalItemRow,
  type BlueskyThreadViewPost,
  type MastodonStatus,
  isThreadViewPost,
  extractBlueskyViewMedia,
  extractBlueskyViewQuoteUri,
  stripHtmlTags,
  extractMastodonStatusId,
} from "./external-items-shared.js";
import {
  readMastodonStatusContext,
  mastodonStatusIdentity,
} from "@platform-pub/shared/lib/mastodon-api.js";

// ===========================================================================
// Live thread hydration → DB (UNIVERSAL-POST-ADR §8, /thread parity fix)
//
// The unified /thread projector (post-thread.ts) is pure-DB: it walks
// source_reply_uri over INGESTED external_items. But we ingest only a source's
// own posts, not the full reply graph around them — so a Bluesky/Mastodon item
// that advertises N replies on-origin would expand to nothing. The legacy
// /external-items/:id/thread papered over this with a LIVE source-API walk that
// rendered transient entries; the Phase-5 cutover dropped that path.
//
// This restores parity by HYDRATING the live source thread into the substrate
// the projector reads: each ancestor/descendant is persisted context-only into
// external_items + feed_items (the identity trigger mints post_id / version /
// biddability_tier / external_author_id), so /thread then resolves them exactly
// like natively-ingested nodes. is_context_only keeps them out of the main feed
// (post-feed.ts filters on it); external-context-gc reclaims them.
//
// Best-effort and throttled: a per-item TTL guard prevents a re-write storm on
// repeated expands, and any source/DB failure leaves the request to fall back to
// whatever was already ingested.
// ===========================================================================

// HydratedNode and persistHydratedThreadNodes live in shared (context-persist.ts),
// held by the gateway and feed-ingest's linked-notification poller alike.
// Re-exported so every importer of this module is unchanged.
export { persistHydratedThreadNodes, type HydratedNode };

// Two registries, answering two different questions (THREAD-HYDRATION-LATENCY-ADR
// D1). Keep them distinct — conflating them is the deadlock this ADR fixes:
//   • hydrateGuard: "may I RE-TRIGGER a hydrate for this item?" — a TTL throttle
//     so repeated expands don't storm the source. Set at kickoff, cleared early
//     only on failure so a failed hydrate is immediately retriable.
//   • hydrationInFlight: "is a hydrate for this item RUNNING right now?" — the
//     truth source for the response's `hydrating` flag. A settled job (success or
//     failure) is absent from this map even while the guard still throttles.
// The in-flight promise resolves a SUCCESS bit (§0f-5): true = the hydrate ran
// to completion (rows committed), false = it failed (guard cleared, retriable).
const hydrateGuard = new Map<string, number>();
const hydrationInFlight = new Map<string, Promise<boolean>>();
const HYDRATE_TTL_MS = 60_000;

// Would a hydrate RE-TRIGGER right now (hydratable protocol AND not throttled)?
// Solely the re-trigger throttle — NOT "is one running" (that's isThreadHydrating).
// Lets a caller decide synchronously whether to kick off background hydration.
export function willHydrateThread(itemId: string, protocol: string): boolean {
  if (
    protocol !== "atproto" &&
    protocol !== "activitypub" &&
    protocol !== "nostr_external"
  )
    return false;
  const until = hydrateGuard.get(itemId);
  return !(until && until > Date.now());
}

// Is a hydrate for this item in flight? The response's `hydrating` flag is
// derived from THIS, never from willHydrateThread (which flips false the instant
// the throttle guard is set — the mid-flight `hydrating: false` deadlock, D1).
export function isThreadHydrating(itemId: string): boolean {
  return hydrationInFlight.has(itemId);
}

// The in-flight hydration promise for this item, if one is running — so a caller
// (D5's short synchronous await) can Promise.race it against a budget.
export function getInFlightHydration(
  itemId: string,
): Promise<boolean> | undefined {
  return hydrationInFlight.get(itemId);
}

// D5 — short synchronous await on first expand. How long /thread will wait on an
// in-flight hydration before falling through to `hydrating: true` + D2 polling.
export const THREAD_HYDRATE_SYNC_BUDGET_MS = 2_000;

// Race an in-flight hydration against a budget (THREAD-HYDRATION-LATENCY-ADR D5).
// Resolves TRUE only if the job settled within budgetMs AND SUCCEEDED — the
// hydrated rows are now committed, so the caller can assemble a COMPLETE thread
// and report `hydrating: false`, sparing the client any polling on a fast
// relay. Resolves FALSE if the budget elapsed first, OR if the job settled by
// FAILING within the budget (§0f-5): a fast failure (all relays refused in
// <2s) must NOT read as "settled" — that let the caller report
// `hydrating: false` and cache the bare-focal thread for 60s, during which no
// client poll ever fired to pick up D1's guard-cleared retry. On FALSE the
// caller returns whatever is ingested so far with `hydrating: true` and the
// client polls to merge the rest (D2) — the poll is also exactly what
// re-triggers the retriable failed hydrate. A missing job (nothing to wait
// for: not hydratable, or throttled-and-settled) resolves TRUE immediately.
// Never rejects (the job never rejects; it resolves its success bit).
export function awaitHydrationWithinBudget(
  job: Promise<boolean> | undefined,
  budgetMs: number,
): Promise<boolean> {
  if (!job) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), budgetMs);
    job.then(
      (ok) => {
        clearTimeout(timer);
        resolve(ok); // no-op if the timer already resolved false
      },
      () => {
        clearTimeout(timer);
        resolve(false); // defensive — the job catches its own errors
      },
    );
  });
}

// Test-only: clear both registries so cases don't leak throttle/in-flight state
// into one another (mirrors resetAuthorTimelineGuard).
export function resetThreadHydrationGuards(): void {
  hydrateGuard.clear();
  hydrationInFlight.clear();
}


// Walk a Bluesky getPostThread response into hydrated nodes (parent chain +
// focal + flattened replies). Keyed by at:// URIs, which are exactly the
// (protocol, source_item_uri) the projector + identity trigger derive post_id
// from, so reply edges connect to the focal already in feed_items.
function collectBlueskyThreadNodes(
  root: BlueskyThreadViewPost,
): HydratedNode[] {
  const out: HydratedNode[] = [];
  const seen = new Set<string>();
  const add = (tvp: BlueskyThreadViewPost) => {
    const post = tvp.post;
    if (!post?.uri || seen.has(post.uri)) return;
    seen.add(post.uri);
    out.push({
      sourceItemUri: post.uri,
      sourceReplyUri: post.record.reply?.parent.uri ?? null,
      sourceQuoteUri: extractBlueskyViewQuoteUri(post.embed),
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri: post.author.did,
      contentText: post.record.text ?? null,
      contentHtml: null,
      media: extractBlueskyViewMedia(post.embed),
      interactionData: blueskyInteractionData(post),
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      publishedAt: new Date(post.record.createdAt ?? Date.now()),
    });
  };

  // ancestors (parent chain)
  let cur = root.parent;
  while (cur && isThreadViewPost(cur)) {
    add(cur);
    cur = cur.parent;
  }
  // focal + descendants (BFS)
  add(root);
  const queue: BlueskyThreadViewPost[] = [];
  for (const r of root.replies ?? []) if (isThreadViewPost(r)) queue.push(r);
  while (queue.length > 0) {
    const node = queue.shift()!;
    add(node);
    for (const r of node.replies ?? []) if (isThreadViewPost(r)) queue.push(r);
  }
  return out;
}

async function hydrateBlueskyThread(item: ExternalItemRow): Promise<void> {
  const atUri =
    (item.interaction_data as { uri?: string }).uri ?? item.source_item_uri;
  const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread`);
  url.searchParams.append("uri", atUri);
  url.searchParams.append("depth", "50");
  url.searchParams.append("parentHeight", "100");

  const res = await safeFetch(url.toString(), {
    headers: { Accept: "application/json" },
    timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  });
  // Transient trouble (rate limit / server error) must THROW: the job's
  // success bit is what keeps a fast failure from reading as settled (§0f-5)
  // — a silent return here reported success, cached the bare focal for the
  // full client TTL, and left the throttle guard set (no retry for 60s: the
  // D1 deadlock in miniature). A definitive 4xx (deleted/blocked post) has
  // nothing to hydrate and stays a clean settle.
  if (res.status === 429 || res.status >= 500)
    throw new Error(`appview thread fetch failed: ${res.status}`);
  if (!res.ok) return;
  const data = JSON.parse(res.text) as { thread: BlueskyThreadViewPost };
  if (!isThreadViewPost(data.thread)) return;

  await persistHydratedThreadNodes(
    item.source_id,
    "atproto",
    collectBlueskyThreadNodes(data.thread),
  );
}

async function hydrateMastodonThread(item: ExternalItemRow): Promise<void> {
  const statusId = extractMastodonStatusId(item.source_item_uri);
  if (!statusId) return;
  const host = new URL(item.source_item_uri).hostname;
  const res = await readMastodonStatusContext(`https://${host}`, statusId, { timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS });
  // Same split as the Bluesky fetch above: transient (429/5xx) throws so the
  // failure clears the guard and the client keeps polling; a definitive 4xx
  // (status deleted, instance refuses) is a clean settle.
  if (res.status === 429 || res.status >= 500)
    throw new Error(`mastodon context fetch failed: ${res.status}`);
  if (!res.ok) return;

  interface RichStatus extends MastodonStatus {
    account: MastodonStatus["account"] & { avatar?: string };
    media_attachments?: Array<{
      type: string;
      url: string;
      preview_url?: string;
      description?: string;
    }>;
  }
  const data = res.body as {
    ancestors: RichStatus[];
    descendants: RichStatus[];
  };

  // in_reply_to_id is a LOCAL status id, but the projector threads on
  // source_reply_uri. Map every id in the conversation (incl. the focal, whose
  // stored uri is item.source_item_uri) to the canonical uri we persist, so a
  // reply's source_reply_uri equals its parent's source_item_uri.
  // Key on the federated ActivityPub id (`uri`), NOT the human web `url`: the
  // ingestion adapter stores source_item_uri = note.id and source_reply_uri =
  // note.inReplyTo, both of which are the `uri` form. Persisting ancestors under
  // `url` would mint a parallel id-space, so the focal's source_reply_uri never
  // matches a hydrated parent's source_item_uri and the ancestor walk finds
  // nothing (parents go missing). `uri` is always present on a Mastodon status.
  //
  // AND IT MAY CLAIM THAT ID ONLY ON THE ORIGIN THAT ANSWERED (CA-A10,
  // 2026-09-29): every node goes through `mastodonStatusIdentity` against the
  // api origin asked, and a node naming another host's status or actor is
  // dropped (logged in the one home) — never keyed on its web url instead.
  // A reply whose parent was dropped threads to nothing rather than to a
  // forged id.
  const apiOrigin = `https://${host}`;
  const admitted: Array<{ s: RichStatus; uri: string; authorUri: string }> = [];
  const idToUri = new Map<string, string>();
  idToUri.set(statusId, item.source_item_uri);
  for (const s of [...data.ancestors, ...data.descendants]) {
    const identity = mastodonStatusIdentity(s, apiOrigin);
    if (!identity) continue;
    admitted.push({ s, ...identity });
    idToUri.set(s.id, identity.uri);
  }

  const toNode = ({ s, uri, authorUri }: (typeof admitted)[number]): HydratedNode => ({
    sourceItemUri: uri,
    sourceReplyUri: s.in_reply_to_id
      ? (idToUri.get(s.in_reply_to_id) ?? null)
      : null,
    // Mastodon's status context carries no quote linkage; quotes for fedi posts
    // are resolved on demand by the quote endpoint, not via hydration.
    sourceQuoteUri: null,
    authorName: s.account.display_name || s.account.acct,
    authorHandle: s.account.acct,
    authorAvatarUrl: s.account.avatar ?? null,
    authorUri,
    contentText: stripHtmlTags(s.content ?? ""),
    contentHtml: sanitizeContent(s.content ?? ""),
    media: (s.media_attachments ?? []).map((m) => ({
      type: m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    })),
    interactionData: { id: uri, webUrl: s.url },
    likeCount: s.favourites_count ?? 0,
    replyCount: s.replies_count ?? 0,
    repostCount: s.reblogs_count ?? 0,
    publishedAt: new Date(s.created_at),
  });

  await persistHydratedThreadNodes(item.source_id, "activitypub", admitted.map(toNode));
}

// ── Nostr thread hydration ─────────────────────────────────────────────────
// Nostr has no single "get thread" call (unlike Bluesky's getPostThread or
// Mastodon's /context). We reconstruct the conversation from the relay graph:
//   1. fetch the focal event to read its NIP-10 tags and locate the thread root
//   2. fetch the root event + every event that `#e`-references the root — that
//      one query returns the whole subtree (ancestors of the focal, the focal,
//      siblings and descendants), because NIP-10 replies tag the root
//   3. fetch kind-0 metadata for every distinct author for display names/avatars
// Each event is normalised into the SAME relay-free identity encoding the
// ingest path uses (nostrEventUri / nostrAddrUri — relay hints never enter the
// id; see feed-ingest-nostr.ts), so a hydrated reply's source_reply_uri equals
// its parent's source_item_uri and assembleExternalThread's DB walk connects
// them. Best-effort and bounded (relay / timeout / node caps).

const NOSTR_THREAD_RELAY_CAP = 6;
const NOSTR_THREAD_NODE_CAP = 200;
const NOSTR_THREAD_REQ_TIMEOUT_MS = 6_000;
// The ancestor walk fetches one parent per hop; keep its per-hop timeout short so
// a deep/slow chain can't stall the request (it breaks early on the first miss).
const NOSTR_WALK_TIMEOUT_MS = 4_000;
const NOSTR_ANCESTOR_DEPTH_CAP = 12;
// D3 broad-net early-resolve: return once this many relays EOSE, or the soft
// deadline elapses (whichever first), rather than paying a hung relay's full
// NOSTR_THREAD_REQ_TIMEOUT_MS. The hard timeout still bounds the call.
const NOSTR_BROAD_KOFN = 2;
const NOSTR_BROAD_SOFT_DEADLINE_MS = 2_500;

async function hydrateNostrThread(item: ExternalItemRow): Promise<void> {
  const data = item.interaction_data as { id?: string; relays?: unknown } | null;
  const focalId =
    decodeNostrEventId(data?.id) ?? decodeNostrEventId(item.source_item_uri);
  if (!focalId) return;

  // Relay set: the focal's own relay hints first; if it carries none, fall back
  // to the source's configured relays. Deduped, scheme-checked, capped.
  const rawRelays = data?.relays;
  const hinted = Array.isArray(rawRelays)
    ? rawRelays.filter((r): r is string => typeof r === "string")
    : [];
  // Source-configured relays as a secondary hint set, then the high-coverage
  // fallbacks. Post hints first (most likely to hold the thread), capped.
  let sourceRelays: string[] = [];
  {
    const { rows } = await pool.query<{ relay_urls: string[] | null }>(
      `SELECT relay_urls FROM external_sources WHERE id = $1`,
      [item.source_id],
    );
    sourceRelays = rows[0]?.relay_urls ?? [];
  }
  const relays = relayCandidates(hinted, NOSTR_THREAD_RELAY_CAP, sourceRelays);
  if (relays.length === 0) return;

  // 1. Fetch the focal event to read its NIP-10 tags → root + immediate parent.
  //    Content-addressed by id → the first relay to return it is authoritative
  //    (D3 first-event; no "newer" copy to wait for).
  const [focal] = await fetchNostrEvents(
    relays,
    [{ ids: [focalId] }],
    NOSTR_THREAD_REQ_TIMEOUT_MS,
    { mode: "first-event" },
  );
  const rootId = focal ? nostrRootId(focal) : focalId;

  const all = new Map<string, RawNostrEvent>();
  if (focal) all.set(focal.id, focal);

  // 2. Broad net: the root event, everything that `#e`-tags the root (catches
  //    descendants — replies conventionally tag the root), and direct replies to
  //    the focal. One multi-filter REQ.
  //    The broad `#e` nets legitimately trickle events over time, so resolve
  //    k-of-n relays (or the soft deadline) rather than the slowest (D3 k-of-n).
  const broad = await fetchNostrEvents(
    relays,
    [
      { ids: [rootId] },
      { kinds: [1], "#e": [rootId], limit: NOSTR_THREAD_NODE_CAP },
      { kinds: [1], "#e": [focalId], limit: NOSTR_THREAD_NODE_CAP },
    ],
    NOSTR_THREAD_REQ_TIMEOUT_MS,
    { mode: "k-of-n", k: NOSTR_BROAD_KOFN, softDeadlineMs: NOSTR_BROAD_SOFT_DEADLINE_MS },
  );
  for (const ev of broad) all.set(ev.id, ev);
  // Nothing found (focal absent, broad empty) ⇒ the walk can't start either
  // (its cursor is the focal's reply target). Zero events is a FAILURE, not an
  // empty thread: the k-of-n soft deadline fires unconditionally, so on a
  // slow-relay day both fetches can come back empty with no relay having
  // answered — and a silent return here read as hydration success, caching
  // the bare focal for the full client TTL with the throttle guard still set
  // (§0f-5's rule: a fast failure must not read as settled). An event that
  // genuinely no longer exists on any relay costs only the bounded client
  // poll budget in retries.
  if (all.size === 0)
    throw new Error("nostr thread hydration harvested zero events");

  // D4: the kind-0 profile REQ for every author known after the broad net runs
  // CONCURRENTLY with the ancestor walk below — the two slow phases cost `max`,
  // not `sum`. Profiles stay exhaustive (replaceable-by-author: newest-wins must
  // survive, so no early-resolve here). Authors the walk newly discovers get a
  // small follow-up REQ once both settle.
  const pubkeysBeforeWalk = [...new Set([...all.values()].map((e) => e.pubkey))];
  const profilesPromise: Promise<RawNostrEvent[]> = pubkeysBeforeWalk.length
    ? fetchNostrEvents(
        relays,
        [{ kinds: [0], authors: pubkeysBeforeWalk, limit: pubkeysBeforeWalk.length }],
        NOSTR_THREAD_REQ_TIMEOUT_MS,
      )
    : Promise.resolve([]);

  // 3. Ancestor walk. The broad net only finds ancestors that tag the *root* —
  //    but many clients tag only the immediate parent, so an intermediate
  //    ancestor (root ≠ parent) is missed and the chain breaks at the first hop.
  //    Climb parent-by-parent by id instead, fetching only hops not already held
  //    (each hop is content-addressed → D3 first-event).
  let cursor = focal ? nostrReplyTargetId(focal) : null;
  const walked = new Set<string>([focalId]);
  for (let depth = 0; depth < NOSTR_ANCESTOR_DEPTH_CAP && cursor; depth++) {
    if (walked.has(cursor)) break;
    walked.add(cursor);
    let parent = all.get(cursor);
    if (!parent) {
      [parent] = await fetchNostrEvents(
        relays,
        [{ ids: [cursor] }],
        NOSTR_WALK_TIMEOUT_MS,
        { mode: "first-event" },
      );
      if (!parent) break; // parent not on any relay — chain ends here
      all.set(parent.id, parent);
    }
    cursor = nostrReplyTargetId(parent);
  }

  // 4. Assemble the profile events: the concurrent batch, plus a follow-up REQ
  //    for any authors the walk discovered that the first batch didn't cover.
  const profileEvents = [...(await profilesPromise)];
  const knownPubkeys = new Set(pubkeysBeforeWalk);
  const walkPubkeys = [...new Set([...all.values()].map((e) => e.pubkey))].filter(
    (pk) => !knownPubkeys.has(pk),
  );
  if (walkPubkeys.length) {
    profileEvents.push(
      ...(await fetchNostrEvents(
        relays,
        [{ kinds: [0], authors: walkPubkeys, limit: walkPubkeys.length }],
        NOSTR_THREAD_REQ_TIMEOUT_MS,
      )),
    );
  }
  const profiles = new Map<string, NostrProfile>();
  for (const ev of [...profileEvents].sort(
    (a, b) => b.created_at - a.created_at,
  )) {
    if (!profiles.has(ev.pubkey)) {
      profiles.set(ev.pubkey, parseNostrProfile(ev.content));
    }
  }

  const nodes = [...all.values()]
    .slice(0, NOSTR_THREAD_NODE_CAP)
    .map((ev) =>
      normaliseNostrThreadNode(
        ev,
        relays,
        profiles.get(ev.pubkey) ?? {
          name: null,
          picture: null,
          nip05: null,
          about: null,
          website: null,
          lud16: null,
        },
      ),
    );
  await persistHydratedThreadNodes(item.source_id, "nostr_external", nodes);
  logger.debug(
    {
      id: item.id,
      focalId,
      rootId,
      focalFound: Boolean(focal),
      relays: relays.length,
      subtreeEvents: all.size,
      persisted: nodes.length,
    },
    "nostr thread hydrate complete",
  );
}

// Public entrypoint: best-effort, throttled hydration of an external item's live
// source thread into external_items + feed_items, so the pure-DB /thread
// projector can then resolve its ancestors + replies. Never throws.
//
// Returns the in-flight hydration promise (D1/D5) resolving its SUCCESS bit
// (§0f-5): a caller can race it against a budget and only report "settled" on
// success. The promise is registered in hydrationInFlight for its lifetime and
// deleted in a `finally` when it settles, so isThreadHydrating tracks it exactly.
// Concurrent callers in the same throttle window share the running job; a caller
// arriving while throttled-but-settled gets a resolved promise (nothing to do —
// and the guard surviving means the prior run SUCCEEDED, so it resolves true).
export function hydrateExternalThreadContext(item: {
  id: string;
  source_id: string;
  protocol: string;
  source_item_uri: string;
  interaction_data: Record<string, unknown> | null;
}): Promise<boolean> {
  if (
    item.protocol !== "atproto" &&
    item.protocol !== "activitypub" &&
    item.protocol !== "nostr_external"
  )
    return Promise.resolve(true);

  // Concurrent caller while a job is already running → share it (so `hydrating`
  // and D5's race observe the same settle).
  const existing = hydrationInFlight.get(item.id);
  if (existing) return existing;

  // Throttled and NOT in flight → it ran recently, settled, and succeeded (a
  // failure clears the guard); nothing to do.
  const until = hydrateGuard.get(item.id);
  if (until && until > Date.now()) return Promise.resolve(true);

  hydrateGuard.set(item.id, Date.now() + HYDRATE_TTL_MS);
  if (hydrateGuard.size > CACHE_MAX_ENTRIES) {
    const oldest = hydrateGuard.keys().next().value;
    if (oldest !== undefined) hydrateGuard.delete(oldest);
  }

  const row: ExternalItemRow = {
    id: item.id,
    source_id: item.source_id,
    protocol: item.protocol,
    source_item_uri: item.source_item_uri,
    source_reply_uri: null,
    like_count: 0,
    reply_count: 0,
    repost_count: 0,
    interaction_data: item.interaction_data ?? {},
  };
  const job = (async () => {
    try {
      if (item.protocol === "atproto") await hydrateBlueskyThread(row);
      else if (item.protocol === "activitypub") await hydrateMastodonThread(row);
      else await hydrateNostrThread(row);
      return true;
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), id: item.id },
        "External thread hydration failed",
      );
      // Secondary defect (D1): the guard was set before the run; a failure must
      // clear it so willHydrateThread is true again on the next poll instead of
      // freezing retries for the full TTL.
      hydrateGuard.delete(item.id);
      return false;
    }
  })();
  // Register synchronously (before returning) so a same-tick concurrent caller
  // sees the in-flight entry; delete on settle so `hydrating` never sticks true
  // and the map can't leak one entry per thread.
  hydrationInFlight.set(item.id, job);
  void job.finally(() => hydrationInFlight.delete(item.id));
  return job;
}
