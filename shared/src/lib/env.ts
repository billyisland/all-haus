import { createPrivateKey, type KeyObject } from 'node:crypto'

// =============================================================================
// Environment Variable Validation
//
// Call requireEnv() at service startup to fail fast on missing config.
// =============================================================================

// A BOOLEAN FLAG IS "1", "0" OR ABSENT — AND ANYTHING ELSE SAYS SO.
//
// Every brake in this file was a bare `=== "1"`, which is correct for the two
// legal spellings and silent for every other: `DM_PRICING_ENABLED=true` — the
// spelling a deployer reaches for first, and the one `docker-compose.yml` uses
// for its own booleans — reads exactly as *not set at all*. The operator flips
// the switch, restarts, and the feature does not appear, with nothing anywhere
// saying why. That is the dead-dial failure in its environment-variable form,
// and `ops-and-config.md` already names it: a fallback is for an ABSENT value,
// never a malformed one, and the malformed arm has to say so.
//
// It still falls back to OFF — a dark feature staying dark is the safe half,
// and throwing here would take down a service over a typo in a flag it may not
// even read — but it warns once per variable, which is what turns "nothing
// happened" into a line an operator can find.
//
// Console rather than the shared logger deliberately: this module is imported
// by every service at load time, including before pino is configured, and a
// boot-time flag read must not depend on the logging stack being up.
const warnedMalformedFlags = new Set<string>()

export function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return false
  if (raw === '1') return true
  if (raw === '0') return false
  if (!warnedMalformedFlags.has(name)) {
    warnedMalformedFlags.add(name)
    console.warn(
      `[env] ${name}=${JSON.stringify(raw)} is not a flag value — expected "1" or "0". ` +
        'Treating it as OFF; the feature will not appear. Set it to "1" to enable.',
    )
  }
  return false
}

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

/**
 * A hex-encoded key of an exact BYTE length — the boot check for material a
 * cipher will later parse, stated in the units the cipher uses.
 *
 * `requireEnvMinLength(name, 32)` is 32 CHARACTERS, and every consumer of these
 * keys wants 32 BYTES, i.e. 64 hex characters. So a 32-character value passed
 * the startup check and threw at the first real use — for `ACCOUNT_KEY_HEX`
 * that is the first publish or key export, for `KMS_MASTER_KEY_HEX` the first
 * paywalled unlock. A fail-fast check that lets exactly the wrong value through
 * is worse than none: it reads as a validated deployment.
 *
 * The hex test matters as much as the length. `Buffer.from(s, 'hex')` silently
 * STOPS at the first non-hex character, so a 64-character value with a typo in
 * it yields a short key and, in some ciphers, a different one every restart.
 */
export function requireHexKeyBytes(name: string, bytes: number): string {
  const value = requireEnv(name)
  const expected = bytes * 2
  if (!new RegExp(`^[0-9a-fA-F]{${expected}}$`).test(value)) {
    throw new Error(
      `Environment variable ${name} must be ${bytes} bytes as ${expected} hex characters ` +
        `(got ${value.length} characters${/^[0-9a-fA-F]*$/.test(value) ? '' : ', and it is not all hex'})`
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
/**
 * The shared internal-service secret, read at USE time.
 *
 * Never `process.env.INTERNAL_SECRET ?? ""`. That is the shape the
 * `verifySession` invariant names — a fault of ours wearing an ordinary
 * negative outcome's clothes: the empty string is a well-formed credential that
 * every peer correctly rejects, so an unconfigured deployment presents as
 * key-service refusing the gateway's requests, which is indistinguishable from a
 * genuine authorisation problem and points the operator at the wrong thing.
 *
 * A function rather than a module constant because a constant makes a module's
 * IMPORTABILITY depend on deployment config: `article-publisher.ts` and
 * `export.ts` are imported by tests that have no business holding a secret, and
 * a top-level `requireEnv` turns those into collection-time crashes. The
 * gateway's refusal to boot without it is held where it belongs — at boot, by
 * `routes/articles/shared.ts` and `article-access/gate-pass.ts`.
 */
export function internalSecret(): string {
  return requireEnv("INTERNAL_SECRET");
}

// Trust graph (parked). Off ⇒ every trust route 404s (routes/trust.ts) and
// feed-ingest schedules none of the three trust crons. Client counterpart:
// NEXT_PUBLIC_TRUST_ENABLED (build arg).
export function trustSystemEnabled(): boolean {
  return envFlag("TRUST_SYSTEM_ENABLED")
}

// Traffology (writer analytics, parked). Off ⇒ every gateway /traffology/*
// route 404s. The ingest + worker containers are already removed from compose
// (DEPLOYMENT.md › Traffology (parked)), so the tables are empty and the
// surface would render only an empty state. Client counterpart:
// NEXT_PUBLIC_TRAFFOLOGY_ENABLED (build arg), which gates the /traffology
// pages, the dashboard's Analytics pill and the article beacon.
export function traffologyEnabled(): boolean {
  return envFlag("TRAFFOLOGY_ENABLED")
}

// Tribute authoring (Upstream Edges Phase 2). Default OFF.
//
// SUSPENDED BY OPERATOR DIRECTIVE 2026-08-25: the entire tribute system is not
// part of the launch version of all.haus. Do not flip this in a flag cleanup,
// and do not flip it on the engineering gates alone (the Dial-A rework, plus
// the rest of the conditions recorded in docs/adr/LEGAL-BRAKES.md) —
// restoration additionally requires the operator's explicit all-clear. The reason is substantive, not an unfinished feature; it is
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
  return envFlag("TRIBUTES_ENABLED")
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
  return envFlag("UPSTREAM_EDGES_ENABLED")
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
// cancel + pro-rata credit via applyLedgerDelta). That check was run at the
// 2026-08-31 suspension and came back empty, so nothing needed resolving that
// time — §1 H2. Run it again before darking a database that has rows.
//
// ONE VALUE ACROSS BOTH SERVICES — the gateway authors publications, the payment
// service moves their money. Client counterpart: NEXT_PUBLIC_PUBLICATIONS_ENABLED
// (build arg). Same shape as TRUST_SYSTEM_ENABLED.
export function publicationsEnabled(): boolean {
  return envFlag("PUBLICATIONS_ENABLED")
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
  return envFlag("PLEDGES_ENABLED")
}

// Priced DMs — SUSPENDED 2026-09-15. Default OFF, and the flag gates the whole
// subsystem rather than just its settings panel, because the panel was the only
// part that had ever been built.
//
// WHAT WAS WRONG. `dm_pricing` has always been written and read back by its own
// settings form and by nothing else: no send path consults it, so every DM on
// the platform is free whatever a member sets. The form stood above the tabs of
// the since-dissolved Network page, saying "Discourage unwanted messages by
// setting a fee for DMs from people you don't follow" — a promise about safety
// that the platform was in no position to keep, and the one class of dead
// control worse than a button that does nothing. It was never retired; it was
// never finished (CONSOLIDATED-TODO §5.3 still carries the charge-and-unblock
// endpoint as outstanding work).
//
// DO NOT TURN THIS ON UNTIL THE CHARGE EXISTS. Unlike the two flags above, which
// park COMPLETE features, this one parks an incomplete one — flipping it to "1"
// today does not revive a feature, it re-exposes the same false claim. The
// precondition is a 402 charge-and-unblock path on send, posting a ledger entry
// in the same transaction as the message (root CLAUDE.md › Money invariants),
// and that is a money path built at money speed, not at beta speed.
//
// Gated at the four routes and nowhere else, which is the whole of the entry to
// the four service functions (`gateway/src/routes/messages.ts`) — the narrowest
// shared choke point, so there is NO `NEXT_PUBLIC_` twin to flip in lockstep.
// The web asks rather than carrying a second copy of the flag: `DmFeeSettings`
// renders nothing unless `GET /settings/dm-pricing` answers 200, so the surface
// is cut by the gateway refusing rather than by a build-time constant.
//
// The table, its rows, the service functions and the routes are all left in
// place, so nobody's saved figure is destroyed and reviving it is one variable
// plus the work above.
//
// COUNT THE ROWS BEFORE DARKENING ANY DATABASE THAT HAS THEM. Suspending this
// withdraws a control somebody may believe is protecting them, so whether
// anyone has to be told is a question answered BEFORE the act, not noticed
// after it — the same discipline the publications note above requires of live
// subscriptions. The query, and what it returned at this suspension, are in
// DEPLOYMENT.md's `DM_PRICING_ENABLED` row: a count of who is on the platform
// is written in a doc, which does not ship to the public mirror, and never in
// a comment under a shipped directory (root CLAUDE.md › the mirror pre-flight).
// It inverts once the charge exists — a row then records a promise being kept,
// and darkening the feature would break it.
export function dmPricingEnabled(): boolean {
  return envFlag("DM_PRICING_ENABLED")
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
  return envFlag("STRIPE_ALLOCATED_FUNDS")
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
  return envFlag("IDENTITY_LINK_DETECT_ENABLED")
}

// Nostr reaction/reply count refresh on external cards (UNIVERSAL-FEED-ADR
// §VI.2). Default OFF — the relay REQ sweep is the heaviest engagement source.
// Read by feed-ingest (whether the counts exist at all: the refresh and the
// resonance baseline) AND by the gateway (whether `addSource` promises them),
// so it is ONE value on both services — compose passes the root `.env`'s value
// to each (CA-F1: feed-ingest had no way to receive it at all, and the three
// copies of this reader accepted `true` where every other flag warns on it).
export function nostrEngagementCountsEnabled(): boolean {
  return envFlag("NOSTR_ENGAGEMENT_COUNTS_ENABLED")
}

/**
 * An RSA private key, given as base64 of its PKCS#8 PEM, of at least `minBits`.
 *
 * The `requireHexKeyBytes` family, one cipher along: stated in the units the
 * CONSUMER uses. The consumer here is `crypto.createPrivateKey` followed by
 * `crypto.sign`, so what the check has to establish is not a length but that
 * the string yields a usable RSA private key of a modulus size the fediverse
 * will accept — a 1024-bit key parses perfectly and is refused by Mastodon.
 *
 * Base64 rather than the PEM itself because a PEM carries newlines, and a
 * multi-line value in a `.env` is the shape that arrives at the process
 * truncated at the first line: `createPrivateKey` then throws on a header with
 * no body, at the first outbound fetch rather than at boot. One line, one
 * decode, one parse, all of it before `listen()`.
 *
 * ABSENT IS NOT MALFORMED. This throws for both, so a caller that means the key
 * to be OPTIONAL tests `process.env[name]` itself and only calls this when
 * something is set — a typo must fail the boot, and an unset key must not.
 */
export function requireRsaPrivateKeyB64(name: string, minBits: number): string {
  const raw = requireEnv(name)
  // `Buffer.from(…, 'base64')` never throws — it skips what it cannot decode —
  // so malformed base64 is caught by the PEM-header test below, not by a catch.
  const pem = Buffer.from(raw, 'base64').toString('utf8')
  if (!pem.includes('-----BEGIN')) {
    throw new Error(
      `Environment variable ${name} must be base64 of a PEM private key ` +
        `(decoded to ${pem.length} characters with no PEM header — generate it with ` +
        `\`npx tsx scripts/gen-ap-instance-key.ts\`)`
    )
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (err) {
    throw new Error(
      `Environment variable ${name} did not parse as a private key: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(
      `Environment variable ${name} must be an RSA key (got ${key.asymmetricKeyType ?? 'unknown'})`
    )
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < minBits) {
    throw new Error(
      `Environment variable ${name} must be at least ${minBits} bits (got ${bits})`
    )
  }
  return pem
}
