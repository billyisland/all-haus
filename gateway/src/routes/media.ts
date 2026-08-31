import fs from "fs/promises";
import type { FastifyInstance } from "fastify";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { storeImage, MediaStoreError } from "../services/media-store.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Media Routes
//
// POST /media/upload       — Upload image (Sharp crunch → Blossom BUD-02)
// GET  /media/oembed       — Proxy oEmbed lookups
//
// The bytes-to-URL pipeline lives in services/media-store.ts; this route owns
// only what is about the REQUEST — multipart parsing, the declared MIME
// allow-list, and status codes. See docs/adr/ADR-blossom-migration.md.
// =============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/app/media";

/** MIME types this route accepts from a client — a claim ABOUT THE REQUEST,
 *  which is why it lives here and not in the bytes module. It is a cheap first
 *  filter on what the client says it is sending; `sharp` inside `storeImage` is
 *  what decides whether the bytes really are an image. */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// oEmbed provider endpoints
const OEMBED_PROVIDERS: Record<string, string> = {
  "youtube.com": "https://www.youtube.com/oembed",
  "youtu.be": "https://www.youtube.com/oembed",
  "vimeo.com": "https://vimeo.com/api/oembed.json",
  "twitter.com": "https://publish.twitter.com/oembed",
  "x.com": "https://publish.twitter.com/oembed",
  "open.spotify.com": "https://open.spotify.com/oembed",
};

// Ensure the media directory exists on startup
async function ensureMediaDir() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err, dir: MEDIA_DIR }, "Failed to create media directory");
  }
}

export async function mediaRoutes(app: FastifyInstance) {
  await ensureMediaDir();

  // ---------------------------------------------------------------------------
  // POST /media/upload — upload an image
  //
  // Parse the multipart part, reject a type we don't accept, hand the bytes to
  // the media store. Everything after "read into buffer" is storeImage().
  // ---------------------------------------------------------------------------

  app.post(
    "/media/upload",
    { preHandler: requireAuth, bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      const uploaderId = req.session!.sub;

      try {
        const data = await req.file();
        if (!data) {
          return reply.status(400).send({ error: "No file uploaded" });
        }

        if (!ALLOWED_IMAGE_TYPES.has(data.mimetype)) {
          return reply.status(400).send({
            error: `Unsupported file type: ${data.mimetype}. Allowed: JPEG, PNG, GIF, WebP`,
          });
        }

        const stored = await storeImage(uploaderId, await data.toBuffer());

        // A duplicate is not a creation, and its payload deliberately carries
        // only what the caller needs to reference the existing blob.
        if (stored.duplicate) {
          return reply.status(200).send({
            url: stored.url,
            sha256: stored.sha256,
            duplicate: true,
          });
        }

        return reply.status(201).send({
          url: stored.url,
          sha256: stored.sha256,
          mimeType: stored.mimeType,
          size: stored.sizeBytes,
        });
      } catch (err) {
        // MediaStoreError already logged its specifics at the failure point,
        // and says which side failed. Bytes we cannot decode are the client's
        // 400 — the same answer the declared-MIME check above gives, since a
        // .png that is really a PDF is the same mistake found one step later.
        // Anything else (Blossom down, a mismatched hash) is ours: 500, and no
        // detail, because the caller can do nothing with it.
        if (err instanceof MediaStoreError) {
          if (err.failure === "undecodable") {
            return reply.status(400).send({ error: err.message });
          }
          return reply.status(500).send({ error: "Upload failed" });
        }
        logger.error({ err, uploaderId }, "Media upload error");
        return reply.status(500).send({ error: "Upload failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /media/oembed?url=... — proxy oEmbed lookups
  // ---------------------------------------------------------------------------

  app.get("/media/oembed", { preHandler: optionalAuth }, async (req, reply) => {
    const url = (req.query as { url?: string }).url;
    if (!url) {
      return reply.status(400).send({ error: "Missing url parameter" });
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, "");

      const oembedEndpoint = OEMBED_PROVIDERS[hostname];
      if (!oembedEndpoint) {
        return reply.status(400).send({ error: "Unsupported embed provider" });
      }

      const oembedUrl = `${oembedEndpoint}?url=${encodeURIComponent(url)}&format=json&maxwidth=680`;

      const res = await safeFetch(oembedUrl, {
        headers: { "User-Agent": "Platform/1.6 (+https://all.haus)" },
        timeout: 5000,
      });

      if (!res.ok) {
        return reply.status(res.status).send({ error: "oEmbed lookup failed" });
      }

      const oembedData = JSON.parse(res.text);

      return reply.status(200).send({
        type: oembedData.type,
        title: oembedData.title,
        authorName: oembedData.author_name,
        authorUrl: oembedData.author_url,
        providerName: oembedData.provider_name,
        providerUrl: oembedData.provider_url,
        thumbnailUrl: oembedData.thumbnail_url,
        thumbnailWidth: oembedData.thumbnail_width,
        thumbnailHeight: oembedData.thumbnail_height,
        html: oembedData.html,
        width: oembedData.width,
        height: oembedData.height,
      });
    } catch (err) {
      logger.error({ err, url }, "oEmbed lookup error");
      return reply.status(500).send({ error: "oEmbed lookup failed" });
    }
  });
}
