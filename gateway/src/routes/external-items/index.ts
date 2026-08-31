import type { FastifyInstance } from "fastify";
import { registerEngagementRoutes } from "./engagement.js";
import { registerParentRoutes } from "./parent.js";
import { registerQuoteRoutes } from "./quote.js";
import { registerThreadRoutes } from "./thread.js";
import { registerInteractionRoutes } from "./interactions.js";

// External-item interaction + context routes (engagement counts, parent/quote/
// thread context tiles, and the outbound like/repost/poll-vote/reply actions),
// split into concern modules under routes/external-items/ (item 4a). Pure move:
// same route paths, same /api/v1 prefix (registered in gateway/src/index.ts).
// The background thread-hydration internals (willHydrateThread,
// hydrateExternalThreadContext) moved to lib/external-hydration.ts because they
// are consumed by routes/post-thread.ts, not just here; the shared row/interface
// types + Bluesky/Mastodon extractors live in lib/external-items-shared.ts.
export async function externalItemsRoutes(app: FastifyInstance) {
  registerEngagementRoutes(app);
  registerParentRoutes(app);
  registerQuoteRoutes(app);
  registerThreadRoutes(app);
  registerInteractionRoutes(app);
}
