import type { FastifyInstance } from "fastify";
import { loadConfig } from "@platform-pub/shared/db/client.js";

// =============================================================================
// GET /published-figures — the dials the public pages NAME.
//
// About tells a stranger what the platform's cut is and what a new account is
// given. Both are `platform_config` dials (`platform_fee_bps`,
// `free_allowance_pence`), so a figure typed into that copy is a second,
// silent copy of the dial: right at the default, and wrong the day either is
// retuned (walkthrough A24). The page asks this route instead.
//
// Public and unauthenticated, and NOT behind CLOSED_BETA: these are facts the
// About page states to everybody, unlike `/auth/open`, whose 404 IS the
// closed-beta answer. Only dials the public copy actually names belong here —
// a dial with no sentence on a public page is operator business, not this
// route's.
//
// Its one heavy caller is the web's About page, which renders behind
// `revalidate`, so the server fetch arrives about once per window; the bucket
// is for everyone else.
// =============================================================================

export async function publishedFiguresRoutes(app: FastifyInstance) {
  app.get(
    "/published-figures",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      const { platformFeeBps, freeAllowancePence } = await loadConfig();
      return reply.status(200).send({ platformFeeBps, freeAllowancePence });
    },
  );
}
