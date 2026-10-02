import type { FastifyInstance, FastifyRequest } from "fastify";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { sanitizeArticleContent } from "@platform-pub/shared/lib/sanitize.js";
import { normaliseCaptions } from "../lib/article-captions.js";
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

// A PER-MEMBER BUDGET (CA-D8). Each call is an outbound fetch of up to 5 MB
// and a JSDOM + Readability parse that runs SYNCHRONOUSLY on the event loop,
// and the cache is keyed on the raw URL, so a query-string variation defeats
// it — one signed-in member looping this could stall every request the gateway
// serves. The limiter plugin is `global: false`, so without this nothing
// covered it. Keyed on the member at `preHandler`, after `requireAuth` (at the
// limiter's default `onRequest` the session is not there yet and every member
// would share one `req.ip` bucket — see the header of `signing.ts`). Opening
// an external article is one call; 30 a minute is well past reading speed.
const extractLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
    hook: "preHandler" as const,
    keyGenerator: (req: FastifyRequest) => `extract:${req.session?.sub ?? req.ip}`,
  },
};

export async function extractRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string } }>(
    "/extract",
    { preHandler: requireAuth, config: extractLimit },
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
        return reply.status(400).send({ error: "That isn't a web address we can read." });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return reply
          .status(400)
          .send({ error: "Please use a web address starting with http:// or https://." });
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
            .send({ error: `That site answered with an error (HTTP ${res.status}), so we couldn't fetch the article.` });
        }
        html = res.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, url }, "Extract fetch failed");
        return reply.status(422).send({ error: "Couldn't reach that site." });
      }

      try {
        const dom = new JSDOM(html, { url });
        // `keepClasses` carries the caption signal as far as normaliseCaptions
        // and no further: the sanitiser's allowlist has `class` on no tag, so
        // nothing about the origin page's stylesheet reaches the client. Without
        // it Readability strips the one thing that distinguishes a caption from
        // a paragraph on most of the web (gateway/src/lib/article-captions.ts).
        const reader = new Readability(dom.window.document, { keepClasses: true });
        const article = reader.parse();

        if (!article || !article.content) {
          return reply
            .status(422)
            .send({ error: "Couldn't find an article on that page." });
        }

        const result: ExtractResult = {
          title: article.title ?? "",
          // Readability does NOT sanitize — strip scripts/handlers/dangerous
          // schemes before this reaches the client's dangerouslySetInnerHTML.
          content: sanitizeArticleContent(normaliseCaptions(article.content)),
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
          .send({ error: "Couldn't find an article on that page." });
      }
    },
  );
}
