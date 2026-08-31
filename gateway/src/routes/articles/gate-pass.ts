import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { performGatePass } from "../../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { KEY_SERVICE_URL, proxyToService } from "./shared.js";

// =============================================================================
// Vault/key proxies + gate-pass route
//
// POST  /articles/:nostrEventId/vault      — Proxy to key service (vault create)
// PATCH /articles/:nostrEventId/vault      — Proxy to key service (vault ID update)
// POST  /articles/:nostrEventId/key        — Proxy to key service (key issuance)
// POST  /articles/:nostrEventId/gate-pass  — Delegated to article-access orchestrator
// =============================================================================

export async function articleGatePassRoutes(app: FastifyInstance) {
  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/vault",
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers["x-writer-id"] = req.session!.sub!;
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        "POST",
        req,
        reply,
      );
    },
  );

  app.patch<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/vault",
    { preHandler: requireAuth },
    async (req, reply) => {
      // Inject writer identity so the key service can verify ownership
      req.headers["x-writer-id"] = req.session!.sub!;
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/vault`,
        "PATCH",
        req,
        reply,
      );
    },
  );

  app.post<{ Params: { nostrEventId: string } }>(
    "/articles/:nostrEventId/key",
    { preHandler: requireAuth },
    async (req, reply) => {
      req.headers["x-reader-id"] = req.session!.sub!;
      return proxyToService(
        `${KEY_SERVICE_URL}/api/v1/articles/${req.params.nostrEventId}/key`,
        "POST",
        req,
        reply,
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
