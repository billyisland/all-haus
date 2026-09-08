import { pool } from "@platform-pub/shared/db/client.js";
import { checkArticleAccessSet } from "../services/article-access/access-check.js";

// =============================================================================
// Which of a page's conversation ROOTS are locked to this viewer.
// ARTICLE-HEADED-CONVERSATIONS-ADR D5, item 8.
//
// Keyed on the roots' nostr EVENT IDS, which is the one key that JOINS, and the
// caller's `root_post_id` is a separate key that GROUPS. The two are still two
// things, but they no longer disagree about which piece they name: `root_post_id`
// was a bare `feed_items_derive_post_id('nostr', c.target_event_id)` until
// `a0c4fd13`, which is right for a NOTE root and wrong for an ARTICLE one — an
// article's real `feed_items.post_id` is minted from its naddr COORD, so the
// derived value was a different string for the same piece and matched no row
// anywhere. It now resolves through the one home (`post-mapper`'s
// `nostrTargetPostId` -> the `article_post_id(uuid)` SQL function), which READS
// the stored id. What has not changed, and is the reason this file takes event
// ids: only the event id reaches `articles`, so only the event id can be the
// join.
//
// Built on the wrong key this fails SILENTLY AND REASSURINGLY: an empty join
// means no root is found paywalled, so every comment ships `rootLocked` absent
// and a locked conversation is disclosed as an open one, with no error anywhere.
// That is what root-locked-key.test.ts exists to catch, and it has to be
// DB-backed — only Postgres knows the two keys are different strings.
// root-locked-parity.test.ts is the other half, and a different claim: that
// `checkArticleAccessSet` below and `checkArticleAccess` agree grant for grant,
// which is what makes the answer this file computes the same answer the WRITE
// path would give.
//
// Only a PAYWALLED ARTICLE root can be locked, so the first query is also the
// filter: a note-rooted comment's target returns no row and its comments ship
// `rootLocked` absent, which is the truth about them. This is the reason the
// resolution is its own set query rather than a join onto the comments read —
// `comments` targets notes as well as articles and the Replies log is keyed on
// the author with no target filter, so an INNER join there would silently delete
// every note-rooted comment from a member's log.
//
// An ANONYMOUS reader runs the second query not at all: every paywalled root is
// locked to them by definition. That is a MEASURED fact about them rather than a
// defaulted one — not the "widening a gated read omits the viewer's fields"
// trap, which is about claims that cannot exist.
// =============================================================================

// EXPORTED so the DB-backed key test runs the REAL statement rather than a copy
// of it. The whole defect this guards is a key that looks right and matches no
// row, and a test that retypes the join has already made the same choice the
// code did.
export const LOCKED_ROOT_ARTICLES_SQL = `SELECT nostr_event_id, id, writer_id, publication_id
       FROM articles
      WHERE nostr_event_id = ANY($1::text[])
        AND access_mode = 'paywalled'
        AND deleted_at IS NULL`;

export async function resolveLockedRoots(
  viewerId: string | null,
  rootEventIds: string[],
): Promise<Set<string>> {
  if (rootEventIds.length === 0) return new Set();
  const { rows } = await pool.query<{
    nostr_event_id: string;
    id: string;
    writer_id: string;
    publication_id: string | null;
  }>(LOCKED_ROOT_ARTICLES_SQL, [rootEventIds]);
  if (rows.length === 0) return new Set();
  const readable = await checkArticleAccessSet(
    viewerId,
    rows.map((r) => ({
      id: r.id,
      writerId: r.writer_id,
      publicationId: r.publication_id,
    })),
  );
  return new Set(
    rows.filter((r) => !readable.has(r.id)).map((r) => r.nostr_event_id),
  );
}
