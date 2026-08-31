import Parser from "rss-parser";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  sanitizeContent,
  stripHtml,
} from "@platform-pub/shared/lib/sanitize.js";

// =============================================================================
// RSS / Atom ingestion adapter
//
// Fetches an RSS or Atom feed, parses items, and returns normalised rows
// ready for INSERT INTO external_items.
// =============================================================================

type RssItemExtras = {
  mediaContent: unknown;
  mediaThumbnail: unknown;
  "content:encoded"?: string;
  author?: string;
  "itunes:duration"?: string;
  "itunes:image"?: unknown;
  "itunes:author"?: string;
  "itunes:summary"?: string;
  "itunes:episode"?: string;
  "itunes:season"?: string;
  "podcast:transcript"?: unknown;
  "podcast:chapters"?: unknown;
};

const parser = new Parser<Record<string, never>, RssItemExtras>({
  timeout: 10_000,
  maxRedirects: 3,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      "content:encoded",
      "author",
      "itunes:duration",
      "itunes:image",
      "itunes:author",
      "itunes:summary",
      "itunes:episode",
      "itunes:season",
      "podcast:transcript",
      "podcast:chapters",
    ],
  },
});

interface RssFetchOptions {
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
}

interface RssFetchResult {
  items: NormalisedItem[];
  etag?: string;
  lastModified?: string;
  feedTitle?: string;
  feedDescription?: string;
  notModified: boolean;
}

interface NormalisedItem {
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  summary: string | null;
  title: string | null;
  language: string | null;
  media: MediaAttachment[];
  interactionData?: Record<string, unknown>;
  publishedAt: Date;
}

interface MediaAttachment {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  title?: string;
  description?: string;
  duration_in_seconds?: number;
  size_in_bytes?: number;
}

export async function fetchRssFeed(
  options: RssFetchOptions,
): Promise<RssFetchResult> {
  const headers: Record<string, string> = {
    Accept:
      "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  const response = await safeFetch(options.feedUrl, { headers });

  if (response.status === 304) {
    return { items: [], notModified: true };
  }

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}`);
  }

  // JSON Feed detection: content-type or shape-sniff
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/feed+json") || ct.includes("application/json")) {
    try {
      return parseJsonFeed(response.text, response);
    } catch {
      // Fall through to rss-parser — might be JSON-shaped but not a JSON Feed
    }
  } else if (!ct || ct.includes("text/plain")) {
    // Some feeds serve as text/plain — try JSON parse as fallback
    try {
      const probe = JSON.parse(response.text);
      if (
        typeof probe === "object" &&
        probe !== null &&
        typeof probe.version === "string" &&
        probe.version.startsWith("https://jsonfeed.org/version/")
      ) {
        return parseJsonFeed(response.text, response);
      }
    } catch {
      // Not JSON — fall through to rss-parser
    }
  }

  const feed = await parser.parseString(response.text);

  const feedImageUrl = feed.itunes?.image ?? undefined;

  const items: NormalisedItem[] = [];
  for (const entry of feed.items ?? []) {
    const guid = entry.guid ?? entry.link;
    if (!guid) continue;

    const rawHtml =
      entry["content:encoded"] ?? entry.content ?? entry.summary ?? "";
    const contentHtml = rawHtml ? sanitizeContent(rawHtml) : null;
    const contentText = rawHtml ? stripHtml(rawHtml) : null;
    const summaryText = entry.summary
      ? stripHtml(entry.summary)
      : entry["itunes:summary"]
        ? stripHtml(entry["itunes:summary"])
        : null;

    const media = extractMedia(entry, feedImageUrl);

    const interactionData = buildPodcastInteractionData(entry);

    // new Date(badString) yields an Invalid Date (getTime() === NaN), it does
    // NOT throw — so the old try/catch was dead code and `NaN > x` is false, so
    // an Invalid Date slipped through, poisoned the batched INSERT, failed the
    // whole fetch, and after ~10 polls deactivated the source. Guard on isNaN
    // (matching the AP/atproto adapters).
    let publishedAt = entry.pubDate
      ? new Date(entry.pubDate)
      : entry.isoDate
        ? new Date(entry.isoDate)
        : new Date();
    if (isNaN(publishedAt.getTime())) {
      publishedAt = new Date();
    }
    // Reject dates in the far future (likely parsing errors)
    if (publishedAt.getTime() > Date.now() + 86_400_000) {
      publishedAt = new Date();
    }

    items.push({
      sourceItemUri: guid,
      authorName:
        entry.creator ??
        entry.author ??
        entry["itunes:author"] ??
        feed.itunes?.author ??
        null,
      authorHandle: null,
      authorUri: null,
      contentText,
      contentHtml,
      summary: summaryText,
      title: entry.title ?? null,
      language: null,
      media,
      ...(interactionData && { interactionData }),
      publishedAt,
    });
  }

  return {
    items,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    feedTitle: feed.title ?? undefined,
    feedDescription: feed.description ?? undefined,
    notModified: false,
  };
}

function buildPodcastInteractionData(
  entry: any,
): Record<string, unknown> | undefined {
  const chaptersRaw = entry["podcast:chapters"];
  const transcriptRaw = entry["podcast:transcript"];
  const episode = entry["itunes:episode"];
  const season = entry["itunes:season"];

  const chaptersUrl =
    typeof chaptersRaw === "object" && chaptersRaw !== null
      ? (chaptersRaw.$ ?? chaptersRaw).url
      : undefined;
  const transcriptUrl =
    typeof transcriptRaw === "object" && transcriptRaw !== null
      ? (transcriptRaw.$ ?? transcriptRaw).url
      : undefined;

  const data: Record<string, unknown> = {};
  if (chaptersUrl) data.chaptersUrl = chaptersUrl;
  if (transcriptUrl) data.transcriptUrl = transcriptUrl;
  if (episode) data.episode = parseInt(episode, 10) || undefined;
  if (season) data.season = parseInt(season, 10) || undefined;

  return Object.keys(data).length > 0 ? data : undefined;
}

function extractItunesImageUrl(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    const href = (raw as any).$ ? (raw as any).$.href : (raw as any).href;
    if (typeof href === "string" && /^https?:\/\//i.test(href)) return href;
  }
  return undefined;
}

function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (!isNaN(asNum) && asNum >= 0) return Math.round(asNum);
  const parts = trimmed.split(":").map(Number);
  if (parts.some(isNaN)) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function extractMedia(entry: any, feedImageUrl?: string): MediaAttachment[] {
  const media: MediaAttachment[] = [];

  const duration = parseDuration(entry["itunes:duration"]);
  const episodeImage = extractItunesImageUrl(entry["itunes:image"]);

  // <enclosure> elements
  if (entry.enclosure) {
    const enc = entry.enclosure;
    if (enc.url && /^https?:\/\//i.test(enc.url)) {
      const type = inferMediaType(enc.type ?? "");
      media.push({
        type,
        url: enc.url,
        mime_type: enc.type ?? undefined,
        ...(type === "audio" && {
          duration_in_seconds: duration,
          size_in_bytes: enc.length
            ? parseInt(enc.length, 10) || undefined
            : undefined,
          thumbnail: episodeImage ?? feedImageUrl,
        }),
      });
    }
  }

  // <media:content> elements
  if (Array.isArray(entry.mediaContent)) {
    for (const mc of entry.mediaContent) {
      const attrs = mc.$ ?? mc;
      if (attrs.url && /^https?:\/\//i.test(attrs.url)) {
        media.push({
          type: inferMediaType(attrs.medium ?? attrs.type ?? ""),
          url: attrs.url,
          width: attrs.width ? parseInt(attrs.width, 10) : undefined,
          height: attrs.height ? parseInt(attrs.height, 10) : undefined,
          mime_type: attrs.type ?? undefined,
        });
      }
    }
  }

  // <media:thumbnail>
  if (entry.mediaThumbnail) {
    const thumb = entry.mediaThumbnail.$ ?? entry.mediaThumbnail;
    if (thumb.url && /^https?:\/\//i.test(thumb.url) && media.length > 0) {
      media[0].thumbnail = thumb.url;
    } else if (thumb.url && /^https?:\/\//i.test(thumb.url)) {
      media.push({ type: "image", url: thumb.url });
    }
  }

  return media;
}

function inferMediaType(hint: string): "image" | "video" | "audio" | "link" {
  const h = hint.toLowerCase();
  if (h.includes("image") || h === "image") return "image";
  if (h.includes("video") || h === "video") return "video";
  if (h.includes("audio") || h === "audio") return "audio";
  return "link";
}

// =============================================================================
// JSON Feed (https://jsonfeed.org/version/1.1) parser
// =============================================================================

interface JsonFeedItem {
  id?: string;
  url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  date_modified?: string;
  authors?: Array<{ name?: string; url?: string }>;
  author?: { name?: string; url?: string };
  language?: string;
  image?: string;
  banner_image?: string;
  attachments?: Array<{
    url?: string;
    mime_type?: string;
    title?: string;
    size_in_bytes?: number;
    duration_in_seconds?: number;
  }>;
}

interface JsonFeed {
  version: string;
  title?: string;
  description?: string;
  language?: string;
  items?: JsonFeedItem[];
}

function parseJsonFeed(
  text: string,
  response: { headers: Headers },
): RssFetchResult {
  const feed: JsonFeed = JSON.parse(text);

  if (
    typeof feed.version !== "string" ||
    !feed.version.startsWith("https://jsonfeed.org/version/")
  ) {
    throw new Error("Not a JSON Feed");
  }

  const items: NormalisedItem[] = [];
  for (const entry of feed.items ?? []) {
    const id = entry.id ?? entry.url;
    if (!id) continue;

    const rawHtml = entry.content_html ?? "";
    const rawText = entry.content_text ?? "";
    const contentHtml = rawHtml ? sanitizeContent(rawHtml) : null;
    const contentText = rawText || (rawHtml ? stripHtml(rawHtml) : null);
    const summaryText = entry.summary ? stripHtml(entry.summary) : null;

    // JSON Feed 1.1 uses authors[]; 1.0 uses author
    const authorObj = entry.authors?.[0] ?? entry.author;

    const media: MediaAttachment[] = [];

    if (entry.image && /^https?:\/\//i.test(entry.image)) {
      media.push({ type: "image", url: entry.image });
    }
    if (entry.banner_image && /^https?:\/\//i.test(entry.banner_image)) {
      media.push({ type: "image", url: entry.banner_image });
    }

    for (const att of entry.attachments ?? []) {
      if (!att.url || !/^https?:\/\//i.test(att.url)) continue;
      media.push({
        type: inferMediaType(att.mime_type ?? ""),
        url: att.url,
        mime_type: att.mime_type ?? undefined,
        title: att.title ?? undefined,
        duration_in_seconds: att.duration_in_seconds ?? undefined,
        size_in_bytes: att.size_in_bytes ?? undefined,
      });
    }

    // As above: new Date(bad) is an Invalid Date, not a throw — guard on isNaN.
    let publishedAt = entry.date_published
      ? new Date(entry.date_published)
      : new Date();
    if (isNaN(publishedAt.getTime())) {
      publishedAt = new Date();
    }
    if (publishedAt.getTime() > Date.now() + 86_400_000) {
      publishedAt = new Date();
    }

    items.push({
      sourceItemUri: id,
      authorName: authorObj?.name ?? null,
      authorHandle: null,
      authorUri: authorObj?.url ?? null,
      contentText,
      contentHtml,
      summary: summaryText,
      title: entry.title ?? null,
      language: entry.language ?? feed.language ?? null,
      media,
      publishedAt,
    });
  }

  return {
    items,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    feedTitle: feed.title ?? undefined,
    feedDescription: feed.description ?? undefined,
    notModified: false,
  };
}
