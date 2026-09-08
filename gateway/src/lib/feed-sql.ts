import { UUID_RE } from "./uuid.js";
import { parseCursorEpoch } from "./cursor.js";
// =============================================================================
// Shared feed SQL — the candidate-gathering SELECT/JOINs over feed_items plus
// the keyset cursor parser, reused by every read path that projects feed_items:
//   post-feed.ts   (GET /feed/:feedId   — Post-model timeline)
//   post-thread.ts (GET /thread/:postId — Post-model thread)
//   sources.ts     (GET /sources/:id    — source surface, Post[])
//   author.ts      (GET /author/:id/... — author surface, Post[])
//   tags.ts        (GET /tags/:name/... — tag surface, Post[])
//
// Extracted from the retired legacy `GET /feed` handler (timeline.ts, deleted
// in FEED-RETIREMENT-PLAN Slice 6). The legacy row→response mapper
// (feedItemToResponse) and biddability helper died with that handler; these
// callers map rows to the Post shape via lib/post-mapper.ts instead.
// =============================================================================

export interface CursorParts {
  score?: number; // explore-feed ranking score — undefined on legacy cursors
  ts: number;
  id: string;
}

export function parseCursor(raw: string | undefined): CursorParts | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  // 3-part: "score:unix_seconds:uuid" — explore-feed compound cursor
  if (parts.length === 3) {
    const score = Number(parts[0]);
    const ts = parseCursorEpoch(parts[1]);
    const id = parts[2];
    if (!isNaN(score) && !isNaN(ts) && UUID_RE.test(id))
      return { score, ts, id };
  }
  // 2-part: "unix_seconds:uuid" — following-feed cursor (legacy for explore too)
  if (parts.length === 2) {
    const ts = parseCursorEpoch(parts[0]);
    const id = parts[1];
    if (!isNaN(ts) && UUID_RE.test(id)) return { ts, id };
  }
  // Legacy: plain unix seconds (no id component — use max uuid for stable ordering)
  const ts = parseCursorEpoch(raw);
  if (!isNaN(ts)) return { ts, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
  return undefined;
}

// Shared SELECT columns — feed_items + LEFT JOINs for type-specific fields
export const FEED_SELECT = `
  fi.id AS fi_id, fi.item_type, fi.title, fi.article_id, fi.note_id, fi.external_item_id,
  fi.author_id, fi.nostr_event_id, fi.source_protocol, fi.source_item_uri,
  fi.source_id, COALESCE(ei.media, fi.media) AS media, fi.score,
  EXTRACT(EPOCH FROM fi.published_at)::bigint AS published_at_epoch,
  -- Resonance band (SOCIAL-PROOF-RESONANCE-ADR D7). NULL is meaningful and
  -- load-bearing: rss/email and dark-nostr rows get no band at all, and a
  -- silent protocol must not read as an unpopular writer. Never COALESCE it.
  -- (D4/D6 also store fi.resonance; the step-5 ranking blend reads it in its
  -- own scored CTE.) The band is the AUTHOR-relative axis; ambient_pctl is the
  -- PLATFORM-relative one, and the glyph's gloss needs both — the band alone
  -- can only say "more than this author usually draws" and the tooltip claimed
  -- a second thing it had no field for. NULL on both is meaningful and
  -- load-bearing: rss/email and dark-nostr rows get neither, and a silent
  -- protocol must not read as an unpopular writer. Never COALESCE either.
  fi.resonance_band,
  fi.ambient_pctl,
  -- Author pubkey (native content only — single join covers both articles and notes)
  acc.nostr_pubkey AS nostr_pubkey,
  -- Article-specific (NULL for non-articles)
  a.nostr_d_tag, a.access_mode, a.price_pence, a.gate_position_pct,
  a.content_free, a.summary AS a_summary, a.size_tier,
  -- The publication the article was published IN (BYLINE-AND-PROVENANCE-ADR
  -- D8): a native card's provenance line reads VIA ALL.HAUS · <Publication>,
  -- because the publication is the thing the reader subscribed to — the same
  -- slot an external card gives its source. NULL for an article outside a
  -- publication (the byline already IS the source) and for every non-article
  -- row; the join hangs off a, so it costs nothing on notes/external rows.
  -- pub_status rides along because /pub/:slug answers 404 unless the
  -- publication is 'active': the card must still SAY where the article was
  -- published after the publication closes, but must not link to a 404.
  pub.name AS pub_name, pub.slug AS pub_slug, pub.status AS pub_status,
  COALESCE(
    (SELECT array_agg(t.name ORDER BY t.name)
     FROM article_tags at2 JOIN tags t ON t.id = at2.tag_id
     WHERE at2.article_id = a.id),
    '{}'
  ) AS tag_names,
  -- Note-specific (NULL for non-notes)
  n.content AS note_content, n.is_quote_comment,
  n.quoted_event_id, n.quoted_event_kind,
  n.quoted_excerpt, n.quoted_title, n.quoted_author,
  n.quoted_post_id, n.quoted_url, n.quoted_source,
  n.external_parent_id,
  -- External-specific (NULL for non-external)
  ei.author_name AS ei_author_name, ei.author_handle AS ei_author_handle,
  ei.author_uri AS ei_author_uri,
  ei.content_text AS ei_content_text, ei.content_html AS ei_content_html,
  ei.title AS ei_title, ei.summary AS ei_summary,
  ei.source_reply_uri AS ei_source_reply_uri,
  ei.source_quote_uri AS ei_source_quote_uri,
  ei.content_warning AS ei_content_warning,
  ei.interaction_data AS ei_interaction_data,
  ei.like_count AS ei_like_count, ei.reply_count AS ei_reply_count,
  ei.repost_count AS ei_repost_count,
  xs.display_name AS source_display_name, xs.avatar_url AS source_avatar_url,
  -- Is this row's source_id INHERITED rather than owned? A context-only row was
  -- minted by thread/profile hydration and anchored on the HYDRATING FOCAL's
  -- source (EXTERNAL-AUTHOR-HISTORY-ADR §4.2), so xs.display_name names the
  -- account whose card was expanded, never this post's author. The mapper must
  -- not read it as provenance. Real ingest PROMOTES such a row (flag cleared,
  -- source_id re-homed to the author's own source), which is what makes the
  -- flag the right discriminator: it is protocol-agnostic and self-healing,
  -- where an author_uri = source_uri comparison is neither (nostr_external
  -- writes no author_uri at ingest and an njump.me URL at hydration, so it
  -- would suppress the name on every nostr row including the ones it is
  -- correct on).
  ei.is_context_only AS ei_is_context_only,
  -- Trust Layer 1 pip (NULL for external items — they default to 'unknown')
  tl.pip_status,
  -- Parent author for reply provenance — denormalised onto the row at ingest by the
  -- feed_items_post_identity trigger + maintained by feed_items_author_refresh
  -- (migration 105, audit C4 / #11). Replaces the per-candidate correlated subqueries
  -- (native parent note author's display_name; external parent item's author_handle).
  fi.reply_to_author,
  fi.is_reply
`;

export const FEED_JOINS = `
  LEFT JOIN articles a ON a.id = fi.article_id
  LEFT JOIN publications pub ON pub.id = a.publication_id
  LEFT JOIN notes n ON n.id = fi.note_id
  LEFT JOIN accounts acc ON acc.id = fi.author_id
  LEFT JOIN external_items ei ON ei.id = fi.external_item_id
  LEFT JOIN external_sources xs ON xs.id = fi.source_id
  LEFT JOIN trust_layer1 tl ON tl.user_id = fi.author_id
`;
