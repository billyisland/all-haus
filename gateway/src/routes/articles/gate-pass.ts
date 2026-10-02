import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { requireWriter } from "../../lib/writer-gate.js";
import { performGatePass } from "../../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { KEY_SERVICE_URL, proxyToService } from "./shared.js";
import { keyServiceHeaders } from "../../lib/key-service-client.js";
import { READER_TERMS_REQUIRED } from "../../lib/terms-gate.js";

// =============================================================================
// Vault proxy + gate-pass route
//
// POST  /articles/:nostrEventId/vault      — Proxy to key service (vault create)
// POST  /articles/:nostrEventId/gate-pass  — Delegated to article-access orchestrator
//
// There is no key-issuance proxy: a reader's key is issued inside the gate
// pass (`performGatePass` → key-service `POST /key`), never on a bare request
// (CA-I10 deleted the uncalled `/key` and `PATCH /vault` proxies).
// =============================================================================

export async function articleGatePassRoutes(app: FastifyInstance) {
  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/vault",
    // Sealing a paywalled body is the browser's paywalled publish path.
    { preHandler: [requireAuth, requireWriter] },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      const writerId = req.session!.sub!;
      req.headers["x-writer-id"] = writerId;
      const path = `/api/v1/articles/${req.params.nostrEventId}/vault`;
      return proxyToService(
        `${KEY_SERVICE_URL}${path}`,
        "POST",
        req,
        reply,
        (rawBody) =>
          keyServiceHeaders({
            method: "POST",
            path,
            rawBody,
            identity: { writerId },
          }),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // POST /articles/:nostrEventId/gate-pass — thin HTTP wrapper over the
  // performGatePass orchestrator. All free/charged/key-issuance logic lives in
  // services/article-access; this handler only translates the typed result
  // into HTTP status codes.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/gate-pass",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const readerPubkey = req.session!.pubkey;
      const { nostrEventId } = req.params;

      try {
        const result = await performGatePass({
          readerId,
          readerPubkey,
          nostrEventId,
        });

        switch (result.kind) {
          case "success":
            return reply.status(200).send(result.body);
          case "not_found":
            return reply.status(404).send({ error: "Article not found" });
          case "not_gated":
            return reply.status(400).send({ error: "Article is not gated" });
          case "misconfigured":
            return reply.status(409).send({
              error: "article_misconfigured",
              message:
                "This article can't be unlocked right now — its paywalled content wasn't stored correctly. You have not been charged. The author needs to re-publish it.",
            });
          case "invitation_required":
            return reply.status(403).send({
              error: "invitation_required",
              message:
                "This is a private article. Contact the author to request access.",
            });
          // 403 and not 402, for the reader-terms reason one step further on:
          // money is not the obstacle and a card will not clear it. The piece
          // is not on sale. The message says nothing about the writer's Stripe
          // account — that is between us and them (Writer 9.3; L5.6).
          case "not_for_sale":
            return reply.status(403).send({
              error: "not_for_sale",
              message:
                "This piece isn't available to buy at the moment. Nothing has been charged.",
            });
          // 403, not 402: money is not the obstacle and a card will not clear
          // it. The web has a dedicated branch on this code (`mapUnlockError`)
          // that renders the acceptance in the gate — a 402 would put it on the
          // add-a-card path, which for this reader is already done.
          case "reader_terms_required":
            return reply.status(403).send({
              error: READER_TERMS_REQUIRED,
              message:
                "Before your next paid read, please accept the all.haus Reader Terms.",
            });
          case "payment_required":
            return reply.status(402).send({
              error: result.error,
              message: "Payment required.",
            });
          case "key_issuance_failed_after_payment":
            return reply.status(502).send({
              error:
                "Key issuance failed — the read has been recorded. Retry to get the content key.",
              readEventId: result.readEventId,
            });
          case "service_unreachable":
            return reply
              .status(502)
              .send({ error: "Payment or key service unreachable" });
          case "service_error":
            return reply
              .status(500)
              .send({ error: "Gate pass recording failed" });
        }
      } catch (err) {
        logger.error(
          { err, readerId, nostrEventId },
          "Gate pass orchestration failed",
        );
        return reply.status(500).send({ error: "Internal error" });
      }
    },
  );
}
