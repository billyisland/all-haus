// =============================================================================
// What does this Nostr event id actually name?  (MIRROR-AUDIT §2.7, S5)
//
// THE KIND IS ON THE REQUEST AND THE TRUTH IS ON THE ROW. `POST /replies` and
// `POST /votes` each picked their table from the request's own `targetKind`,
// which made the declared kind a way to CHOOSE which table gets searched — and
// `POST /notes` indexes a note under a client-supplied `nostrEventId` with no
// signer check. So: mint a note whose id is a paywalled article's event id,
// then send `targetKind: 1`. The lookup lands in `notes`, the article row is
// never read, and the `access_mode` guard that both routes carry is skipped
// entirely. The comment or vote lands on the paywalled article's conversation.
//
// The fix is to stop asking the request. This resolves an event id against the
// tables in a FIXED order and lets the row decide what it is.
//
// WHY THIS ORDER — articles, then comments, then notes. `notes` is the one
// table whose `nostr_event_id` is attacker-chosen (that is §0e's open item, and
// the durable fix is for the server to mint the id). Everything that CAN be
// squatted is therefore searched last, so a squat can only ever lose. Between
// the first two, an article is the stronger claim and the one carrying the
// paywall, which is what the guard needs.
//
// THE DECLARED KIND IS NOT REFUSED WHEN IT DISAGREES, IT IS IGNORED. Refusing
// looks stricter and is worse: a native reply is projected into a thread as a
// Post of `type: "note"` (`post-mapper.ts::commentToPost` — a comment is not an
// article, and the Post union has no third value), so `PostActions` declares
// kind 1 for it in perfect good faith. Under the old branch-on-kind that vote
// searched `notes`, found nothing and 404'd; under a strict mismatch refusal it
// would 400 instead. Resolving by row fixes it. A disagreement is logged, since
// the interesting ones are squats.
//
// Callers take a client rather than the pool so the resolution can ride the
// transaction that acts on it.
// =============================================================================

import logger from "@platform-pub/shared/lib/logger.js";

interface QueryClient {
  query: <R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
}

export type ResolvedTarget =
  | {
      kind: 30023;
      articleId: string;
      authorId: string;
      commentsEnabled: boolean;
      accessMode: string;
      publicationId: string | null;
    }
  | {
      kind: 1111;
      commentId: string;
      authorId: string;
      commentsEnabled: boolean;
      rootEventId: string;
    }
  | { kind: 1; noteId: string; authorId: string; commentsEnabled: boolean };

export async function resolveEventTarget(
  client: QueryClient,
  eventId: string,
  declaredKind?: number,
): Promise<ResolvedTarget | null> {
  const resolved = await resolve(client, eventId);
  if (resolved && declaredKind !== undefined && declaredKind !== resolved.kind) {
    // Not an error — see the header. Worth a line because the shape of a squat
    // is exactly this: a kind that points away from the row that exists.
    logger.warn(
      { eventId, declaredKind, resolvedKind: resolved.kind },
      "Event target kind disagreed with the row; the row wins",
    );
  }
  return resolved;
}

async function resolve(
  client: QueryClient,
  eventId: string,
): Promise<ResolvedTarget | null> {
  const article = await client.query<{
    id: string;
    writer_id: string;
    comments_enabled: boolean;
    access_mode: string;
    publication_id: string | null;
  }>(
    `SELECT id, writer_id, comments_enabled, access_mode, publication_id
       FROM articles
      WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
    [eventId],
  );
  if (article.rows.length > 0) {
    const a = article.rows[0];
    return {
      kind: 30023,
      articleId: a.id,
      authorId: a.writer_id,
      commentsEnabled: a.comments_enabled,
      accessMode: a.access_mode,
      publicationId: a.publication_id,
    };
  }

  const comment = await client.query<{
    id: string;
    author_id: string;
    target_event_id: string;
  }>(
    `SELECT id, author_id, target_event_id
       FROM comments
      WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
    [eventId],
  );
  if (comment.rows.length > 0) {
    const c = comment.rows[0];
    return {
      kind: 1111,
      commentId: c.id,
      authorId: c.author_id,
      // A comment has no `comments_enabled` of its own and should not: whether a
      // conversation is open is the ROOT's decision, and the root is what the
      // caller checks. `true` here means "this row imposes no closure", never
      // "the conversation is open".
      commentsEnabled: true,
      rootEventId: c.target_event_id,
    };
  }

  const note = await client.query<{
    id: string;
    author_id: string;
    comments_enabled: boolean;
  }>(
    `SELECT id, author_id, comments_enabled FROM notes WHERE nostr_event_id = $1`,
    [eventId],
  );
  if (note.rows.length > 0) {
    return {
      kind: 1,
      // Carried so a caller binding a notification to the note reads it off
      // the RESOLVED row — a second lookup keyed on the declared kind is the
      // §2.7 branch reappearing one statement later (S25 item 1).
      noteId: note.rows[0].id,
      authorId: note.rows[0].author_id,
      commentsEnabled: note.rows[0].comments_enabled,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Does this event id already belong to something that is not a note?
//
// The other half of §2.7, and the one `POST /notes` calls: the resolver above
// makes a squat LOSE, this stops it being planted. Both are needed — a resolver
// cannot un-plant a row that some other reader may still pick up, and
// `feed_items.nostr_event_id` has no unique index, so a planted row is a coin
// toss in any `LIMIT 1` that lands on it.
//
// It lives here, beside the resolution order it protects, and is EXPORTED so
// the DB-backed test drives this statement rather than a copy of it — a test
// holding its own copy of production SQL proves the copy.
//
// `notes` is deliberately NOT one of the arms: a repeat of a note's own id is an
// ordinary duplicate, which the INSERT's `ON CONFLICT DO NOTHING` already
// answers with a 200.
// ---------------------------------------------------------------------------
export async function eventIdIsTaken(
  client: QueryClient,
  eventId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM articles WHERE nostr_event_id = $1
      UNION ALL
     SELECT 1 FROM comments WHERE nostr_event_id = $1
     LIMIT 1`,
    [eventId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The REPLY-side twin (CA-B2, 2026-09-29): does this event id already belong
// to something that is not a comment?
//
// `POST /replies` takes its event id from the client too, and its INSERT had
// only `ON CONFLICT (nostr_event_id) DO NOTHING` — unique against COMMENTS
// alone. A comment planted under a live note's id therefore won the resolver
// (articles → comments → notes): every reply to that note answered
// `target_is_reply`, and a vote on it resolved to the comment. The note-side
// helper above cannot be reused verbatim — its comments arm is the unique
// index's job here, and it has no notes arm — so this asks the two tables a
// comment must not shadow. Same contract: run INSIDE the reply transaction,
// answer 409; a repeat of a comment's own id stays the ordinary duplicate.
// ---------------------------------------------------------------------------
export async function replyEventIdIsTaken(
  client: QueryClient,
  eventId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM articles WHERE nostr_event_id = $1
      UNION ALL
     SELECT 1 FROM notes WHERE nostr_event_id = $1
     LIMIT 1`,
    [eventId],
  );
  return rows.length > 0;
}
