import type { FastifyRequest } from "fastify";
import { verifySession } from "@platform-pub/shared/auth/session.js";

// =============================================================================
// A rate-limit bucket keyed on the AUTHENTICATED ACCOUNT, under a namespace.
//
// Behind nginx every request shares the proxy's IP, so @fastify/rate-limit's
// default `req.ip` key would put every member in one bucket — one caller could
// exhaust it for everyone — and would give a stolen cookie a fresh bucket from
// each new address. The account is the identity these routes carry.
//
// `keyGenerator` runs at onRequest, BEFORE the requireAuth preHandler, so the
// session is re-derived here rather than read off `req.session`, which is not
// set yet. With no session it falls back to the IP, which requireAuth then
// answers with a 401 a moment later anyway. The namespace keeps each family's
// budget its own: two routes share a bucket only by naming the same one.
//
// One home for the construction the money routes, the reader's settle and
// the export legs had each written out (CA-H3).
// =============================================================================

export function accountRateLimitKey(
  namespace: string,
): (req: FastifyRequest) => Promise<string> {
  return async (req) => {
    try {
      const session = await verifySession(req);
      if (session?.sub) return `${namespace}:acct:${session.sub}`;
    } catch {
      // fall through to IP; requireAuth answers a moment later anyway
    }
    return `${namespace}:ip:${req.ip}`;
  };
}
