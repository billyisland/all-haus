// =============================================================================
// Environment Variable Validation
//
// Call requireEnv() at service startup to fail fast on missing config.
// =============================================================================

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export function requireEnvMinLength(name: string, minLength: number): string {
  const value = requireEnv(name)
  if (value.length < minLength) {
    throw new Error(
      `Environment variable ${name} must be at least ${minLength} characters (got ${value.length})`
    )
  }
  return value
}

// Trust subsystem master switch (Layer 1/2/4). Default OFF — the trust graph is
// parked (architecture-audit item 7): a display-only subsystem nobody is
// viewing. When off, feed-ingest stops scheduling the trust crons and the web
// UI hides the trust surfaces (the pip degrades to a neutral dot). Tables and
// the LEFT JOINs stay in place and degrade to NULL. Mirrors the
// DISCOVERY_PUBLISH_ENABLED shape; lives in shared so both gateway and
// feed-ingest can read it. Client counterpart: NEXT_PUBLIC_TRUST_ENABLED.
export function trustSystemEnabled(): boolean {
  return process.env.TRUST_SYSTEM_ENABLED === "1"
}

// Tribute authoring (Upstream Edges Phase 2). Default OFF.
//
// SUSPENDED BY OPERATOR DIRECTIVE 2026-08-25: the entire tribute system is not
// part of the launch version of all.haus. Do not flip this in a flag cleanup,
// and do not flip it on the engineering gates alone (Dial-A rework + compliance
// residual #1) — restoration additionally requires the operator's explicit
// all-clear. The reason is substantive, not an unfinished feature; it is
// recorded, with the restore conditions, in docs/adr/LEGAL-BRAKES.md (docs/
// deliberately does not ship to the public mirror, which is why the reason
// lives there and not here).
//
// When off, the tribute routes 404 and the lifecycle sweep is not scheduled;
// settlement freezes no accruals and the tribute payout cycle no-ops. The
// credit/citation/dispute edges (Phase 1) have their OWN brake below — the
// 2026-08-25 suspension covers both. Same shape as TRUST_SYSTEM_ENABLED.
// Client counterpart: NEXT_PUBLIC_TRIBUTES_ENABLED.
export function tributesEnabled(): boolean {
  return process.env.TRIBUTES_ENABLED === "1"
}

// Upstream Edges Phase 1 (credit / citation / dispute edges). Default OFF.
//
// SUSPENDED BY OPERATOR DIRECTIVE 2026-08-25, with the tribute system above —
// the directive covers the whole upstream-edges apparatus, not just the money
// edge (reason: docs/adr/LEGAL-BRAKES.md). Phase 1 redirects no earnings; its
// only money is the third-party disputant's refundable £5 stake on their OWN
// reading tab. It shipped live and ungated until this suspension. Do not flip
// without the operator's all-clear; flip together with (or ahead of)
// TRIBUTES_ENABLED, never the reverse — tribute authoring composes FROM citations.
//
// When off, every Phase-1 route 404s (POST /credits · /citations · /disputes,
// DELETE /disputes/:id, GET /articles/:id/credits · /citations), so no edge or
// dispute can be created, served, or withdrawn, and the article-foot apparatus
// renders nothing (the web fetchers answer empty on 404). Tables, ledger trigger
// types (dispute_stake/_refund) and relay-published edge events are untouched —
// flipping back on revives the feature whole. NOTE before darking a DB that has
// rows: an open third-party dispute holds a real £5 stake, and the withdraw/
// refund route darks with the rest — refund any held stakes first (zero rows
// everywhere as of 2026-08-25). Same shape as TRUST_SYSTEM_ENABLED. Client
// counterpart: NEXT_PUBLIC_UPSTREAM_EDGES_ENABLED.
export function upstreamEdgesEnabled(): boolean {
  return process.env.UPSTREAM_EDGES_ENABLED === "1"
}

// The whole publications system (multi-author titles: CRUD, membership and
// invites, the CMS submit/approve pipeline, the public /pub reader surface,
// publication subscriptions, revenue splits and the payroll surface).
// Default OFF.
//
// SUSPENDED BY OPERATOR DIRECTIVE 2026-08-31. Launch is SOLO AUTHOR ACCOUNTS
// ONLY. Like the tribute suspension above this is a deliberate brake, not an
// unfinished feature — the system is built, tested and shipped, it simply
// cannot be reached. Do not flip it in a flag cleanup and do not flip it on
// engineering grounds: restoration requires the operator's explicit all-clear
// (reason and conditions: docs/adr/LEGAL-BRAKES.md). Reinstatement checklist:
// docs/adr/PUBLICATIONS-SUSPENSION-PLAN.md §8.
//
// When off: all 27 /publications* routes 404 (one preHandler on the composed
// plugin), publication subscribe/unsubscribe and the publication RSS feed 404,
// publishToPublication/approveAndPublishArticle throw, the scheduler un-schedules
// a publication draft rather than publishing it (leaving the draft intact, same
// disposition as the paywall block), a publication subscription expires instead
// of renewing, and a formula projection skips publication sources and COUNTS
// them as excluded. Tables, rows, splits, payout history and already-published
// publication events are untouched.
//
// DELIBERATELY NOT GATED — read this before "finishing the job":
// `runPublicationPayoutCycle` and the publication chargeback/reversal paths stay
// live and data-driven. The publication pool and the personal writer cycle are
// exact complements (every personal query carries `AND publication_id IS NULL`),
// so a read claimed by neither is claimed by NOTHING: gating the pool would
// strand settled-but-unpaid publication earnings permanently, invisibly, with no
// error. With authoring dark no new publication reads are created, so the cycle
// drains what exists and then no-ops on its own — which is what makes this flag
// safe to toggle on-then-off. Same reasoning as the tribute chargeback path at
// settlement.ts. See PUBLICATIONS-SUSPENSION-PLAN.md §1 H1.
//
// NOTE before darking a DB that has rows: a live publication subscription is
// recurring tab debt, and its renewal worker darks with the rest — readers would
// be charged for pages that 404. Resolve live subscriptions FIRST (immediate
// cancel + pro-rata credit via applyLedgerDelta). Zero on prod at suspension
// (2026-08-31: 1 publication, 1 member, 0 articles, 0 subscriptions, 0 unpaid
// reads), so nothing needed resolving this time — §1 H2.
//
// ONE VALUE ACROSS BOTH SERVICES — the gateway authors publications, the payment
// service moves their money. Client counterpart: NEXT_PUBLIC_PUBLICATIONS_ENABLED
// (build arg). Same shape as TRUST_SYSTEM_ENABLED.
export function publicationsEnabled(): boolean {
  return process.env.PUBLICATIONS_ENABLED === "1"
}

// Pledge drives (crowdfund + commission) — parked 2026-07-13. Default OFF: the
// whole commissioning/pledging subsystem ships dark while it's out of play. When
// off, every /drives route 403s (create/pledge/accept/decline/…), so no new drive
// or pledge can be created; the fulfilment plumbing (matchDriveForPublish /
// fulfillDrive / drive-expiry) is left in place and simply goes inert — with no
// open drive, the publish-time match is a harmless no-op. Tables, ledger trigger
// type (pledge_fulfil) and the draftId threading are untouched, so flipping this
// back on revives the feature whole. Same shape as TRUST_SYSTEM_ENABLED. Client
// counterpart: NEXT_PUBLIC_PLEDGES_ENABLED.
export function pledgesEnabled(): boolean {
  return process.env.PLEDGES_ENABLED === "1"
}

// Stripe funds segregation / allocated funds (FUNDS-SEGREGATION-INTEGRATION.md).
// Default OFF — the beta is sandbox-only until Stripe enables it on the live
// account, and flipping it changes how every payout transfer is funded. When on:
// settlement PaymentIntents are created with allocated_funds enabled, the
// allocation-sync sweep reads each charge's locked balance back from Stripe, and
// the payout cycles pack their earnings onto charges as N child transfers each
// carrying source_transaction + an explicit application_fee_amount. When off,
// behaviour is byte-identical to today (one aggregate transfer per payout, the
// fee left implicit in the platform balance) and nothing writes the segregation
// tables. Read by payment-service (settlement, payout, webhook clients) and the
// gateway; auth.ts's Stripe client is deliberately NOT on the preview API
// version — it drives Connect onboarding and reader card setup, neither of which
// carries allocation, and a preview version moving under those paths locks
// writers out of onboarding or readers out of attaching a card. Same shape as
// TRUST_SYSTEM_ENABLED. No web twin — this is entirely server-side.
export function allocatedFundsEnabled(): boolean {
  return process.env.STRIPE_ALLOCATED_FUNDS === "1"
}

// The preview API version the allocated-funds beta requires on every Stripe API
// request. Runtime behaviour is governed by this header string, not by the
// stripe-node version (pinned at 2023-10-16 types), so the four call sites cast
// it rather than taking a v14→v18 major on this critical path.
export const ALLOCATED_FUNDS_API_VERSION =
  "2026-06-24.preview; allocated_funds_preview=v1"

// Cross-source identity-link detection (Slice 8 P3). Default OFF — the daily
// detection task writes GLOBAL links that suppress cross-posted duplicates in
// everyone's feed, so it ships dark behind this switch. When off, feed-ingest
// doesn't schedule the detect cron; user-asserted links (P2) are unaffected.
// Same shape as TRUST_SYSTEM_ENABLED. Spec: SLICE-8-IDENTITY-LINKING-PLAN.md §P3.
export function identityLinkDetectEnabled(): boolean {
  return process.env.IDENTITY_LINK_DETECT_ENABLED === "1"
}
