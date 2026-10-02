import { fetchApDocument } from "@platform-pub/shared/lib/activitypub-fetch.js";
import { authoritativeId } from "@platform-pub/shared/lib/activitypub-origin.js";
import {
  fetchMastodonAccountByActorUri,
  fetchMastodonStatusById,
  fetchMastodonStatuses,
  mastodonAccountIdentity,
  type MastodonStatus,
} from "@platform-pub/shared/lib/mastodon-api.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  sanitizeContent,
  stripHtml,
} from "@platform-pub/shared/lib/sanitize.js";
import type { DetectedRepost } from "../lib/repost-edge.js";

// =============================================================================
// ActivityPub (Mastodon) outbox adapter
//
// Fetches an actor's public outbox and normalises each Note object into the
// shape expected by external_items + feed_items. See docs/adr/UNIVERSAL-FEED-ADR.md
// §VI.4.
//
// This is deliberately a minimal reader: we only ingest public `Create`
// activities whose object is a `Note`. Announces (boosts) and private posts
// are skipped. Deletes are not surfaced via outbox polling; ADR §VI.4 notes
// that inbox delivery (future phase) is the clean mechanism for tombstones.
// =============================================================================

const PUBLIC_URI = "https://www.w3.org/ns/activitystreams#Public";

export interface MediaAttachment {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  title?: string;
  description?: string;
}

export interface ActorMetadata {
  id: string;
  name: string | null;
  preferredUsername: string | null;
  summary: string | null;
  icon: string | null;
  /** NULL when the actor document was unreadable and this came off the
   *  client API instead — there is no outbox to poll, so `reader` says so. */
  outbox: string | null;
  url: string | null;
  // Instance host derived from actor id
  host: string;
  /**
   * Which reader this actor's posts must be fetched with.
   *
   * `outbox` is ActivityPub and the richer document. `mastodon_api` is the
   * fallback for an instance in secure mode (`AUTHORIZED_FETCH`), which
   * answers 401 to every unsigned AP GET — the state that had deactivated
   * every mastodon.social source on the platform.
   */
  reader: "outbox" | "mastodon_api";
  /** Instance-local account id, on the `mastodon_api` arm only. */
  apiAccountId: string | null;
}

export interface NormalisedActivityPubItem {
  sourceItemUri: string;
  title: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string;
  contentText: string;
  contentHtml: string;
  language: string | null;
  media: MediaAttachment[];
  sourceReplyUri: string | null;
  sourceQuoteUri: string | null; // FEP-044f `quote` / Fedibird `quoteUrl` / Misskey `_misskey_quote`
  contentWarning: string | null;
  publishedAt: Date;
  webUrl: string | null;
  interactionData: {
    id: string;
    activityId?: string;
    replyTo?: string;
    webUrl?: string;
    audience?: string;
    poll?: {
      options: Array<{ title: string; votesCount: number }>;
      multiple: boolean;
      expiresAt: string | null;
      closed: boolean;
    };
  };
}

// =============================================================================
// Actor fetch
// =============================================================================

/** Fetch error carrying the HTTP status so the ingest task can distinguish a
 *  transient failure from a 410 Gone — the fediverse's account-deletion
 *  tombstone (RESOLVER-DISCOVERY-ADR §8.3). */
export class ApFetchStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApFetchStatusError";
  }
}

export async function fetchActor(actorUri: string): Promise<ActorMetadata> {
  // `fetchApDocument` is the three-arm reader: unsigned, then SIGNED if the
  // instance refused the unsigned read. `signedFetchRefused` is its verdict
  // that the refusal survived a signature — i.e. still a fact about US, not
  // about the source — which is what the client-API fallback below is for and
  // what the ingest task must not spend the error budget on.
  //
  // A THROW takes the same fallback, as the gateway's reader does: a transport
  // fault or a timeout is not a verdict on the account, and if the instance's
  // client API answers, the source IS readable and must not spend its error
  // budget. (A tarpit on repeat unsigned actor GETs is the case the gateway's
  // comment names — reported, not reproduced 2026-09-25 — but the rule holds
  // whether or not it is real.) Where the client API cannot stand in either,
  // the ORIGINAL error propagates by identity, so the ingest task classifies
  // exactly what it did before.
  let fetched: Awaited<ReturnType<typeof fetchApDocument>>;
  try {
    fetched = await fetchApDocument(actorUri);
  } catch (err) {
    // Never throws: `shared/lib/mastodon-api.ts` answers null on any failure.
    const viaApi = await fetchActorViaMastodonApi(actorUri);
    if (viaApi) return viaApi;
    throw err;
  }
  const { res, signedFetchRefused } = fetched;
  if (!res.ok) {
    // AUTHORIZED_FETCH: the instance refuses ActivityPub reads it cannot
    // attribute. Treating that as an ordinary error is what spent the error
    // budget and DEACTIVATED every mastodon.social source on the platform. The
    // client API is not in the refusal; try it before giving up.
    if (signedFetchRefused) {
      const viaApi = await fetchActorViaMastodonApi(actorUri);
      if (viaApi) return viaApi;
    }
    throw new ApFetchStatusError(
      `Actor fetch returned HTTP ${res.status}`,
      res.status,
    );
  }

  let actor: any;
  try {
    actor = JSON.parse(res.text);
  } catch {
    throw new Error("Actor response is not valid JSON");
  }

  const outbox =
    typeof actor.outbox === "string" ? actor.outbox : actor.outbox?.id;
  if (!outbox || typeof outbox !== "string") {
    throw new Error("Actor has no outbox URL");
  }

  // An actor may only claim an id on the origin that served it (§2.9). The
  // authority is `res.url` — where the fetch ENDED, after up to 3 redirects —
  // never `actorUri`, or an instance that legitimately redirects is refused.
  // And this REFUSES: the old `actor.id ?? actorUri` fallback substituted the
  // safe value and so hid the hostile document instead of reporting it.
  const id = authoritativeId(actor.id, res.url);
  if (!id)
    throw new Error(
      `Actor id is not authoritative for the host that served it (${res.url})`,
    );
  const icon = extractImage(actor.icon);
  // `authoritativeId` has already parsed it as an http(s) URL.
  const host = new URL(id).hostname;

  return {
    reader: "outbox",
    apiAccountId: null,
    id,
    name: typeof actor.name === "string" ? actor.name : null,
    preferredUsername:
      typeof actor.preferredUsername === "string"
        ? actor.preferredUsername
        : null,
    summary:
      typeof actor.summary === "string" ? stripHtml(actor.summary) : null,
    icon,
    outbox,
    url: typeof actor.url === "string" ? actor.url : null,
    host,
  };
}

/**
 * The actor, read through the instance's client API. §2.9 holds on this door
 * too — `mastodonAccountIdentity` is the check.
 *
 * Returns null rather than throwing: the caller still has a real HTTP status
 * from the AP attempt and that is the better thing to report.
 */
async function fetchActorViaMastodonApi(
  actorUri: string,
): Promise<ActorMetadata | null> {
  const account = await fetchMastodonAccountByActorUri(actorUri);
  if (!account) return null;

  const identity = mastodonAccountIdentity(account, actorUri);
  if (!identity) return null;
  const { id, host } = identity;

  return {
    reader: "mastodon_api",
    apiAccountId: account.id,
    id,
    name: account.displayName,
    // The bare local part, to match what an AP actor's `preferredUsername`
    // holds — `normaliseNote` re-qualifies it with the host, and a handle
    // qualified twice would disagree with every row the outbox path wrote.
    preferredUsername: account.acct.split("@")[0] || null,
    summary: account.note ? stripHtml(account.note) : null,
    icon: account.avatar,
    outbox: null,
    url: account.url,
    host,
  };
}

function extractImage(obj: any): string | null {
  if (!obj) return null;
  if (typeof obj === "string") return obj;
  if (typeof obj.url === "string") return obj.url;
  if (Array.isArray(obj) && obj.length > 0) return extractImage(obj[0]);
  return null;
}

// =============================================================================
// Outbox pagination
//
// Mastodon's outbox is an OrderedCollection whose `first` is a URL (or inline
// page). Each page is an OrderedCollectionPage with `orderedItems` and a
// `next` URL. We paginate newest → oldest, stopping when we reach the
// cursor (the id of the newest item from the previous poll) or the cutoff.
// =============================================================================

interface OutboxFetchOptions {
  outboxUrl: string;
  cursor: string | null; // newest seen id URI from previous poll
  cutoffMs: number; // don't page older than this (epoch ms)
  maxPages: number;
  itemsPerPage: number;
  /** The per-poll cap on items handed back. See `planActivityPubBatch`. */
  maxItems: number;
}

interface OutboxFetchResult {
  /** The items to process this run — the OLDEST `maxItems` of what the walk saw, newest first. */
  items: NormalisedActivityPubItem[];
  reposts: DetectedRepost[]; // Announce boosts seen this run (UNIVERSAL-POST §2.2)
  /** Id of the newest item the caller is being handed, in this arm's own id-space. */
  newCursor: string | null;
  /** How many newer items the cap left for the next poll. */
  deferred: number;
}

// =============================================================================
// A CAP THAT DISCARDS ROWS KEEPS THE OLDEST, OR THE CURSOR LIES ABOUT THEM
// (CA-C1, 2026-09-29; the rule is `planNostrPollBatch`'s).
//
// Both walks run newest-first and can hand back up to maxPages × itemsPerPage
// items (400 by default — a first poll's 24h backfill, or the 7-day cutoff
// after a long backoff). The task then kept the NEWEST `maxItems` and wrote
// the cursor as the newest item SEEN, so everything past the cap fell into a
// gap the next poll — which stops at that cursor — never revisits. Permanent,
// silent, and worse the busier the author.
//
// So the cap is applied HERE, over what the walk considered, and it keeps the
// OLDEST `maxItems`: the cursor stops at the newest item actually handed over,
// and the next poll walks down to it and picks up the remainder. Which id that
// is belongs to the ARM — the outbox anchors on the Create ACTIVITY id (the
// walk stops on `activity.id`), the client API on the status uri — which is
// why the cursor is decided beside the walk rather than by the task from the
// item's `sourceItemUri`.
//
// Three corollaries, as for nostr. ONE cap over everything the cursor governs
// (an entry the walk accepted but could not normalise is still a position in
// the outbox and still carries its cursor id). The cursor is a max over what
// was CONSIDERED, so a kept entry whose item is null still moves it. And an
// entry with no id cannot be the cursor, so the newest kept entry that HAS one
// is — the entries newer than it inside the batch are simply re-seen next
// poll, which every writer tolerates (`ON CONFLICT` on `source_item_uri`).
// Reposts ride outside the cap: `recordRepostEdge` is idempotent on its origin
// uri, so a boost re-seen next poll costs a no-op, not a duplicate.
// =============================================================================
export interface ActivityPubSeenEntry {
  /** This entry's id in the walk's own cursor id-space, or null if it has none. */
  cursorId: string | null;
  /** The normalised item, or null where the walk accepted the entry but could not normalise it. */
  item: NormalisedActivityPubItem | null;
}

export interface ActivityPubBatchPlan {
  items: NormalisedActivityPubItem[];
  newCursor: string | null;
  deferred: number;
}

/** `seen` is newest-first, as both walks produce it. */
export function planActivityPubBatch(
  seen: ActivityPubSeenEntry[],
  maxItems: number,
): ActivityPubBatchPlan {
  const cap = Math.max(0, maxItems);
  const kept = seen.length > cap ? seen.slice(seen.length - cap) : seen;
  const deferred = seen.length - kept.length;
  const items: NormalisedActivityPubItem[] = [];
  for (const entry of kept) if (entry.item) items.push(entry.item);
  const newCursor = kept.find((e) => e.cursorId !== null)?.cursorId ?? null;
  return { items, newCursor, deferred };
}

// An `Announce` activity is a boost of another object — no body of its own — so
// it is a RepostEdge, not a THING. `actor` is the booster; the announced object
// uri is the boosted THING; the activity id is the boost's own origin id.
export function detectActivityPubRepost(activity: any): DetectedRepost | null {
  if (activity?.type !== "Announce") return null;
  if (!isPublic(activity)) return null;
  const actor =
    typeof activity.actor === "string"
      ? activity.actor
      : typeof activity.actor?.id === "string"
        ? activity.actor.id
        : null;
  const objectUri =
    typeof activity.object === "string"
      ? activity.object
      : typeof activity.object?.id === "string"
        ? activity.object.id
        : null;
  if (!actor || !objectUri) return null;
  return {
    protocol: "activitypub",
    targetProtocol: "activitypub",
    targetHandle: objectUri,
    actorHandle: actor,
    boostedAt: parseDate(activity.published) ?? new Date(),
    originUri: typeof activity.id === "string" ? activity.id : null,
  };
}

export async function fetchOutbox(
  actor: ActorMetadata,
  opts: OutboxFetchOptions,
): Promise<OutboxFetchResult> {
  // First request resolves the collection → its first page.
  const firstPageUrl = await resolveFirstPageUrl(
    opts.outboxUrl,
    opts.itemsPerPage,
  );

  const seen: ActivityPubSeenEntry[] = [];
  const reposts: DetectedRepost[] = [];
  let nextUrl: string | null = firstPageUrl;
  let reachedCursor = false;
  // Require this many consecutive below-cutoff items before giving up on the
  // remaining pages. Mastodon outboxes can contain scheduled (future)
  // publishes, edited-and-reordered items, or per-page ordering jitter — a
  // single stray older item at the top of a page shouldn't truncate the
  // whole run.
  const CUTOFF_STREAK_THRESHOLD = 5;
  let cutoffStreak = 0;

  for (
    let page = 0;
    page < opts.maxPages && nextUrl && !reachedCursor;
    page++
  ) {
    const { res } = await fetchApDocument(nextUrl);
    if (!res.ok)
      throw new ApFetchStatusError(
        `Outbox page returned HTTP ${res.status}`,
        res.status,
      );

    let body: any;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new Error("Outbox page is not valid JSON");
    }

    const orderedItems: any[] = Array.isArray(body.orderedItems)
      ? body.orderedItems
      : [];
    for (const activity of orderedItems) {
      const activityType =
        typeof activity?.type === "string" ? activity.type : null;
      const activityId = typeof activity?.id === "string" ? activity.id : null;

      // Cursor dedup: stop as soon as we see the previous newest.
      if (opts.cursor && activityId === opts.cursor) {
        reachedCursor = true;
        break;
      }

      // Announce (boost) → a RepostEdge, not a THING (UNIVERSAL-POST §2.2 /
      // Phase 0c). Detect before the Create filter below drops it. The boost
      // does not advance the cursor (it's not a Create we anchor dedup on) and
      // does not count toward the item cutoff streak.
      if (activityType === "Announce") {
        const repost = detectActivityPubRepost(activity);
        if (repost) reposts.push(repost);
        continue;
      }

      // We only ingest public Create→Note activities. Everything else
      // (Update, Delete, Follow, Like) is out of scope for read-only v1
      // ingestion.
      if (activityType !== "Create") continue;
      if (!isPublic(activity)) continue;
      const note = activity.object;
      if (!note || typeof note !== "object") continue;
      if (
        note.type !== "Note" &&
        note.type !== "Article" &&
        note.type !== "Page"
      )
        continue;
      if (!isPublic(note)) continue;

      const publishedAt =
        parseDate(note.published) ??
        parseDate(activity.published) ??
        new Date();
      if (publishedAt.getTime() < opts.cutoffMs) {
        // Older than cutoff — count the streak. Only stop once we've seen
        // several in a row (handles stray out-of-order items gracefully).
        cutoffStreak++;
        if (cutoffStreak >= CUTOFF_STREAK_THRESHOLD) {
          reachedCursor = true;
          break;
        }
        continue;
      }
      cutoffStreak = 0;

      // Only activities we actually accept are cursor positions — anchoring to
      // a skipped Announce or non-public note means a future change to that
      // activity (which we never ingest) could break dedup. Which of them the
      // cursor lands on is `planActivityPubBatch`'s decision, after the cap.
      const normalised = normaliseNote(actor, activity, note, publishedAt);
      seen.push({ cursorId: activityId, item: normalised });
    }

    // A PAGER IS NEVER STEERED OFF THE INSTANCE IT STARTED ON. `body.next` is
    // a string a remote server chose, and this loop follows it — so without
    // this check a hostile (or merely misconfigured) outbox walks us onto any
    // host it names, up to `maxPages` times, with the actor's authority
    // travelling along in the caller's head. `parseNextLink` — the follow-graph
    // pager, one file over in the gateway — has refused a cross-origin
    // `rel=next` for exactly this reason since it was written; the two pagers
    // now agree. `safeFetch` bounds what the damage can be to "a public URL we
    // fetched", which is why this was a P3 and not a hole.
    nextUrl = sameOriginPageUrl(body.next, nextUrl);
  }

  return { ...planActivityPubBatch(seen, opts.maxItems), reposts };
}

async function resolveFirstPageUrl(
  outboxUrl: string,
  itemsPerPage: number,
): Promise<string> {
  const { res } = await fetchApDocument(outboxUrl);
  if (!res.ok)
    throw new ApFetchStatusError(
      `Outbox returned HTTP ${res.status}`,
      res.status,
    );
  let body: any;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error("Outbox is not valid JSON");
  }

  // Some servers embed the first page inline; others return a URL. Either way
  // it is origin-checked against the outbox that named it, for the reason the
  // `next` link is: this is the collection's OWN first page, and a collection
  // that points its first page at another host is not describing itself.
  if (typeof body.first === "string") {
    const first = sameOriginPageUrl(body.first, outboxUrl);
    if (!first) throw new Error("Outbox first page is not on the outbox's host");
    // Append a page size hint (Mastodon honours `?page=true&limit=...`).
    const u = new URL(first);
    if (!u.searchParams.has("limit"))
      u.searchParams.set("limit", String(itemsPerPage));
    return u.toString();
  }
  if (
    body.first &&
    typeof body.first === "object" &&
    typeof body.first.id === "string"
  ) {
    const first = sameOriginPageUrl(body.first.id, outboxUrl);
    if (!first) throw new Error("Outbox first page is not on the outbox's host");
    return first;
  }
  // Last resort: some instances only return OrderedCollectionPage directly.
  //
  // ORIGIN-CHECKED LIKE THE TWO ARMS ABOVE (§0ab item 7). This one returned
  // `body.id` on the document's own word, so a collection naming a foreign id
  // steered page 0 off the instance the poll started on — the very thing
  // `sameOriginPageUrl` exists to refuse, left open on the one arm where the
  // document is describing ITSELF and the check is therefore cheapest to
  // believe unnecessary. The outbox URL we asked for is the authority, not the
  // id the answer claims.
  if (typeof body.id === "string" && Array.isArray(body.orderedItems)) {
    const first = sameOriginPageUrl(body.id, outboxUrl);
    if (!first) throw new Error("Outbox first page is not on the outbox's host");
    return first;
  }
  throw new Error("Outbox has no first page URL");
}

/**
 * A page URL a remote collection named, accepted only if it is on the same
 * origin as the page that named it.
 *
 * Relative is resolved against `from` (conformant, and common on smaller
 * implementations); anything that parses to a different scheme, host or port
 * is REFUSED rather than rewritten, because a rewrite would invent a URL the
 * server never offered. Null means "stop paging", which is what every caller
 * here already does with an absent `next`.
 */
export function sameOriginPageUrl(
  candidate: unknown,
  from: string,
): string | null {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const url = new URL(candidate, from);
    if (url.origin !== new URL(from).origin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// =============================================================================
// Mastodon client-API timeline — the reader for a secure-mode instance
//
// Same contract as `fetchOutbox`, same id-space: `Status.uri` IS the federated
// ActivityPub id, so a source that switches between the two readers keeps one
// `source_item_uri` and dedups against itself.
//
// Three things differ, and each is handled rather than papered over.
//
// THE CURSOR. The outbox anchors dedup on the Create ACTIVITY id; the client
// API has no activity ids, so this anchors on the status uri. A source that
// changes reader therefore fails to match its stored cursor exactly once and
// pages to the cutoff instead — more work for one run, and nothing worse,
// because every insert is idempotent on `(protocol, source_item_uri)`.
//
// THE REPLY PARENT. The outbox gives `inReplyTo` as a URI; the client API
// gives `in_reply_to_id`, an instance-local number that is in nobody's
// id-space. It is resolved with a capped, deduped batch of status fetches —
// and where it cannot be resolved THE REPLY IS SKIPPED, never inserted with a
// null parent. A reply filed as a root is not a smaller feed, it is a wrong
// one: it renders as somebody starting a conversation they were answering, and
// it becomes a dedup root of its own. The shortfall is counted and logged.
//
// VISIBILITY. The outbox filter admits anything with `Public` in to/cc, which
// is public AND unlisted; `visibility` is the same two values by another name.
// =============================================================================

const TIMELINE_VISIBILITY = new Set(["public", "unlisted"]);

// Per-run ceiling on the extra fetches spent recovering reply parents. A busy
// account answering a thread can put 40 replies in one page, and this reader
// is the fallback on instances that already rate-limit us.
const PARENT_RESOLVE_CAP = 15;

export async function fetchMastodonTimeline(
  actor: ActorMetadata,
  opts: Omit<OutboxFetchOptions, "outboxUrl">,
): Promise<OutboxFetchResult> {
  if (!actor.apiAccountId)
    throw new Error("Mastodon timeline read needs an instance account id");
  const apiOrigin = new URL(actor.id).origin;

  const seen: ActivityPubSeenEntry[] = [];
  const reposts: DetectedRepost[] = [];
  let reachedCursor = false;
  let cutoffStreak = 0;
  const CUTOFF_STREAK_THRESHOLD = 5;

  // Parent uri cache — one entry per distinct local id across the whole run,
  // so a thread of replies to the same post costs one fetch, not one each.
  const parentUris = new Map<string, string | null>();
  let parentBudget = PARENT_RESOLVE_CAP;
  let droppedReplies = 0;

  let maxId: string | undefined;
  for (
    let page = 0;
    page < opts.maxPages && !reachedCursor;
    page++
  ) {
    const statuses = await fetchMastodonStatuses(
      apiOrigin,
      actor.apiAccountId,
      opts.itemsPerPage,
      { maxId },
    );
    // A failed page is a failure of the RUN — the caller's error budget and
    // backoff are the right place for it, and returning a short list would
    // advance the cursor past posts we never saw.
    if (statuses === null)
      throw new Error("Mastodon statuses page could not be read");
    if (statuses.length === 0) break;

    for (const status of statuses) {
      if (opts.cursor && status.uri === opts.cursor) {
        reachedCursor = true;
        break;
      }

      // A boost is an edge, not a thing (UNIVERSAL-POST §2.2) — same split the
      // outbox reader makes on `Announce`, and likewise it neither advances
      // the cursor nor counts toward the cutoff streak.
      if (status.reblog) {
        const boosted = status.reblog;
        reposts.push({
          protocol: "activitypub",
          targetProtocol: "activitypub",
          targetHandle: boosted.uri,
          actorHandle: actor.id,
          boostedAt: status.createdAt,
          originUri: status.uri,
        });
        continue;
      }

      if (!TIMELINE_VISIBILITY.has(status.visibility ?? "")) continue;

      if (status.createdAt.getTime() < opts.cutoffMs) {
        cutoffStreak++;
        if (cutoffStreak >= CUTOFF_STREAK_THRESHOLD) {
          reachedCursor = true;
          break;
        }
        continue;
      }
      cutoffStreak = 0;

      // §2.9, exactly as `normaliseNote` applies it: a status served under
      // this actor may only claim an id on the actor's own origin.
      const id = authoritativeId(status.uri, actor.id);
      if (!id) {
        logger.warn(
          { actorId: actor.id, statusUri: status.uri },
          "Mastodon status uri is not authoritative for its actor's origin; skipping",
        );
        continue;
      }

      let replyUri: string | null = null;
      if (status.inReplyToId) {
        replyUri = await resolveParentUri(
          apiOrigin,
          status.inReplyToId,
          parentUris,
          () => {
            if (parentBudget <= 0) return false;
            parentBudget--;
            return true;
          },
        );
        if (!replyUri) {
          droppedReplies++;
          continue;
        }
      }

      // The status uri is this arm's cursor id-space (see the header); the
      // cursor itself is chosen by `planActivityPubBatch`, after the cap.
      seen.push({
        cursorId: id,
        item: normaliseMastodonStatus(actor, status, id, replyUri),
      });
    }

    maxId = statuses[statuses.length - 1]?.id;
    if (!maxId) break;
  }

  if (droppedReplies > 0) {
    logger.warn(
      { actorId: actor.id, droppedReplies, cap: PARENT_RESOLVE_CAP },
      "Mastodon timeline: replies skipped — parent uri unresolved (a reply is not inserted as a root)",
    );
  }

  return { ...planActivityPubBatch(seen, opts.maxItems), reposts };
}

async function resolveParentUri(
  apiOrigin: string,
  localId: string,
  cache: Map<string, string | null>,
  spendBudget: () => boolean,
): Promise<string | null> {
  const cached = cache.get(localId);
  if (cached !== undefined) return cached;
  if (!spendBudget()) return null;
  const parent = await fetchMastodonStatusById(apiOrigin, localId);
  const uri = parent?.uri ?? null;
  cache.set(localId, uri);
  return uri;
}

/**
 * The author fields come off the ACTOR, never off `status.account`.
 *
 * One activitypub source is one author, so the ingest rule resolves the name
 * through the source (`UNIVERSAL-FEED-ADR` §V.1 / the author-name agreement
 * invariant) — and `normaliseNote` spells it exactly this way. Reading
 * `status.account.display_name` here instead would make the two readers
 * disagree about the same row, which is the shape that makes the nightly
 * author-name pass flap: it rewrites the row at 04:00 and the next re-ingest
 * writes it straight back, for ever, reporting drift it caused itself.
 */
function normaliseMastodonStatus(
  actor: ActorMetadata,
  status: MastodonStatus,
  id: string,
  replyUri: string | null,
): NormalisedActivityPubItem {
  const contentWarning =
    status.sensitive && status.spoilerText?.trim()
      ? status.spoilerText
      : null;

  return {
    sourceItemUri: id,
    title: null,
    authorName: actor.name,
    authorHandle: actor.preferredUsername
      ? `${actor.preferredUsername}@${actor.host}`
      : null,
    authorAvatarUrl: actor.icon,
    authorUri: actor.id,
    contentText: stripHtml(status.contentHtml),
    contentHtml: sanitizeContent(status.contentHtml),
    language: status.language,
    media: status.media.map((m) => ({
      type:
        m.type === "image"
          ? "image"
          : m.type === "video" || m.type === "gifv"
            ? "video"
            : m.type === "audio"
              ? "audio"
              : "link",
      url: m.url,
      thumbnail: m.preview_url ?? undefined,
      alt: m.description ?? undefined,
      width: m.meta?.original?.width,
      height: m.meta?.original?.height,
    })),
    sourceReplyUri: replyUri,
    sourceQuoteUri: status.quoteUri,
    contentWarning,
    publishedAt: status.createdAt,
    webUrl: status.url,
    interactionData: {
      id,
      replyTo: replyUri ?? undefined,
      webUrl: status.url ?? undefined,
      ...(status.poll ? { poll: status.poll } : {}),
    },
  };
}

// =============================================================================
// Visibility — Mastodon marks public posts with `Public` in to/cc.
// =============================================================================

function isPublic(obj: any): boolean {
  const to = normaliseAudience(obj?.to);
  const cc = normaliseAudience(obj?.cc);
  return to.includes(PUBLIC_URI) || cc.includes(PUBLIC_URI);
}

function normaliseAudience(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string");
  return [];
}

// =============================================================================
// Note normaliser
// =============================================================================

function normaliseNote(
  actor: ActorMetadata,
  activity: any,
  note: any,
  publishedAt: Date,
): NormalisedActivityPubItem | null {
  // A note arrives through this actor's outbox, so the actor's own origin is
  // the authority for the id it claims (§2.9). A `Create` naming another
  // instance's status id would file the post under that host's item — and,
  // inserted first, `DO NOTHING`-suppress the genuine one for ever.
  const id = authoritativeId(note.id, actor.id);
  if (!id) {
    // A skipped note is otherwise indistinguishable from an absent one, and
    // this is the half of §2.9 that persists as a suppressed genuine post.
    if (typeof note.id === "string")
      logger.warn(
        { actorId: actor.id, noteId: note.id },
        "ActivityPub note id is not authoritative for its actor's origin; skipping",
      );
    return null;
  }

  const title =
    typeof note.name === "string" && note.name.trim() ? note.name.trim() : null;
  const rawHtml = typeof note.content === "string" ? note.content : "";
  const contentHtml = sanitizeContent(rawHtml);
  const contentText = stripHtml(rawHtml);

  const media = extractAttachments(note.attachment);
  const sourceReplyUri =
    typeof note.inReplyTo === "string" ? note.inReplyTo : null;
  const sourceQuoteUri = extractQuoteUri(note);

  const webUrl = typeof note.url === "string" ? note.url : null;
  const language = extractLanguage(note);
  const contentWarning =
    note.sensitive === true &&
    typeof note.summary === "string" &&
    note.summary.trim().length > 0
      ? note.summary
      : null;

  const audience =
    typeof note.audience === "string" ? note.audience : undefined;
  const poll = extractPoll(note);

  return {
    sourceItemUri: id,
    title,
    authorName: actor.name,
    authorHandle: actor.preferredUsername
      ? `${actor.preferredUsername}@${actor.host}`
      : null,
    authorAvatarUrl: actor.icon,
    authorUri: actor.id,
    contentText,
    contentHtml,
    language,
    media,
    sourceReplyUri,
    sourceQuoteUri,
    contentWarning,
    publishedAt,
    webUrl,
    interactionData: {
      id,
      activityId: typeof activity?.id === "string" ? activity.id : undefined,
      replyTo: sourceReplyUri ?? undefined,
      webUrl: webUrl ?? undefined,
      ...(audience ? { audience } : {}),
      ...(poll ? { poll } : {}),
    },
  };
}

// Quote posts have no single standard yet. Mastodon's forthcoming support and
// FEP-044f use `quote`; Fedibird uses `quoteUrl`; Misskey uses `_misskey_quote`
// (and a `quoteUri` alias). Each may be a bare URI string or an object with an
// `id`/`href`. Probe the known keys and return the first usable URI.
export function extractQuoteUri(note: any): string | null {
  const candidates = [
    note?.quote,
    note?.quoteUrl,
    note?.quoteUri,
    note?._misskey_quote,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (c && typeof c === "object") {
      const uri = typeof c.id === "string" ? c.id : c.href;
      if (typeof uri === "string" && uri.trim()) return uri.trim();
    }
  }
  return null;
}

function extractPoll(note: any): {
  options: Array<{ title: string; votesCount: number }>;
  multiple: boolean;
  expiresAt: string | null;
  closed: boolean;
} | null {
  const choices = Array.isArray(note.oneOf)
    ? note.oneOf
    : Array.isArray(note.anyOf)
      ? note.anyOf
      : null;
  if (!choices || choices.length === 0) return null;

  const multiple = Array.isArray(note.anyOf) && note.anyOf.length > 0;
  const options = choices
    .filter((c: any) => c && typeof c.name === "string")
    .map((c: any) => ({
      title: c.name as string,
      votesCount:
        typeof c.replies?.totalItems === "number" ? c.replies.totalItems : 0,
    }));

  if (options.length === 0) return null;

  const expiresAt = typeof note.endTime === "string" ? note.endTime : null;
  const closed =
    typeof note.closed === "string" ||
    (expiresAt !== null && new Date(expiresAt).getTime() < Date.now());

  return { options, multiple, expiresAt, closed };
}

function extractAttachments(raw: unknown): MediaAttachment[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const media: MediaAttachment[] = [];
  for (const att of arr) {
    if (!att || typeof att !== "object") continue;
    const a: any = att;
    const url =
      typeof a.url === "string"
        ? a.url
        : typeof a.href === "string"
          ? a.href
          : Array.isArray(a.url) && typeof a.url[0]?.href === "string"
            ? a.url[0].href
            : null;
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const mime = typeof a.mediaType === "string" ? a.mediaType : undefined;
    const type = inferType(a.type, mime);
    media.push({
      type,
      url,
      thumbnail: extractImage(a.icon) ?? undefined,
      alt: typeof a.name === "string" ? a.name : undefined,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
      mime_type: mime,
    });
  }
  return media;
}

function inferType(
  apType: unknown,
  mime: string | undefined,
): "image" | "video" | "audio" | "link" {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const t = typeof apType === "string" ? apType.toLowerCase() : "";
  if (t.includes("image")) return "image";
  if (t.includes("video")) return "video";
  if (t.includes("audio")) return "audio";
  return "link";
}

function extractLanguage(note: any): string | null {
  if (typeof note?.contentMap === "object" && note.contentMap) {
    const keys = Object.keys(note.contentMap);
    if (keys.length > 0) return keys[0];
  }
  return null;
}

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return d;
}
