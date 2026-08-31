import sharp from "sharp";
import { createHash } from "crypto";
import { pool } from "@platform-pub/shared/db/client.js";
import { signEvent } from "../lib/key-custody-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Media store — the one path from image bytes to a public URL
//
// Extracted from POST /media/upload (2026-08-08) so a caller that already holds
// a buffer can use it without inventing a multipart request. The route is the
// first caller; the archive importer, which fetches images from a third-party
// CDN, is the second.
//
// The route keeps what is about the REQUEST (multipart parsing, the declared
// MIME allow-list, status codes). This module keeps what is about the BYTES:
// crunch → hash → dedupe → BUD-02 signed PUT → verify → record.
//
// Never bypass this to write media_uploads or PUT to Blossom directly: the
// hash verification before the INSERT is what stops the table claiming a blob
// the store does not have. See docs/adr/ADR-blossom-migration.md.
// =============================================================================

const PUBLIC_MEDIA_URL =
  process.env.PUBLIC_MEDIA_URL ?? "https://all.haus/media";
// Internal Blossom blob store (BUD-02). Fixed service hop — see the deliberate
// safeFetch exemption at the upload call site.
const BLOSSOM_URL = process.env.BLOSSOM_URL ?? "http://blossom:3003";

export interface StoredImage {
  url: string;
  sha256: string;
  mimeType: "image/webp";
  sizeBytes: number;
  /** The blob was already in media_uploads; nothing was uploaded this call. */
  duplicate: boolean;
}

/**
 * Which SIDE failed — the caller's bytes, or our store.
 *
 * These are opposite facts and a caller must be able to tell them apart.
 * `undecodable` means these bytes will fail again however many times they are
 * sent — the route answers 400, and a bulk caller can skip the one image.
 * `unavailable` means the bytes were fine and the store was not — 500, and a
 * bulk caller should stop rather than march on quietly dropping every picture
 * in the archive. Answering both with 500 (what this did before) tells a member
 * their perfectly good PNG is our outage, and tells us an outage is a bad file.
 */
export type MediaStoreFailure = "undecodable" | "unavailable";

/** Anything that went wrong between the bytes and the stored blob. */
export class MediaStoreError extends Error {
  constructor(
    message: string,
    readonly failure: MediaStoreFailure,
  ) {
    super(message);
    this.name = "MediaStoreError";
  }
}

/**
 * Crunch an image to WebP, store it in Blossom, and record it.
 *
 * Content-addressed: identical bytes always yield the same URL and are stored
 * once. That dedupe is not an optimisation here — a writer's header image
 * repeated across two hundred imported posts fetches many times and stores
 * once, and re-running a failed import re-stores nothing.
 *
 * `sharp` is what validates that the buffer really is an image; a caller that
 * fetched arbitrary bytes gets a MediaStoreError rather than a stored blob.
 */
export async function storeImage(
  uploaderId: string,
  originalBuffer: Buffer,
): Promise<StoredImage> {
  // Crunch. .rotate() with no args reads EXIF orientation and applies it,
  // fixing upside-down/rotated photos from phones.
  let fileBuffer: Buffer;
  try {
    fileBuffer = await sharp(originalBuffer)
      .rotate()
      .resize(1200, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err, uploaderId }, "Media crunch failed — not a decodable image");
    throw new MediaStoreError(
      `Not a decodable image: ${err instanceof Error ? err.message : "unknown"}`,
      "undecodable",
    );
  }

  const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

  // Already stored — always return the CURRENT PUBLIC_MEDIA_URL, never a URL
  // recorded under an older scheme.
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM media_uploads WHERE sha256 = $1 LIMIT 1",
    [sha256],
  );
  if (existing.rows.length > 0) {
    return {
      url: `${PUBLIC_MEDIA_URL}/${sha256}.webp`,
      sha256,
      mimeType: "image/webp",
      sizeBytes: fileBuffer.length,
      duplicate: true,
    };
  }

  const filename = `${sha256}.webp`;

  // Upload the crunched blob to Blossom (BUD-02). Sign a kind-24242
  // authorization event server-side with the uploader's custodial key
  // (the same signEvent path used across the codebase).
  const nowSec = Math.floor(Date.now() / 1000);
  const authTemplate = {
    kind: 24242,
    content: `Upload ${filename}`,
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", String(nowSec + 60)],
    ],
    created_at: nowSec,
  };
  const signed = await signEvent(uploaderId, authTemplate, "account");
  const authHeader = `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`;

  // Deliberate safeFetch exemption: BLOSSOM_URL is a fixed internal
  // service hop (Docker hostname → private 172.x), not an
  // attacker-influenceable host. safeFetch unconditionally rejects private
  // IPs (shared/lib/http-client.ts), so it CANNOT reach Blossom — same
  // reason key-custody-client.ts uses plain fetch. Do not "harden" this.
  const blossomRes = await fetch(`${BLOSSOM_URL}/upload`, {
    method: "PUT",
    headers: { Authorization: authHeader, "Content-Type": "image/webp" },
    // Uint8Array (a BodyInit) — Node's fetch types don't accept Buffer directly.
    body: new Uint8Array(fileBuffer),
  });
  if (!blossomRes.ok) {
    const detail = await blossomRes.text().catch(() => "");
    logger.error(
      { uploaderId, sha256, status: blossomRes.status, detail },
      "Blossom upload failed",
    );
    throw new MediaStoreError(
      `Blossom upload failed: ${blossomRes.status}`,
      "unavailable",
    );
  }
  // Blossom hashes the body independently — verify it stored what we sent
  // before recording the row. Mismatch ⇒ abort, no INSERT.
  const descriptor = (await blossomRes.json().catch(() => ({}))) as {
    sha256?: string;
  };
  if (descriptor.sha256 !== sha256) {
    logger.error(
      { uploaderId, sha256, returned: descriptor.sha256 },
      "Blossom returned a mismatched hash — aborting insert",
    );
    throw new MediaStoreError(
      "Blossom returned a mismatched hash",
      "unavailable",
    );
  }

  // Public URL is backend-independent (nginx proxies /media/<sha256>.webp
  // → Blossom), so swapping the store again needs no URL rewrites.
  const publicUrl = `${PUBLIC_MEDIA_URL}/${filename}`;

  await pool.query(
    `INSERT INTO media_uploads (uploader_id, blossom_url, sha256, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5)`,
    [uploaderId, publicUrl, sha256, "image/webp", fileBuffer.length],
  );

  logger.info(
    { uploaderId, sha256, size: fileBuffer.length },
    "Media uploaded",
  );

  return {
    url: publicUrl,
    sha256,
    mimeType: "image/webp",
    sizeBytes: fileBuffer.length,
    duplicate: false,
  };
}
