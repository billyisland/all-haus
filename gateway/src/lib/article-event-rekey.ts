// =============================================================================
// An edit mints a NEW event id, and everything pointing at the old one has to
// come with it (MIRROR-AUDIT §2.8, S6).
//
// A NIP-23 article is a replaceable event, so editing it signs a new event with
// a new id, and the upsert in the publish paths writes that id over the old one.
// Nothing moved what pointed AT it — so every comment, vote, tally and
// engagement row on the piece was silently orphaned on every edit. The article
// page and the thread projector key on the current id and found nothing; the
// commenters' Replies log shipped their comments with `rootLocked` absent,
// which discloses a locked conversation as an open one.
//
// THE STRUCTURAL FIX IS A DIFFERENT PIECE OF WORK and is still open: key
// conversations on something an edit does not move (`articles.id`, or the
// naddr-minted `feed_items.post_id` the rest of the system standardised on).
// That is a migration, a backfill and every reader — `root-locked.ts` says in
// as many words that "only the event id reaches `articles`, so only the event
// id can be the join", and rebuilding that wrong fails SILENTLY AND
// REASSURINGLY (an empty join finds no root paywalled). This closes the defect
// meanwhile, and it stays correct afterwards: the event id keeps meaning "the
// current event" either way.
//
// WHAT MAKES IT MORE THAN A PATCH IS THE REGISTRY. Every column in the schema
// that can hold an ARTICLE's event id is named below — moved, or deliberately
// not moved with the reason — and `gateway/tests/article-event-rekey.test.ts`
// enumerates the live schema and FAILS on a column in neither list. The failure
// mode this closes is not the four tables we know about; it is the fifth one
// somebody adds in a year, which would orphan in exactly the same silence.
// (Same shape as the ledger-adjacency guard: the rule is enforced by something
// that reads the world, not by remembering.)
// =============================================================================

interface QueryClient {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rowCount: number | null }>;
}

/**
 * Columns that hold an ARTICLE's `nostr_event_id` and therefore move with it.
 *
 * `comments.target_event_id` is the conversation itself. The three engagement
 * columns are the reactions to the piece — a vote is cast on the piece, not on
 * the byte-string that happened to represent it that morning.
 */
export const REKEYED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["comments", "target_event_id"],
  ["votes", "target_nostr_event_id"],
  ["vote_tallies", "target_nostr_event_id"],
  ["feed_engagement", "target_nostr_event_id"],
  // A report is about the PIECE. Left behind it points at an event that
  // resolves to nothing, so a moderator opening the queue after an edit finds a
  // report they cannot action — and an edit would quietly launder every report
  // against the piece. Moving it keeps the report findable; it does not (and
  // must not) alter what was reported, which is why nothing else on the row is
  // touched.
  ["moderation_reports", "target_nostr_event_id"],
];

/**
 * Columns that can hold an article event id and are deliberately NOT moved.
 * The reason is the point — an unexplained omission is indistinguishable from
 * an oversight, which is the whole bug.
 */
export const NOT_REKEYED: Readonly<Record<string, string>> = {
  // The article's own identity, and the thing being changed.
  "articles.nostr_event_id": "the column being rewritten; this is the source",
  // Already rewritten by both publish paths' `feed_items` upsert.
  "feed_items.nostr_event_id":
    "rewritten in the same transaction by the feed_items dual-write",
  // Keyed on article_id for lookup; key-service keeps the event id current on
  // republish (vault.ts) — so it is maintained, just not from here.
  "vault_keys.nostr_article_event_id":
    "maintained by key-service on republish; lookup is by article_id",
  "articles.vault_event_id": "the article's own vault pointer, rewritten by the upsert",
  // A QUOTE is a quote of a VERSION. Re-pointing it would silently change what
  // somebody is on record as having quoted, which is a claim about them.
  "notes.quoted_event_id": "a quote is of the version quoted — moving it rewrites what someone said",
  "citation_edges.nostr_event_id": "a citation is of the version cited (and the whole system is suspended)",
  "citation_edges.source_version_event_id": "explicitly version-scoped, by its own name",
  // A reply-to on a NOTE is a note's parent, never an article's.
  "notes.reply_to_event_id": "notes reply to notes; an article reply is a comments row",
  "pledge_drives.parent_note_event_id": "a note id by construction",
  // Scores are recomputed from scratch by the ranking crons; a stale row ages
  // out rather than misreporting, and moving it would carry an old score onto
  // a new version.
  "feed_scores.nostr_event_id": "recomputed by the ranking crons; a stale row ages out",
  // Not article ids at all.
  "comments.nostr_event_id": "the comment's own id",
  "notes.nostr_event_id": "the note's own id",
  "direct_messages.nostr_event_id": "a DM's own id",
  "dispute_edges.nostr_event_id": "a dispute's own id",
  "outbound_posts.nostr_event_id": "the outbound copy's own id",
  "subscriptions.nostr_event_id": "a subscription event's own id",
  "pledge_drives.nostr_event_id": "a drive's own id",
  "article_drafts.nostr_draft_event_id": "a draft's own id, and a draft has no conversation",
  "read_events.receipt_nostr_event_id": "a receipt's own id",
  "content_key_issuances.read_event_id": "a read_events row id, not a nostr id",
  "pledges.read_event_id": "a read_events row id, not a nostr id",
  "tribute_accruals.read_event_id": "a read_events row id, not a nostr id",
  "stripe_webhook_events.event_id": "a Stripe event id",
};

/**
 * Move everything that points at `oldEventId` onto `newEventId`.
 *
 * Call INSIDE the publish transaction, and only for an EDIT: on a new article
 * there is nothing to move, and a stray match would capture another article's
 * conversation. The caller therefore has to have read the old id BEFORE its
 * upsert — `xmax = 0` only says afterwards whether a row existed.
 *
 * Returns what moved, for the log line. A no-op returns zeroes rather than
 * throwing: an article with no conversation is the ordinary case.
 */
export async function rekeyArticleEvent(
  client: QueryClient,
  oldEventId: string,
  newEventId: string,
): Promise<Record<string, number>> {
  if (!oldEventId || oldEventId === newEventId) return {};

  const moved: Record<string, number> = {};
  for (const [table, column] of REKEYED_COLUMNS) {
    // Identifiers are from the constant list above, never from input.
    const { rowCount } = await client.query(
      `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
      [newEventId, oldEventId],
    );
    if (rowCount) moved[table] = rowCount;
  }
  return moved;
}
