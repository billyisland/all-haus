import {
  sanitizeContent,
  stripHtml,
} from "@platform-pub/shared/lib/sanitize.js";

// =============================================================================
// Email newsletter adapter — normalises Postmark inbound webhook payloads
// into the standard NormalisedEmailItem shape for dual-write.
// =============================================================================

export interface PostmarkInboundPayload {
  From: string;
  FromFull: { Email: string; Name: string };
  To: string;
  ToFull: Array<{ Email: string; Name: string }>;
  Subject: string;
  HtmlBody: string;
  TextBody: string;
  MessageID: string;
  Date: string;
  Attachments: Array<{
    Name: string;
    Content: string;
    ContentType: string;
    ContentLength: number;
  }>;
  Headers: Array<{ Name: string; Value: string }>;
}

interface MediaAttachment {
  type: "image" | "video" | "audio" | "link";
  url: string;
  alt?: string;
}

export interface NormalisedEmailItem {
  sourceItemUri: string;
  title: string;
  authorName: string;
  authorHandle: string;
  contentText: string;
  contentHtml: string;
  canonicalUrl: string | null;
  media: MediaAttachment[];
  publishedAt: Date;
}

// Patterns that signal a "view in browser" link
const CANONICAL_LINK_PATTERNS =
  /view[\s._-]*(?:in|this|the)?[\s._-]*(?:browser|online|email)|read[\s._-]*online|web[\s._-]*version|open[\s._-]*in[\s._-]*browser/i;

const CANONICAL_HREF_PATTERNS =
  /\/view[-_]?in[-_]?browser|\/web[-_]?version|\?view=browser|\/archive\//i;

export function extractCanonicalUrl(html: string): string | null {
  // Match <a> tags and check both the anchor text/context and the href
  const anchorRegex =
    /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const innerText = match[2];
    if (
      CANONICAL_LINK_PATTERNS.test(innerText) ||
      CANONICAL_HREF_PATTERNS.test(href)
    ) {
      try {
        const url = new URL(href);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return href;
        }
      } catch {
        // Not a valid URL, skip
      }
    }
  }
  return null;
}

// Known tracking pixel patterns
const TRACKER_SRC_PATTERN =
  /pixel\.|\/track\/|\/open\/|open\.convertkit|list-manage\.com\/track|ct\.sendgrid\.net|clicks\.mlsend\.com|trk\.klclick\.|\.list-manage\.com\/track|email\.mg\d*\./i;

export function extractImages(html: string): MediaAttachment[] {
  const images: MediaAttachment[] = [];
  const imgRegex = /<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const src = match[1];

    // Skip tracking pixels (1x1 dimensions)
    if (/(?:width|height)\s*=\s*["']?1["']?/i.test(tag)) continue;
    // Skip known tracker domains
    if (TRACKER_SRC_PATTERN.test(src)) continue;
    // Skip data URIs and non-http(s)
    if (!/^https?:\/\//i.test(src)) continue;

    const altMatch = tag.match(/alt\s*=\s*["']([^"']*)["']/i);
    images.push({
      type: "image",
      url: src,
      ...(altMatch?.[1] ? { alt: altMatch[1] } : {}),
    });
  }
  return images;
}

export function sanitiseNewsletterHtml(html: string): string {
  let processed = html;

  // Strip tracking pixels
  processed = processed.replace(
    /<img\s[^>]*(?:(?:width|height)\s*=\s*["']?1["']?)[^>]*\/?>/gi,
    "",
  );
  processed = processed.replace(
    new RegExp(
      `<img\\s[^>]*src\\s*=\\s*["'][^"']*(?:${TRACKER_SRC_PATTERN.source})[^"']*["'][^>]*/?>`,
      "gi",
    ),
    "",
  );

  // Collapse table layout tags — preserves content, strips structure
  processed = processed.replace(
    /<\/?(table|tr|td|th|tbody|thead|tfoot|col|colgroup|caption)[^>]*>/gi,
    "",
  );

  // Strip MSO conditional comments (Outlook-specific)
  processed = processed.replace(/<!--\[if\s+mso[\s\S]*?<!\[endif\]-->/gi, "");

  // Run through the standard sanitiser
  return sanitizeContent(processed);
}

export function normaliseEmail(
  payload: PostmarkInboundPayload,
): NormalisedEmailItem {
  const authorName =
    payload.FromFull?.Name || payload.From?.replace(/<.*>/, "").trim() || "";
  const authorHandle =
    payload.FromFull?.Email ||
    payload.From?.match(/<([^>]+)>/)?.[1] ||
    payload.From ||
    "";

  const rawHtml = payload.HtmlBody || "";
  const canonicalUrl = rawHtml ? extractCanonicalUrl(rawHtml) : null;
  const media = rawHtml ? extractImages(rawHtml) : [];

  let contentHtml: string;
  let contentText: string;

  if (rawHtml) {
    contentHtml = sanitiseNewsletterHtml(rawHtml);
    contentText = stripHtml(rawHtml);
  } else {
    contentText = payload.TextBody || "";
    contentHtml = contentText
      .split(/\n\n+/)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  let publishedAt = new Date(payload.Date);
  if (isNaN(publishedAt.getTime())) {
    publishedAt = new Date();
  }

  return {
    sourceItemUri: payload.MessageID,
    title: payload.Subject || "(no subject)",
    authorName,
    authorHandle,
    contentText,
    contentHtml,
    canonicalUrl,
    media,
    publishedAt,
  };
}
