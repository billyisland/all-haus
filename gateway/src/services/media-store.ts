import sharp from "sharp";
import { createHash } from "crypto";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
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
    // THE BLOB IS SHARED; THE ROW IS PER-UPLOADER — and until L7.2 only the
    // first half was true. The dedupe returned the existing URL and recorded
    // NOTHING for the second uploader, so `media_uploads` held one row for a
    // blob two people were using and there was no way, at delete time, to know
    // the second one existed. A delete then silently broke their post.
    //
    // So the second uploader gets their own row, pointing at the same blob and
    // uploading nothing. `duplicate` keeps its meaning exactly — nothing was
    // uploaded this call — and `WHERE NOT EXISTS` keeps one row per (uploader,
    // hash) without a unique index to lean on, so re-posting your own picture
    // does not accumulate rows.
    await pool.query(
      `INSERT INTO media_uploads (uploader_id, blossom_url, sha256, mime_type, size_bytes)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM media_uploads WHERE uploader_id = $1 AND sha256 = $3
        )`,
      [
        uploaderId,
        `${PUBLIC_MEDIA_URL}/${sha256}.webp`,
        sha256,
        "image/webp",
        fileBuffer.length,
      ],
    );
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

/** Why a delete did nothing. `shared` is a refusal; the others are facts. */
export type BlobDeleteOutcome =
  | "deleted"
  /**
   * Our last row for these bytes is gone, but Blossom refused the DELETE
   * (403): its owner table names the FIRST uploader, whose row went with an
   * earlier `shared` delete, and BUD-02 lets only an owner delete. The blob
   * stays in the store under that pubkey; we hold no claim to it (§0z 17b).
   */
  | "orphaned_at_blossom"
  | "not_yours"
  | "shared";

export interface BlobDeleteResult {
  outcome: BlobDeleteOutcome;
  sha256: string;
}

/**
 * Remove one uploader's blob — the inverse of storeImage, and the piece the
 * erase procedure needs (L7.2; D8 §7, D5 §11).
 *
 * THE ROW IS PER-UPLOADER AND THE BLOB IS SHARED, so a delete is two different
 * questions. Is this row yours? — if not, `not_yours`, and nothing happens.
 * Is anybody ELSE using these same bytes? — if so, `shared`: your row goes, the
 * blob stays, and the other member's picture keeps loading. Content addressing
 * means two people who upload the same image get the same hash, so this is not
 * a corner case; it is what a writer's copy of a widely-posted photograph looks
 * like from here.
 *
 * ORDER, AND WHY THIS ONE. The row is deleted inside a transaction and the
 * Blossom call is made before the commit, so a store that refuses leaves the
 * row exactly where it was. The opposite order — blob first — would leave
 * `media_uploads` claiming a blob the store does not have, which is precisely
 * what storeImage's verify-before-INSERT exists to prevent; this is that same
 * invariant read backwards.
 *
 * nginx proxies `/media/<hash>.webp` read-only and must stay that way
 * (security.md): this call goes over the internal network to BLOSSOM_URL, the
 * same fixed service hop the upload uses.
 */
export async function deleteBlob(
  sha256: string,
  uploaderId: string,
): Promise<BlobDeleteResult> {
  const mine = await pool.query<{ id: string }>(
    "SELECT id FROM media_uploads WHERE sha256 = $1 AND uploader_id = $2 LIMIT 1",
    [sha256, uploaderId],
  );
  if (mine.rows.length === 0) {
    return { outcome: "not_yours", sha256 };
  }

  const others = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM media_uploads WHERE sha256 = $1 AND uploader_id <> $2",
    [sha256, uploaderId],
  );
  // `count(*)` is a bigint and arrives as a STRING (money.md's rule, which is
  // about the wire and not about money): `Number(others.rows[0].n) > 0` is the
  // comparison that survives it, and `=== 0` on the raw value would not.
  const sharedWithOthers = Number(others.rows[0]?.n ?? "0") > 0;
  let orphaned = false;

  if (sharedWithOthers) {
    await pool.query(
      "DELETE FROM media_uploads WHERE sha256 = $1 AND uploader_id = $2",
      [sha256, uploaderId],
    );
    logger.info(
      { uploaderId, sha256 },
      "Media row removed; blob kept — another uploader holds the same bytes",
    );
    return { outcome: "shared", sha256 };
  }

  await withTransaction(async (client) => {
    await client.query(
      "DELETE FROM media_uploads WHERE sha256 = $1 AND uploader_id = $2",
      [sha256, uploaderId],
    );

    // BUD-02 delete: the same kind-24242 shape as the upload, with `t: delete`.
    // Signed with the uploader's own custodial key, because Blossom's authority
    // model is the signature on the auth event and the blob is theirs.
    const nowSec = Math.floor(Date.now() / 1000);
    const signed = await signEvent(
      uploaderId,
      {
        kind: 24242,
        content: `Delete ${sha256}.webp`,
        tags: [
          ["t", "delete"],
          ["x", sha256],
          ["expiration", String(nowSec + 60)],
        ],
        created_at: nowSec,
      },
      "account",
    );
    const authHeader = `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`;

    // Same deliberate safeFetch exemption as the upload — a fixed internal
    // service hop. Do not "harden" this.
    const res = await fetch(`${BLOSSOM_URL}/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    // A blob that is ALREADY gone is a success, not a failure: the erase
    // procedure is resumable and must be safe to re-run, and a 404 here means
    // the end state this call was asked for. Anything else throws, which rolls
    // the row back — the table must never claim a blob the store does not have,
    // and it must never forget one the store still does.
    if (res.status === 403) {
      // NOT OURS TO DELETE AT BLOSSOM, though ours in the table (§0z item
      // 17b). `storeImage`'s dedupe records the second uploader a ROW and
      // uploads nothing, so Blossom's owner table only ever names the first;
      // when the first uploader's row has gone (`shared`) and the second's is
      // the sole one left, the second's signature is refused and, before
      // this, the erasure `failed` on every re-run for ever. The row goes —
      // the table must not claim a blob the store will not answer for on our
      // key — and the outcome names what remains and whose it is.
      //
      // BUT A 403 IS NOT ONLY THAT (§0ab guard (e)). blossom-server 6.2.0
      // answers 403 for three things: "not an owner", a token of the wrong
      // `t` type, and an `x` tag naming another blob — the last two are OUR
      // auth event being wrong. And "not an owner" is also what a signature
      // from the WRONG KEY earns, which is our fault too. Read categorically,
      // any of those orphaned every blob with a clean exit, and the erasure
      // then blanked the very key a re-run would need. So the orphan is
      // claimed only when Blossom SAYS it is an ownership refusal AND the
      // event was signed by the key this account publishes under; anything
      // else throws, the row rolls back, and the erasure counts a failure.
      // Fail-closed is the safe direction: a Blossom upgrade that rewords
      // its reason makes a real orphan a counted failure, never the reverse.
      const reason = res.headers.get("x-reason") ?? (await res.text().catch(() => ""));
      const ownershipRefusal = /not an owner/i.test(reason);
      const { rows: acct } = await client.query<{ nostr_pubkey: string | null }>(
        "SELECT nostr_pubkey FROM accounts WHERE id = $1",
        [uploaderId],
      );
      const signedByUploader =
        typeof signed.pubkey === "string" && signed.pubkey === acct[0]?.nostr_pubkey;
      if (!ownershipRefusal || !signedByUploader) {
        logger.error(
          { uploaderId, sha256, reason, ownershipRefusal, signedByUploader },
          "Blossom refused the delete (403) for a reason that is ours, not the blob's owner — rolling back the row",
        );
        throw new MediaStoreError(
          `Blossom delete refused: ${ownershipRefusal ? "signed by a key that is not the uploader's" : reason || "403"}`,
          "unavailable",
        );
      }
      logger.warn(
        { uploaderId, sha256 },
        "Blossom refused the delete (403): the blob's owner there is an earlier uploader; row removed, blob orphaned at Blossom",
      );
      orphaned = true;
      return;
    }
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      logger.error(
        { uploaderId, sha256, status: res.status, detail },
        "Blossom delete failed — rolling back the row",
      );
      throw new MediaStoreError(
        `Blossom delete failed: ${res.status}`,
        "unavailable",
      );
    }
  });

  if (orphaned) return { outcome: "orphaned_at_blossom", sha256 };
  logger.info({ uploaderId, sha256 }, "Media deleted");
  return { outcome: "deleted", sha256 };
}
