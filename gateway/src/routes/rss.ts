import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requirePublicationsEnabled } from "../middleware/publication-auth.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import { marked } from "marked";
import { sanitizeContent } from "@platform-pub/shared/lib/sanitize.js";
import { stripHtmlTags } from "../lib/external-items-shared.js";

// =============================================================================
// RSS Feed Routes
//
// Per ADR §II.6: "RSS/Atom output: all.haus writers' public posts
// available as RSS at launch, for distribution."
//
// Two feeds:
//   GET /rss/:username     — articles by a specific writer
//   GET /rss               — recent articles across the platform
//
// Only the free section (pre-gate) of paywalled articles is included in
// the RSS body. This is consistent with how paywalled content works in the
// Nostr ecosystem — the NIP-23 event only contains the free section.
//
// Feed format: RSS 2.0 (broader client support than Atom)
// =============================================================================

// THE BODY IS MARKDOWN, AND A FEED READER IS NOT A MARKDOWN RENDERER (CA-B5,
// 2026-09-29). `content_free` is what the editor's markdown serialiser wrote
// and what the NIP-23 event carries; `content:encoded` put it in raw, so every
// feed reader showed asterisks and brackets, and `description` ran a tag
// strip over text that had no tags. It is rendered here through `marked` and
// then through the shared sanitiser — the same allow-list every other HTML
// body on the site passes — so a feed reader gets the piece as the article
// page shows it and nothing the sanitiser refuses reaches a third-party
// renderer. The description is the rendered text, tags stripped.
//
// A PUBLICATION PIECE HIDDEN FROM THE PROFILE IS HIDDEN FROM THE WRITER'S
// FEED TOO: `show_on_writer_profile` is the same clause the profile counts
// carry (`writers.ts`). Moot while publications are suspended; kept in
// lockstep so it is true the day they are not.
function renderBody(markdown: string): string {
  return sanitizeContent(marked.parse(markdown, { async: false }));
}

// The gateway refuses to boot without APP_URL (`index.ts`), so this is read at
// call time, never with a fallback — a fallback here is a second spelling of a
// value that already has one home, and a module constant would freeze whatever
// the importing process had set at import.
const siteUrl = () => requireEnv("APP_URL");

export async function rssRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /rss/:username — writer-specific RSS feed
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    "/rss/:username",
    async (req, reply) => {
      const { username } = req.params;

      const writerResult = await pool.query<{
        id: string;
        display_name: string | null;
        bio: string | null;
      }>(
        `SELECT id, display_name, bio FROM accounts
         WHERE username = $1 AND status = 'active'`,
        [username],
      );

      if (writerResult.rows.length === 0) {
        return reply.status(404).send("Writer not found");
      }

      const writer = writerResult.rows[0];

      const { rows: articles } = await pool.query<{
        nostr_d_tag: string;
        title: string;
        summary: string | null;
        content_free: string | null;
        published_at: Date;
      }>(
        `SELECT nostr_d_tag, title, summary, content_free, published_at
         FROM articles
         WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL
           AND (publication_id IS NULL OR show_on_writer_profile = TRUE)
         ORDER BY published_at DESC
         LIMIT 20`,
        [writer.id],
      );

      const displayName = writer.display_name ?? username;
      const feedUrl = `${siteUrl()}/rss/${username}`;
      const writerUrl = `${siteUrl()}/${username}`;

      const xml = buildRssFeed({
        title: `${displayName} — all.haus`,
        description: writer.bio ?? `Articles by ${displayName} on all.haus`,
        link: writerUrl,
        feedUrl,
        items: articles.map((a) => ({
          title: a.title,
          link: `${siteUrl()}/article/${a.nostr_d_tag}`,
          description:
            a.summary ?? truncate(stripHtmlTags(renderBody(a.content_free ?? "")), 300),
          content: renderBody(a.content_free ?? ""),
          pubDate: a.published_at,
        })),
      });

      reply.header("Content-Type", "application/rss+xml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=600"); // 10 min cache
      return reply.send(xml);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/pub/:slug/rss — publication RSS feed
  // ---------------------------------------------------------------------------

  // Publications suspended 2026-08-31 — per-route gate, since the writer and
  // platform feeds above are siblings in this plugin and stay live. See env.ts.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/pub/:slug/rss",
    { preHandler: requirePublicationsEnabled() },
    async (req, reply) => {
      const { slug } = req.params;

      const pubResult = await pool.query<{
        id: string;
        name: string;
        tagline: string | null;
      }>(
        `SELECT id, name, tagline FROM publications
         WHERE slug = $1 AND status = 'active'`,
        [slug],
      );

      if (pubResult.rows.length === 0) {
        return reply.status(404).send("Publication not found");
      }

      const pub = pubResult.rows[0];

      const { rows: articles } = await pool.query<{
        nostr_d_tag: string;
        title: string;
        summary: string | null;
        content_free: string | null;
        published_at: Date;
        writer_username: string;
        writer_display_name: string | null;
      }>(
        `SELECT a.nostr_d_tag, a.title, a.summary, a.content_free, a.published_at,
                w.username AS writer_username, w.display_name AS writer_display_name
         FROM articles a
         JOIN accounts w ON w.id = a.writer_id
         WHERE a.publication_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
           AND a.publication_article_status = 'published'
         ORDER BY a.published_at DESC
         LIMIT 20`,
        [pub.id],
      );

      const pubUrl = `${siteUrl()}/pub/${slug}`;
      const xml = buildRssFeed({
        title: `${pub.name}`,
        description: pub.tagline ?? `Articles from ${pub.name}`,
        link: pubUrl,
        feedUrl: `${siteUrl()}/api/v1/pub/${slug}/rss`,
        items: articles.map((a) => ({
          title: a.title,
          link: `${siteUrl()}/pub/${slug}/${a.nostr_d_tag}`,
          description:
            a.summary ?? truncate(stripHtmlTags(renderBody(a.content_free ?? "")), 300),
          content: renderBody(a.content_free ?? ""),
          pubDate: a.published_at,
          author: a.writer_display_name ?? a.writer_username,
        })),
      });

      reply.header("Content-Type", "application/rss+xml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=600");
      return reply.send(xml);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /rss — platform-wide recent articles feed
  // ---------------------------------------------------------------------------

  app.get("/rss", async (req, reply) => {
    const { rows: articles } = await pool.query<{
      nostr_d_tag: string;
      title: string;
      summary: string | null;
      content_free: string | null;
      published_at: Date;
      writer_username: string;
      writer_display_name: string | null;
    }>(
      `SELECT a.nostr_d_tag, a.title, a.summary, a.content_free, a.published_at,
              w.username AS writer_username,
              w.display_name AS writer_display_name
       FROM articles a
       JOIN accounts w ON w.id = a.writer_id
       WHERE a.published_at IS NOT NULL AND a.deleted_at IS NULL AND w.status = 'active'
       ORDER BY a.published_at DESC
       LIMIT 30`,
    );

    const xml = buildRssFeed({
      title: "all.haus — recent articles",
      description: "Recent articles from writers on all.haus",
      link: siteUrl(),
      feedUrl: `${siteUrl()}/rss`,
      items: articles.map((a) => ({
        title: a.title,
        link: `${siteUrl()}/article/${a.nostr_d_tag}`,
        description:
          a.summary ?? truncate(stripHtmlTags(renderBody(a.content_free ?? "")), 300),
        content: renderBody(a.content_free ?? ""),
        pubDate: a.published_at,
        author: a.writer_display_name ?? a.writer_username,
      })),
    });

    reply.header("Content-Type", "application/rss+xml; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=300"); // 5 min cache
    return reply.send(xml);
  });
}

// =============================================================================
// RSS XML builder
// =============================================================================

interface RssFeedParams {
  title: string;
  description: string;
  link: string;
  feedUrl: string;
  items: RssItem[];
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  content: string;
  pubDate: Date;
  author?: string;
}

function buildRssFeed(params: RssFeedParams): string {
  const items = params.items
    .map(
      (item) => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description)}</description>
      <content:encoded><![CDATA[${item.content.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></content:encoded>
      <pubDate>${item.pubDate.toUTCString()}</pubDate>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      ${item.author ? `<dc:creator>${escapeXml(item.author)}</dc:creator>` : ""}
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(params.title)}</title>
    <description>${escapeXml(params.description)}</description>
    <link>${escapeXml(params.link)}</link>
    <atom:link href="${escapeXml(params.feedUrl)}" rel="self" type="application/rss+xml"/>
    <language>en</language>
    <generator>all.haus</generator>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "...";
}
