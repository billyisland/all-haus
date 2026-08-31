import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
import { optionalAuth } from "../middleware/auth.js";

// =============================================================================
// Search Routes
//
// Per ADR §III.3 open question #6: "Full-text search across the network is
// not well-supported in Nostr (NIP-50 is limited). The feed service likely
// needs its own search index."
//
// The schema already has a pg_trgm trigram index on articles.title:
//   CREATE INDEX idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);
//
// This endpoint provides:
//   - Title trigram search (fuzzy matching — handles typos)
//   - Content free-text search via ILIKE on content_free
//   - Writer name search
//
// For launch this is sufficient. Post-launch, consider a dedicated search
// service (MeiliSearch, Typesense) for better relevance ranking.
//
// GET /search?q=<query>&type=articles|writers&limit=20
// =============================================================================

const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

export async function searchRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { q: string; type?: string; limit?: string; offset?: string };
  }>(
    "/search",
    {
      preHandler: optionalAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const query = (req.query.q ?? "").trim();
      if (query.length < 2) {
        return reply
          .status(400)
          .send({ error: "Search query must be at least 2 characters" });
      }

      const type = req.query.type ?? "articles";
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 50);
      const offset = Math.min(parseInt(req.query.offset ?? "0", 10) || 0, 1000);

      if (type === "writers") {
        return searchWriters(query, limit, offset, reply);
      }
      if (type === "publications") {
        // Publications suspended 2026-08-31 (shared/src/lib/env.ts). This leg
        // returns an EMPTY RESULT SET rather than 404ing like the /publications
        // routes do, deliberately: search is a mixed surface and the workspace
        // panel fires all three legs in one Promise.all, so a 404 here would
        // take writer and article search down with it. Excluding a suspended
        // kind from results is the same shape as the formula projection's
        // exclusion — the surface goes quiet, the caller keeps working.
        if (!publicationsEnabled()) {
          return reply
            .status(200)
            .send({ query, type: "publications", results: [], limit, offset });
        }
        return searchPublications(query, limit, offset, reply);
      }

      return searchArticles(query, limit, offset, reply);
    },
  );
}

// ---------------------------------------------------------------------------
// Article search — trigram similarity on title + ILIKE on content_free
//
// Uses pg_trgm similarity() for ranked results. The trigram index handles
// fuzzy matching (misspellings, partial words). Results are ranked by
// similarity score descending.
// ---------------------------------------------------------------------------

async function searchArticles(
  query: string,
  limit: number,
  offset: number,
  reply: any,
) {
  const { rows } = await pool.query<{
    id: string;
    nostr_event_id: string;
    nostr_d_tag: string;
    title: string;
    summary: string | null;
    word_count: number | null;
    access_mode: string;
    published_at: Date;
    writer_username: string;
    writer_display_name: string | null;
    similarity: number;
  }>(
    `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.summary,
            a.word_count, a.access_mode, a.published_at,
            w.username AS writer_username,
            w.display_name AS writer_display_name,
            similarity(a.title, $1) AS similarity
     FROM articles a
     JOIN accounts w ON w.id = a.writer_id
     WHERE a.published_at IS NOT NULL
       AND a.deleted_at IS NULL
       AND w.status = 'active'
       AND (
         similarity(a.title, $1) > 0.1
         OR a.title ILIKE $2
         OR a.content_free ILIKE $2
       )
     ORDER BY similarity DESC, a.published_at DESC
     LIMIT $3 OFFSET $4`,
    [query, `%${escapeLike(query)}%`, limit, offset],
  );

  const results = rows.map((r) => ({
    id: r.id,
    nostrEventId: r.nostr_event_id,
    dTag: r.nostr_d_tag,
    title: r.title,
    summary: r.summary,
    wordCount: r.word_count,
    accessMode: r.access_mode,
    isPaywalled: r.access_mode === "paywalled",
    publishedAt: r.published_at.toISOString(),
    writer: {
      username: r.writer_username,
      displayName: r.writer_display_name,
    },
    relevance: r.similarity,
  }));

  return reply
    .status(200)
    .send({ query, type: "articles", results, limit, offset });
}

// ---------------------------------------------------------------------------
// Writer search — trigram on username and display_name
// ---------------------------------------------------------------------------

async function searchWriters(
  query: string,
  limit: number,
  offset: number,
  reply: any,
) {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    bio: string | null;
    avatar_blossom_url: string | null;
    nostr_pubkey: string;
    article_count: string;
  }>(
    `SELECT a.id, a.username, a.display_name, a.bio,
            a.avatar_blossom_url, a.nostr_pubkey,
            (SELECT COUNT(*) FROM articles WHERE writer_id = a.id AND published_at IS NOT NULL AND deleted_at IS NULL) AS article_count
     FROM accounts a
     WHERE a.status = 'active'
       AND (
         a.username ILIKE $1
         OR a.display_name ILIKE $1
       )
     ORDER BY
       CASE WHEN a.username ILIKE $2 THEN 0 ELSE 1 END,
       a.display_name
     LIMIT $3 OFFSET $4`,
    [`%${escapeLike(query)}%`, `${escapeLike(query)}%`, limit, offset],
  );

  const results = rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    bio: r.bio,
    avatar: r.avatar_blossom_url,
    pubkey: r.nostr_pubkey,
    articleCount: parseInt(r.article_count, 10),
  }));

  return reply
    .status(200)
    .send({ query, type: "writers", results, limit, offset });
}

// ---------------------------------------------------------------------------
// Publication search — trigram on name and tagline
// ---------------------------------------------------------------------------

async function searchPublications(
  query: string,
  limit: number,
  offset: number,
  reply: any,
) {
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    logo_blossom_url: string | null;
    article_count: string;
    member_count: string;
    similarity: number;
  }>(
    `SELECT p.id, p.slug, p.name, p.tagline, p.logo_blossom_url,
            (SELECT COUNT(*) FROM articles WHERE publication_id = p.id AND published_at IS NOT NULL AND deleted_at IS NULL) AS article_count,
            (SELECT COUNT(*) FROM publication_members WHERE publication_id = p.id AND removed_at IS NULL) AS member_count,
            similarity(p.name, $1) AS similarity
     FROM publications p
     WHERE p.status = 'active'
       AND (
         similarity(p.name, $1) > 0.1
         OR p.name ILIKE $2
         OR p.tagline ILIKE $2
       )
     ORDER BY similarity DESC, p.name
     LIMIT $3 OFFSET $4`,
    [query, `%${escapeLike(query)}%`, limit, offset],
  );

  const results = rows.map((r) => ({
    type: "publication" as const,
    id: r.id,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    logo: r.logo_blossom_url,
    articleCount: parseInt(r.article_count, 10),
    memberCount: parseInt(r.member_count, 10),
    relevance: r.similarity,
  }));

  return reply
    .status(200)
    .send({ query, type: "publications", results, limit, offset });
}
