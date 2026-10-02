import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { vaultService, KeyServiceError } from "../services/vault.js";
import { decryptContentKey } from "../lib/kms.js";
import { wrapKeyForReader } from "../lib/nip44.js";
import { pool } from "@platform-pub/shared/db/client.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import logger from "@platform-pub/shared/lib/logger.js";
// The per-route budgets, and the reason each route needs its own — one home,
// shared with src/index.ts's registration (MIRROR-AUDIT §2.13).
import {
  readerKeyLimit,
  writerPublishLimit,
  writerReadLimit,
  writerExportLimit,
} from "../lib/rate-limit.js";
import {
  BINDING_HEADER,
  keyServiceSubject,
  verifyInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";
import { rawBodyOf } from "../lib/raw-body.js";

// =============================================================================
// Key Service Routes
//
// POST /articles/:nostrEventId/vault   — publish: encrypt body + store key
// POST /articles/:nostrEventId/key     — issue: verify payment + return NIP-44 key
// PATCH /articles/:nostrEventId/vault  — update vault event ID after relay publish
// GET  /writers/export-keys            — export all vault keys wrapped to the writer
//
// Auth: every route trusts gateway-injected identity headers (x-reader-id /
// x-reader-pubkey / x-writer-id), so every route must prove the caller IS the
// gateway: the plugin-scope preHandler below requires x-internal-secret to
// match INTERNAL_SECRET. Fail-closed — no secret configured means no access.
//
// AND, since S16, a per-request BINDING on top of that bearer (MIRROR-AUDIT §3
// *Security*). The secret alone says only "somebody holds it", and what it was
// buying here is every content key on the platform: the vault write, the paying
// reader's key issue, the author's own paywalled body, and an export of every
// vault key one writer holds. One captured request off the plaintext compose
// network yielded the credential and with it every other request.
//
// THE SUBJECT IS IN THE HEADERS ON THIS SERVICE, and that is the whole reason
// the shared tuple grew a `subject` term. key-custody names its signer in the
// body, so hashing the body already covers a retarget. Here `POST
// /articles/:id/key` carries `{}` and takes its reader from `x-reader-id`, and
// `GET /writers/export-keys` has no body at all — so path-plus-body-hash would
// not have noticed a captured request pointed at a different reader or a
// different writer by editing one header. The guard therefore re-reads those
// headers off the request it actually got and puts them in the tuple, in the
// order gateway/src/lib/key-service-client.ts fixes.
//
// `GET /auth-check` stays on the bare secret, deliberately: it is the shared
// boot-time parity probe, reaching it IS the proof, and a 401 there exits the
// gateway. Binding it would make one probe three.
// =============================================================================

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on unequal lengths; a length mismatch is already a
  // non-match, and the secret is high-entropy so leaking its length is harmless.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The identity headers this service acts on, in the fixed order the sender uses
 * (`keyServiceSubject`, in shared). Read off the
 * request, never off the binding — a binding that supplied its own subject would
 * be asserting the thing it is meant to prove.
 *
 * A missing header is the empty string rather than a skipped term, so no two
 * different identity sets can spell the same tuple.
 */
function subjectOf(req: {
  headers: Record<string, string | string[] | undefined>;
}): string[] {
  const one = (name: string): string => {
    const v = req.headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" ? s : "";
  };
  // The ORDER is `shared`'s, not ours — one spelling of the tuple, imported by
  // the sender too. Two copies would disagree silently.
  return keyServiceSubject({
    readerId: one("x-reader-id"),
    readerPubkey: one("x-reader-pubkey"),
    writerId: one("x-writer-id"),
    writerPubkey: one("x-writer-pubkey"),
  });
}

const PublishVaultSchema = z.object({
  articleId: z.string().uuid(),
  paywallBody: z.string().min(1),
  pricePence: z.number().int().positive(),
  gatePositionPct: z.number().int().min(1).max(99),
  nostrDTag: z.string().min(1),
});

export async function keyRoutes(app: FastifyInstance) {
  // Internal-secret gate for the whole plugin scope. The identity headers these
  // routes act on are only trustworthy when the gateway injected them; without
  // this gate any container on the compose network could mint itself a
  // writer/reader identity and decrypt paywalled content.
  app.addHook("preHandler", async (req, reply) => {
    const rawSecret = req.headers["x-internal-secret"];
    const secret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
    const expected = process.env.INTERNAL_SECRET;
    if (
      !expected ||
      typeof secret !== "string" ||
      !constantTimeEqual(secret, expected)
    ) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    // The parity probe is bearer-only. See the header.
    if (req.routeOptions?.url === "/api/v1/auth-check") return;

    const verdict = verifyInternalRequest(
      expected,
      req.headers[BINDING_HEADER],
      {
        method: req.method,
        path: req.url,
        rawBody: rawBodyOf(req),
        subject: subjectOf(req),
      },
    );
    if (!verdict.ok) {
      // The REASON is logged and never returned: the caller learns 401 and
      // nothing about which half it got wrong.
      logger.warn(
        { path: req.url, reason: verdict.reason },
        "Rejected unbound key-service request",
      );
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /auth-check
  //
  // The gateway's boot-time secret-parity probe. It needs no guard of its own —
  // the plugin-scope preHandler above already covers every route here, which is
  // exactly what makes reaching this handler proof that the caller's
  // INTERNAL_SECRET matches ours. The 200 IS the parity proof and the 401 IS the
  // mismatch; nothing derived from the secret is disclosed.
  // Spec: gateway/src/lib/internal-parity.ts.
  // ---------------------------------------------------------------------------

  // Exempt from rate limiting, deliberately. A 429 here is classified
  // "unreachable" by `classifyParityStatus` (gateway/src/lib/internal-parity.ts
  // names 200/401/403/404 and defaults the rest to ambiguous), so it is
  // correctly not fatal — but it leaves key-service reading "never confirmed",
  // which is the third state the probe exists to keep distinct from "fine",
  // degraded by an unrelated burst of publishing. Rate-limiting a liveness
  // probe is the wrong shape whichever bucket it lands in.
  app.get("/auth-check", { config: { rateLimit: false } }, async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/vault
  // Called by the publishing pipeline after the writer hits publish.
  // Encrypts the paywalled body and stores the content key.
  // Returns the vault event template for the caller to sign and publish.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/vault",
    { config: writerPublishLimit },
    async (req, reply) => {
      const writerId = req.headers["x-writer-id"];
      if (!writerId || typeof writerId !== "string") {
        return reply.status(401).send({ error: "Missing x-writer-id" });
      }

      const parsed = PublishVaultSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      // Verify the writer owns this article
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM articles
         WHERE id = $1 AND writer_id = $2 AND nostr_event_id = $3`,
        [parsed.data.articleId, writerId, req.params.nostrEventId],
      );

      if (rows.length === 0) {
        return reply
          .status(403)
          .send({ error: "Article not found or not owned by writer" });
      }

      try {
        const result = await vaultService.publishArticle({
          articleId: parsed.data.articleId,
          nostrArticleEventId: req.params.nostrEventId,
          paywallBody: parsed.data.paywallBody,
          pricePence: parsed.data.pricePence,
          gatePositionPct: parsed.data.gatePositionPct,
          nostrDTag: parsed.data.nostrDTag,
        });

        return reply.status(201).send({
          vaultKeyId: result.vaultKeyId,
          ciphertext: result.ciphertext,
          algorithm: result.algorithm,
        });
      } catch (err) {
        logger.error(
          { err, writerId, nostrEventId: req.params.nostrEventId },
          "Vault publish failed",
        );
        return reply.status(500).send({ error: "Vault publish failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/key
  // Called by the web client when a reader passes a gate.
  // Verifies payment, issues the NIP-44 encrypted content key.
  //
  // Rate-limited: 10 requests per reader per minute — prevents key-fishing.
  // (`readerKeyLimit` above; the plugin is registered non-global at startup, so
  // this budget is this route's alone and is no longer spent by writer traffic.)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/key",
    { config: readerKeyLimit },
    async (req, reply) => {
      const readerId = req.headers["x-reader-id"];
      const readerPubkey = req.headers["x-reader-pubkey"];

      if (!readerId || typeof readerId !== "string") {
        return reply.status(401).send({ error: "Missing x-reader-id" });
      }
      if (!readerPubkey || typeof readerPubkey !== "string") {
        return reply.status(401).send({ error: "Missing x-reader-pubkey" });
      }
      if (!/^[0-9a-f]{64}$/.test(readerPubkey)) {
        return reply
          .status(400)
          .send({ error: "Invalid x-reader-pubkey format" });
      }

      try {
        const keyResponse = await vaultService.issueKey({
          readerId,
          readerPubkey,
          articleNostrEventId: req.params.nostrEventId,
        });

        return reply.status(200).send(keyResponse);
      } catch (err) {
        if (err instanceof KeyServiceError) {
          const statusMap: Record<string, number> = {
            ARTICLE_NOT_FOUND: 404,
            PAYMENT_NOT_VERIFIED: 402,
            PROVISIONAL_ONLY: 402,
            NO_PAYMENT_RECORD: 402,
            VAULT_KEY_NOT_FOUND: 404,
          };
          const status = statusMap[err.code] ?? 500;
          return reply
            .status(status)
            .send({ error: err.code, message: err.message });
        }

        logger.error(
          { err, readerId, nostrEventId: req.params.nostrEventId },
          "Key issuance failed",
        );
        return reply.status(500).send({ error: "Key issuance failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /writers/export-keys
  //
  // Author migration support. Returns all vault keys for the authenticated
  // writer, each wrapped with NIP-44 to the writer's own pubkey. The writer
  // can decrypt them with their Nostr private key to access their own content
  // after leaving the platform.
  //
  // Requires x-writer-id and x-writer-pubkey headers (injected by gateway).
  // ---------------------------------------------------------------------------

  app.get("/writers/export-keys", { config: writerExportLimit }, async (req, reply) => {
    const writerId = req.headers["x-writer-id"];
    const writerPubkey = req.headers["x-writer-pubkey"];

    if (!writerId || typeof writerId !== "string") {
      return reply.status(401).send({ error: "Missing x-writer-id" });
    }
    if (!writerPubkey || typeof writerPubkey !== "string") {
      return reply.status(401).send({ error: "Missing x-writer-pubkey" });
    }

    try {
      // Fetch all vault keys for the writer's paywalled articles
      const { rows } = await pool.query<{
        article_id: string;
        nostr_event_id: string;
        nostr_d_tag: string;
        title: string;
        content_key_enc: string;
        algorithm: string;
      }>(
        `SELECT vk.article_id, a.nostr_event_id, a.nostr_d_tag, a.title,
                vk.content_key_enc, vk.algorithm
         FROM vault_keys vk
         JOIN articles a ON a.id = vk.article_id
         WHERE a.writer_id = $1
           AND a.deleted_at IS NULL
         ORDER BY a.published_at DESC`,
        [writerId],
      );

      // One undecryptable row is a fact about that article, not about the
      // export: it is skipped and NAMED beside the keys that did open, never
      // allowed to fail the writer's every other key (the partial-outcome rule).
      const keys = [];
      const skipped: string[] = [];
      for (const row of rows) {
        try {
          const contentKeyBytes = decryptContentKey(row.content_key_enc);
          const encryptedKey = wrapKeyForReader(contentKeyBytes, writerPubkey);
          keys.push({
            articleId: row.article_id,
            nostrEventId: row.nostr_event_id,
            dTag: row.nostr_d_tag,
            title: row.title,
            algorithm: row.algorithm,
            encryptedKey, // NIP-44 wrapped to writer's own pubkey
          });
        } catch (err) {
          logger.error(
            { err, writerId, articleId: row.article_id },
            "Writer key export: key could not be opened; skipped",
          );
          skipped.push(row.article_id);
        }
      }

      logger.info(
        { writerId, count: keys.length, skipped: skipped.length },
        "Writer key export",
      );
      return reply.status(200).send({ keys, skipped });
    } catch (err) {
      logger.error({ err, writerId }, "Writer key export failed");
      return reply.status(500).send({ error: "Key export failed" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /articles/:articleId/paywall-content
  //
  // Returns the decrypted paywall content to the article's own author for editing.
  // Requires x-writer-id header (injected by gateway from session).
  // ---------------------------------------------------------------------------

  app.get<{ Params: { articleId: string } }>(
    "/articles/:articleId/paywall-content",
    { config: writerReadLimit },
    async (req, reply) => {
      const writerId = req.headers["x-writer-id"];
      if (!writerId || typeof writerId !== "string") {
        return reply.status(401).send({ error: "Missing x-writer-id" });
      }

      try {
        const content = await vaultService.decryptForAuthor({
          writerId,
          articleId: req.params.articleId,
        });
        return reply.status(200).send({ content });
      } catch (err) {
        if (err instanceof KeyServiceError) {
          const statusMap: Record<string, number> = {
            ARTICLE_NOT_FOUND: 404,
            FORBIDDEN: 403,
            VAULT_KEY_NOT_FOUND: 404,
          };
          const status = statusMap[err.code] ?? 500;
          return reply.status(status).send({ error: err.code });
        }
        logger.error(
          { err, articleId: req.params.articleId },
          "Paywall content decrypt failed",
        );
        return reply.status(500).send({ error: "Decryption failed" });
      }
    },
  );
}
