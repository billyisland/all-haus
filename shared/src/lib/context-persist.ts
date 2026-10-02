// =============================================================================
// CONTEXT-ROW PERSISTENCE — one home for every writer that files somebody
// else's post as CONTEXT (is_context_only), in two services.
//
// Moved here from the gateway (CROSS-NETWORK-ROUNDTRIP-ADR rung C): thread
// hydration, author-timeline hydration and the thread focus/parent fetchers
// are the gateway's, and the linked-account notification poller is
// feed-ingest's, and all of them must write a context row the SAME way —
// promotion on real ingest, first-writer-owns, the merge that keeps what a
// thinner fetch never saw, the platform-block drop. A second copy of this
// statement in feed-ingest would be exactly the drift the merge constant below
// exists to stop. The gateway modules re-export what they used to define, so
// no importer there changed.
// =============================================================================

import { pool, withTransaction } from "../db/client.js";
import { httpUrlOrNull } from "./sanitize.js";
import { truncatePreview } from "./text.js";
import logger from "./logger.js";

// The ON CONFLICT assignment for external_items.interaction_data on any CONTEXT
// write — hydration, the two thread focus fetchers, the two parent fetchers
// (MIRROR-AUDIT §3 *Data integrity and ingest*, S17).
//
// MERGE, never replace. A context write collides with whatever is already
// there, and that row may be a REAL ingested item whose interaction_data
// carries keys the context fetch never sees: atproto rootUri / rootCid /
// parentUri / parentCid (outbound-cross-post reads these for its strong ref)
// and activitypub poll / audience / activityId / replyTo. All five sites
// assigned EXCLUDED, so every thread expand deleted them from every real row it
// touched — silently, and the loss only shows up later as a cross-post that
// cannot build its reference or a poll that renders as an ordinary post.
//
// The || operator is a shallow merge with the right-hand side winning: what
// this fetch observed is refreshed, what it never fetched survives. COALESCE on
// both operands because the column is nullable (jsonb || NULL is NULL, which
// would erase the lot).
//
// One home for the same reason CONTEXT_FEED_ITEM_INSERT_SQL is one: five
// copies of one rule drift, and this one drifts silently. Interpolated into
// each site's template literal, and exercised for real by
// gateway/tests/context-interaction-merge.test.ts through
// persistHydratedThreadNodes — only Postgres evaluates jsonb ||.
export const CONTEXT_INTERACTION_MERGE_SQL = `interaction_data = COALESCE(external_items.interaction_data, '{}'::jsonb)
                             || COALESCE(EXCLUDED.interaction_data, '{}'::jsonb)`;

export interface HydratedNode {
  sourceItemUri: string;
  sourceReplyUri: string | null;
  sourceQuoteUri: string | null;
  authorName: string;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  media: unknown[];
  interactionData: Record<string, unknown>;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  publishedAt: Date;
}

// Dual-write a batch of hydrated nodes (external_items + feed_items) in one
// transaction. Context-only; deduped by (protocol, source_item_uri) so a node
// already ingested for real is left as a counts refresh, never duplicated.
//
// opts.profileHydrated (EXTERNAL-AUTHOR-HISTORY-ADR §3.3/§3.4): profile-view
// timeline hydration writes is_profile_hydrated = TRUE so the rows show in
// GET /author/:id/posts while inheriting everything is_context_only already
// buys (feed exclusion, context GC, thread-projector expansion). On conflict
// the flag OR-folds: thread hydration (EXCLUDED = FALSE) never changes
// anything; profile hydration GRADUATES a pre-existing thread-context row of
// this author into the profile view; setting it on an already-real row is
// harmless (real rows pass the /posts filter via is_context_only regardless,
// and GC only looks at is_context_only). is_context_only itself is never
// touched on conflict — hydration can never demote a real row (§4.2 is the
// promotion mirror, in the ingest writers).
//
// opts.client: run on the caller's open transaction instead of opening one
// (used by tests to roll fixtures back).
export async function persistHydratedThreadNodes(
  sourceId: string,
  protocol: "atproto" | "activitypub" | "nostr_external",
  nodes: HydratedNode[],
  opts: { profileHydrated?: boolean; client?: { query: any } } = {},
): Promise<void> {
  if (nodes.length === 0) return;
  // atproto + activitypub both map to content_tier 'tier3' (migration 099 §7);
  // nostr_external is 'tier2', matching the native nostr ingest path
  // (feed-ingest-nostr.ts) so a hydrated node and a later real ingest agree.
  const tier = protocol === "nostr_external" ? "tier2" : "tier3";
  const profileHydrated = opts.profileHydrated === true;
  const run = async (client: { query: any }) => {
    // A PLATFORM-BLOCKED NPUB IS NOT WRITTEN (§0z item 15). Hydration is how
    // an identity reaches us without a source of its own — a reply pulled
    // into somebody else's thread — and migration 224 promised the block
    // holds "however they reach us". One SELECT over the batch's authors,
    // before any row is written; the identity trigger would otherwise mint
    // the author row as a side effect of the insert.
    //
    // THE KEY IS THE PUBKEY, AND IT IS NOT IN `author_uri` (§0ab item 2).
    // This asked `platform_blocks` for `n.authorUri`, which for a nostr node
    // is an njump PERMALINK (`nostr-thread.ts` builds `https://njump.me/<npub>`)
    // — while `platform_blocks.target_key` holds 64 lowercase hex, always
    // (`platform-blocks.ts`). Two spellings of one identity: the SELECT asked
    // about a URL, matched nothing, every blocked author's node was written,
    // and the identity trigger minted their author row exactly as the comment
    // above says it must not. The trigger itself has always known where the
    // key lives (`schema.sql`: `v_handle := v_interaction->>'pubkey'` with
    // `-- author_uri is null for nostr`), so this now reads the same field the
    // row's own identity will be minted from. On the dev DB `author_uri` is
    // NULL for 29,745 of 29,745 nostr rows, which is why this failed silently
    // and totally rather than partially.
    let persisted = nodes;
    if (protocol === "nostr_external") {
      const keyOf = (n: HydratedNode): string | null => {
        const k = n.interactionData?.pubkey;
        return typeof k === "string" && k !== "" ? k : null;
      };
      const keys = [...new Set(nodes.map(keyOf).filter((k): k is string => k !== null))];
      if (keys.length > 0) {
        const { rows } = await client.query(
          `SELECT target_key FROM platform_blocks WHERE kind = 'npub' AND target_key = ANY($1::text[])`,
          [keys],
        );
        const blocked = new Set((rows as Array<{ target_key: string }>).map((r) => r.target_key));
        if (blocked.size > 0) {
          persisted = nodes.filter((n) => {
            const k = keyOf(n);
            return k === null || !blocked.has(k);
          });
          logger.info(
            { sourceId, dropped: nodes.length - persisted.length },
            "Thread hydration dropped nodes by platform-blocked npubs",
          );
        }
      }
    }
    for (const n of persisted) {
      const ins = await client.query(
        `INSERT INTO external_items (
           source_id, protocol, tier, source_item_uri, canonical_url,
           author_name, author_handle, author_avatar_url, author_uri,
           content_text, content_html, media,
           source_reply_uri, interaction_data,
           like_count, reply_count, repost_count,
           published_at, source_quote_uri, is_context_only,
           is_profile_hydrated
         ) VALUES ($1, $2, $3, $4, $20, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, TRUE, $19)
         ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
           is_profile_hydrated = external_items.is_profile_hydrated OR EXCLUDED.is_profile_hydrated,
           like_count = EXCLUDED.like_count,
           reply_count = EXCLUDED.reply_count,
           repost_count = EXCLUDED.repost_count,
           ${CONTEXT_INTERACTION_MERGE_SQL},
           -- Fill the parent linkage when we didn't already have it. The ancestor
           -- walk (assembleExternalThread → loadExternalByUri) climbs via
           -- source_reply_uri; a row first seen as a standalone feed item has a
           -- NULL link, so hydration is the only place it can be learned. COALESCE
           -- so a context-only hydrate only *fills* a gap, never clobbers an
           -- authoritative ingested linkage.
           source_reply_uri = COALESCE(external_items.source_reply_uri, EXCLUDED.source_reply_uri),
           -- Same gap-fill for the quote linkage: a row first seen as a standalone
           -- feed item (or via reply-only hydration) has a NULL quote uri, so a
           -- later thread hydration is where the quoted post is learned. COALESCE
           -- only fills, never clobbers an authoritative ingested value.
           source_quote_uri = COALESCE(external_items.source_quote_uri, EXCLUDED.source_quote_uri),
           -- Same gap-fill for the permalink. An item's identity is not its
           -- permalink: source_item_uri is the federated id, canonical_url is
           -- the page a reader opens, and an activitypub object declares them
           -- as different strings. COALESCE only fills -- a hydrate is THINNER
           -- than real ingest and must never take a permalink away.
           canonical_url = COALESCE(external_items.canonical_url, EXCLUDED.canonical_url),
           -- Backfill body/media only when the existing copy is empty, so the
           -- thin row a standalone ingest left behind gains the richer hydrated
           -- content (parents were rendering blank), without overwriting a row
           -- that was already ingested in full.
           content_text = COALESCE(external_items.content_text, EXCLUDED.content_text),
           content_html = COALESCE(external_items.content_html, EXCLUDED.content_html),
           media = CASE
             WHEN external_items.media IS NULL
               OR jsonb_array_length(COALESCE(external_items.media, '[]'::jsonb)) = 0
             THEN EXCLUDED.media
             ELSE external_items.media
           END
         RETURNING id`,
        [
          sourceId,
          protocol,
          tier,
          n.sourceItemUri,
          n.authorName,
          n.authorHandle,
          n.authorAvatarUrl,
          n.authorUri,
          n.contentText,
          n.contentHtml,
          JSON.stringify(n.media),
          n.sourceReplyUri,
          JSON.stringify(n.interactionData),
          n.likeCount,
          n.replyCount,
          n.repostCount,
          n.publishedAt,
          n.sourceQuoteUri,
          profileHydrated,
          // The permalink, read from where the producers already put it. Only
          // the activitypub producers set `webUrl` (the atproto ones carry
          // {uri, cid}), so this is NULL for atproto -- which is right: a PDS
          // serves no HTML, so we genuinely do not know a canonical page and
          // the reader's derivation stays the fallback.
          httpUrlOrNull(n.interactionData.webUrl as string | undefined),
        ],
      );
      const extId = ins.rows[0]?.id;
      if (!extId) continue;
      // feed_items dual-write; the BEFORE INSERT identity trigger mints
      // post_id/version/biddability_tier/external_author_id from these columns.
      await client.query(
        `INSERT INTO feed_items (
           item_type, external_item_id,
           author_name, author_avatar,
           title, content_preview,
           published_at,
           source_protocol, source_item_uri, source_id, media,
           is_reply
         ) VALUES (
           'external', $1,
           $2, $3,
           NULL, $4,
           $5,
           $6, $7, $8, $9,
           $10
         )
         ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING`,
        [
          extId,
          n.authorName,
          n.authorAvatarUrl,
          truncatePreview(n.contentText ?? ""),
          n.publishedAt,
          protocol,
          n.sourceItemUri,
          sourceId,
          JSON.stringify(n.media),
          n.sourceReplyUri != null,
        ],
      );
    }
  };
  if (opts.client) {
    await run(opts.client);
  } else {
    await withTransaction(run);
  }
}

// §3.2 — where an unfollowed author's rows live. external_items.source_id is
// NOT NULL and an unfollowed author often has no source row, so hydration
// upserts a SHADOW source: is_active = FALSE (the poll scheduler never fetches
// it), keyed on the same (protocol, source_uri) identity the subscribe path
// uses — so a later real subscribe lands on this exact row and reactivates it
// (addSource clears is_active/orphaned_at on both its paths). No
// external_subscriptions row is written: this is a storage anchor, not a
// follow — the feed-derived-subscriptions invariant is untouched. The GC then
// treats it as an orphan (deactivate no-op, 90-day cull) — profile-hydrated
// history is a self-refreshing cache, not an archive.
//
// ON CONFLICT DO NOTHING RETURNING returns no row on conflict, hence the
// two-step. Never touches is_active on an existing row — a real subscribed
// source must not be flipped, and a previously shadowed row stays shadowed.
export async function ensureShadowSource(
  protocol: string,
  sourceUri: string,
  db: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<{ id: string; relay_urls: string[] | null } | null> {
  const ins = await db.query(
    `INSERT INTO external_sources (protocol, source_uri, is_active)
     VALUES ($1::external_protocol, $2, FALSE)
     ON CONFLICT (protocol, source_uri) DO NOTHING
     RETURNING id, relay_urls`,
    [protocol, sourceUri],
  );
  if (ins.rows[0]) return ins.rows[0];
  const sel = await db.query(
    `SELECT id, relay_urls FROM external_sources
      WHERE protocol = $1::external_protocol AND source_uri = $2`,
    [protocol, sourceUri],
  );
  return sel.rows[0] ?? null;
}
