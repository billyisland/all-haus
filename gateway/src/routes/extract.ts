import type { FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { sanitizeArticleContent } from "@platform-pub/shared/lib/sanitize.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";

const cache = new Map<string, { data: ExtractResult; expiresAt: number }>();
const CACHE_TTL_MS = 3_600_000; // 1 hour

interface ExtractResult {
  title: string;
  content: string;
  siteName: string;
  excerpt: string;
  byline: string;
  length: number;
}

export async function extractRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string } }>(
    "/extract",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { url } = req.query;
      if (!url || typeof url !== "string") {
        return reply
          .status(400)
          .send({ error: "url query parameter required" });
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return reply.status(400).send({ error: "Invalid URL" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return reply
          .status(400)
          .send({ error: "Only http/https URLs are supported" });
      }

      const cached = cache.get(url);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      let html: string;
      try {
        const res = await safeFetch(url, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": "allhaus-reader/1.0",
          },
        });
        if (!res.ok) {
          return reply
            .status(422)
            .send({ error: `Upstream returned HTTP ${res.status}` });
        }
        html = res.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, url }, "Extract fetch failed");
        return reply.status(422).send({ error: "Could not fetch URL" });
      }

      try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.content) {
          return reply
            .status(422)
            .send({ error: "Could not extract article content" });
        }

        const result: ExtractResult = {
          title: article.title ?? "",
          // Readability does NOT sanitize — strip scripts/handlers/dangerous
          // schemes before this reaches the client's dangerouslySetInnerHTML.
          content: sanitizeArticleContent(article.content),
          siteName: article.siteName ?? parsed.hostname,
          excerpt: article.excerpt ?? "",
          byline: article.byline ?? "",
          length: article.length ?? 0,
        };

        cache.set(url, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });

        // Cap cache size
        if (cache.size > 500) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }

        return reply.send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, url }, "Readability parse failed");
        return reply
          .status(422)
          .send({ error: "Could not extract article content" });
      }
    },
  );
}
