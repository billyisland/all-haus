import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
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

const AP_ACCEPT =
  'application/activity+json, application/ld+json;profile="https://www.w3.org/ns/activitystreams", application/json;q=0.9';
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

interface ActorMetadata {
  id: string;
  name: string | null;
  preferredUsername: string | null;
  summary: string | null;
  icon: string | null;
  outbox: string;
  url: string | null;
  // Instance host derived from actor id
  host: string;
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
  const res = await safeFetch(actorUri, { headers: { Accept: AP_ACCEPT } });
  if (!res.ok)
    throw new ApFetchStatusError(
      `Actor fetch returned HTTP ${res.status}`,
      res.status,
    );

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

  const id = typeof actor.id === "string" ? actor.id : actorUri;
  const icon = extractImage(actor.icon);
  let host: string;
  try {
    host = new URL(id).hostname;
  } catch {
    throw new Error("Invalid actor id URI");
  }

  return {
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
}

interface OutboxFetchResult {
  items: NormalisedActivityPubItem[];
  reposts: DetectedRepost[]; // Announce boosts seen this run (UNIVERSAL-POST §2.2)
  newCursor: string | null; // id of the newest item we saw this run
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

  const items: NormalisedActivityPubItem[] = [];
  const reposts: DetectedRepost[] = [];
  let nextUrl: string | null = firstPageUrl;
  let newCursor: string | null = null;
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
    const res = await safeFetch(nextUrl, { headers: { Accept: AP_ACCEPT } });
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

      // Advance cursor only for activities we actually accept — anchoring to
      // a skipped Announce or non-public note means a future change to that
      // activity (which we never ingest) could break dedup.
      if (newCursor === null && activityId) newCursor = activityId;

      const normalised = normaliseNote(actor, activity, note, publishedAt);
      if (normalised) items.push(normalised);
    }

    nextUrl = typeof body.next === "string" ? body.next : null;
  }

  return { items, reposts, newCursor };
}

async function resolveFirstPageUrl(
  outboxUrl: string,
  itemsPerPage: number,
): Promise<string> {
  const res = await safeFetch(outboxUrl, { headers: { Accept: AP_ACCEPT } });
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

  // Some servers embed the first page inline; others return a URL.
  if (typeof body.first === "string") {
    // Append a page size hint (Mastodon honours `?page=true&limit=...`).
    try {
      const u = new URL(body.first);
      if (!u.searchParams.has("limit"))
        u.searchParams.set("limit", String(itemsPerPage));
      return u.toString();
    } catch {
      return body.first;
    }
  }
  if (
    body.first &&
    typeof body.first === "object" &&
    typeof body.first.id === "string"
  ) {
    return body.first.id;
  }
  // Last resort: some instances only return OrderedCollectionPage directly.
  if (typeof body.id === "string" && Array.isArray(body.orderedItems)) {
    return body.id;
  }
  throw new Error("Outbox has no first page URL");
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
  const id = typeof note.id === "string" ? note.id : null;
  if (!id) return null;

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
