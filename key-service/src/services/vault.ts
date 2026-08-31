import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  generateContentKey,
  encryptContentKey,
  decryptContentKey,
} from "../lib/kms.js";
import {
  encryptArticleBodyXChaCha,
  decryptArticleBodyXChaCha,
  decryptArticleBody,
} from "../lib/crypto.js";
import { wrapKeyForReader } from "../lib/nip44.js";
import { verifyPayment, resolveArticleId } from "./verification.js";
import type { VaultEncryptResult, KeyResponse } from "../types/index.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// VaultService
//
// Two responsibilities:
//
//   1. publishArticle — called when a writer publishes a paywalled article.
//      Generates a content key, encrypts the paywalled body with
//      XChaCha20-Poly1305, stores the key, and returns the ciphertext for the
//      caller to embed as a ['payload', ciphertext, algorithm] tag in the
//      NIP-23 kind 30023 event. No separate kind 39701 vault event is produced.
//
//   2. issueKey — called when a reader passes a gate (or re-requests a key).
//      Verifies payment, retrieves the stored content key, wraps it with
//      NIP-44 to the reader's pubkey, and logs the issuance.
//      Looks up by article_id (via nostr_event_id → articles → vault_keys)
//      so the lookup is stable across NIP-23 event ID changes on re-publish.
// =============================================================================

class VaultService {
  // ---------------------------------------------------------------------------
  // publishArticle
  //
  // Called by the publishing route when a writer publishes a paywalled article.
  // Returns ciphertext and algorithm directly — the caller embeds them in the
  // NIP-23 event as ['payload', ciphertext, algorithm].
  //
  // On edit/re-publish the existing key is reused and the body re-encrypted
  // with the same key — readers who already have the key need do nothing.
  // ---------------------------------------------------------------------------

  async publishArticle(params: {
    articleId: string;
    nostrArticleEventId: string;
    paywallBody: string;
    pricePence: number;
    gatePositionPct: number;
    nostrDTag: string;
  }): Promise<VaultEncryptResult> {
    return withTransaction(async (client) => {
      // Check if a key already exists (edit / re-publish)
      const existingKey = await client.query<{
        id: string;
        content_key_enc: string;
      }>(`SELECT id, content_key_enc FROM vault_keys WHERE article_id = $1`, [
        params.articleId,
      ]);

      let contentKeyBytes: Buffer;
      let vaultKeyId: string;

      if (existingKey.rowCount && existingKey.rowCount > 0) {
        // Reuse existing key — re-encrypt body with same key
        try {
          contentKeyBytes = decryptContentKey(
            existingKey.rows[0].content_key_enc,
          );
        } catch (err) {
          logger.error(
            { err, articleId: params.articleId },
            "Failed to decrypt existing vault key — possible KMS key rotation",
          );
          throw Object.assign(new Error("VAULT_KEY_DECRYPT_FAILED"), {
            statusCode: 500,
          });
        }
        vaultKeyId = existingKey.rows[0].id;

        // Keep nostr_article_event_id current for audit purposes;
        // ciphertext is updated below after re-encryption.
        await client.query(
          `UPDATE vault_keys SET nostr_article_event_id = $1 WHERE id = $2`,
          [params.nostrArticleEventId, vaultKeyId],
        );

        logger.info(
          { articleId: params.articleId, vaultKeyId },
          "Reusing existing vault key for article edit",
        );
      } else {
        // New article — generate fresh key
        contentKeyBytes = generateContentKey();
        const contentKeyEnc = encryptContentKey(contentKeyBytes);

        const keyRow = await client.query<{ id: string }>(
          `INSERT INTO vault_keys (article_id, nostr_article_event_id, content_key_enc, algorithm)
           VALUES ($1, $2, $3, 'xchacha20poly1305')
           RETURNING id`,
          [params.articleId, params.nostrArticleEventId, contentKeyEnc],
        );
        vaultKeyId = keyRow.rows[0].id;
        logger.info(
          { articleId: params.articleId, vaultKeyId },
          "Generated new vault key (xchacha20poly1305)",
        );
      }

      const algorithm = "xchacha20poly1305" as const;

      // Encrypt the paywalled body
      const ciphertext = encryptArticleBodyXChaCha(
        params.paywallBody,
        contentKeyBytes,
      );

      // Persist ciphertext in vault_keys so the gate-pass can serve it directly.
      // This decouples decryption from relay availability — readers no longer need
      // to find the ['payload', ...] tag on the NIP-23 event.
      await client.query(
        `UPDATE vault_keys SET ciphertext = $1 WHERE id = $2`,
        [ciphertext, vaultKeyId],
      );

      return { ciphertext, algorithm, vaultKeyId };
    });
  }

  // ---------------------------------------------------------------------------
  // updateVaultEventId — kept for backward-compat; now a no-op for new articles
  // (new articles don't have a separate vault event to track)
  // ---------------------------------------------------------------------------

  async updateVaultEventId(
    articleId: string,
    vaultNostrEventId: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE articles SET vault_event_id = $1, updated_at = now() WHERE id = $2`,
      [vaultNostrEventId, articleId],
    );
  }

  // ---------------------------------------------------------------------------
  // issueKey
  //
  // The core key service operation. Called by the gateway after a gate pass.
  //
  // Vault key lookup uses article_id (resolved via nostr_event_id → articles),
  // NOT nostr_article_event_id. This decouples key lookup from NIP-23 event ID
  // churn: re-publishing an article (which changes its event ID) no longer risks
  // VAULT_KEY_NOT_FOUND. The article_id FK is stable across re-publishes.
  //
  // Returns the algorithm stored in vault_keys so the client can choose the
  // correct decryption path (xchacha20poly1305 for new articles, aes-256-gcm
  // for articles published before the migration).
  // ---------------------------------------------------------------------------

  async issueKey(params: {
    readerId: string;
    readerPubkey: string;
    articleNostrEventId: string;
  }): Promise<KeyResponse> {
    // Step 1: resolve Nostr event ID → internal article UUID
    const resolved = await resolveArticleId(params.articleNostrEventId);
    if (!resolved) {
      throw new KeyServiceError(
        "ARTICLE_NOT_FOUND",
        `No article found for event ID: ${params.articleNostrEventId}`,
      );
    }

    // Step 2: verify access — own content, permanent unlock, or paid read
    //
    // Own content: the writer always has access to their own articles. No
    // payment record is needed.
    //
    // Permanent unlock: set by recordSubscriptionRead (subscription access)
    // or recordPurchaseUnlock (after a first-time purchase). Checking
    // article_unlocks here means subscription readers and returning purchasers
    // are served without needing a fresh read_event.
    //
    // Paid read: first-time purchasers — the gateway records a read_event via
    // the payment service before calling this endpoint, so verifyPayment finds
    // it and returns isVerified: true.
    const isOwnContent = params.readerId === resolved.writerId;
    let verificationReadEventId: string | null = null;

    if (!isOwnContent) {
      const { rows: unlockRows } = await pool.query<{ id: string }>(
        `SELECT id FROM article_unlocks WHERE reader_id = $1 AND article_id = $2 LIMIT 1`,
        [params.readerId, resolved.articleId],
      );

      if (unlockRows.length === 0) {
        // No permanent unlock — must have a valid payment record
        const verification = await verifyPayment(
          params.readerId,
          resolved.articleId,
        );
        if (!verification.isVerified) {
          const reason = verification.readEventExists
            ? "PROVISIONAL_ONLY"
            : "NO_PAYMENT_RECORD";
          throw new KeyServiceError("PAYMENT_NOT_VERIFIED", reason);
        }
        verificationReadEventId = verification.readEventId;
      }
    }

    // Step 3: retrieve vault key by article_id (stable across event ID changes)
    const keyRow = await pool.query<{
      id: string;
      content_key_enc: string;
      algorithm: string;
      ciphertext: string | null;
    }>(
      `SELECT id, content_key_enc, algorithm, ciphertext FROM vault_keys WHERE article_id = $1`,
      [resolved.articleId],
    );

    if (keyRow.rowCount === 0) {
      throw new KeyServiceError(
        "VAULT_KEY_NOT_FOUND",
        `No vault key for article: ${params.articleNostrEventId}`,
      );
    }

    const vaultKey = keyRow.rows[0];
    const algorithm = vaultKey.algorithm as "xchacha20poly1305" | "aes-256-gcm";

    // Step 4: decrypt content key from KMS envelope, re-wrap with NIP-44
    const contentKeyBytes = decryptContentKey(vaultKey.content_key_enc);
    const encryptedKey = wrapKeyForReader(contentKeyBytes, params.readerPubkey);

    // Step 5: log issuance
    const isReissuance = await this.logIssuance({
      vaultKeyId: vaultKey.id,
      readerId: params.readerId,
      articleId: resolved.articleId,
      readEventId: verificationReadEventId,
    });

    logger.info(
      {
        readerId: params.readerId,
        articleId: resolved.articleId,
        algorithm,
        isReissuance,
      },
      "Content key issued",
    );

    return {
      encryptedKey,
      articleNostrEventId: params.articleNostrEventId,
      algorithm,
      isReissuance,
      ciphertext: vaultKey.ciphertext ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // decryptForAuthor
  //
  // Returns the plaintext paywall content for the article's own author.
  // Used by the gateway's edit route so the author can reload their full article.
  // ---------------------------------------------------------------------------

  async decryptForAuthor(params: {
    writerId: string;
    articleId: string;
  }): Promise<string> {
    const { rows } = await pool.query<{ writer_id: string }>(
      `SELECT writer_id FROM articles WHERE id = $1 AND deleted_at IS NULL`,
      [params.articleId],
    );

    if (rows.length === 0) {
      throw new KeyServiceError("ARTICLE_NOT_FOUND", "Article not found");
    }
    if (rows[0].writer_id !== params.writerId) {
      throw new KeyServiceError("FORBIDDEN", "Not the article author");
    }

    const keyRow = await pool.query<{
      content_key_enc: string;
      algorithm: string;
      ciphertext: string | null;
    }>(
      `SELECT content_key_enc, algorithm, ciphertext FROM vault_keys WHERE article_id = $1`,
      [params.articleId],
    );

    if (keyRow.rowCount === 0 || !keyRow.rows[0].ciphertext) {
      throw new KeyServiceError(
        "VAULT_KEY_NOT_FOUND",
        "No vault content for this article",
      );
    }

    const { content_key_enc, algorithm, ciphertext } = keyRow.rows[0];
    const contentKeyBytes = decryptContentKey(content_key_enc);

    if (algorithm === "xchacha20poly1305") {
      return decryptArticleBodyXChaCha(ciphertext, contentKeyBytes);
    }
    return decryptArticleBody(ciphertext, contentKeyBytes);
  }

  // ---------------------------------------------------------------------------
  // logIssuance — records to content_key_issuances; returns true if re-issuance
  // ---------------------------------------------------------------------------

  private async logIssuance(params: {
    vaultKeyId: string;
    readerId: string;
    articleId: string;
    readEventId: string | null;
  }): Promise<boolean> {
    const { rows: prior } = await pool.query<{ id: string }>(
      `SELECT id FROM content_key_issuances
       WHERE reader_id = $1 AND article_id = $2
       LIMIT 1`,
      [params.readerId, params.articleId],
    );

    const isReissuance = prior.length > 0;

    await pool.query(
      `INSERT INTO content_key_issuances
         (vault_key_id, reader_id, article_id, read_event_id, is_reissuance)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.vaultKeyId,
        params.readerId,
        params.articleId,
        params.readEventId,
        isReissuance,
      ],
    );

    return isReissuance;
  }
}

// ---------------------------------------------------------------------------
// Typed error class — routes can switch on code for HTTP status mapping
// ---------------------------------------------------------------------------

export class KeyServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KeyServiceError";
  }
}

export const vaultService = new VaultService();
