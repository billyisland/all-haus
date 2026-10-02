import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../../lib/platform-config.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
import {
  createFeedForOwner,
  loadFeed,
  tagged,
  ENQUEUE_SPACING_MS,
} from "./shared.js";
import {
  addSource,
  accountArrivedSql,
  compareSourceLabels,
  type AddSourceInput,
} from "./sources.js";
import {
  isPublicSourceProtocol,
  type PublicSourceProtocol,
} from "../../lib/public-source-protocols.js";
import { isUuid } from "../../lib/request-inputs.js";

// =============================================================================
// Feed sharing — a feed's composition as a transmissible object
// (FEED-FORMULAS-ADR; amended by FEED-SHARE-LIVE-LINKS-ADR, 2026-08-30).
//
// THE LINK IS LIVE, THE COPY IS FROZEN (L1). A share link is a POINTER to a
// `feeds` row plus a token: the composition is PROJECTED when somebody looks
// and FROZEN when somebody adds. So a link never goes stale, there is exactly
// one per feed (L2), and after redeem nothing reaches the recipient again —
// D1's owned half, unchanged and now the whole of D1.
//
// TWO KINDS OF ROW, AND THE SCHEMA SAYS WHICH (L4). `feed_formulas.kind`:
//   'link' — resolves live. No feed_formula_sources, no name/description/
//            appearance/source_count/excluded_count; all read from the feed.
//   'seed' — the frozen composition of D6/D11: what every new account is
//            seeded from. It keeps its frozen rows and its snapshot columns.
// `feed_formulas_snapshot_iff_seed` is what makes that a fact rather than a
// rule a reader has to hold, and `kind` never changes after insert — which is
// why provenance keys on it (L9) rather than on `is_default_seed`, whose value
// is about what the operator currently keeps and not about anybody's feed.
//
// THE SEED DOES NOT TRACK LIVE, DELIBERATELY (L3). What a new account receives
// must be a composition a person has approved: a live seed would move the
// empty/too-large refusal from designation time, where an operator is present
// and can be told, to signup time, where a stranger is present and nobody is —
// and there that refusal is not a retryable error but a permanent un-seeding
// of every account created in the window (seedStarterFeeds → the `pre > 0`
// guard). So `seedStarterFeeds` is untouched by any of this; refreshing the
// seed is an operator act (re-designate, which cuts a fresh frozen row).
//
// A SEED HAS NO ADDRESS (L10). The token routes filter `kind = 'link'` in the
// SQL, not in a branch after the read, so a seed and an unknown token are the
// same 404 by construction. Serving a seed's token would project the
// operator's LIVE feed from a URL whose whole point is a frozen composition.
//
// TWO register functions, because the routes are not all workspace-scoped:
//   registerFeedFormulaRoutes  → mounted under /api/v1/workspace with the rest
//                                of the feeds plugin. Mint/status are genuinely
//                                feed-scoped, and /api/v1/feeds is already
//                                owned by external-feeds.ts.
//   formulaPublicRoutes        → mounted at /api/v1 from index.ts. The link
//                                page is a PUBLIC page a logged-out visitor can
//                                open; serving it from a path called
//                                "workspace" would be a lie about who it is for.
// The engine stays in one file either way.
//
// WHAT THIS IS NOT: the starter-template clone this replaced (cloneFeedForOwner,
// deleted with the flag in migration 179). That path copied external_source_id
// verbatim and took neither the feed_sub advisory lock nor a fetch job —
// shortcuts licensed ENTIRELY by its zero-feeds precondition, which a redeemer
// does not have (they hold existing feeds, so a concurrent removeSource
// teardown can race the subscription upsert, and the link may name sources
// this instance does not hold at all). Redemption was built as a sibling of the
// clone path rather than a parameter on it (D3), which is what let the clone go
// without anything needing to be re-argued here.
// =============================================================================

// Operator brake (§8 Phase 1). Default OFF. It gates MINT, the public page and
// REDEEM-BY-TOKEN — and the SEED path must NOT be gated on it: turning it off
// would then silently end new-account seeding, which is the §0l outage again
// from the opposite direction (ADR §6, unchanged and still load-bearing).
export function formulasEnabled(): boolean {
  const v = process.env.FEED_FORMULAS_ENABLED;
  return v === "1" || v === "true";
}

// Fails CLOSED by allow-list rather than by naming email (D5 as amended): the
// external_protocol enum already carries farcaster/matrix/telegram with no
// composer path today, and a future protocol addition must not leak into a
// share link by default. `email` is the one that would actually do harm —
// external_sources.ingest_address is a per-subscriber secret alias, so copying
// the row hands a recipient the author's private address and resolving it by
// identity would subscribe them to a newsletter in the author's name.
//
// The allow-list is unchanged by the live-link amendment and still bounds what
// a link can EVER expose (L1's accepted cost is the feed's future composition,
// not a widening of what may travel).
// The list itself moved to lib/public-source-protocols.ts (S16), which is now
// also what `GET /sources/:id` and add-by-`externalSourceId` ask before handing
// a row to a member who is not already a subscriber. Same list, same reason —
// its header carries both callers and what would make them diverge. The local
// names are kept so the reading of the call sites below is unchanged.
const isPortableProtocol = isPublicSourceProtocol;
type PortableProtocol = PublicSourceProtocol;

// The shareable source cap (§6). A tuning dial, not a constant: what the
// right number is depends on redeem latency, which is a property of live
// traffic. Sized by TIME, not storage — redemption resolves N sources through
// addSource, and a genuinely new identity is probed. In practice almost every
// source in a link is already held healthy by this instance (the author holds
// it), so the known-healthy short-circuit skips the probe; the cap bounds the
// pathological case. Lower it if redeem starts timing out.
const FORMULA_MAX_SOURCES_FALLBACK = 200;
export async function formulaMaxSources(): Promise<number> {
  const cfg = await getPlatformConfig();
  const raw = cfg.get("feed_formula_max_sources");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FORMULA_MAX_SOURCES_FALLBACK;
}

// ---------------------------------------------------------------------------
// Projection — which of a feed's sources can travel, and what they become
// ---------------------------------------------------------------------------

interface FeedSourceForFreeze {
  source_type: "account" | "publication" | "external_source" | "tag";
  throughput: string;
  sampling_mode: string;
  exclude_replies: boolean;
  tag_name: string | null;
  account_pubkey: string | null;
  account_display_name: string | null;
  account_username: string | null;
  account_avatar: string | null;
  publication_pubkey: string | null;
  publication_name: string | null;
  publication_avatar: string | null;
  external_protocol: string | null;
  external_source_uri: string | null;
  external_display_name: string | null;
  external_avatar: string | null;
  external_relay_urls: string[] | null;
  /** An account admit created whose owner has not arrived (`accountArrivedSql`). */
  account_unarrived: boolean;
}

/**
 * One source in portable form.
 *
 * ONE shape for both halves of the split (L1): what `freezeSource` emits from a
 * live feed, and what `populateFeedFromFormula` reads back out of a seed's
 * frozen rows. They must not be allowed to drift apart — the seed path and the
 * link path resolve through the same `resolveFormulaSource`, and two shapes
 * would mean two mappings that agree only by inspection.
 */
export interface FrozenSource {
  tagKind: "p" | "t" | "r" | "a";
  tagValue: string;
  tagHint: string | null;
  sourceType: FeedSourceForFreeze["source_type"];
  protocol: PortableProtocol | null;
  displayName: string | null;
  avatarUrl: string | null;
  throughput: string;
  samplingMode: string;
  excludeReplies: boolean;
}

/**
 * Map one feed_sources row to its portable form, or null if it cannot travel.
 *
 * Exported for the unit tests: this is the whole of D4/D5/D8 in one function —
 * which identities are portable, what each becomes on the wire, and what is
 * excluded — and it is pure, so it can be driven without a database.
 */
export function freezeSource(row: FeedSourceForFreeze): FrozenSource | null {
  const tuning = {
    throughput: row.throughput,
    samplingMode: row.sampling_mode,
    excludeReplies: row.exclude_replies,
  };

  if (row.source_type === "account") {
    // NULL only when the account row is gone (the LEFT JOIN missed) — a
    // deleted member cannot travel, so it is excluded and counted like any
    // other non-portable row rather than shipped as a dangling pubkey.
    if (!row.account_pubkey) return null;
    return {
      tagKind: "p",
      tagValue: row.account_pubkey,
      tagHint: null,
      sourceType: "account",
      protocol: null,
      displayName: row.account_display_name ?? row.account_username,
      avatarUrl: row.account_avatar,
      ...tuning,
    };
  }

  if (row.source_type === "publication") {
    // Publications suspended 2026-08-31 (shared/src/lib/env.ts). A publication
    // cannot travel while the system it points at is dark — a redeemer would
    // get a source that resolves to nothing. Returning null routes it through
    // the caller's existing exclusion tally, so it is COUNTED AND SHOWN rather
    // than silently dropped, which is the ADR §6 rule for every excluded
    // source. Reinstating the flag restores portability with no data change.
    if (!publicationsEnabled()) return null;
    // D4 as amended: a publication travels by publications.nostr_pubkey (unique,
    // publications_nostr_pubkey_key), NEVER by row id — the row id is exactly
    // the local FK D4 forbids for external sources, and it is meaningless the
    // day a formula serialises off-platform. It rides a 'p' tag because a
    // publication signs its own events; source_type is what tells a 'p' that
    // is a publication from a 'p' that is a member at redeem.
    if (!row.publication_pubkey) return null;
    return {
      tagKind: "p",
      tagValue: row.publication_pubkey,
      tagHint: null,
      sourceType: "publication",
      protocol: null,
      displayName: row.publication_name,
      avatarUrl: row.publication_avatar,
      ...tuning,
    };
  }

  if (row.source_type === "tag") {
    if (!row.tag_name) return null;
    return {
      tagKind: "t",
      tagValue: row.tag_name,
      tagHint: null,
      sourceType: "tag",
      protocol: null,
      displayName: row.tag_name,
      avatarUrl: null,
      ...tuning,
    };
  }

  // external_source — allow-list, then map protocol to its wire tag.
  if (!isPortableProtocol(row.external_protocol)) return null;
  if (!row.external_source_uri) return null;
  const protocol = row.external_protocol;
  return {
    // An external Nostr source's canonical source_uri IS a hex pubkey, so it
    // takes 'p' like a native account. rss/activitypub/atproto take 'r' (D8) —
    // note atproto's value is a DID rather than a URL, which is a known
    // stretch of the 'r' slot and is why `protocol` is stored alongside.
    tagKind: protocol === "nostr_external" ? "p" : "r",
    tagValue: row.external_source_uri,
    // The NIP-51 hint slot, used for what it is for: a relay to find this
    // pubkey on. It is a TRANSPORT hint and never part of the identity — the
    // relay-free-identity invariant bans hints from identity fields, and
    // tag_value stays the bare pubkey.
    tagHint:
      protocol === "nostr_external" ? (row.external_relay_urls?.[0] ?? null) : null,
    sourceType: "external_source",
    protocol,
    displayName: row.external_display_name,
    avatarUrl: row.external_avatar,
    ...tuning,
  };
}

/**
 * Read a feed's sources in the form `freezeSource` consumes.
 *
 * This ORDER BY is not the order a link's page shows: composer order (§11) is
 * alphabetical by rendered label, and the label is not a column here either,
 * so `freezeFeedSources` applies it after freezing. created_at/id survives as
 * the stable floor under that sort, which is what keeps `position` total.
 *
 * `feed_sources.muted_at` is deliberately NOT filtered — a muted source is
 * still part of the composition; muting is a per-feed display control on the
 * OWNER's copy. Only removeSource changes what a projection sees.
 */
async function loadFeedSourcesForFreeze(
  client: { query: typeof pool.query },
  feedId: string,
): Promise<FeedSourceForFreeze[]> {
  const { rows } = await client.query<FeedSourceForFreeze>(
    `SELECT fs.source_type, fs.throughput, fs.sampling_mode, fs.exclude_replies, fs.tag_name,
       acc.nostr_pubkey AS account_pubkey, acc.display_name AS account_display_name,
       acc.username AS account_username, acc.avatar_blossom_url AS account_avatar,
       pub.nostr_pubkey AS publication_pubkey, pub.name AS publication_name,
       pub.logo_blossom_url AS publication_avatar,
       xs.protocol::text AS external_protocol, xs.source_uri AS external_source_uri,
       xs.display_name AS external_display_name, xs.avatar_url AS external_avatar,
       xs.relay_urls AS external_relay_urls,
       NOT ${accountArrivedSql("acc")} AS account_unarrived
     FROM feed_sources fs
     LEFT JOIN accounts acc ON acc.id = fs.account_id
     LEFT JOIN publications pub ON pub.id = fs.publication_id
     LEFT JOIN external_sources xs ON xs.id = fs.external_source_id
     WHERE fs.feed_id = $1
     ORDER BY fs.created_at ASC, fs.id ASC`,
    [feedId],
  );
  return rows;
}

export interface FeedProjection {
  sources: FrozenSource[];
  excludedCount: number;
  /** What a redeem would refuse on, REPORTED rather than thrown. */
  refusal: "empty" | "too_large" | null;
}

/**
 * Project a feed's composition: what travels, how much does not, and whether
 * anybody could add it right now.
 *
 * THE ONE projection routine, and that is the point. The composer's status
 * line, the public page and redeem all read it, so they cannot disagree about
 * the row set, the ORDER BY or the allow-list — a status line computed over a
 * different projection is a claim about something nobody will ever receive,
 * and it fails in the reassuring direction (the author is shown MORE than
 * travels and learns otherwise only by opening their own link).
 *
 * Both refusals are returned rather than thrown, because for the composer the
 * refusal IS the message (L8): "nobody can add this yet" is a state the author
 * is entitled to see in words, not a 400 they discover by pressing something.
 * A refusal never blocks minting — a link to an empty feed is a valid link
 * nobody can redeem YET, and it starts working the moment a source is added
 * (L2).
 */
export async function freezeFeedSources(
  client: { query: typeof pool.query },
  feedId: string,
  maxSources: number,
  opts: { includeUnarrived?: boolean } = {},
): Promise<FeedProjection> {
  const rows = await loadFeedSourcesForFreeze(client, feedId);
  const sources: FrozenSource[] = [];
  let excludedCount = 0;
  for (const row of rows) {
    // A member admit created who has not yet arrived is named to nobody
    // (RESHAPE-PLAN-2026-10 §A.2.6), and a share link's page is somebody. So
    // the source is counted into the excluded figure — honestly, the same as
    // any source that cannot travel — and starts travelling the day they
    // arrive, because a link is live. The ONE caller that opts out is the
    // seed cut: the operator is the one person who should see the whole
    // composition, and seeding the cohort is exactly what the cut is for.
    if (row.account_unarrived && !opts.includeUnarrived) {
      excludedCount++;
      continue;
    }
    const f = freezeSource(row);
    if (f) sources.push(f);
    else excludedCount++;
  }
  // Composer order, by the label the recipient will read — the same comparator
  // the composer's own list uses, so the author's copy and the link's page
  // cannot disagree about the order any more than they do about the row set.
  // Sorting AFTER the exclusion loop is deliberate: what travels is decided by
  // `freezeSource` alone, never by where a row landed, and the cap refuses
  // rather than truncates, so the order moves nothing in or out.
  sources.sort((a, b) =>
    compareSourceLabels(frozenSourceLabel(a), frozenSourceLabel(b)),
  );
  return {
    sources,
    excludedCount,
    refusal:
      sources.length === 0
        ? "empty"
        : sources.length > maxSources
          ? "too_large"
          : null,
  };
}

// The one spelling of a frozen source's label, so the order it is sorted into
// is the order of the strings actually rendered.
function frozenSourceLabel(f: FrozenSource) {
  return f.sourceType === "tag" ? `#${f.tagValue}` : (f.displayName ?? f.tagValue);
}

// What a recipient sees. Deliberately display-only: a link's page is a
// composition, never content, and nobody's items appear on it (§3).
function frozenSourceToResponse(f: FrozenSource, position: number) {
  return {
    position,
    kind: f.sourceType,
    protocol: f.protocol,
    label: frozenSourceLabel(f),
    avatar: f.avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// The seed cut — the one place a FROZEN formula is still written (L3, L5)
// ---------------------------------------------------------------------------

export type FreezeResult =
  | {
      ok: true;
      formulaId: string;
      token: string;
      sourceCount: number;
      excludedCount: number;
    }
  | {
      ok: false;
      reason: "empty" | "too_large";
      sourceCount: number;
      excludedCount: number;
    };

/**
 * Freeze a feed's composition into a `kind = 'seed'` formula, inside the
 * caller's transaction.
 *
 * ITS ONLY CALLER IS DESIGNATION (L5): designating is always a fresh cut from
 * one of the operator's own feeds, never the adoption of a row that already
 * exists. That closes the hole L2 would otherwise open — with one link per
 * feed, designating an existing LINK would make a member's own share link
 * `is_default_seed`, which by `feed_formulas_seed_never_revoked` they could
 * then never Stop: an operator silently seizing a member's link and removing
 * their ability to withdraw it. A seed is cut, never adopted.
 *
 * Exported and client-threaded because what this must get right spans
 * feed_sources → accounts/publications/external_sources → feed_formula_sources,
 * and the interesting half is which rows DON'T make it and whether the count of
 * them is truthful. A mocked pool.query would answer from the mock rather than
 * from the database, so the DB-backed test drives this directly inside a
 * transaction it rolls back.
 *
 * The two business refusals are RETURNED, not thrown — both are decided before
 * any INSERT, so the caller's transaction is untouched either way, and the
 * route needs the counts to say anything useful. Unlike a link's mint, the seed
 * cut genuinely must refuse: a sourceless seed feed auto-serves the explore
 * placeholder, so every new member would open what they believe the platform
 * composed for them and be shown the platform stream.
 */
export async function freezeFeedIntoFormula(
  client: { query: typeof pool.query },
  params: {
    feedId: string;
    ownerId: string;
    name: string;
    description: string | null;
    appearance: Record<string, unknown>;
    maxSources: number;
  },
): Promise<FreezeResult> {
  const { sources, excludedCount, refusal } = await freezeFeedSources(
    client,
    params.feedId,
    params.maxSources,
    { includeUnarrived: true },
  );
  if (refusal)
    return {
      ok: false,
      reason: refusal,
      sourceCount: sources.length,
      excludedCount,
    };

  const token = crypto.randomBytes(16).toString("base64url");
  const {
    rows: [f],
  } = await client.query<{ id: string }>(
    `INSERT INTO feed_formulas
       (author_id, source_feed_id, kind, name, description, appearance, token,
        source_count, excluded_count)
     VALUES ($1, $2, 'seed', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.ownerId,
      params.feedId,
      params.name,
      params.description,
      JSON.stringify(params.appearance ?? {}),
      token,
      sources.length,
      excludedCount,
    ],
  );
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, tag_hint, source_type,
          protocol, display_name, avatar_url, throughput, sampling_mode, exclude_replies)
       VALUES ($1, $2, $3, $4, $5, $6, $7::external_protocol, $8, $9, $10, $11, $12)`,
      [
        f.id,
        i,
        s.tagKind,
        s.tagValue,
        s.tagHint,
        s.sourceType,
        s.protocol,
        s.displayName,
        s.avatarUrl,
        s.throughput,
        s.samplingMode,
        s.excludeReplies,
      ],
    );
  }
  return {
    ok: true,
    formulaId: f.id,
    token,
    sourceCount: sources.length,
    excludedCount,
  };
}

// ---------------------------------------------------------------------------
// The link row
// ---------------------------------------------------------------------------

interface LinkRow {
  id: string;
  token: string;
  created_at: Date;
  revoked_at: Date | null;
  is_default_seed: boolean;
  source_feed_id: string | null;
  feed_name: string | null;
  feed_appearance: Record<string, unknown> | null;
  author_display_name: string | null;
  author_username: string | null;
}

// A link is a POINTER, so its projection joins the feed it points at. The join
// is LEFT: `source_feed_id` is ON DELETE SET NULL, and a dangling link is a
// STATE rather than a deleted row (L7) — deleting the row is what would erase
// the provenance of every feed already redeemed from it, and the record of who
// published it. `kind = 'link'` is a filter in every caller's WHERE, never a
// branch after the read (L10).
const LINK_SELECT = `
  SELECT ff.id, ff.token, ff.created_at, ff.revoked_at, ff.is_default_seed,
         ff.source_feed_id,
         f.name AS feed_name, f.appearance AS feed_appearance,
         a.display_name AS author_display_name, a.username AS author_username
    FROM feed_formulas ff
    JOIN accounts a ON a.id = ff.author_id
    LEFT JOIN feeds f ON f.id = ff.source_feed_id`;

/** The live link for a feed, if the owner has one. */
async function loadLiveLinkForFeed(
  db: { query: typeof pool.query },
  feedId: string,
): Promise<LinkRow | null> {
  const { rows } = await db.query<LinkRow>(
    `${LINK_SELECT}
      WHERE ff.source_feed_id = $1 AND ff.kind = 'link' AND ff.revoked_at IS NULL`,
    [feedId],
  );
  return rows[0] ?? null;
}

/**
 * Mint the feed's share link, or hand back the one it already has.
 *
 * IDEMPOTENT, AND THAT IS WHAT MAKES THE COMPOSER ONE BUTTON (L2). The section
 * should never have to know whether it is creating or fetching, so this returns
 * the existing row rather than 409-ing. The pre-check does not survive two
 * presses of Create, so the `23505` from `uq_feed_formulas_live_per_feed`
 * resolves the same way: re-read and return the existing row. "Replace" is
 * Stop-then-Create, and is deliberately not a control.
 *
 * IT NEVER REFUSES. A link to a feed that is currently empty or over the cap is
 * a valid link nobody can redeem YET; the refusal belongs at redeem (L8) and
 * the composer says it in words. The old freeze had to refuse because it was
 * minting a snapshot of nothing — a pointer to nothing is still a pointer, and
 * it starts working the moment the author adds a source.
 *
 * The INSERT writes no `kind` and no snapshot column: `kind` defaults to
 * 'link', and name/description/appearance/source_count/excluded_count all land
 * NULL, which `feed_formulas_snapshot_iff_seed` is what requires.
 */
async function mintLinkForFeed(
  feedId: string,
  ownerId: string,
): Promise<LinkRow> {
  const existing = await loadLiveLinkForFeed(pool, feedId);
  if (existing) return existing;

  try {
    const {
      rows: [minted],
    } = await pool.query<{ id: string }>(
      `INSERT INTO feed_formulas (author_id, source_feed_id, token)
       VALUES ($1, $2, $3) RETURNING id`,
      [ownerId, feedId, crypto.randomBytes(16).toString("base64url")],
    );
    const { rows } = await pool.query<LinkRow>(`${LINK_SELECT} WHERE ff.id = $1`, [
      minted.id,
    ]);
    return rows[0];
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "23505") throw err;
    // Two presses raced. The index refused the second, which means the first
    // landed — so the answer to "create me a link" is the link that exists.
    const raced = await loadLiveLinkForFeed(pool, feedId);
    if (!raced) throw err;
    return raced;
  }
}

function linkToResponse(
  link: LinkRow,
  projection: FeedProjection | null,
  maxSources: number,
) {
  // A WITHDRAWN LINK CARRIES ITS OWN SENTENCE AND NOTHING ELSE, and that is a
  // property of the RESPONSE rather than of any one page (§0u.1). The join in
  // LINK_SELECT is live by design, so every field it projects tracks the feed's
  // edits AFTER the author pressed Stop: an author who withdrew a link and then
  // renamed the feed to something private was having the new name served to
  // anyone still holding the dead token. The `/f` page happens not to render
  // these fields on the revoked branch — but "happens not to" is not a privacy
  // guarantee, and the API is what a client actually reads.
  //
  // Derived from the row rather than passed in, so a caller cannot forget it.
  // The two workspace reads and /my/formulas all filter `revoked_at IS NULL`
  // and are unaffected; the public token route is the one that can see a
  // revoked row, which is exactly the one this is for.
  //
  // The AUTHOR stays. It is the link's own author, not the feed's composition,
  // and the withdrawn sentence names them ("X has taken this link down") — the
  // page would lose its subject without it.
  const revoked = link.revoked_at !== null;
  // Computed off the ROW, before the strip: a revoked link whose feed is also
  // gone is still gone, and deriving this from the redacted name would make
  // every revoked link claim its feed had been deleted.
  const gone = link.source_feed_id === null || link.feed_name === null;
  return {
    id: link.id,
    token: link.token,
    url: `/f/${link.token}`,
    createdAt: link.created_at.toISOString(),
    // Live, not stamped: L1's own posture settles it — an author renaming the
    // feed they have shared is the same act as adding a source to it. What a
    // recipient ALREADY holds keeps the name it had at redeem (L6). Live only
    // while the link is: withdrawal ends the projection, it does not keep it
    // current.
    name: revoked ? null : link.feed_name,
    appearance: revoked ? {} : (link.feed_appearance ?? {}),
    // D7 — attribution travels, adoption counts do not. There is no add count
    // here, public or private: an adoption metric on a curatorial object is an
    // engagement surface by another name.
    author: {
      displayName: link.author_display_name ?? link.author_username,
      username: link.author_username,
    },
    revoked: link.revoked_at !== null,
    // Always false on a `kind = 'link'` row — `feed_formulas_seed_kind` forbids
    // otherwise — and READ rather than assumed, because the composer hides
    // Stop on it and the schema is what makes that safe. Under L5 designation
    // always cuts a fresh seed, so a member's link can no longer be seized
    // into the unrevocable slot; this is the belt for that brace.
    isDefaultSeed: link.is_default_seed,
    // L7 — the feed this points at has been deleted or merged away. A state,
    // not a missing row.
    gone,
    sourceCount: projection?.sources.length ?? 0,
    // Named out loud, never silently omitted: an author who shares a feed with
    // three email sources must be able to see that three did not travel, or
    // they believe they shared their whole feed (D5, count now live — L8).
    excludedCount: projection?.excludedCount ?? 0,
    refusal: projection?.refusal ?? null,
    // The cap the refusal is measured against, on the link itself (§0u.6). It
    // was only ever on the STATUS read, so a composer whose status GET blipped
    // had nothing to interpolate and fabricated a zero — rendering "trim it to
    // 0" over a feed with a real cap. A dial the server holds is never a number
    // the client should have to guess.
    maxSources,
    sources: (projection?.sources ?? []).map(frozenSourceToResponse),
  };
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

/** What a replay did: `skipped*` are expected outcomes, never failures. */
export interface PopulateResult {
  added: number;
  failed: RedeemFailure[];
  /** The composition named the owner themselves (§A.2.3). */
  skippedSelf: number;
  /** The composition named a member who has since deleted their account. */
  skippedGone: number;
}

export interface RedeemFailure {
  position: number;
  label: string;
  /** `unresolvable` | `unreachable` | `invalid` | `suspended` | `error`. */
  reason: string;
}

/**
 * Redeem a share link into a new feed for `ownerId`.
 *
 * FREEZES AT REDEEM (L1). The projection is taken ONCE, up front, so a
 * mid-redeem edit by the author cannot produce a half-and-half copy; the
 * per-source loop then runs as it always has.
 *
 * Deliberately NOT one transaction (§6), and deliberately NOT client-threaded:
 * N sources means N addSource calls, each with its own transaction and
 * per-owner advisory lock, and wrapping the loop would hold that lock across
 * every source and serialise the whole account. So a partial redeem is a real
 * outcome — it leaves a real feed holding what resolved and REPORTS what did
 * not, the same summary shape as an import run.
 *
 * EVERY GATE IS HERE RATHER THAN IN THE ROUTE (§12 departure 1): a core that
 * mints feeds from a shared artifact has to enforce its own preconditions, or
 * the next caller is the one that forgets. In order — kind, revoked, the source
 * feed still existing, then the projection's own refusal — and all of them
 * before `createFeedForOwner`, so a refused redeem never leaves an empty feed
 * behind. Throws FORMULA_NOT_FOUND / FORMULA_REVOKED / SOURCE_FEED_GONE /
 * FORMULA_EMPTY / FORMULA_TOO_LARGE; anyone may redeem, so there is no
 * ownership check to make.
 */
export async function redeemFormulaForOwner(
  formulaId: string,
  ownerId: string,
): Promise<{ feedId: string; added: number; failed: RedeemFailure[] }> {
  const {
    rows: [f],
  } = await pool.query<LinkRow>(
    `${LINK_SELECT} WHERE ff.id = $1 AND ff.kind = 'link'`,
    [formulaId],
  );
  if (!f) throw tagged("FORMULA_NOT_FOUND");
  // D10: revoking cannot un-add — it stops FUTURE redemptions and nothing else.
  if (f.revoked_at) throw tagged("FORMULA_REVOKED");
  // L7 — the author deleted (or merged away) the feed this points at.
  // `source_feed_id` carries it: the FK is ON DELETE SET NULL, so the column
  // goes null and the LEFT JOIN misses together. The second arm is therefore
  // unreachable behind the FK (mutating it away breaks no test, and should
  // not) and is kept for the compiler: it is what makes `f.feed_name` a
  // `string` at the createFeedForOwner call below.
  if (!f.source_feed_id || f.feed_name === null) throw tagged("SOURCE_FEED_GONE");

  const projection = await freezeFeedSources(
    pool,
    f.source_feed_id,
    await formulaMaxSources(),
  );
  if (projection.refusal === "empty") throw tagged("FORMULA_EMPTY");
  if (projection.refusal === "too_large") throw tagged("FORMULA_TOO_LARGE");

  // The feed exists before the first source lands, which is what makes a
  // partial redeem survivable. Appearance travels verbatim (§5) — the look is
  // part of the curatorial claim, and the recipient restyles it afterwards like
  // any feed. `originLabel` is STAMPED here (L6): the source feed's name at the
  // moment this recipient added it, so a later rename by the author does not
  // rewrite somebody else's "from …" line.
  const feed = await createFeedForOwner(ownerId, f.feed_name, pool, {
    appearance: f.feed_appearance ?? {},
    fromFormulaId: f.id,
    originLabel: f.feed_name,
  });

  const { added, failed } = await populateFeedFromSources(
    feed.id,
    ownerId,
    projection.sources,
  );
  return { feedId: feed.id, added, failed };
}

/**
 * The source-population half of a redeem: resolve each source by portable
 * identity and land it on an ALREADY-EXISTING feed via the addSource core.
 *
 * Split from redeemFormulaForOwner so the starter-seed path can mint the feed
 * inside its own short claim transaction and run this on the pool afterwards
 * (§0s.4) — never call it while holding a pooled client, since every addSource
 * inside opens a further transaction of its own.
 */
export async function populateFeedFromSources(
  feedId: string,
  ownerId: string,
  sources: FrozenSource[],
): Promise<PopulateResult> {
  const failed: RedeemFailure[] = [];
  let added = 0;
  let skippedSelf = 0;
  let skippedGone = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const label = s.displayName ?? s.tagValue;
    // A SUSPENDED PROTOCOL IS SKIPPED AND COUNTED, NEVER LEFT TO FAIL AS
    // "error" (§0u.2). `freezeSource` drops a publication while publications
    // are dark, but that runs at CUT time — and a seed frozen before the
    // 2026-08-31 suspension still holds its publication rows, which this replay
    // was handing to `addSource` ungated. It threw TARGET_NOT_FOUND, filed
    // under the catch-all `error` arm below, and the only witness was
    // seedStarterFeeds' logger.error — at every signup, on the one path whose
    // refusals have nowhere to report (ADR §6). So the exclusion is stated
    // where the replay is, in the same words the cut uses, with a reason of its
    // own so the Default-seed panel can say it out loud.
    //
    // Read at replay rather than at freeze because that is what makes the flag
    // reversible: reinstating publications restores these rows with no data
    // change and no re-cut.
    if (s.sourceType === "publication" && !publicationsEnabled()) {
      failed.push({ position: i, label, reason: "suspended" });
      continue;
    }
    try {
      const input = await resolveFormulaSource(s);
      if (!input) {
        failed.push({ position: i, label, reason: "unresolvable" });
        continue;
      }
      // TWO ACCOUNT SOURCES ARE SKIPPED AND COUNTED, NEVER FAILED
      // (RESHAPE-PLAN-2026-10 §A.2.3). Both are expected, and the failure
      // list must stay a witness to real failures — seedStarterFeeds logs it
      // at error level for every new member it is non-empty for.
      //
      //  · SELF. Admission appends each new member to the seed, so every
      //    cohort member's own seed names them. `addSource` refuses a
      //    self-source (SELF_SOURCE), which is right, and this is where the
      //    refusal is anticipated rather than reported. It sits in this
      //    shared loop, so a share link whose composition names its redeemer
      //    gets the same answer (it used to come back as `error`).
      //  · GONE. A cohort member who later deletes their account would
      //    otherwise be a dead source in every later newcomer's feed. Only
      //    `deleted` is terminal; a suspension is temporary and is left to
      //    addSource like any other source.
      if (input.sourceType === "account") {
        if (input.accountId === ownerId) {
          skippedSelf++;
          continue;
        }
        if (input.accountStatus === "deleted") {
          skippedGone++;
          continue;
        }
      }
      const result = await addSource(feedId, ownerId, input, {
        // skipProbe deliberately NOT set (§6): a source can have rotted since
        // the author added it, so a genuinely new identity is probed.
        // Everything this instance already holds healthy short-circuits the
        // probe anyway, which is the common case.
        //
        // §6.4b stampede brake — trickle the subscribe-time ingest jobs rather
        // than dumping N immediate fetches on the worker.
        enqueueRunAt: new Date(
          Date.now() +
            (i + 1) * ENQUEUE_SPACING_MS +
            Math.floor(Math.random() * ENQUEUE_SPACING_MS),
        ),
      });
      // Tuning travels with the composition (§5). addSource's insert takes only
      // the target, so the throughput/sampling/replies triple is applied straight
      // after — scoped to the row it just minted in the feed this call just
      // created, so there is nothing else it could touch.
      await pool.query(
        `UPDATE feed_sources SET throughput = $2, sampling_mode = $3, exclude_replies = $4
          WHERE id = $1`,
        [result.source.id, s.throughput, s.samplingMode, s.excludeReplies],
      );
      added++;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "DUPLICATE") {
        // The composition named the same target twice. Idempotent, not a
        // failure — the source is on the feed either way.
        continue;
      }
      failed.push({
        position: i,
        label,
        reason:
          code === "SOURCE_UNREACHABLE"
            ? "unreachable"
            : code === "SOURCE_URI_INVALID"
              ? "invalid"
              : "error",
      });
      logger.warn(
        { err, ownerId, feedId, position: i },
        "Shared source failed to resolve",
      );
    }
  }
  return { added, failed, skippedSelf, skippedGone };
}

/**
 * Populate a feed from a SEED's frozen rows.
 *
 * The wrapper `seedStarterFeeds` calls, unchanged at the signature so L3 holds
 * where it can be checked: the seed path takes a `formulaId` and reads the
 * frozen composition, exactly as it did before links went live. A link's redeem
 * calls the core above with a live projection instead.
 */
export async function populateFeedFromFormula(
  feedId: string,
  ownerId: string,
  formulaId: string,
): Promise<PopulateResult> {
  const { rows } = await pool.query<{
    tag_kind: FrozenSource["tagKind"];
    tag_value: string;
    tag_hint: string | null;
    source_type: FrozenSource["sourceType"];
    protocol: string | null;
    display_name: string | null;
    avatar_url: string | null;
    throughput: string;
    sampling_mode: string;
    exclude_replies: boolean;
  }>(
    `SELECT tag_kind, tag_value, tag_hint, source_type, protocol::text AS protocol,
            display_name, avatar_url, throughput, sampling_mode, exclude_replies
       FROM feed_formula_sources WHERE formula_id = $1 ORDER BY position ASC`,
    [formulaId],
  );
  return populateFeedFromSources(
    feedId,
    ownerId,
    rows.map((r) => ({
      tagKind: r.tag_kind,
      tagValue: r.tag_value,
      tagHint: r.tag_hint,
      sourceType: r.source_type,
      // A frozen row can only carry a protocol the allow-list passed at
      // freeze time; re-checking it here is what keeps the type honest and
      // covers a protocol REMOVED from the list after a seed was cut.
      protocol: isPortableProtocol(r.protocol) ? r.protocol : null,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      throughput: r.throughput,
      samplingMode: r.sampling_mode,
      excludeReplies: r.exclude_replies,
    })),
  );
}

/**
 * Turn one portable source back into an addSource call.
 *
 * Resolution by identity is the point (D4): a pubkey is looked UP, never
 * assumed to be the id it was at projection time, and an external source is
 * handed to addSource's (protocol, sourceUri) branch which creates-or-finds.
 * Returns null when the identity resolves to nothing here — a member who
 * deleted their account, a publication that no longer exists — which is a
 * reported failure, not a thrown one.
 */
async function resolveFormulaSource(
  s: FrozenSource,
): Promise<(AddSourceInput & { accountStatus?: string }) | null> {
  if (s.sourceType === "account") {
    // The status rides along so the replay can skip a deleted member rather
    // than hand addSource a target it will refuse.
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM accounts WHERE nostr_pubkey = $1`,
      [s.tagValue],
    );
    return rows[0]
      ? { sourceType: "account", accountId: rows[0].id, accountStatus: rows[0].status }
      : null;
  }
  if (s.sourceType === "publication") {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM publications WHERE nostr_pubkey = $1`,
      [s.tagValue],
    );
    return rows[0]
      ? { sourceType: "publication", publicationId: rows[0].id }
      : null;
  }
  if (s.sourceType === "tag") {
    return { sourceType: "tag", tagName: s.tagValue };
  }
  if (!isPortableProtocol(s.protocol)) return null;
  return {
    sourceType: "external_source",
    protocol: s.protocol,
    sourceUri: s.tagValue,
    // Display metadata rides along so a source this instance has never held
    // does not land with a bare-URI label.
    displayName: s.displayName ?? undefined,
    avatarUrl: s.avatarUrl ?? undefined,
    relayUrls:
      s.protocol === "nostr_external" && s.tagHint ? [s.tagHint] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes — workspace-scoped half
// ---------------------------------------------------------------------------

export function registerFeedFormulaRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /workspace/feeds/:id/formula — this feed's share link, and what a
  // recipient would get right now
  //
  // Owner-scoped, like every other feed read: the projection names every source
  // in the feed, so it is exactly as private as the feed itself.
  //
  // `link: null` is the ordinary un-shared state, not an error. The projection
  // ships either way, because the composer's one line of prose beneath the
  // control is drawn from it — the excluded count, or the refusal in words.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/feeds/:id/formula",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const cap = await formulaMaxSources();
      const projection = await freezeFeedSources(pool, id, cap);
      const link = await loadLiveLinkForFeed(pool, id);
      return reply.send({
        link: link ? linkToResponse(link, projection, cap) : null,
        sourceCount: projection.sources.length,
        excludedCount: projection.excludedCount,
        refusal: projection.refusal,
        maxSources: cap,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /workspace/feeds/:id/formula — create this feed's share link
  //
  // NO BODY, idempotent, 200 with the existing link rather than 409, and it
  // never refuses (L2). Everything the old publish flow asked for — a name, a
  // description, a preview to approve — was the freeze's paperwork, and the
  // freeze is gone.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/feeds/:id/formula",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that channel." });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "We couldn't find that channel." });

      const link = await mintLinkForFeed(id, ownerId);
      const cap = await formulaMaxSources();
      const projection = await freezeFeedSources(pool, id, cap);
      logger.info(
        {
          ownerId,
          feedId: id,
          formulaId: link.id,
          sourceCount: projection.sources.length,
          excluded: projection.excludedCount,
        },
        "Feed share link served",
      );
      return reply.send({ link: linkToResponse(link, projection, cap) });
    },
  );
}

// ---------------------------------------------------------------------------
// Routes — public / account-scoped half (mounted at /api/v1)
// ---------------------------------------------------------------------------

export async function formulaPublicRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /my/formulas — the author's own live links
  //
  // KEPT, and narrowed to live links. It is the dark-ship probe: the web has no
  // NEXT_PUBLIC twin and asks instead, and `formulasAvailable()` probes exactly
  // this route (200 ⇒ live, 404 ⇒ dark). Repointing it would mean repointing
  // the probe and rewriting its DEPLOYMENT.md row for nothing.
  // -------------------------------------------------------------------------
  app.get("/my/formulas", { preHandler: requireAuth }, async (req, reply) => {
    if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
    const { rows } = await pool.query<LinkRow>(
      `${LINK_SELECT}
        WHERE ff.author_id = $1 AND ff.kind = 'link' AND ff.revoked_at IS NULL
        ORDER BY ff.created_at DESC`,
      [req.session!.sub],
    );
    const cap = await formulaMaxSources();
    return reply.send({
      formulas: await Promise.all(
        rows.map(async (r) => ({
          feedId: r.source_feed_id,
          ...linkToResponse(
            r,
            r.source_feed_id
              ? await freezeFeedSources(pool, r.source_feed_id, cap)
              : null,
            cap,
          ),
        })),
      ),
    });
  });

  // -------------------------------------------------------------------------
  // GET /formulas/:token — the public page's data
  //
  // optionalAuth: a logged-out visitor sees the same composition and the
  // waitlist CTA; only redeeming needs an account.
  //
  // `kind = 'link'` is in the SQL (L10), so a seed's token and an unknown token
  // are the same 404 by construction rather than by a branch somebody could
  // forget. The composition is projected LIVE — the page shows the feed as it
  // is now (L1).
  // -------------------------------------------------------------------------
  app.get<{ Params: { token: string } }>(
    "/formulas/:token",
    { preHandler: optionalAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
      const {
        rows: [f],
      } = await pool.query<LinkRow>(
        `${LINK_SELECT} WHERE ff.token = $1 AND ff.kind = 'link'`,
        [req.params.token],
      );
      if (!f) return reply.status(404).send({ error: "We couldn't find that link." });
      // A withdrawn link, and a link whose feed is gone, both render as their
      // own sentence and nothing else: projecting the composition of a feed the
      // author has withdrawn would publish exactly what they took down.
      const projectable = f.revoked_at === null && f.source_feed_id !== null;
      const cap = await formulaMaxSources();
      return reply.send({
        formula: linkToResponse(
          f,
          projectable
            ? await freezeFeedSources(pool, f.source_feed_id!, cap)
            : null,
          cap,
        ),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /formulas/:token/redeem — mint a new feed from this composition
  //
  // MUST STAY BEHIND POST. Link-preview crawlers in chat clients issue GET on
  // whatever is pasted; the public page is the confirm step that keeps a paste
  // from minting feeds.
  //
  // Deliberately NOT one transaction (§6) — see redeemFormulaForOwner.
  // -------------------------------------------------------------------------
  app.post<{ Params: { token: string } }>(
    "/formulas/:token/redeem",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
      const ownerId = req.session!.sub;
      const {
        rows: [f],
      } = await pool.query<{ id: string }>(
        `SELECT ff.id FROM feed_formulas ff
          WHERE ff.token = $1 AND ff.kind = 'link'`,
        [req.params.token],
      );
      if (!f) return reply.status(404).send({ error: "We couldn't find that link." });

      let result;
      try {
        result = await redeemFormulaForOwner(f.id, ownerId);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        // ONE STATUS CLASS, THREE REASONS. Strictly nothing is "gone" for
        // empty/too_large — but the public page branches on one class meaning
        // "this link will not produce a feed right now", `source_feed_gone`
        // genuinely is 410, and the `error` code carries the distinction. One
        // class the page has to learn rather than three.
        if (code === "FORMULA_REVOKED")
          return reply.status(410).send({
            error: "formula_revoked",
            message: "This link is no longer available.",
          });
        if (code === "SOURCE_FEED_GONE")
          return reply.status(410).send({
            error: "source_feed_gone",
            message: "The channel this link points at no longer exists.",
          });
        if (code === "FORMULA_EMPTY")
          return reply.status(410).send({
            error: "formula_empty",
            message: "This channel has nothing in it that can be shared yet.",
          });
        if (code === "FORMULA_TOO_LARGE")
          return reply.status(410).send({
            error: "formula_too_large",
            message: "This channel has too many sources to share as a link.",
          });
        if (code === "FORMULA_NOT_FOUND")
          return reply.status(404).send({ error: "We couldn't find that link." });
        throw err;
      }
      logger.info(
        {
          ownerId,
          formulaId: f.id,
          feedId: result.feedId,
          added: result.added,
          failed: result.failed.length,
        },
        "Feed share link redeemed",
      );
      // `failed` is reported, never swallowed: a redeem that quietly dropped
      // four sources would read to the recipient as the author's composition.
      return reply.status(201).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /formulas/:id — Stop sharing
  //
  // D10: revoking cannot un-add. It stops future redemptions and NOTHING else;
  // no feed anywhere is touched. Stated in the ADR explicitly because "revoke"
  // reads as though it ought to reach into people's workspaces — and that is
  // also why it does not confirm on the surface.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/formulas/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!formulasEnabled()) return reply.status(404).send({ error: "We couldn't find that." });
      const { id } = req.params;
      if (!isUuid(id))
        return reply.status(404).send({ error: "We couldn't find that link." });

      // The designated default seed cannot be revoked (D11). The schema CHECK
      // backs this refusal — this 409 exists to say WHY rather than let a
      // constraint violation surface as a 500. Under L5 a seed can no longer BE
      // somebody's link (designation always cuts a fresh row), so this is now
      // unreachable from the composer; the guard stays because the schema is
      // what makes it true.
      const { rows } = await pool.query<{ is_default_seed: boolean }>(
        `UPDATE feed_formulas SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1 AND author_id = $2 AND NOT is_default_seed
          RETURNING is_default_seed`,
        [id, req.session!.sub],
      );
      if (rows.length === 0) {
        const {
          rows: [survivor],
        } = await pool.query<{ is_default_seed: boolean }>(
          `SELECT is_default_seed FROM feed_formulas WHERE id = $1 AND author_id = $2`,
          [id, req.session!.sub],
        );
        if (survivor?.is_default_seed)
          return reply.status(409).send({
            error: "default_seed_formula",
            message:
              "This composition seeds every new account. Designate a replacement before revoking it.",
          });
        return reply.status(404).send({ error: "We couldn't find that link." });
      }
      return reply.status(204).send();
    },
  );
}
