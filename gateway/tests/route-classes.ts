// =============================================================================
// Every gateway route, classified (READER-WRITER-SPLIT-ADR §4.6)
//
// Test data, read by nothing at runtime. `route-classes.test.ts` builds the
// real route table through `registerRoutes` and fails if a route is missing
// from here, if an entry here is no longer registered, or if a route's class
// and its guard disagree:
//
//   writer               — makes or changes something a publisher or seller
//                          makes. Carries `requireWriter` (or, for the two
//                          signing routes, the kind-30023 check in the handler).
//   money-out            — how money already earned leaves, or an operator act
//                          on payouts. Must NOT carry `requireWriter`: a gate
//                          that stops a writer being paid is a trap.
//   money-in-to-account  — moves a reader's money TO an account. Must ask the
//                          recipient predicate (`writerAdmittedSql`) in the file
//                          named in RECIPIENT_PREDICATE_HOME.
//   neither              — everything else: reading, notes and replies, taking
//                          down or reading back one's own work, admin, feeds.
//
// ADDING A ROUTE MEANS DECIDING ITS CLASS HERE. That is the point: a hand-kept
// list of writer routes passes CI when somebody adds one and forgets it; this
// does not. HEAD routes Fastify derives from GETs are not listed.
// =============================================================================

export const ROUTE_CLASS_NAMES = [
  "writer",
  "money-out",
  "money-in-to-account",
  "neither",
] as const;
export type RouteClass = (typeof ROUTE_CLASS_NAMES)[number];

/** Writer routes whose check lives in the handler (a note must not pay for the lookup). */
export const IN_HANDLER_WRITER_CHECK = new Set([
  "POST /api/v1/sign",
  "POST /api/v1/sign-and-publish",
]);

/** Where each live money-in route asks the recipient predicate. */
export const RECIPIENT_PREDICATE_HOME: Record<string, string> = {
  "POST /api/v1/subscriptions/:writerId": "src/routes/subscriptions/writer.ts",
  "POST /api/v1/articles/:nostrEventId/gate-pass": "src/services/article-access/gate-pass.ts",
  // The arrival route performs a gate pass (`articles/arrival.ts`).
  "POST /api/v1/articles/:dTag/arrival": "src/services/article-access/gate-pass.ts",
  "POST /api/v1/drives": "src/routes/drives.ts",
  "POST /api/v1/drives/:id/pledge": "src/routes/drives.ts",
};

/**
 * Money-in routes whose target check is DELIBERATELY not applied, with the
 * reason. A tribute pays an inspirer who need not be a writer (an external
 * invitee signs up to claim one), so whether a reader may receive one is for
 * the session that un-darks tributes (READER-WRITER-SPLIT-ADR §4.5; why they
 * are dark is docs/adr/LEGAL-BRAKES.md). The test asserts each is still dark.
 */
export const RECIPIENT_CHECK_DEFERRED: Record<string, { file: string; darkBy: string }> = {
  "POST /api/v1/tributes/:id/consent": { file: "src/routes/tributes.ts", darkBy: "tributesEnabled" },
  "POST /api/v1/tributes/claim": { file: "src/routes/tributes.ts", darkBy: "tributesEnabled" },
};

export const ROUTE_CLASSES: Record<string, RouteClass> = {
  "GET /.well-known/jwks.json": "neither",
  "GET /.well-known/nostr.json": "neither",
  "GET /.well-known/oauth-client-metadata.json": "neither",
  "GET /.well-known/webfinger": "neither",
  "GET /actor": "neither",
  "POST /actor/inbox": "neither",
  "GET /api/v1/account/export": "neither",
  "POST /api/v1/account/export/request": "neither",
  "GET /api/v1/admin/activitypub/instance-health": "neither",
  "GET /api/v1/admin/blocks": "neither",
  "POST /api/v1/admin/blocks": "neither",
  "DELETE /api/v1/admin/blocks/:id": "neither",
  "GET /api/v1/admin/dashboard/allocation-coverage": "neither",
  "GET /api/v1/admin/dashboard/config": "neither",
  "PATCH /api/v1/admin/dashboard/config": "neither",
  "GET /api/v1/admin/dashboard/content": "neither",
  "POST /api/v1/admin/dashboard/dead-jobs/reap": "neither",
  "POST /api/v1/admin/dashboard/halt-payouts/:accountId": "money-out", // admin
  "GET /api/v1/admin/dashboard/members": "neither",
  "GET /api/v1/admin/dashboard/overview": "neither",
  "GET /api/v1/admin/dashboard/reader-credits": "neither",
  "POST /api/v1/admin/dashboard/refund": "money-out", // admin; pays a reader's credit back
  "GET /api/v1/admin/dashboard/regulatory": "neither",
  "POST /api/v1/admin/dashboard/resume-payouts": "money-out", // admin
  "POST /api/v1/admin/dashboard/resume-payouts/:accountId": "money-out", // admin
  "GET /api/v1/admin/dashboard/seed-formula": "neither",
  "POST /api/v1/admin/dashboard/seed-formula": "neither",
  "POST /api/v1/admin/dashboard/trigger-payouts": "money-out", // admin
  "POST /api/v1/admin/dashboard/trigger-settlements": "money-out", // admin
  "GET /api/v1/admin/dashboard/users": "neither",
  "GET /api/v1/admin/dashboard/waitlist": "neither",
  "POST /api/v1/admin/dashboard/waitlist/admit": "neither",
  "POST /api/v1/admin/dashboard/waitlist/invite": "neither",
  "POST /api/v1/admin/dashboard/waitlist/remove": "neither",
  "GET /api/v1/admin/dashboard/writer-applications": "neither",
  // The grant makes somebody a writer, but it is the OPERATOR's act on another
  // account, behind requireAdmin — not a writer's own act, so no requireWriter.
  "POST /api/v1/admin/dashboard/writer-applications/grant": "neither",
  "POST /api/v1/admin/reinstate/:accountId": "neither",
  "GET /api/v1/admin/reports": "neither",
  "PATCH /api/v1/admin/reports/:reportId": "neither",
  "PATCH /api/v1/admin/reports/:reportId/appeal": "neither",
  "PATCH /api/v1/admin/reports/:reportId/priority": "neither",
  "POST /api/v1/admin/reports/:reportId/review": "neither",
  "POST /api/v1/admin/suspend/:accountId": "neither",
  "POST /api/v1/articles": "writer", // the index route
  "POST /api/v1/articles/:articleId/gift-link": "writer", // a publisher act
  "DELETE /api/v1/articles/:articleId/gift-link/:linkId": "neither",
  "GET /api/v1/articles/:articleId/gift-links": "neither",
  "POST /api/v1/articles/:articleId/redeem-gift": "neither",
  "GET /api/v1/articles/:articleId/tags": "neither",
  "PUT /api/v1/articles/:articleId/tags": "neither",
  "GET /api/v1/articles/:dTag": "neither",
  "POST /api/v1/articles/:dTag/arrival": "money-in-to-account",
  "DELETE /api/v1/articles/:id": "neither",
  "PATCH /api/v1/articles/:id": "neither",
  "GET /api/v1/articles/:id/citations": "neither",
  "GET /api/v1/articles/:id/credits": "neither",
  "POST /api/v1/articles/:id/pin": "neither",
  "GET /api/v1/articles/:id/tributes": "neither",
  "POST /api/v1/articles/:id/unpublish": "neither",
  "POST /api/v1/articles/:nostrEventId/gate-pass": "money-in-to-account",
  "POST /api/v1/articles/:nostrEventId/vault": "writer", // seal a paywalled body
  "GET /api/v1/articles/by-event/:nostrEventId": "neither",
  "POST /api/v1/auth/accept-terms": "neither",
  "POST /api/v1/auth/change-email": "neither",
  "POST /api/v1/auth/change-username": "neither",
  "GET /api/v1/auth/check-username/:username": "neither",
  "POST /api/v1/auth/connect-card": "neither",
  "POST /api/v1/auth/deactivate": "neither",
  "POST /api/v1/auth/declare-age": "neither",
  "POST /api/v1/auth/delete-account": "neither",
  "GET /api/v1/auth/google": "neither",
  "POST /api/v1/auth/google/exchange": "neither",
  "POST /api/v1/auth/login": "neither",
  "POST /api/v1/auth/logout": "neither",
  "GET /api/v1/auth/me": "neither",
  "POST /api/v1/auth/onboarded": "neither",
  "GET /api/v1/auth/open": "neither",
  "DELETE /api/v1/auth/payment-method": "neither",
  "PATCH /api/v1/auth/profile": "neither",
  "POST /api/v1/auth/setup-intent": "neither",
  "POST /api/v1/auth/signup": "neither",
  "POST /api/v1/auth/upgrade-writer": "money-out", // Connect onboarding; asks canWrite OR holdsWriterLedger in the handler
  "POST /api/v1/auth/verify": "neither",
  "POST /api/v1/auth/undo-email-change": "neither",
  "POST /api/v1/auth/verify-email-change": "neither",
  "GET /api/v1/author-card": "neither",
  "POST /api/v1/author/:authorId/links": "neither",
  "DELETE /api/v1/author/:authorId/links/:linkId": "neither",
  "GET /api/v1/author/:authorId/posts": "neither",
  "GET /api/v1/author/:authorId/profile": "neither",
  "GET /api/v1/author/:authorId/replies": "neither",
  "POST /api/v1/citations": "writer", // dark (UPSTREAM_EDGES_ENABLED)
  "POST /api/v1/conversations": "neither",
  "POST /api/v1/credits": "writer", // dark (UPSTREAM_EDGES_ENABLED)
  "POST /api/v1/disputes": "neither",
  "DELETE /api/v1/disputes/:id": "neither",
  "POST /api/v1/dm/decrypt-batch": "neither",
  "GET /api/v1/drafts": "neither",
  "POST /api/v1/drafts": "writer", // create and save a draft
  "DELETE /api/v1/drafts/:id": "neither",
  "GET /api/v1/drafts/:id": "neither",
  "POST /api/v1/drafts/:id/publish": "writer", // publish now (server-side publisher)
  "DELETE /api/v1/drafts/:id/schedule": "neither",
  "POST /api/v1/drafts/:id/schedule": "writer", // schedule a publish
  "POST /api/v1/drives": "money-in-to-account", // dark
  "DELETE /api/v1/drives/:id": "neither",
  "GET /api/v1/drives/:id": "neither",
  "PUT /api/v1/drives/:id": "neither",
  "POST /api/v1/drives/:id/accept": "writer", // dark (PLEDGES_ENABLED)
  "POST /api/v1/drives/:id/decline": "neither",
  "POST /api/v1/drives/:id/pin": "neither",
  "DELETE /api/v1/drives/:id/pledge": "neither",
  "POST /api/v1/drives/:id/pledge": "money-in-to-account", // dark
  "GET /api/v1/drives/by-user/:userId": "neither",
  "GET /api/v1/earnings/:writerId": "money-out",
  "GET /api/v1/earnings/:writerId/articles": "money-out",
  "GET /api/v1/email/unsubscribe": "neither",
  "POST /api/v1/email/unsubscribe": "neither",
  "GET /api/v1/external-items/:id/engagement": "neither",
  "POST /api/v1/external-items/:id/like": "neither",
  "GET /api/v1/external-items/:id/parent": "neither",
  "POST /api/v1/external-items/:id/poll-vote": "neither",
  "GET /api/v1/external-items/:id/quote": "neither",
  "POST /api/v1/external-items/:id/reply": "neither",
  "POST /api/v1/external-items/:id/repost": "neither",
  "GET /api/v1/external-items/:id/thread": "neither",
  "GET /api/v1/extract": "neither",
  "POST /api/v1/follow-imports": "neither",
  "DELETE /api/v1/follow-imports/:id": "neither",
  "GET /api/v1/follow-imports/:id": "neither",
  "POST /api/v1/follow-imports/:id/confirm": "neither",
  "POST /api/v1/follow-imports/opml": "neither",
  "POST /api/v1/follow-imports/sync": "neither",
  "GET /api/v1/follows": "neither",
  "DELETE /api/v1/follows/:writerId": "neither",
  "GET /api/v1/follows/followers": "neither",
  "GET /api/v1/follows/pubkeys": "neither",
  "DELETE /api/v1/follows/publication/:id": "neither",
  "POST /api/v1/follows/publication/:id": "neither",
  "DELETE /api/v1/formulas/:id": "neither",
  "GET /api/v1/formulas/:token": "neither",
  "POST /api/v1/formulas/:token/redeem": "neither",
  "GET /api/v1/linked-accounts": "neither",
  "DELETE /api/v1/linked-accounts/:id": "neither",
  "PATCH /api/v1/linked-accounts/:id": "neither",
  "POST /api/v1/linked-accounts/bluesky": "neither",
  "POST /api/v1/linked-accounts/bluesky/assisted": "neither",
  "GET /api/v1/linked-accounts/bluesky/callback": "neither",
  "GET /api/v1/linked-accounts/callback": "neither",
  "POST /api/v1/linked-accounts/mastodon": "neither",
  "POST /api/v1/linked-accounts/mastodon/assisted": "neither",
  "GET /api/v1/me/privacy-preferences": "neither",
  "PUT /api/v1/me/privacy-preferences": "neither",
  "GET /api/v1/me/reading-preferences": "neither",
  "PUT /api/v1/me/reading-preferences": "neither",
  "GET /api/v1/media/oembed": "neither",
  "POST /api/v1/media/upload": "neither",
  "GET /api/v1/messages": "neither",
  "GET /api/v1/messages/:conversationId": "neither",
  "POST /api/v1/messages/:conversationId": "neither",
  "POST /api/v1/messages/:conversationId/read-all": "neither",
  "POST /api/v1/messages/:messageId/like": "neither",
  "POST /api/v1/messages/:messageId/read": "neither",
  "POST /api/v1/moderation/appeal/:reportId": "neither",
  "GET /api/v1/my/account-statement": "neither",
  "GET /api/v1/my/articles": "neither",
  "GET /api/v1/my/blocks": "neither",
  "DELETE /api/v1/my/blocks/:userId": "neither",
  "POST /api/v1/my/blocks/:userId": "neither",
  "GET /api/v1/my/commissions": "neither",
  "GET /api/v1/my/formulas": "neither",
  "GET /api/v1/my/library": "neither",
  "GET /api/v1/my/mutes": "neither",
  "DELETE /api/v1/my/mutes/:userId": "neither",
  "POST /api/v1/my/mutes/:userId": "neither",
  "GET /api/v1/my/payout-preferences": "money-out",
  "PATCH /api/v1/my/payout-preferences": "money-out",
  "GET /api/v1/my/pledges": "neither",
  "GET /api/v1/my/publications": "neither",
  "GET /api/v1/my/receipts/:settlementId": "neither",
  "GET /api/v1/my/relations/:userId": "neither",
  "GET /api/v1/my/tab": "neither",
  "POST /api/v1/my/tab/settle": "neither",
  "GET /api/v1/my/vouches": "neither",
  "POST /api/v1/notes": "neither",
  "DELETE /api/v1/notes/:nostrEventId": "neither",
  "GET /api/v1/notifications": "neither",
  "POST /api/v1/notifications/:id/read": "neither",
  "GET /api/v1/notifications/preferences": "neither",
  "PUT /api/v1/notifications/preferences/:category": "neither",
  "POST /api/v1/notifications/read-all": "neither",
  "GET /api/v1/platform-pubkey": "neither",
  "GET /api/v1/published-figures": "neither",
  "GET /api/v1/pub/:slug/rss": "neither",
  "POST /api/v1/publications": "writer", // dark (PUBLICATIONS_ENABLED)
  "DELETE /api/v1/publications/:id": "neither",
  "PATCH /api/v1/publications/:id": "neither",
  "GET /api/v1/publications/:id/articles": "neither",
  "POST /api/v1/publications/:id/articles": "writer", // dark
  "DELETE /api/v1/publications/:id/articles/:articleId": "neither",
  "PATCH /api/v1/publications/:id/articles/:articleId": "writer", // dark
  "POST /api/v1/publications/:id/articles/:articleId/publish": "writer", // dark
  "POST /api/v1/publications/:id/articles/:articleId/unpublish": "neither",
  "GET /api/v1/publications/:id/earnings": "money-out",
  "POST /api/v1/publications/:id/leave": "neither",
  "GET /api/v1/publications/:id/members": "neither",
  "DELETE /api/v1/publications/:id/members/:memberId": "neither",
  "PATCH /api/v1/publications/:id/members/:memberId": "neither",
  "POST /api/v1/publications/:id/members/accept": "writer", // dark; how one becomes a publication's writer
  "POST /api/v1/publications/:id/members/invite": "neither",
  "GET /api/v1/publications/:id/payroll": "neither",
  "PATCH /api/v1/publications/:id/payroll": "writer", // dark
  "PATCH /api/v1/publications/:id/payroll/article/:articleId": "writer", // dark
  "GET /api/v1/publications/:id/rate-card": "neither",
  "PATCH /api/v1/publications/:id/rate-card": "writer", // dark
  "POST /api/v1/publications/:id/transfer-ownership": "neither",
  "GET /api/v1/publications/:slug": "neither",
  "GET /api/v1/publications/:slug/masthead": "neither",
  "GET /api/v1/publications/:slug/public": "neither",
  "GET /api/v1/publications/by-slug/:slug/articles": "neither",
  "GET /api/v1/publications/invites/:token": "neither",
  "DELETE /api/v1/reading-log": "neither",
  "GET /api/v1/reading-log": "neither",
  "POST /api/v1/reading-log": "neither",
  "GET /api/v1/reading-positions/:postId": "neither",
  "PUT /api/v1/reading-positions/:postId": "neither",
  "GET /api/v1/receipts/export": "neither",
  "POST /api/v1/replies": "neither",
  "DELETE /api/v1/replies/:replyId": "neither",
  "GET /api/v1/replies/:targetEventId": "neither",
  "POST /api/v1/reports": "neither",
  "POST /api/v1/resolve": "neither",
  "GET /api/v1/resolve/:requestId": "neither",
  "GET /api/v1/search": "neither",
  "GET /api/v1/settings/dm-pricing": "neither",
  "PUT /api/v1/settings/dm-pricing": "neither",
  "DELETE /api/v1/settings/dm-pricing/override/:userId": "neither",
  "PUT /api/v1/settings/dm-pricing/override/:userId": "neither",
  "PATCH /api/v1/settings/subscription-price": "writer", // selling
  "GET /api/v1/settings/subscription-welcome": "neither",
  "PATCH /api/v1/settings/subscription-welcome": "writer", // selling
  "POST /api/v1/sign": "writer", // kind 30023 only, checked in the handler
  "POST /api/v1/sign-and-publish": "writer", // kind 30023 only, checked in the handler
  "GET /api/v1/sources/:id": "neither",
  "GET /api/v1/subscribers": "neither",
  "GET /api/v1/subscription-offers": "neither",
  "POST /api/v1/subscription-offers": "writer", // selling
  "DELETE /api/v1/subscription-offers/:offerId": "neither",
  "GET /api/v1/subscription-offers/redeem/:code": "neither",
  "PATCH /api/v1/subscriptions/:id/notifications": "neither",
  "DELETE /api/v1/subscriptions/:writerId": "neither",
  "POST /api/v1/subscriptions/:writerId": "money-in-to-account",
  "PATCH /api/v1/subscriptions/:writerId/visibility": "neither",
  "GET /api/v1/subscriptions/check/:writerId": "neither",
  "GET /api/v1/subscriptions/mine": "neither",
  "DELETE /api/v1/subscriptions/publication/:id": "neither",
  "POST /api/v1/subscriptions/publication/:id": "neither",
  "GET /api/v1/tags/:name": "neither",
  "GET /api/v1/tags/:name/posts": "neither",
  "GET /api/v1/tags/search": "neither",
  "GET /api/v1/thread/:postId": "neither",
  "GET /api/v1/thread/:postId/top": "neither",
  "GET /api/v1/traffology/concurrent": "neither",
  "GET /api/v1/traffology/concurrent/:pieceId": "neither",
  "GET /api/v1/traffology/feed": "neither",
  "GET /api/v1/traffology/overview": "neither",
  "GET /api/v1/traffology/piece/:pieceId": "neither",
  "POST /api/v1/tributes": "writer", // dark (TRIBUTES_ENABLED)
  "DELETE /api/v1/tributes/:id": "neither",
  "POST /api/v1/tributes/:id/consent": "money-in-to-account", // dark; target check deferred
  "POST /api/v1/tributes/:id/decline": "neither",
  "POST /api/v1/tributes/claim": "money-in-to-account", // dark; target check deferred
  "GET /api/v1/tributes/mine": "neither",
  "GET /api/v1/trust/:userId": "neither",
  "DELETE /api/v1/trust/polls/:userId": "neither",
  "GET /api/v1/trust/polls/:userId": "neither",
  "POST /api/v1/trust/polls/:userId": "neither",
  "GET /api/v1/unread-counts": "neither",
  "POST /api/v1/unwrap-key": "neither",
  "POST /api/v1/votes": "neither",
  "GET /api/v1/votes/mine": "neither",
  "GET /api/v1/votes/tally": "neither",
  "POST /api/v1/vouches": "neither",
  "DELETE /api/v1/vouches/:id": "neither",
  "POST /api/v1/waitlist": "neither",
  // A reader asking to write: the one writer-shaped route a reader must reach.
  "POST /api/v1/writer-applications": "neither",
  "GET /api/v1/workspace/bootstrap": "neither",
  "GET /api/v1/workspace/feeds": "neither",
  "POST /api/v1/workspace/feeds": "neither",
  "DELETE /api/v1/workspace/feeds/:id": "neither",
  "PATCH /api/v1/workspace/feeds/:id": "neither",
  "DELETE /api/v1/workspace/feeds/:id/author-volume/:pubkey": "neither",
  "GET /api/v1/workspace/feeds/:id/author-volume/:pubkey": "neither",
  "PUT /api/v1/workspace/feeds/:id/author-volume/:pubkey": "neither",
  "GET /api/v1/workspace/feeds/:id/formula": "neither",
  "POST /api/v1/workspace/feeds/:id/formula": "neither",
  "GET /api/v1/workspace/feeds/:id/items": "neither",
  "POST /api/v1/workspace/feeds/:id/merge": "neither",
  "GET /api/v1/workspace/feeds/:id/seen": "neither",
  "POST /api/v1/workspace/feeds/:id/seen": "neither",
  "GET /api/v1/workspace/feeds/:id/sources": "neither",
  "POST /api/v1/workspace/feeds/:id/sources": "neither",
  "DELETE /api/v1/workspace/feeds/:id/sources/:sourceId": "neither",
  "PATCH /api/v1/workspace/feeds/:id/sources/:sourceId": "neither",
  "POST /api/v1/workspace/feeds/:id/sources/:sourceId/move": "neither",
  "PUT /api/v1/workspace/feeds/order": "neither",
  "GET /api/v1/writers/:username": "neither",
  "GET /api/v1/writers/:username/articles": "neither",
  "GET /api/v1/writers/:username/followers": "neither",
  "GET /api/v1/writers/:username/following": "neither",
  "GET /api/v1/writers/:username/notes": "neither",
  "GET /api/v1/writers/:username/replies": "neither",
  "GET /api/v1/writers/:username/subscriptions": "neither",
  "GET /api/v1/writers/by-pubkey/:pubkey": "neither",
  "GET /health": "neither",
  "POST /inbound-mail": "neither",
  "POST /inbound-mail/:secret": "neither",
  "GET /rss": "neither",
  "GET /rss/:username": "neither",
};
