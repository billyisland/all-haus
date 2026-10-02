import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { parseTimestampCursor } from "@platform-pub/shared/lib/timestamp-cursor.js";
import { UUID_RE, loadFeed } from "./shared.js";
import { loadFeedSeenWindow, recordFeedSeen } from "./items.js";

// =============================================================================
// The reading counts' two routes (WORKSPACE-QUEUE-ADR §IV.1).
//
//   GET  /workspace/feeds/:id/seen   — the feed's window (FeedSeenWindow)
//   POST /workspace/feeds/:id/seen   — { asOf }: the member has LOOKED; move
//                                      the baseline, answer the new window
//
// Both are owner-scoped through loadFeed and answer 404 on somebody else's
// feed. The window and the baseline write live beside the selection they share
// (items.ts); this file owns only what is about the REQUEST.
//
// The baseline is not folded into the feed PATCH, whose fields are all things
// the member CHOSE. A look is not a choice, and it has its own shape: a token
// the server minted, only ever moving forward.
// =============================================================================

// Reads the body two ways, because two senders post it.
//
// JSON from `request`, and text/plain from `navigator.sendBeacon`, which is
// how a closing tab records the look it was in the middle of (§IV.4) and which
// cannot set a content type — a string body goes as `text/plain`. Fastify's
// default parsers hand the first over as an object and the second as a string,
// so the string is parsed here.
//
// TEXT/PLAIN MAKES THIS ROUTE REACHABLE BY A CROSS-SITE SIMPLE REQUEST, which
// is safe only because the session cookie is `sameSite: "lax"`
// (shared/src/auth/session.ts): a cross-site POST carries no session and meets
// requireAuth's 401. The effect is bounded anyway — the baseline only moves
// forward and never past now() — but IF THE COOKIE'S SameSite IS EVER LOOSENED,
// THIS ROUTE NEEDS A CSRF CHECK FIRST.
function readAsOf(body: unknown): string | null {
  let value: unknown = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Not JSON: the modelled outcome is "malformed", answered as a 400.
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  // Parsed at the edge: a string Postgres would refuse must never reach the
  // `::timestamptz` cast, where it would surface as a fault of ours rather
  // than the client's.
  return parseTimestampCursor((value as { asOf?: unknown }).asOf as string);
}

export function registerFeedSeenRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/feeds/:id/seen",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      // A path id answers 404, never 400 (security.md).
      if (!UUID_RE.test(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });
      return reply.send(
        await loadFeedSeenWindow(ownerId, id, feed.source_count),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/feeds/:id/seen",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });
      const asOf = readAsOf(req.body);
      if (!asOf)
        return reply
          .status(400)
          .send({ error: "asOf must be a timestamp the server issued" });
      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });
      const window = await recordFeedSeen(ownerId, id, asOf, feed.source_count);
      if (!window) return reply.status(404).send({ error: "We couldn't find that channel." });
      return reply.send(window);
    },
  );
}
