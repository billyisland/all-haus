import { pool } from "@platform-pub/shared/db/client.js";
import type { PoolClient } from "pg";

// =============================================================================
// The blocks predicate — one home, and it is SYMMETRIC by default
//
// A block is a statement about a PAIR, not about a direction, so any path where
// one member causes something to appear in front of another asks it both ways.
// The rule is already written down for comp offers
// (`subscriptions/subscribers.ts`, and CLAUDE.md's consent-by-offer invariant):
// *a gift is a message, so `blocks` is checked in BOTH directions, with one
// refusal for both so neither party learns which way the block runs.*
//
// Two paths were asking half of it, and the halves failed in opposite ways.
//
//   `sendMessage` asked only "did a recipient block me?" — so a blocker could
//   go on sending one-way messages to somebody who, by construction, cannot
//   reply. Blocking someone made them unable to answer you and left you able to
//   keep writing to them, which is the harassment shape the feature exists to
//   end.
//
//   `POST /follows` asked nothing at all, and it inserts a `new_follower`
//   notification — so a blocked account had a direct, repeatable notification
//   channel to the person who had blocked them (unfollow, follow again). A
//   follow is a message here for exactly the reason a comp offer is.
//
// **One refusal for both directions, and it names neither.** A message that
// says "you are blocked by a recipient" is an oracle: it discloses that a
// block exists AND which way it runs, to whichever party did not set it. The
// callers below return one neutral refusal.
//
// **`pool` is the default and a caller inside a transaction passes its own
// client**, so a guard can be read in the same transaction as the write it
// guards — the ordering rule the presence-deprovision and article-re-key
// transactions are built on.
//
// `listInbox` is the display twin of `sendMessage` and asks the SAME question
// through `blockPairSql`: a conversation the viewer could not write into is
// not listed, whichever way the block runs. Before S25 it hid only the
// conversations where a member had blocked the VIEWER, so a member who blocked
// somebody kept seeing a thread that every send into would 403 — the mute
// filter beside it is the tool for "hide this without blocking".
//
// `POST /replies` asks it both ways too (W2, 2026-09-24). It had asked one
// direction only — the content author blocked the replier — on the argument
// that whether blocking somebody should stop YOU commenting under THEIR public
// piece was a product decision. It was put to the operator and decided: a
// block is about the pair, so a blocker cannot go on commenting under the
// work of somebody who can no longer answer them in their own conversation.
//
// ── WHAT A VIEWER SEES, and the one direction a viewer is ever TOLD ──────────
//
// Two different questions live below and they must not be confused.
//
//   HIDING is symmetric and silent. `loadHiddenAuthorIds` and
//   `hiddenFromViewerSql` answer "should this person's words reach this
//   viewer?" — yes unless the viewer muted them or a block runs either way.
//   Threads (the workspace projector and the article page) and notifications
//   read it. Nothing about it is rendered as a fact.
//
//   STATE is one-directional. `viewerRelation` answers "what has the VIEWER
//   done to this person?" — the muted/blocked pair a profile bar and a DM
//   header draw as Mute/Unmute and Block/Unblock. It never reports a block the
//   OTHER party set: a control reading "Unblock" on somebody who blocked you
//   is the oracle the neutral refusals above exist to avoid, and the viewer
//   could not undo it anyway.
// =============================================================================

export interface BlocksQueryable {
  query: typeof pool.query;
}

// The pair predicate AS SQL, for a query that has to ask it per row rather
// than per call — `listInbox` filters a conversation list on it. `a` and `b`
// are SQL expressions (a parameter placeholder, a column), interpolated by the
// caller into its own statement. It is the one spelling of the predicate:
// `blockExistsBetween` below is this fragment wrapped in a SELECT, so a query
// that inlines it cannot drift into the one-directional form on its own.
export function blockPairSql(a: string, b: string): string {
  return `EXISTS (
    SELECT 1 FROM blocks
     WHERE (blocker_id = ${a} AND blocked_id = ${b})
        OR (blocker_id = ${b} AND blocked_id = ${a})
  )`;
}

// Does a block exist between these two accounts, in EITHER direction?
export async function blockExistsBetween(
  a: string,
  b: string,
  client: BlocksQueryable | PoolClient = pool,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 WHERE ${blockPairSql("$1", "$2")}`,
    [a, b],
  );
  return rows.length > 0;
}

// Does a block exist between `actorId` and ANY of `otherIds`, in either
// direction? The set form, for a conversation's member list. An empty
// `otherIds` is false rather than a query — `= ANY('{}')` is never true, but
// spending a round trip to be told so is the loop-that-runs-once shape.
export async function blockExistsWithAny(
  actorId: string,
  otherIds: string[],
  client: BlocksQueryable | PoolClient = pool,
): Promise<boolean> {
  if (otherIds.length === 0) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = ANY($2))
        OR (blocked_id = $1 AND blocker_id = ANY($2))
     LIMIT 1`,
    [actorId, otherIds],
  );
  return rows.length > 0;
}

// The viewer-facing HIDE predicate AS SQL: `other` is muted by `viewer`, or a
// block runs between them either way. For a statement that filters rows per
// row — `GET /notifications` over `n.actor_id`. A NULL `other` (a system
// notification with no actor) is never hidden: both EXISTS are false.
export function hiddenFromViewerSql(viewer: string, other: string): string {
  return `(EXISTS (
    SELECT 1 FROM mutes WHERE muter_id = ${viewer} AND muted_id = ${other}
  ) OR ${blockPairSql(viewer, other)})`;
}

// The same set, materialised: every account whose words are hidden from this
// viewer. For a projector that walks rows in JS (the thread assembly, the
// article page's reply tree). An anonymous viewer hides nobody, and is not
// sent to the database to be told so.
export async function loadHiddenAuthorIds(
  viewerId: string | null,
  client: BlocksQueryable | PoolClient = pool,
): Promise<Set<string>> {
  if (!viewerId) return new Set();
  const { rows } = await client.query<{ id: string }>(
    `SELECT muted_id AS id FROM mutes WHERE muter_id = $1
     UNION
     SELECT blocked_id FROM blocks WHERE blocker_id = $1
     UNION
     SELECT blocker_id FROM blocks WHERE blocked_id = $1`,
    [viewerId],
  );
  return new Set(rows.map((r) => r.id));
}

export interface ViewerRelation {
  muted: boolean;
  blocked: boolean;
}

// What the VIEWER has done to `subjectId` — see the header: one direction
// only, never the block the subject set. The caller omits the field entirely
// for an anonymous viewer and for the viewer's own profile; it is not
// defaulted to false (a relationship that does not exist is not stated).
export async function viewerRelation(
  viewerId: string,
  subjectId: string,
  client: BlocksQueryable | PoolClient = pool,
): Promise<ViewerRelation> {
  const { rows } = await client.query<{ muted: boolean; blocked: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM mutes  WHERE muter_id   = $1 AND muted_id   = $2) AS muted,
       EXISTS (SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2) AS blocked`,
    [viewerId, subjectId],
  );
  return { muted: rows[0].muted, blocked: rows[0].blocked };
}
