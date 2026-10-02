import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { feedRowToResponse } from "./shared.js";
import { listFeedsForOwner } from "./crud.js";
import { loadFeedSources } from "./sources.js";
import { loadFeedItemsPage } from "./items.js";

// =============================================================================
// GET /workspace/bootstrap — one-shot workspace hydration (performance audit #3)
//
// The workspace cold-start used to be a client waterfall: feeds.list(), then a
// listSources() + items() per feed. Even with the per-feed calls fired in
// parallel that's fetchMe → list → items (3 serial hops) plus a 1 + 2N request
// fan-out — costly under HTTP/1.1 and N round-trips of latency.
//
// This endpoint collapses the data half into a single response: the feed list
// (seeding starter feeds for a new owner, exactly as GET /feeds does), plus each
// feed's sources and first page of items. The server does the per-feed fan-out
// concurrently against the shared pool, so the client pays one round trip.
//
// Shape mirrors the existing endpoints so the client maps it field-for-field:
//   { feeds: WorkspaceFeed[],
//     vessels: { [feedId]: { sources, items, nextCursor, placeholder, asOf } } }
//
// The per-vessel `items`/`nextCursor`/`placeholder` are exactly what GET
// /feeds/:id/items returns (minus the redundant `feed`, already in `feeds`);
// `sources` is exactly GET /feeds/:id/sources. A feed that errors mid-fan-out
// is omitted from `vessels` (logged) rather than failing the whole bootstrap —
// the client falls back to its per-vessel loader for any feed missing here.
// =============================================================================

const FIRST_PAGE_LIMIT = 20;

/** How many feeds hydrate at once (CA-G8). Each runs its sources read beside
 *  a page read of 3-4 sequential queries, so an unbounded fan-out over a
 *  member with ten-plus feeds took the whole 20-slot pool for the duration and
 *  queued every other request on the gateway behind one workspace load. */
const BOOTSTRAP_CONCURRENCY = 4;

export function registerFeedBootstrapRoutes(app: FastifyInstance) {
  app.get("/bootstrap", { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub;

    const feedRows = await listFeedsForOwner(ownerId);

    const vessels: Record<
      string,
      {
        sources: Awaited<ReturnType<typeof loadFeedSources>>;
        items: unknown[];
        nextCursor: string | undefined;
        placeholder: boolean;
        asOf: string;
      }
    > = {};

    // A fixed set of workers pulling from one queue: at most
    // BOOTSTRAP_CONCURRENCY feeds in flight, each failing alone.
    const queue = [...feedRows];
    const hydrate = async (feed: (typeof feedRows)[number]) => {
      try {
        const [sources, page] = await Promise.all([
          loadFeedSources(feed.id),
          loadFeedItemsPage(
            ownerId,
            feed.id,
            feed.source_count,
            undefined,
            FIRST_PAGE_LIMIT,
          ),
        ]);
        vessels[feed.id] = {
          sources,
          items: page.items,
          nextCursor: page.nextCursor,
          placeholder: page.placeholder,
          asOf: page.asOf,
        };
      } catch (err) {
        // Omit this feed's vessel payload; the client loads it lazily. One
        // bad feed must not blank the whole workspace.
        logger.error(
          { err, feedId: feed.id, ownerId },
          "Bootstrap vessel hydration failed",
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BOOTSTRAP_CONCURRENCY, queue.length) },
        async () => {
          for (let feed = queue.shift(); feed; feed = queue.shift()) {
            await hydrate(feed);
          }
        },
      ),
    );

    return reply.send({ feeds: feedRows.map(feedRowToResponse), vessels });
  });
}
