import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth, invalidateAuthCache } from '../middleware/auth.js'
import { getAdminIds, requireAdmin } from '../middleware/admin.js'
import { signEvents } from '../lib/key-custody-client.js'
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from '@platform-pub/shared/lib/relay-outbox.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { isUuid, parseLimit, parseOffset } from '../lib/request-inputs.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import {
  sendModerationNoticeEmail,
  type ModerationNoticeKind,
} from '@platform-pub/shared/lib/member-notices.js'
import {
  requestStepUpToken,
  claimStepUpToken,
} from '@platform-pub/shared/auth/magic-links.js'
import {
  REPORT_CATEGORIES,
  REPORT_PRIORITIES,
  APPEAL_WINDOW_DAYS,
  priorityForCategory,
  triageDeadline,
  type ReportCategory,
  type ReportPriority,
} from '../lib/report-taxonomy.js'
import { PLATFORM_BLOCK_KINDS, HEX_PUBKEY_RE } from '@platform-pub/shared/lib/platform-blocks.js'
import { recordConfigAudit } from '@platform-pub/shared/lib/config-audit.js'
import { verifySourceLiveness } from '../lib/source-liveness.js'
import { nip19, type EventTemplate } from 'nostr-tools'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import { claimantSql } from '@platform-pub/shared/lib/presence-claim.js'

// -----------------------------------------------------------------------------
// Removal helpers — an admin removal must be as complete as the author's own
// delete paths (articles/manage.ts, notes.ts): un-publishing alone left the
// card, title and free body in every workspace feed (feed queries filter only
// on feed_items.deleted_at, never published_at) and left the full NIP-23 /
// kind-1 event served forever by the platform's own relay (no kind-5). So we
// (a) soft-delete the feed_items rows and (b) enqueue the kind-5 tombstone in
// the same transaction. Notes cascade out of feed_items on DELETE, so they only
// need the tombstone. Signed with the content author's own custodial key (the
// platform holds it), exactly as a self-delete would be.
//
// Two-phase (§0f-14, H4): PREPARE — select the removable set and sign every
// tombstone (one key-custody HTTP round-trip each) — runs OUTSIDE the caller's
// transaction, so a prolific account's hundreds of sign calls no longer hold a
// transaction open, and key-custody downtime fails the request cleanly instead
// of mid-transaction. APPLY — pure DB writes + outbox enqueues — is what runs
// inside the transaction (only the enqueue ever needed it). Content published
// in the tiny prepare→commit window escapes this sweep, but a suspension
// commits `status = 'suspended'` which blocks further publishing, and the
// admin surface can always re-run a removal.
// -----------------------------------------------------------------------------

interface RemovableArticle {
  id: string
  nostr_event_id: string | null
  nostr_d_tag: string | null
  writer_id: string
  nostr_pubkey: string
}

interface RemovableNote {
  id: string
  nostr_event_id: string | null
  author_id: string
}

/**
 * A native reply. Same two columns the note carries, because a reply is a
 * kind-1 event on the relay exactly as a note is (`web/src/lib/replies.ts`
 * signs and publishes it, then indexes it here) — the only difference is that
 * it is addressed to a conversation.
 */
interface RemovableComment {
  id: string
  nostr_event_id: string | null
  author_id: string
}

interface PreparedRemoval {
  articles: Array<{ article: RemovableArticle; tombstone: SignedNostrEvent | null }>
  notes: Array<{ note: RemovableNote; tombstone: SignedNostrEvent | null }>
  comments: Array<{ comment: RemovableComment; tombstone: SignedNostrEvent | null }>
  /**
   * Whose content this is (L5.5b), so the removal notice reaches the author.
   * Derived from the rows that were actually found, never from the report: a
   * report's `target_account_id` is null on every report this site can produce
   * (L0.2 — `ReportButton` passes an event id alone), so a notice keyed on it
   * would never be sent. Null where the prepare matched nothing, and where the
   * prepare matched several authors the first is taken — the removal targets
   * ONE event, so there is only ever one.
   */
  ownerAccountId: string | null
}

// ONE BATCH PER SIGNER, NEVER ONE CALL PER PIECE (CA-A8, 2026-09-29). This
// signed each tombstone with its own `/keypairs/sign` round-trip, and that
// route's budget is 120 a minute PER SIGNER — every tombstone here signs as
// the content's author, so a member with 121 published pieces was one nobody
// could suspend: the 121st sign answered 429, `signEvent` threw, the route
// 500'd, and `status` was never written. `signEvents` goes to key-custody's
// batch route (its own budget, 500 a call) once per author, and the results
// come back positionally. The two-phase shape above is unchanged: this still
// runs OUTSIDE the transaction, so key-custody being down still fails the
// request cleanly before anything is written, and the suspension notice's
// "removed from the relays it had reached" stays a statement rather than a
// promise. A row with no relay event (never published there) takes a null
// tombstone and is not sent to the signer at all.
//
// Exported for the test: the batching IS the behaviour, and a mocked signer
// counting its calls is the only instrument that can see it.
export async function signRemovals(
  articles: RemovableArticle[],
  notes: RemovableNote[],
  comments: RemovableComment[] = [],
): Promise<PreparedRemoval> {
  const prepared: PreparedRemoval = {
    articles: [],
    notes: [],
    comments: [],
    ownerAccountId:
      articles[0]?.writer_id ?? notes[0]?.author_id ?? comments[0]?.author_id ?? null,
  }
  const now = Math.floor(Date.now() / 1000)

  // Every tombstone to sign, keyed on its signer, remembering where to put it
  // back. Same kind-5 shapes as before: the article's carries the `a` address
  // as well as the `e`; a note's and a reply's carry the `e` alone — the reply
  // IS a kind-1 event and it reached the relay under its author's pubkey, so
  // "removed from the relays it had reached" is a kind-5 or it is not true.
  type Slot =
    | { kind: 'article'; index: number }
    | { kind: 'note'; index: number }
    | { kind: 'comment'; index: number }
  const bySigner = new Map<string, { templates: EventTemplate[]; slots: Slot[] }>()
  const queue = (signerId: string, template: EventTemplate, slot: Slot) => {
    const group = bySigner.get(signerId) ?? { templates: [], slots: [] }
    group.templates.push(template)
    group.slots.push(slot)
    bySigner.set(signerId, group)
  }

  articles.forEach((a, index) => {
    prepared.articles.push({ article: a, tombstone: null })
    if (a.nostr_event_id && a.nostr_d_tag) {
      queue(a.writer_id, {
        kind: 5,
        content: '',
        tags: [
          ['e', a.nostr_event_id],
          ['a', `30023:${a.nostr_pubkey}:${a.nostr_d_tag}`],
        ],
        created_at: now,
      }, { kind: 'article', index })
    }
  })
  notes.forEach((n, index) => {
    prepared.notes.push({ note: n, tombstone: null })
    if (n.nostr_event_id) {
      queue(n.author_id, { kind: 5, content: '', tags: [['e', n.nostr_event_id]], created_at: now }, { kind: 'note', index })
    }
  })
  comments.forEach((c, index) => {
    prepared.comments.push({ comment: c, tombstone: null })
    if (c.nostr_event_id) {
      queue(c.author_id, { kind: 5, content: '', tags: [['e', c.nostr_event_id]], created_at: now }, { kind: 'comment', index })
    }
  })

  for (const [signerId, group] of bySigner) {
    const signed = await signEvents(signerId, group.templates)
    signed.forEach((event, i) => {
      const slot = group.slots[i]
      const tombstone = event as SignedNostrEvent
      if (slot.kind === 'article') prepared.articles[slot.index].tombstone = tombstone
      else if (slot.kind === 'note') prepared.notes[slot.index].tombstone = tombstone
      else prepared.comments[slot.index].tombstone = tombstone
    })
  }
  return prepared
}

// PREPARE one target by its Nostr event id (article, note or reply). No transaction.
//
// THE REPLY ARM IS NOT OPTIONAL (§0ab item 4). Since migration 232 a native
// reply is a card with its own `feed_items` row and its own `nostr_event_id`,
// so it is reportable from every feed — and `resolveReportTarget` resolves it
// to a NON-external target carrying that event id. This prepare read `articles`
// and `notes` only, so the lookup matched nothing and the matched-nothing
// refusal answered 409 `no_removable_content`: the one content action on a
// reported reply was unreachable from the day replies became cards, while the
// queue showed the button. `authorOfEvent` below has always unioned `comments`,
// which is what made the ACCOUNT rungs work on a reply while the CONTENT rung
// did not — the asymmetry was visible in this file.
async function prepareContentRemovalByEventId(eventId: string): Promise<PreparedRemoval> {
  const { rows: articles } = await pool.query<RemovableArticle>(
    `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.writer_id, acc.nostr_pubkey
       FROM articles a JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.nostr_event_id = $1 AND a.deleted_at IS NULL`,
    [eventId]
  )
  const { rows: notes } = await pool.query<RemovableNote>(
    `SELECT id, nostr_event_id, author_id FROM notes WHERE nostr_event_id = $1`,
    [eventId]
  )
  // `deleted_at IS NULL`, so a reply already soft-deleted matches nothing and
  // the removal is REFUSED rather than recorded a second time — the same
  // "a removal that matched nothing is refused" contract the articles arm keeps.
  const { rows: comments } = await pool.query<RemovableComment>(
    `SELECT id, nostr_event_id, author_id FROM comments
      WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
    [eventId]
  )
  return signRemovals(articles, notes, comments)
}

// PREPARE all of an account's published articles, notes and replies. No transaction.
//
// THEIR REPLIES, NOT JUST THEIR REPLY CARDS (§0ab item 4, sibling).
//
// This used to stamp `feed_items` for the member's comments and leave the
// `comments` rows alone, on the reasoning that a conversation is other
// people's too. The feed half of that was right and is kept. The other half
// made the notice untrue: `account_suspended` and `account_terminated` both
// say "the writing you had published has been removed from all.haus and from
// the relays it had reached", and a reply is writing they published, indexed
// here from a kind-1 event they signed. With `comments.deleted_at` NULL,
// `GET /replies` went on serving the full text on the article page and no
// tombstone was ever published — so the sentence was false on both of its
// clauses, on the surface a reader is most likely to be looking at.
//
// A SOFT DELETE KEEPS BOTH. The thread projector reads `comments.deleted_at`
// and renders the node as "[deleted]" (`replies.ts`), so the conversation
// keeps its SHAPE — replies to the reply still hang off something, and other
// people's remarks still read — while the writing itself goes. That is the
// distinction the old comment was reaching for, and it costs one column.
async function prepareAllContentRemovalForAccount(accountId: string): Promise<PreparedRemoval> {
  const { rows: articles } = await pool.query<RemovableArticle>(
    `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.writer_id, acc.nostr_pubkey
       FROM articles a JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.writer_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL`,
    [accountId]
  )
  const { rows: notes } = await pool.query<RemovableNote>(
    `SELECT id, nostr_event_id, author_id FROM notes WHERE author_id = $1`,
    [accountId]
  )
  const { rows: comments } = await pool.query<RemovableComment>(
    `SELECT id, nostr_event_id, author_id FROM comments
      WHERE author_id = $1 AND deleted_at IS NULL`,
    [accountId]
  )
  return signRemovals(articles, notes, comments)
}

// APPLY a prepared removal: DB effects + outbox enqueues only — no external IO,
// safe to run inside the caller's transaction. Idempotent per row (UPDATE/
// DELETE by id), so re-applying after a retried transaction is harmless.
async function applyPreparedRemoval(client: PoolClient, prepared: PreparedRemoval): Promise<void> {
  for (const { article: a, tombstone } of prepared.articles) {
    await client.query(
      `UPDATE articles SET published_at = NULL, updated_at = now() WHERE id = $1`,
      [a.id]
    )
    await client.query(
      `UPDATE feed_items SET deleted_at = now() WHERE article_id = $1 AND deleted_at IS NULL`,
      [a.id]
    )
    if (tombstone) {
      await enqueueRelayPublish(client, {
        entityType: 'article_deletion',
        entityId: a.id,
        signedEvent: tombstone,
      })
    }
  }
  for (const { note: n, tombstone } of prepared.notes) {
    if (tombstone) {
      await enqueueRelayPublish(client, {
        entityType: 'note_deletion',
        entityId: n.id,
        signedEvent: tombstone,
      })
    }
    // Cascades to feed_items via feed_items_note_id_fkey ON DELETE CASCADE.
    await client.query(`DELETE FROM notes WHERE id = $1`, [n.id])
  }
  // SOFT-DELETED, never deleted: the thread keeps the node and renders it
  // "[deleted]", so the replies hanging off it still have something to hang
  // from. The card goes with it in the same transaction, which is the pairing
  // `DELETE /replies/:replyId` makes for a member deleting their own.
  for (const { comment: c, tombstone } of prepared.comments) {
    if (tombstone) {
      // `note_deletion`, not a new vocabulary value: the event being tombstoned
      // IS a kind 1. The entity_type CHECK is a schema constraint, so a
      // `comment_deletion` would be a migration, and it would be a migration to
      // say something less true than this.
      await enqueueRelayPublish(client, {
        entityType: 'note_deletion',
        entityId: c.id,
        signedEvent: tombstone,
      })
    }
    await client.query(
      `UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [c.id]
    )
    await client.query(
      `UPDATE feed_items SET deleted_at = now()
        WHERE comment_id = $1 AND deleted_at IS NULL`,
      [c.id]
    )
  }
}

// =============================================================================
// Moderation Routes
//
// Per ADR §I.5 (Minimum Viable Moderation at Launch):
//   - Report button on all content, feeding a human-reviewed queue
//   - Small set of report categories: illegal content, harassment, spam, other
//   - No automated action — human review only
//   - Platform ability to remove content and suspend accounts
//   - Manual operation by the founder is acceptable at launch
//
// POST   /reports                  — submit a report (any authenticated user)
// GET    /admin/reports            — list reports (founder/admin only)
// PATCH  /admin/reports/:reportId  — resolve a report (remove content / no action)
// POST   /admin/suspend/:accountId — suspend an account
// =============================================================================

// A readonly `as const` tuple is what a test can compare against; zod wants a
// mutable one. The cast is the seam between those two facts and nothing else —
// the ARRAY is the single source, in `lib/report-taxonomy.ts`, and the web's
// copy of it is pinned against that file by `web/tests/admin-report-wire.test.ts`.
const categoryEnum = z.enum(
  REPORT_CATEGORIES as unknown as [ReportCategory, ...ReportCategory[]],
)

const SubmitReportSchema = z.object({
  // FIVE WAYS TO NAME A THING, because there are five kinds of thing on this
  // site and the table could hold two of them (L6.3). `targetPostId` is the
  // important addition: `feed_items.post_id` is the one identity spanning
  // native and external items, so it is what the workspace reports with — and
  // until it existed, an external card, which is most of what the workspace
  // shows, had no id this table could hold and so carried no report control at
  // all.
  targetNostrEventId: z.string().max(200).optional(),
  targetAccountId: z.string().uuid().optional(),
  targetPostId: z.string().max(200).optional(),
  targetConversationId: z.string().uuid().optional(),
  targetProfileId: z.string().uuid().optional(),
  category: categoryEnum,
  notes: z.string().max(2000).optional(),
})

/**
 * D7 §5's ladder, as a vocabulary the route accepts.
 *
 *   removal + warning → suspension (7 days) → termination
 *
 * Six values against the three that shipped, and the three that shipped
 * collapsed the ladder: `warn` did not exist, so a first offence had to be a
 * removal; `suspend_7d` did not exist, so the only suspension was permanent;
 * and `terminate` did not exist, so the fast-track D7 §5 reserves for CSAM,
 * grooming, credible threats and confirmed fraud had to be spelled as an
 * ordinary suspension. A ladder with one rung is not a ladder, and the
 * published procedure named all three.
 */
const REPORT_ACTIONS = [
  'no_action',
  'warn',
  'remove_content',
  'suspend_7d',
  'suspend',
  'terminate',
] as const
type ReportAction = (typeof REPORT_ACTIONS)[number]

/**
 * A reviewer raising a report's priority (§0z item 8; Terms 9.3, D7 §2).
 * `reason` is REQUIRED for the reason every operator act on somebody else's
 * report requires one: a change to a published deadline is evidence or it is
 * nothing. `.trim()` before `.min(1)`, because a space is not a reason.
 */
const RaisePrioritySchema = z.object({
  priority: z.enum(REPORT_PRIORITIES as unknown as [ReportPriority, ...ReportPriority[]]),
  reason: z.string().trim().min(1).max(1000),
})

const ResolveReportSchema = z.object({
  action: z.enum(REPORT_ACTIONS as unknown as [ReportAction, ...ReportAction[]]),
  // REQUIRED (L5.5b). D5 §9 and D7 §5 say a member is told WHY, so the reason
  // is what the notice carries — and a field that was optional and discarded
  // was worse than no field: it looked like a record and was not one.
  // `.trim()` before `.min(1)`, because a space is not a reason.
  //
  // It is now STORED as well as sent (L6.4, migration 223). The two are a pair
  // and neither substitutes: `reason` is the sentence the MEMBER reads, written
  // to be answerable; `reasoning` below is the judgement, written for whoever
  // reads the log afterwards — including the appeal, which is a fresh review
  // against the first one.
  reason: z.string().trim().min(1).max(1000),
  // D7 §8: "The one-line reasoning is mandatory even for obvious calls — the
  // log is the evidence that judgements were made under this guidance." So it
  // is required on every action including `no_action`: a dismissal is a
  // judgement, and it is the one most likely to be questioned later.
  reasoning: z.string().trim().min(1).max(2000),
})

/** The direct suspend/reinstate routes take the same required reason. */
const ModerationActionSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
})

/** An appeal is words, or it is a button press we cannot answer (D7 §5). */
const AppealSchema = z.object({
  token: z.string().min(1).max(512),
  text: z.string().trim().min(1).max(4000),
})

const AppealDecisionSchema = z.object({
  outcome: z.enum(['upheld', 'reversed']),
  // Same rule as the resolution's: "Uphold or reverse; record reasoning"
  // (D7 §5). An appeal answered with no recorded re-reasoning is the solo
  // operator marking their own homework with the page left blank.
  reasoning: z.string().trim().min(1).max(2000),
})

const BlockSchema = z.object({
  kind: z.enum(PLATFORM_BLOCK_KINDS as unknown as ['source', 'npub']),
  /** A source URI, or an npub/hex pubkey — see `normaliseBlockTarget`. */
  target: z.string().trim().min(1).max(2048),
  protocol: z.string().min(1).max(32).optional(),
  reason: z.string().trim().min(1).max(1000),
})

/** Lifting a block is an operator act too, and leaves the same evidence. */
const BlockLiftSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
})

/** The protocols `verifySourceLiveness` can canonicalise. `email` sources are
 *  addressed by the inbound alias and carry no alternate spelling. */
const CANONICALISABLE = new Set(['rss', 'atproto', 'activitypub', 'nostr_external'])

/**
 * A LATER, LESSER DECISION MUST NOT DOWNGRADE A STANDING ONE (§0z item 14).
 * Which account states each rung may be applied FROM. The timed rung only
 * from `active` — applied to an indefinite suspension it would give it a
 * timer, and the sweep would lift a decision nobody reversed. The indefinite
 * rungs may overwrite `suspended` (a timed one becomes indefinite; a
 * suspension becomes a termination) but never `moderated`, and none of them
 * touches a member's own `deactivated` or `deleted`, which are not ours.
 */
const ACCOUNT_ACTION_FROM: Record<'suspend_7d' | 'suspend' | 'terminate', readonly string[]> = {
  suspend_7d: ['active'],
  suspend: ['active', 'suspended'],
  terminate: ['active', 'suspended'],
}

/** Thrown INSIDE the appeal's transaction when the UPDATE matched no report,
 *  so the token claim rolls back with it rather than committing behind a
 *  refusal (§0ab guard (d)). */
class AppealNotFiledError extends Error {
  constructor() {
    super('No appealable report matched')
    this.name = 'AppealNotFiledError'
  }
}

/** Thrown INSIDE the transaction when the guarded status write matched no
 *  row, so the claim rolls back with it — a 409 returned from the callback
 *  would commit the claim behind the refusal. */
class StandingDecisionError extends Error {
  constructor(public readonly standing: { status: string; suspendedUntil: Date | null }) {
    super('A standing moderation decision refuses this one')
    this.name = 'StandingDecisionError'
  }
}

async function readStanding(
  accountId: string,
  client: { query: typeof pool.query } = pool,
): Promise<{ status: string; suspendedUntil: Date | null } | null> {
  const { rows } = await client.query<{ status: string; suspended_until: Date | null }>(
    'SELECT status::text AS status, suspended_until FROM accounts WHERE id = $1',
    [accountId],
  )
  return rows[0] ? { status: rows[0].status, suspendedUntil: rows[0].suspended_until } : null
}

/** The report statuses that mean "this is out of the queue". */
const RESOLVED_STATUSES = new Set([
  'resolved_removed',
  'resolved_no_action',
  'resolved_actioned',
])

/**
 * What the action DID, in the two words the record and the queue need: the
 * coarse status (which is what the queue filters on) and the notice the member
 * gets (which is what they read). `null` for a notice means we say nothing —
 * true of `no_action` alone, because nothing was done to anybody.
 */
const ACTION_OUTCOME: Record<
  ReportAction,
  {
    status: string
    notice: ModerationNoticeKind | null
    removesContent: boolean
    /**
     * The action's WHOLE effect is the notice — so with nobody to send it to,
     * pressing it does nothing at all.
     *
     * `warn` is the only one, and it is exactly the silent no-op this route's
     * other guards exist to stop: driven against a report on an ingested post,
     * it resolved the report, wrote a creditable record, and warned nobody —
     * because an external author has no all.haus account to write to. Every
     * other action still DOES something without a recipient (a removal removes;
     * a dismissal is a dismissal), so the refusal is narrow.
     */
    noticeIsTheAction?: true
  }
> = {
  no_action: { status: 'resolved_no_action', notice: null, removesContent: false },
  warn: {
    status: 'resolved_actioned',
    notice: 'content_warned',
    removesContent: false,
    noticeIsTheAction: true,
  },
  remove_content: { status: 'resolved_removed', notice: 'content_removed', removesContent: true },
  suspend_7d: { status: 'resolved_removed', notice: 'account_suspended_7d', removesContent: true },
  suspend: { status: 'resolved_removed', notice: 'account_suspended', removesContent: true },
  terminate: { status: 'resolved_removed', notice: 'account_terminated', removesContent: true },
}

/** The three actions that move `accounts.status`, and where they move it to. */
const ACTION_ACCOUNT_STATUS: Partial<Record<ReportAction, 'suspended' | 'moderated'>> = {
  suspend_7d: 'suspended',
  suspend: 'suspended',
  terminate: 'moderated',
}

/**
 * The same three, as a runtime list a statement can compare against — the
 * appeal lift asks "did a LATER account action land on this member?" and a
 * bare type answers nothing (CLAUDE.md › a type is not a contract). Derived
 * from the table above rather than restated, so a fourth account rung cannot
 * be added without this following it.
 */
const ACCOUNT_ACTION_NAMES = Object.keys(ACTION_ACCOUNT_STATUS)

// -----------------------------------------------------------------------------
// What a report points at, resolved ONCE
//
// A report now names any of five things, and the two questions every action
// asks of it — "is there content here we can take down?" and "whose account is
// this?" — have to be answered from whichever one it named. Resolved here, in
// one place, rather than re-derived per action branch: the old code asked
// `report.target_nostr_event_id` in one branch and `report.target_account_id`
// in another, which is how `suspend_account` came to be permanently unreachable
// (every report this site could produce carried an event id and no account).
//
// THE EXTERNAL ANSWER IS A REFUSAL, NOT A GAP. An external post is not ours: we
// did not host it and we cannot tombstone it, and D7 §7 says so in terms —
// client-mode remedies are "hide-for-reporter, ingestion-source block,
// external-identity block". So `remove_content` on an external item is refused
// with the remedy named, rather than silently resolving a report and removing
// nothing, which is the failure mode the old Suspend button had.
//
// THE POST ID IS ASKED FIRST (§0z item 6). It is the one identifier that
// carries BOTH answers — `feed_items.item_type` says whether the thing is
// ours, `author_id` says whose it is — and it is what every card sends. The
// event id used to short-circuit ahead of it, and the web sends one on every
// card: a native post therefore resolved to an event and NO account, so the
// ladder's four account rungs answered 409 from the two main surfaces; and an
// external card's "event id" was `feed_items.version`, a content hash, so it
// resolved as native, the removal matched nothing, and the report closed
// `resolved_removed` with nothing removed — the silent no-op L6.4 had said it
// eliminated. Where a report carries an event id alone (older rows, the
// article page without a post id), "whose account" is answered from the
// content tables by that id, so the account rungs are reachable there too.
// -----------------------------------------------------------------------------

export interface ReportRow {
  id: string
  target_nostr_event_id: string | null
  target_account_id: string | null
  target_post_id: string | null
  target_conversation_id: string | null
  target_profile_id: string | null
  status: string
}

export interface ResolvedTarget {
  /** A native Nostr event id we can remove and tombstone. */
  eventId: string | null
  /** Whose account the ladder's account actions land on, where we know it. */
  accountId: string | null
  /** The target is an item we ingested and do not host (D7 §7). */
  external: boolean
}

/**
 * Whose content is this native event? Articles, notes and comments each carry
 * the event id they were published under; the first that knows it answers.
 * Deleted rows are not filtered — a removed article still tells us its author,
 * which is the question being asked.
 */
async function authorOfEvent(eventId: string): Promise<string | null> {
  const { rows } = await pool.query<{ account_id: string }>(
    `SELECT writer_id AS account_id FROM articles WHERE nostr_event_id = $1
     UNION ALL
     SELECT author_id FROM notes WHERE nostr_event_id = $1
     UNION ALL
     SELECT author_id FROM comments WHERE nostr_event_id = $1
     LIMIT 1`,
    [eventId],
  )
  return rows[0]?.account_id ?? null
}

// Exported for presence-identity-claim.test.ts, which runs it against Postgres.
export async function resolveReportTarget(report: ReportRow): Promise<ResolvedTarget> {
  // An account the REPORT names outranks one derived from content: a profile
  // report is about the person, whatever else the row carries.
  const named = report.target_account_id ?? report.target_profile_id ?? null

  if (report.target_post_id) {
    // One row per post_id is not guaranteed by an index (post_id carries no
    // unique constraint), so this is a LIMIT 1 over an indexed lookup — the
    // same shape the thread projector's root lookup takes.
    const { rows } = await pool.query<{
      item_type: string
      author_id: string | null
      nostr_event_id: string | null
      claimant_id: string | null
    }>(
      `SELECT fi.item_type, fi.author_id, fi.nostr_event_id,
              CASE WHEN xa.account_id IS NOT NULL THEN ${claimantSql('xa')} END
                AS claimant_id
         FROM feed_items fi
         LEFT JOIN external_authors xa ON xa.id = fi.external_author_id
        WHERE fi.post_id = $1
        ORDER BY fi.deleted_at NULLS FIRST
        LIMIT 1`,
      [report.target_post_id],
    )
    const row = rows[0]
    if (row) {
      if (row.item_type === 'external') {
        // Whatever else the report carries: the web used to send
        // `feed_items.version` as the event id on every card, and on an
        // external card that is a content hash, not an event.
        //
        // A member's OWN post elsewhere is about them (CROSS-NETWORK-ROUNDTRIP-
        // ADR D-Q3a, operator 2026-09-27): where they linked the account AND
        // consented to showing it, the account rungs reach them. Still
        // `external`, so remove_content stays refused — we did not host it.
        // An undisclosed claim resolves to nobody: acting on it would tell the
        // member, and through them the reporter, whose account it is.
        return {
          eventId: null,
          accountId: named ?? row.claimant_id,
          external: true,
        }
      }
      return {
        eventId: row.nostr_event_id ?? report.target_nostr_event_id,
        accountId: named ?? row.author_id,
        external: false,
      }
    }
    // No timeline row (pruned, or never projected): fall through to the event
    // id, which is the content's own identity rather than the timeline's.
  }

  if (report.target_nostr_event_id) {
    return {
      eventId: report.target_nostr_event_id,
      accountId: named ?? (await authorOfEvent(report.target_nostr_event_id)),
      external: false,
    }
  }

  return { eventId: null, accountId: named, external: false }
}

// -----------------------------------------------------------------------------
// The snapshot (D7 §8, migration 223)
//
// Taken at FILING, because resolving a report deletes what it points at: the
// removal soft-deletes the feed_items row and publishes a kind-5 tombstone, so
// the record of why we removed something stopped being able to show what we
// removed at the exact moment it started mattering. And because by review time
// the author may have edited it — what the reporter saw is the thing being
// judged.
//
// IT NEVER READS A DIRECT MESSAGE. A reported conversation snapshots its id and
// nothing else. D7 §4 permits decrypting a reported thread on review and
// requires the access logged (`key_access_log`, migration 213); a snapshot
// taken here, by a route with no reviewer and no log row, would be a copy of
// the participants' private messages made on a stranger's say-so.
//
// A FAILURE HERE IS NOT THE REPORT'S FAILURE. Filing must not depend on our
// ability to describe what was filed, so the capture is caught and the report
// is written with `{captured: false}` — which says out loud that there is no
// snapshot, rather than leaving a NULL that reads as "nobody has looked yet".
// -----------------------------------------------------------------------------

async function captureSnapshot(
  data: z.infer<typeof SubmitReportSchema>,
): Promise<unknown> {
  const base = { capturedAt: new Date().toISOString() }
  try {
    if (data.targetPostId) {
      const { rows } = await pool.query(
        `SELECT item_type, title, content_preview, author_name, author_username,
                source_protocol, source_item_uri, published_at, nostr_event_id
           FROM feed_items WHERE post_id = $1 ORDER BY deleted_at NULLS FIRST LIMIT 1`,
        [data.targetPostId],
      )
      return rows[0]
        ? { ...base, kind: 'post', postId: data.targetPostId, item: rows[0] }
        : { ...base, kind: 'post', postId: data.targetPostId, captured: false }
    }
    if (data.targetNostrEventId) {
      const { rows } = await pool.query(
        `SELECT 'article' AS kind, title, summary, published_at
           FROM articles WHERE nostr_event_id = $1
          UNION ALL
         SELECT 'note' AS kind, NULL, left(content, 2000), created_at
           FROM notes WHERE nostr_event_id = $1
          LIMIT 1`,
        [data.targetNostrEventId],
      )
      return rows[0]
        ? { ...base, kind: 'event', eventId: data.targetNostrEventId, item: rows[0] }
        : { ...base, kind: 'event', eventId: data.targetNostrEventId, captured: false }
    }
    const personId = data.targetProfileId ?? data.targetAccountId
    if (personId) {
      const { rows } = await pool.query(
        `SELECT username, display_name, bio FROM accounts WHERE id = $1`,
        [personId],
      )
      return rows[0]
        ? { ...base, kind: 'profile', accountId: personId, item: rows[0] }
        : { ...base, kind: 'profile', accountId: personId, captured: false }
    }
    if (data.targetConversationId) {
      // Ids only. See the header — this is the one target we deliberately do
      // not describe.
      return {
        ...base,
        kind: 'conversation',
        conversationId: data.targetConversationId,
        note: 'Contents not captured: a DM is read on review, through the audited path (D7 §4).',
      }
    }
    return { ...base, captured: false }
  } catch (err) {
    logger.error({ err }, 'Report snapshot capture failed — filing the report without one')
    return { ...base, captured: false }
  }
}

/** The appeal link a notice carries, minted against the member's own account. */
async function mintAppealLink(
  accountId: string,
  reportId: string,
  deadline: Date,
): Promise<string | undefined> {
  try {
    const { token } = await requestStepUpToken(accountId, 'appeal', deadline)
    const base = requireEnv('APP_URL')
    return `${base}/appeal/${reportId}?token=${encodeURIComponent(token)}`
  } catch (err) {
    // The notice still goes, and still names the mailbox — a member must not
    // lose the fact that they were moderated because we could not mint a link.
    logger.error({ err, accountId, reportId }, 'Appeal token mint failed')
    return undefined
  }
}

/**
 * Send a moderation notice, and never let its failure become the action's
 * (L5.5b). Fired AFTER the transaction has committed, so a member is never told
 * about something that then rolled back; the shortfall is logged rather than
 * returned, because the operator's screen is reporting on the moderation act
 * and a 500 there would invite them to do it twice.
 */
async function tellThem(
  req: { log: { error: (o: unknown, m: string) => void; info: (o: unknown, m: string) => void } },
  accountId: string,
  kind: ModerationNoticeKind,
  reason: string,
  // The appeal route D7 §5 promises on every notice of an action against a
  // member. Optional because two callers have nothing to appeal (a
  // reinstatement, an appeal decision) and one may fail to mint a token — and
  // the notice's own fallback says so rather than dropping the promise.
  appeal?: { url?: string; deadline?: Date }
): Promise<void> {
  const outcome = await sendModerationNoticeEmail(accountId, kind, reason, {
    appealUrl: appeal?.url,
    appealDeadline: appeal?.deadline,
  })
  if (outcome.skipped > 0) {
    // A member with no address on file, or a provider outage. Either way they
    // have not been told what was done to them, which is a fact somebody has to
    // be able to find afterwards.
    req.log.error({ accountId, kind }, 'moderation notice was NOT delivered')
  } else {
    req.log.info({ accountId, kind }, 'moderation notice sent')
  }
}

export async function moderationRoutes(app: FastifyInstance) {
  const adminIds = await getAdminIds()
  if (adminIds.length === 0) {
    logger.warn('ADMIN_ACCOUNT_IDS is not set — all admin routes will return 403')
  }


  // ---------------------------------------------------------------------------
  // POST /reports — submit a content report
  //
  // Per ADR: "Any reader can report content using the report button present
  // on every article, note, and comment. Reports are reviewed by a human —
  // there is no automated removal."
  // ---------------------------------------------------------------------------

  app.post('/reports', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SubmitReportSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const reporterId = req.session!.sub
    const data = parsed.data

    if (
      !data.targetNostrEventId &&
      !data.targetAccountId &&
      !data.targetPostId &&
      !data.targetConversationId &&
      !data.targetProfileId
    ) {
      return reply.status(400).send({ error: 'Must specify a target' })
    }

    // A CONVERSATION IS NOT ADDRESSABLE BY UUID UNLESS YOU ARE IN IT. Every
    // other target here is public — a post, an account, a profile — and a
    // stranger naming one discloses nothing. A conversation id is the opposite:
    // accepting one from anybody would let a caller enumerate live
    // conversations by guessing (a filed report is a 201 and an absent one a
    // 403, which is an oracle), and would let them put a private thread in
    // front of a reviewer who may then read it. The private-row rule
    // applies: the refusal is 404, not 403, so a conversation the caller is not
    // in is indistinguishable from one that does not exist.
    if (data.targetConversationId) {
      const { rows: member } = await pool.query(
        `SELECT 1 FROM conversation_members
          WHERE conversation_id = $1 AND user_id = $2`,
        [data.targetConversationId, reporterId],
      )
      if (member.length === 0) {
        return reply.status(404).send({ error: 'conversation_not_found' })
      }
    }

    // A PERSON WHO DOES NOT EXIST IS A 404, NOT A FOREIGN-KEY 500. Both
    // columns reference `accounts`, so a well-formed uuid naming nobody reached
    // the INSERT and answered `internal_error` — a fault of ours reported for
    // an ordinary "no such thing". Asked BEFORE the snapshot, which would
    // otherwise capture `{captured:false}` for somebody who was never there.
    // Accounts are soft-deleted, so a member who has left still exists here and
    // stays reportable.
    const personIds = [data.targetAccountId, data.targetProfileId].filter(
      (id): id is string => id !== undefined,
    )
    if (personIds.length > 0) {
      const { rows: found } = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE id = ANY($1::uuid[])`,
        [personIds],
      )
      const present = new Set(found.map((r) => r.id))
      if (!personIds.every((id) => present.has(id))) {
        return reply.status(404).send({ error: 'account_not_found' })
      }
    }

    // The priority is DERIVED, never sent: it is what our published deadline
    // keys on (D7 §2), and a deadline a stranger sets is not a commitment.
    const priority = priorityForCategory(data.category)
    const snapshot = await captureSnapshot(data)

    const { rows } = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO moderation_reports (
         reporter_id, target_nostr_event_id, target_account_id,
         target_post_id, target_conversation_id, target_profile_id,
         category, notes, status, priority, snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10)
       RETURNING id, created_at`,
      [
        reporterId,
        data.targetNostrEventId ?? null,
        data.targetAccountId ?? null,
        data.targetPostId ?? null,
        data.targetConversationId ?? null,
        data.targetProfileId ?? null,
        data.category,
        data.notes ?? null,
        priority,
        JSON.stringify(snapshot),
      ]
    )

    logger.info(
      { reportId: rows[0].id, category: data.category, priority, reporterId },
      'Report submitted'
    )

    // The reporter is told the deadline that applies to what they reported,
    // rather than the one figure the panel used to print for everything. The
    // triage table is the promise; a single "48 hours" was neither of the three
    // numbers in it.
    return reply.status(201).send({
      reportId: rows[0].id,
      priority,
      triageDeadline: triageDeadline(priority, rows[0].created_at).toISOString(),
    })
  })

  // ---------------------------------------------------------------------------
  // GET /admin/reports — list reports (admin only)
  //
  // Returns open and under_review reports, newest first.
  // Resolved reports are excluded by default (pass ?all=true to include).
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { all?: string; limit?: string; offset?: string } }>(
    '/admin/reports',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const showAll = req.query.all === 'true'
      const limit = parseLimit(req.query.limit, 50, 100)
      const offset = parseOffset(req.query.offset)

      const statusFilter = showAll
        ? ''
        : `AND r.status IN ('open', 'under_review')`

      const { rows } = await pool.query<{
        id: string
        reporter_username: string | null
        target_nostr_event_id: string | null
        target_account_username: string | null
        target_account_id: string | null
        target_post_id: string | null
        target_conversation_id: string | null
        target_profile_id: string | null
        target_profile_username: string | null
        subject_account_id: string | null
        subject_username: string | null
        category: string
        priority: string | null
        notes: string | null
        snapshot: unknown
        status: string
        action: string | null
        reason: string | null
        reasoning: string | null
        appeal_deadline: Date | null
        appealed_at: Date | null
        appeal_text: string | null
        appeal_outcome: string | null
        appeal_reasoning: string | null
        appeal_decided_at: Date | null
        created_at: Date
        triaged_at: Date | null
        reviewed_at: Date | null
        priority_raised_at: Date | null
        priority_raised_by_username: string | null
        priority_raise_reason: string | null
      }>(
        // THE QUEUE IS ORDERED BY ITS DEADLINE, NOT BY ARRIVAL. D7 §2 gives P0
        // 24 hours and P2 seven days, so a flat `created_at DESC` buried a
        // CSAM report under a week of spam reports the moment the list ran to
        // more than a screen. Open rows sort worst-priority-first and then
        // OLDEST first, which is the order a deadline is met in; everything
        // resolved has no deadline left and reads better newest-first. A report
        // filed before migration 223 has a NULL priority and sorts last rather
        // than first — an unknown is not an emergency.
        `SELECT r.id, reporter.username AS reporter_username,
                r.target_nostr_event_id,
                target_acct.username AS target_account_username,
                r.target_account_id,
                r.target_post_id, r.target_conversation_id, r.target_profile_id,
                target_prof.username AS target_profile_username,
                r.subject_account_id, subject.username AS subject_username,
                r.category, r.priority, r.notes, r.snapshot, r.status,
                r.action, r.reason, r.reasoning,
                r.appeal_deadline, r.appealed_at, r.appeal_text,
                r.appeal_outcome, r.appeal_reasoning, r.appeal_decided_at,
                r.created_at, r.triaged_at, r.reviewed_at,
                r.priority_raised_at, r.priority_raise_reason,
                raiser.username AS priority_raised_by_username,
                (r.status IN ('open', 'under_review')) AS in_queue
         FROM moderation_reports r
         LEFT JOIN accounts reporter ON reporter.id = r.reporter_id
         LEFT JOIN accounts raiser ON raiser.id = r.priority_raised_by
         LEFT JOIN accounts target_acct ON target_acct.id = r.target_account_id
         LEFT JOIN accounts target_prof ON target_prof.id = r.target_profile_id
         LEFT JOIN accounts subject ON subject.id = r.subject_account_id
         WHERE 1=1 ${statusFilter}
         ORDER BY (r.status IN ('open', 'under_review')) DESC,
                  CASE WHEN r.status IN ('open', 'under_review')
                       THEN r.priority END ASC NULLS LAST,
                  CASE WHEN r.status IN ('open', 'under_review')
                       THEN r.created_at END ASC,
                  r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )

      // Two counts, because they are two different things an operator acts on:
      // how much is waiting, and how much is LATE. The second is computed in
      // SQL against the same table rather than from the page above it — a
      // figure about a source is computed from the source, never from what a
      // downstream filter left (the reading-log paging rule, one table over).
      const countResult = await pool.query<{ open: string; overdue: string; appeals: string }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
                COUNT(*) FILTER (
                  WHERE status IN ('open', 'under_review')
                    AND triaged_at IS NULL
                    AND created_at + make_interval(hours => CASE priority
                          WHEN 'P0' THEN 24 WHEN 'P1' THEN 72 ELSE 168 END) < now()
                ) AS overdue,
                COUNT(*) FILTER (WHERE appealed_at IS NOT NULL AND appeal_decided_at IS NULL)
                  AS appeals
           FROM moderation_reports`
      )

      return reply.status(200).send({
        reports: rows.map((r) => ({
          id: r.id,
          reporterUsername: r.reporter_username,
          targetNostrEventId: r.target_nostr_event_id,
          targetAccountUsername: r.target_account_username,
          targetAccountId: r.target_account_id,
          targetPostId: r.target_post_id,
          targetConversationId: r.target_conversation_id,
          targetProfileId: r.target_profile_id,
          targetProfileUsername: r.target_profile_username,
          subjectAccountId: r.subject_account_id,
          subjectUsername: r.subject_username,
          category: r.category,
          priority: r.priority,
          notes: r.notes,
          snapshot: r.snapshot ?? null,
          status: r.status,
          action: r.action,
          reason: r.reason,
          reasoning: r.reasoning,
          appealDeadline: r.appeal_deadline?.toISOString() ?? null,
          appealedAt: r.appealed_at?.toISOString() ?? null,
          appealText: r.appeal_text,
          appealOutcome: r.appeal_outcome,
          appealReasoning: r.appeal_reasoning,
          appealDecidedAt: r.appeal_decided_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
          triagedAt: r.triaged_at?.toISOString() ?? null,
          reviewedAt: r.reviewed_at?.toISOString() ?? null,
          // The raise, where a reviewer made one (§0z item 8): who, when, why.
          priorityRaisedAt: r.priority_raised_at?.toISOString() ?? null,
          priorityRaisedByUsername: r.priority_raised_by_username ?? null,
          priorityRaiseReason: r.priority_raise_reason ?? null,
          // Derived rather than stored: it is a fact about the clock, and a
          // stored copy would be wrong between the write and the read. Reads
          // the priority AS IT NOW STANDS from `created_at` — a raise moves the
          // deadline back to where the published figure puts it, and a report
          // raised to P0 thirty hours in is overdue the moment it is raised,
          // which is the truth 9.3 tells.
          triageDeadline:
            r.priority !== null
              ? triageDeadline(r.priority as ReportPriority, r.created_at).toISOString()
              : null,
        })),
        openCount: parseInt(countResult.rows[0].open, 10),
        overdueCount: parseInt(countResult.rows[0].overdue, 10),
        openAppealCount: parseInt(countResult.rows[0].appeals, 10),
        limit,
        offset,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /admin/reports/:reportId/priority — a reviewer raises the priority
  //
  // Terms 9.3 promises 24 hours for "a credible threat to life" and "anything
  // plausibly involving a child", and neither is a box a reporter can tick —
  // `priorityForCategory` derives P0 from the three categories D7 §2 names by
  // name and `report-taxonomy.ts` has always said the reviewer raises the rest
  // at triage. Until §0z item 8 nothing wrote `priority` after the filing
  // INSERT, so a credible threat filed under `harassment` was P1 for its whole
  // life and the 24-hour figure had no instrument. This is the instrument.
  //
  // A RAISE ONLY. The priority is the CLAIM (what was alleged, derived from
  // the category), and a reviewer may find the claim graver than its box but
  // never less grave: lowering would rewrite what was reported, and what the
  // reviewer concluded is `reasoning`, a different column for a different
  // reason. 'P0' < 'P1' < 'P2' as text, so a raise is a new value that sorts
  // BEFORE the old — the same ordering the queue sorts by. A pre-223 row with
  // no priority may be given any.
  //
  // THE GUARD RIDES THE UPDATE, like the review and the resolve: the status
  // test, the direction test and the write are one statement, so two
  // reviewers pressing at once contend in Postgres and the loser reads the
  // row back rather than reporting an outcome it assumed. The reason is
  // REQUIRED and stored beside who and when (migration 226): a change to a
  // published deadline is an operator act on somebody else's report, and it
  // leaves evidence or it is nothing.
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId/priority',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { reportId } = req.params
      if (!isUuid(reportId)) {
        return reply.status(404).send({ error: 'report_not_found' })
      }
      const parsed = RaisePrioritySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { priority, reason } = parsed.data

      const { rows } = await pool.query<{ id: string; created_at: Date }>(
        `UPDATE moderation_reports
            SET priority = $2,
                priority_raised_at = now(),
                priority_raised_by = $3,
                priority_raise_reason = $4
          WHERE id = $1
            AND status IN ('open', 'under_review')
            AND (priority IS NULL OR priority > $2)
          RETURNING id, created_at`,
        [reportId, priority, req.session!.sub, reason],
      )
      if (rows.length === 0) {
        const { rows: still } = await pool.query<{ status: string; priority: string | null }>(
          'SELECT status::text AS status, priority FROM moderation_reports WHERE id = $1',
          [reportId],
        )
        if (still.length === 0) {
          return reply.status(404).send({ error: 'report_not_found' })
        }
        if (!['open', 'under_review'].includes(still[0].status)) {
          return reply.status(409).send({ error: 'not_open', status: still[0].status })
        }
        // Open, and not raised: the requested priority is not above the one
        // in force. Named, with the value in force, so the screen can say so.
        return reply.status(409).send({ error: 'not_a_raise', priority: still[0].priority })
      }

      logger.info(
        { reportId, priority, adminId: req.session!.sub },
        'Report priority raised',
      )
      return reply.status(200).send({
        reportId,
        priority,
        triageDeadline: triageDeadline(priority, rows[0].created_at).toISOString(),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/reports/:reportId/review — take a report under review
  //
  // `under_review` has existed in the enum since the table was created and
  // nothing had ever written it, so the middle state of D7 §2's triage — seen,
  // classified, not yet decided — was unrepresentable, and a report being
  // worked on looked exactly like one nobody had opened.
  //
  // It stamps `triaged_at`, which is the column the deadline is measured
  // against: D7 §2 is explicit that triage means "reviewed, classified, and
  // either decided or escalated — not merely opened". So this is a deliberate
  // press, not a side effect of the card rendering.
  //
  // The guard rides the UPDATE, the claim shape the waitlist and reinstate
  // paths take: two admins pressing at once contend in Postgres, one wins, and
  // the loser reads the row back rather than reporting an outcome it assumed.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId/review',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { reportId } = req.params
      if (!isUuid(reportId)) {
        return reply.status(404).send({ error: 'report_not_found' })
      }
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE moderation_reports
            SET status = 'under_review',
                triaged_at = COALESCE(triaged_at, now()),
                reviewed_by = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [reportId, req.session!.sub],
      )
      if (rows.length === 0) {
        const { rows: still } = await pool.query<{ status: string }>(
          'SELECT status::text AS status FROM moderation_reports WHERE id = $1',
          [reportId],
        )
        if (still.length === 0) {
          return reply.status(404).send({ error: 'report_not_found' })
        }
        return reply.status(409).send({ error: 'not_open', status: still[0].status })
      }
      return reply.status(200).send({ reportId, status: 'under_review' })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /admin/reports/:reportId — resolve a report, on D7 §5's ladder
  //
  // Actions (the published ladder, in order of severity):
  //   no_action        — content stays, report closed, nobody is written to
  //   warn             — content stays, the member is told it breached
  //   remove_content   — content removed from platform surfaces + relay (kind 5)
  //   suspend_7d       — account suspended for 7 days, all content removed
  //   suspend          — account suspended indefinitely, all content removed
  //   terminate        — account closed ('moderated'), all content removed
  //
  // WHAT REPLACED WHAT. `suspend_account` is gone and `suspend` is not a rename
  // of it: the old branch suspended `report.target_account_id`, which is NULL on
  // every report this site has ever been able to produce, so it silently
  // resolved the report and suspended nobody. The subject is now RESOLVED from
  // whatever the report named — including the author of the content it names —
  // and the resolution REFUSES rather than proceeding where there is no subject
  // to act on. A moderation screen that closes a report having done nothing is
  // the worst outcome the surface has available.
  //
  // AN EXTERNAL ITEM IS NOT OURS TO REMOVE (D7 §7). We did not host it and we
  // cannot tombstone it; the client-mode remedies are the ingestion-source block
  // and the external-identity block (L6.5, `POST /admin/blocks`). So
  // `remove_content` on an external post is a 409 that names the remedy.
  //
  // Per ADR enforcement rules:
  //   - Content removed from platform relay and surfaces
  //   - Nostr identity (keypair) intact
  //   - Settled earnings paid out on normal schedule
  //   - Accrued-but-unsettled earnings held pending review
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = ResolveReportSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const adminId = req.session!.sub
      const { reportId } = req.params
      if (!isUuid(reportId)) {
        return reply.status(404).send({ error: 'report_not_found' })
      }
      const { action, reason, reasoning } = parsed.data
      const outcome = ACTION_OUTCOME[action]

      // Set inside the transaction, invalidated after COMMIT — an in-txn
      // invalidate races a concurrent request re-caching the pre-commit row.
      let statusChangedAccountId: string | null = null
      // Who to tell, and what we did to them (L5.5b). Collected inside the
      // transaction and SENT AFTER IT COMMITS: a member must not be told their
      // account was suspended by a transaction that then rolled back, and an
      // email outage must not leave a report un-resolved.
      // A holder rather than a bare `let`: the assignments below happen inside
      // the transaction callback, and TypeScript narrows a `let` initialised to
      // `null` back to `null` at the read after it — so `notice.accountId`
      // would not compile against a value the code plainly sets. A field on an
      // object is not narrowed that way.
      const notice: { to: { accountId: string; kind: ModerationNoticeKind } | null } = {
        to: null,
      }

      // Read the report + PREPARE the removal (select + sign every tombstone
      // via key-custody) BEFORE the transaction (§0f-14): the sign loop is one
      // HTTP round-trip per item, so a prolific account held a transaction
      // open across hundreds of calls — and key-custody downtime failed the
      // resolution mid-transaction. The status is re-checked inside the
      // transaction, so a concurrent resolve still loses cleanly (409).
      const preRead = await pool.query<ReportRow>(
        `SELECT id, target_nostr_event_id, target_account_id, target_post_id,
                target_conversation_id, target_profile_id, status
           FROM moderation_reports WHERE id = $1`,
        [reportId]
      )
      if (preRead.rows.length === 0) {
        return reply.status(404).send({ error: 'Report not found' })
      }
      const report = preRead.rows[0]
      if (RESOLVED_STATUSES.has(report.status)) {
        return reply.status(409).send({ error: 'Report already resolved' })
      }

      const target = await resolveReportTarget(report)
      const accountAction = ACTION_ACCOUNT_STATUS[action]

      // REFUSE BEFORE ANYTHING MOVES, and say which of the two is missing. Both
      // of these used to be silent: the action ran, matched nothing, and the
      // report closed looking exactly like one where the work had been done.
      if (action === 'remove_content' && target.external) {
        return reply.status(409).send({
          error: 'external_content_not_removable',
          message:
            'This item was ingested from another network. We do not host it and cannot tombstone it. Block the source or the identity instead.',
        })
      }
      if (outcome.removesContent && !accountAction && !target.eventId) {
        return reply.status(409).send({ error: 'no_removable_content' })
      }
      if (accountAction && !target.accountId) {
        return reply.status(409).send({ error: 'no_subject_account' })
      }

      let prepared: PreparedRemoval | null = null
      if (accountAction && target.accountId) {
        prepared = await prepareAllContentRemovalForAccount(target.accountId)
      } else if (action === 'remove_content' && target.eventId) {
        prepared = await prepareContentRemovalByEventId(target.eventId)
        // A REMOVAL THAT MATCHED NOTHING IS REFUSED, not recorded. An event id
        // that names no article, no note and no live reply — already removed,
        // never ours, or a hash that was never an event — would otherwise close
        // the report `resolved_removed` with nothing removed, which is the
        // silent no-op the two refusals above exist to end. An ACCOUNT action is
        // different: suspending a member with no content still suspends them.
        if (
          prepared.articles.length === 0 &&
          prepared.notes.length === 0 &&
          prepared.comments.length === 0
        ) {
          return reply.status(409).send({ error: 'no_removable_content' })
        }
      }

      // WHO THE ACTION LANDS ON. Derived from the rows the removal actually
      // matched where the report itself does not name a person — a content
      // report's `target_account_id` is null, so a subject keyed on it would be
      // null on every report this site can produce.
      const subjectAccountId = target.accountId ?? prepared?.ownerAccountId ?? null

      // The warn refusal, and it is here rather than beside the two above
      // because it is the only guard that needs the PREPARE to have run: a
      // content report names no account, so whether there is anybody to warn is
      // a fact about the rows the target resolved to.
      if (outcome.noticeIsTheAction && !subjectAccountId) {
        return reply.status(409).send({ error: 'no_subject_account' })
      }

      // A STANDING DECISION IS NOT DOWNGRADED (§0z item 14). Read before the
      // transaction, like every other refusal here, so the claim is never
      // spent on a decision that cannot be applied; re-asserted on the UPDATE
      // itself inside, where a race is settled by Postgres.
      const allowedFrom = accountAction
        ? ACCOUNT_ACTION_FROM[action as keyof typeof ACCOUNT_ACTION_FROM]
        : null
      if (allowedFrom && target.accountId) {
        const standing = await readStanding(target.accountId)
        if (standing && !allowedFrom.includes(standing.status)) {
          return reply.status(409).send({
            error: 'standing_decision',
            status: standing.status,
            suspendedUntil: standing.suspendedUntil?.toISOString() ?? null,
          })
        }
      }

      // The appeal window opens at the decision (D7 §5: seven days), and only
      // for an action that was taken AGAINST somebody. `no_action` has nothing
      // to appeal, which is why the deadline is null rather than an unused date.
      const appealDeadline =
        outcome.notice === null
          ? null
          : new Date(Date.now() + APPEAL_WINDOW_DAYS * 86_400_000)

      let result
      try {
        result = await withTransaction(async (client) => {
        // THE CLAIM IS THE FIRST STATEMENT, AND IT IS THE WHOLE GUARD.
        //
        // It used to be a `SELECT … FOR UPDATE` followed by a status test and
        // then the writes. Two things were wrong with that order and both are
        // about what happens to the LOSER. A resolver that read, wrote the
        // suspension, and only then found the report already resolved answered
        // 409 by RETURNING from the callback — and `withTransaction` commits on
        // a normal return, so the refusal it reported came with the suspension
        // committed behind it. And a re-read plus a test is a read-then-write
        // window even under a row lock, which is the shape the waitlist admit,
        // the reinstate and the review route all replaced with a claim.
        //
        // So: one UPDATE that both records the decision and refuses to make it
        // twice, first, before anything else in the transaction has happened.
        // A losing resolver has written nothing to roll back.
        const claimed = await client.query<{ id: string }>(
          `UPDATE moderation_reports
              SET status = $1::report_status, reviewed_by = $2, reviewed_at = now(),
                  triaged_at = COALESCE(triaged_at, now()),
                  action = $4, reason = $5, reasoning = $6,
                  subject_account_id = $7, appeal_deadline = $8
            WHERE id = $3
              AND status NOT IN ('resolved_removed', 'resolved_no_action', 'resolved_actioned')
            RETURNING id`,
          [
            outcome.status,
            adminId,
            reportId,
            action,
            reason,
            reasoning,
            subjectAccountId,
            appealDeadline,
          ]
        )
        if (claimed.rows.length === 0) {
          // Nothing moved, and nothing else in this transaction has run.
          // Whether the report is gone or somebody else got there first is a
          // read-back rather than a guess, exactly as on the reinstate path.
          const { rows: still } = await client.query<{ status: string }>(
            'SELECT status::text AS status FROM moderation_reports WHERE id = $1',
            [reportId]
          )
          return still.length === 0
            ? { status: 404, body: { error: 'Report not found' } }
            : { status: 409, body: { error: 'Report already resolved' } }
        }

        // The account half of the ladder. moderation.ts stays the ONE
        // moderation writer of `accounts.status`; `suspended_until` is the
        // 7-day rung's timer and is CLEARED on the indefinite rungs, because a
        // stale timer would lift a permanent suspension a week later.
        if (accountAction && target.accountId && allowedFrom) {
          const written = await client.query(
            `UPDATE accounts
                SET status = $2::account_status,
                    suspended_until = $3,
                    updated_at = now()
              WHERE id = $1
                AND status = ANY($4::account_status[])`,
            [
              target.accountId,
              accountAction,
              action === 'suspend_7d'
                ? new Date(Date.now() + 7 * 86_400_000)
                : null,
              allowedFrom,
            ]
          )
          if ((written.rowCount ?? 0) === 0) {
            // Lost a race with a graver decision since the pre-read. Throw,
            // so the claim above rolls back with this.
            const standing = await readStanding(target.accountId, client)
            throw new StandingDecisionError(standing ?? { status: 'unknown', suspendedUntil: null })
          }
          statusChangedAccountId = target.accountId
        }

        if (prepared) await applyPreparedRemoval(client, prepared)

        if (subjectAccountId && outcome.notice) {
          notice.to = { accountId: subjectAccountId, kind: outcome.notice }
        }

        logger.info(
          { reportId, action, subjectAccountId, adminId },
          'Report resolved'
        )

        return { status: 200, body: {
          reportId,
          status: outcome.status,
          action,
          subjectAccountId,
        } }
        })
      } catch (err) {
        if (err instanceof StandingDecisionError) {
          return reply.status(409).send({
            error: 'standing_decision',
            status: err.standing.status,
            suspendedUntil: err.standing.suspendedUntil?.toISOString() ?? null,
          })
        }
        throw err
      }
      // Sent AFTER the commit (a send inside the callback went out before
      // COMMIT, so a 200 could name a decision that then failed to commit),
      // and still BEFORE the notice below, so a failed notice cannot turn a
      // recorded decision into a 500.
      reply.status(result.status).send(result.body)
      if (statusChangedAccountId) invalidateAuthCache(statusChangedAccountId)
      if (notice.to) {
        const url = appealDeadline
          ? await mintAppealLink(notice.to.accountId, reportId, appealDeadline)
          : undefined
        await tellThem(req, notice.to.accountId, notice.to.kind, reason, {
          url,
          deadline: appealDeadline ?? undefined,
        })
      }
      return reply
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/suspend/:accountId — suspend an account directly
  // (without a report — for cases the founder discovers directly)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { accountId: string } }>(
    '/admin/suspend/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { accountId } = req.params

      // THE REASON IS REQUIRED HERE TOO (L5.5b). This route and the report
      // resolution do the same thing to a person, so they ask for the same
      // thing from the operator — a suspension the member is told about
      // without being told why is the one D7 §5 refuses.
      const parsed = ModerationActionSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      // A path id answers 404, never 400 and never 500 (`lib/request-inputs.ts`).
      // And on THIS route the guard has a second job: the prepare below signs a
      // kind-5 tombstone per removable row through key-custody, so a malformed
      // id would spend that whole round-trip before Postgres refused the cast.
      if (!isUuid(accountId)) {
        return reply.status(404).send({ error: 'account_not_found' })
      }

      // A standing decision is not downgraded (§0z item 14): an indefinite
      // suspension may be re-asserted, a termination may not be softened,
      // and a member's own deactivated/deleted is not ours to act on.
      const standingBefore = await readStanding(accountId)
      if (!standingBefore) {
        return reply.status(404).send({ error: 'account_not_found' })
      }
      if (!ACCOUNT_ACTION_FROM.suspend.includes(standingBefore.status)) {
        return reply.status(409).send({
          error: 'standing_decision',
          status: standingBefore.status,
          suspendedUntil: standingBefore.suspendedUntil?.toISOString() ?? null,
        })
      }

      // Sign all tombstones before the transaction (§0f-14) — see the
      // removal-helper header.
      const prepared = await prepareAllContentRemovalForAccount(accountId)

      // EVERY MODERATION ACTION PRODUCES A RECORD, whether or not a member
      // filed one (D7 §8: one record per report, and the reporter type is a
      // FIELD — "user / fraud@ / external" — precisely because not every
      // report arrives through the in-product button). Without this row a
      // direct suspension had no record, and therefore nothing for an appeal
      // to be about: D7 §5 says every suspension notice states the appeal
      // route, and an appeal is keyed on a report. So the route opens one,
      // already resolved, with the operator as the reporter.
      const appealDeadline = new Date(Date.now() + APPEAL_WINDOW_DAYS * 86_400_000)
      const adminId = req.session!.sub

      let result
      try {
        result = await withTransaction(async (client) => {
        const written = await client.query(
          `UPDATE accounts SET status = 'suspended', suspended_until = NULL, updated_at = now()
            WHERE id = $1
              AND status = ANY($2::account_status[])`,
          [accountId, ACCOUNT_ACTION_FROM.suspend]
        )
        if ((written.rowCount ?? 0) === 0) {
          const standing = await readStanding(accountId, client)
          throw new StandingDecisionError(standing ?? { status: 'unknown', suspendedUntil: null })
        }
        await applyPreparedRemoval(client, prepared)

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO moderation_reports (
             reporter_id, target_account_id, subject_account_id, category,
             status, priority, action, reason, reasoning,
             reviewed_by, reviewed_at, triaged_at, appeal_deadline
           ) VALUES ($1, $2, $2, 'other', 'resolved_removed', 'P2', 'suspend',
                     $3, $4, $1, now(), now(), $5)
           RETURNING id`,
          [
            adminId,
            accountId,
            parsed.data.reason,
            // The operator typed one sentence and it is the member's; the
            // judgement column says where it came from rather than inventing a
            // second sentence the operator never wrote.
            `Direct suspension from the member roster. Reason as given to the member: ${parsed.data.reason}`,
            appealDeadline,
          ]
        )

        logger.info(
          { accountId, adminId, reportId: rows[0].id },
          'Account suspended directly'
        )

        return { reportId: rows[0].id }
        })
      } catch (err) {
        if (err instanceof StandingDecisionError) {
          return reply.status(409).send({
            error: 'standing_decision',
            status: err.standing.status,
            suspendedUntil: err.standing.suspendedUntil?.toISOString() ?? null,
          })
        }
        throw err
      }
      // Answered after COMMIT and before the notice, as on the report path.
      reply.status(200).send({ ok: true, accountId, status: 'suspended' })
      // After COMMIT — an in-txn invalidate races a concurrent request
      // re-caching the pre-commit 'active' row for a full TTL.
      invalidateAuthCache(accountId)
      const appealUrl = await mintAppealLink(accountId, result.reportId, appealDeadline)
      await tellThem(req, accountId, 'account_suspended', parsed.data.reason, {
        url: appealUrl,
        deadline: appealDeadline,
      })
      return reply
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/reinstate/:accountId — lift a suspension
  //
  // Suspension had no inverse. An account moved to 'suspended' — by resolving a
  // report or by the direct route above — stayed there until somebody wrote SQL
  // on the box, so a mis-click, or a decision the operator later changed her
  // mind about, locked a member out permanently from a screen that offered no
  // way back. That is the asymmetry this closes, and it is the whole of what it
  // closes.
  //
  // IT DOES NOT RESTORE THEIR CONTENT, AND MUST NOT CLAIM TO. Suspension calls
  // `applyPreparedRemoval`, which publishes a kind-5 tombstone for every one of
  // their events to the relay — and a tombstone is a statement to other relays
  // that has already left the building. Reinstating flips the account's status
  // and nothing else: they can sign in, read and post again, and what they had
  // written before is gone. The surface says so in those words; a route that
  // implied otherwise would be the more damaging lie of the two.
  //
  // ONLY FROM A SUSPENSION. Three of the five statuses are refused, each for
  // its own reason rather than by a shared "is it not active" test:
  //
  //   · 'active'      — nothing to lift. 409, not a silent no-op, because the
  //                     operator pressed a button expecting a change and is
  //                     owed the fact that there wasn't one.
  //   · 'deactivated' — the MEMBER's own choice, not ours. Reversing it from
  //                     this screen would re-activate an account its owner
  //                     closed, which is not moderation, and they reverse it
  //                     themselves by signing back in.
  //   · 'deleted'     — there is nothing behind the row to reinstate.
  //
  // 'moderated' IS reinstatable alongside 'suspended': it is the same kind of
  // state (one we imposed), and leaving it with no exit would rebuild the trap
  // one status along.
  //
  // The guard rides the UPDATE itself — same single-statement claim the waitlist
  // admit and remove paths use, for the same reason: two clicks, or a reinstate
  // racing a fresh suspension, contend in Postgres and exactly one wins, and the
  // loser reads the row back to find out which outcome it lost to rather than
  // reporting the one it assumed.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { accountId: string } }>(
    '/admin/reinstate/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { accountId } = req.params

      // A reason here too, and it is NOT ceremony: the member is told their
      // account is open again, and "why" is the thing that makes that a
      // resolution rather than a second unexplained event.
      const parsed = ModerationActionSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      // 404 rather than the 500 a malformed uuid earns from the cast — the
      // same rule the suspend path above takes, and the reason the absent and
      // the malformed answer alike (`lib/request-inputs.ts`).
      if (!isUuid(accountId)) {
        return reply.status(404).send({ error: 'account_not_found' })
      }

      const claimed = await pool.query<{ id: string }>(
        // `suspended_until` goes with the status. A reinstatement that left the
        // timer behind would leave a row claiming a member is suspended until
        // Thursday while their status says active — and the expiry sweep, which
        // reads exactly that pair, would then find nothing to do and never
        // clear it. A state and its timer are written together or they drift.
        `UPDATE accounts SET status = 'active', suspended_until = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('suspended', 'moderated')
          RETURNING id`,
        [accountId]
      )

      if (claimed.rows.length === 0) {
        // Nothing moved. Read the row back rather than guessing why: the
        // operator needs to know whether the account is already active, is in a
        // state this screen does not govern, or does not exist at all.
        const still = await pool.query<{ status: string }>(
          'SELECT status::text AS status FROM accounts WHERE id = $1',
          [accountId]
        )
        if (still.rows.length === 0) {
          return reply.status(404).send({ error: 'account_not_found' })
        }
        return reply.status(409).send({
          error: 'not_reinstatable',
          status: still.rows[0].status,
        })
      }

      // After the write, like the suspend paths — an invalidate that races a
      // concurrent request re-caches the pre-write row for a full TTL.
      invalidateAuthCache(accountId)

      logger.info({ accountId, adminId: req.session!.sub }, 'Account reinstated')
      await tellThem(req, accountId, 'account_reinstated', parsed.data.reason)

      return reply.status(200).send({ ok: true, accountId, status: 'active' })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /moderation/appeal/:reportId — the subject's appeal (D7 §5, D5 §9)
  //
  // NOT BEHIND `requireAuth`, AND THAT IS THE WHOLE DESIGN. `requireAuth`
  // answers 403 to any account whose status is not 'active', so a suspended or
  // terminated member cannot reach ANY authenticated route on this platform. An
  // appeal route behind a session would therefore have been a right that
  // existed only for the members it did not apply to — and every one of the
  // three actions that carry an appeal (removal, suspension, termination)
  // either locks the member out or is one step from it.
  //
  // So the credential is the single-use token carried in the notice email, the
  // one channel that survives a suspension. It is the step-up primitive from
  // the key export (migration 192) with its own `purpose` — which is the rule
  // that primitive exists to state: a token reused for a second purpose SAYS
  // which, and both readers filter on it, so a token minted to appeal can never
  // be spent to export a private key.
  //
  // ONE APPEAL PER REPORT, INSIDE THE WINDOW, and both guards ride the UPDATE
  // itself — the claim shape, so a double-submit contends in Postgres and
  // exactly one wins. The token claim rides the SAME transaction: a spent token
  // must be a token whose consequence was recorded, which is only guaranteed if
  // both commit or neither.
  //
  // THE REFUSAL IS DELIBERATELY UNINFORMATIVE. A bad token, a report that does
  // not exist, a window that closed and an appeal already filed all answer the
  // same 403 shape — this endpoint is unauthenticated, so a finer answer would
  // make it an oracle over which members have been moderated.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { reportId: string } }>(
    '/moderation/appeal/:reportId',
    async (req, reply) => {
      const parsed = AppealSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { reportId } = req.params
      if (!isUuid(reportId)) {
        return reply.status(404).send({ error: 'report_not_found' })
      }

      const { rows: found } = await pool.query<{ subject_account_id: string | null }>(
        'SELECT subject_account_id FROM moderation_reports WHERE id = $1',
        [reportId],
      )
      const subjectId = found[0]?.subject_account_id ?? null
      if (!subjectId) {
        return reply.status(403).send({ error: 'appeal_not_available' })
      }

      // A REFUSAL AFTER THE CLAIM IS THROWN, NEVER RETURNED (§0ab guard (d)).
      // `return false` from the callback COMMITS — so an UPDATE that matched
      // nothing (window closed, already appealed, or a token for report A
      // posted at report B's URL) burned the token with no appeal recorded,
      // which is the one outcome the paragraph above rules out. The throw rolls
      // the claim back with it; the refusal is the same 403 either way.
      let filed: boolean
      try {
        filed = await withTransaction(async (client) => {
          const spent = await claimStepUpToken(client, parsed.data.token, subjectId, 'appeal')
          if (!spent) return false
          const { rowCount } = await client.query(
            `UPDATE moderation_reports
                SET appealed_at = now(), appeal_text = $2
              WHERE id = $1
                AND appealed_at IS NULL
                AND appeal_deadline IS NOT NULL
                AND appeal_deadline > now()`,
            [reportId, parsed.data.text],
          )
          if ((rowCount ?? 0) === 0) throw new AppealNotFiledError()
          return true
        })
      } catch (err) {
        if (!(err instanceof AppealNotFiledError)) throw err
        filed = false
      }

      if (!filed) {
        return reply.status(403).send({ error: 'appeal_not_available' })
      }

      logger.info({ reportId, subjectId }, 'Appeal filed')
      return reply.status(201).send({ reportId, appealed: true })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /admin/reports/:reportId/appeal — decide an appeal (D7 §5)
  //
  // "Appeals decided within 7 days by fresh review of the original material.
  // Uphold or reverse; record reasoning. (Solo-operator honesty: the same
  // person decides the appeal; the mitigation is the written re-review against
  // this document, recorded in the log.)" So the reasoning is required, and it
  // is a SECOND column rather than an overwrite of the first — the value of a
  // re-review is that both readings survive to be compared.
  //
  // REVERSING LIFTS WHAT CAN BE LIFTED AND SAYS SO ABOUT THE REST. An account
  // state is ours to undo and is undone here. A removal is not: the kind-5
  // tombstone was published to relays we do not own and cannot be recalled, so
  // the notice tells the member their work is gone and they are free to publish
  // it again — which is true, and is better than a promise we cannot keep.
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId/appeal',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = AppealDecisionSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { reportId } = req.params
      if (!isUuid(reportId)) {
        return reply.status(404).send({ error: 'report_not_found' })
      }
      const { outcome, reasoning } = parsed.data

      // ONE TRANSACTION, AND THE LIFT IS ABOUT THE DECISION THAT WAS APPEALED
      // (§0ab item 3). Two things were wrong here and they compound.
      //
      // The claim and the lift were two separate `pool.query` calls, so a
      // failure between them left an appeal recorded as reversed with the
      // account still suspended — the resolve path has been one transaction
      // since §0z item 14 for exactly this reason.
      //
      // And the lift asked `status IN ('suspended','moderated')`: whatever is
      // standing, not what this report wrote. `ACCOUNT_ACTION_FROM.terminate`
      // permits `suspended → moderated`, so a member suspended 7 days by report
      // A and then TERMINATED by report B, winning the appeal on A, had B's
      // termination lifted — an appeal of the lesser decision undoing the
      // greater one, which is the same "a later, lesser decision never
      // downgrades a standing one" rule the resolve path keeps, read from the
      // other end. The appeal is still RECORDED either way: reversing A is a
      // judgement about A, and B's decision stands on its own until B is
      // appealed too. `accountLifted` is what tells the operator which
      // happened, and the notice is sent regardless.
      const decision = await withTransaction(async (client) => {
        const decided = await client.query<{
          subject_account_id: string | null
          action: string | null
          reviewed_at: Date | null
        }>(
          `UPDATE moderation_reports
              SET appeal_outcome = $2, appeal_reasoning = $3, appeal_decided_at = now()
            WHERE id = $1 AND appealed_at IS NOT NULL AND appeal_decided_at IS NULL
            RETURNING subject_account_id, action, reviewed_at`,
          [reportId, outcome, reasoning],
        )
        if (decided.rows.length === 0) return null

        const { subject_account_id: subjectId, action, reviewed_at: reviewedAt } = decided.rows[0]
        const wroteStatus = ACTION_ACCOUNT_STATUS[action as ReportAction]
        let lifted = false
        if (outcome === 'reversed' && subjectId && wroteStatus && reviewedAt) {
          const { rowCount } = await client.query(
            `UPDATE accounts SET status = 'active', suspended_until = NULL, updated_at = now()
              WHERE id = $1
                -- What THIS action wrote, still standing. A member who has
                -- since deactivated their own account is not reactivated by
                -- our appeal, and a status somebody else's decision wrote is
                -- not ours to clear from here.
                AND status::text = $2
                -- And no decision made AFTER this one is holding them there.
                -- A later account action that has not itself been reversed
                -- stands on its own; reversing the earlier report does not
                -- reach it.
                AND NOT EXISTS (
                  SELECT 1 FROM moderation_reports later
                   WHERE later.subject_account_id = $1
                     AND later.id <> $3
                     AND later.action = ANY($4::text[])
                     AND later.reviewed_at IS NOT NULL
                     AND later.reviewed_at > $5
                     AND later.appeal_outcome IS DISTINCT FROM 'reversed'
                )`,
            [subjectId, wroteStatus, reportId, ACCOUNT_ACTION_NAMES, reviewedAt],
          )
          lifted = (rowCount ?? 0) > 0
        }
        return { subjectId, lifted }
      })

      if (decision === null) {
        const { rows: still } = await pool.query<{ appealed_at: Date | null }>(
          'SELECT appealed_at FROM moderation_reports WHERE id = $1',
          [reportId],
        )
        if (still.length === 0) {
          return reply.status(404).send({ error: 'report_not_found' })
        }
        return reply.status(409).send({
          error: still[0].appealed_at === null ? 'not_appealed' : 'already_decided',
        })
      }

      const { subjectId, lifted } = decision
      if (lifted) invalidateAuthCache(subjectId!)

      if (subjectId) {
        await tellThem(
          req,
          subjectId,
          outcome === 'reversed' ? 'appeal_reversed' : 'appeal_upheld',
          reasoning,
        )
      }

      logger.info({ reportId, outcome, subjectId, lifted, adminId: req.session!.sub }, 'Appeal decided')
      return reply.status(200).send({ reportId, outcome, accountLifted: lifted })
    }
  )

  // ---------------------------------------------------------------------------
  // Platform blocks (L6.5; D1 §9.6, D5 §5, D7 §5/§7)
  //
  // GET    /admin/blocks       — what we are refusing, and why
  // POST   /admin/blocks       — refuse a source, or an external identity
  // DELETE /admin/blocks/:id   — stop refusing it
  //
  // THE TARGET IS OMNIVOROUS AND THE STORAGE IS NOT. The operator pastes
  // whatever they have — an npub, a hex pubkey, a feed URL — and the route
  // normalises to the one form the rest of the platform holds (hex for a Nostr
  // identity), because a block stored in a second spelling matches nothing and
  // fails OPEN. The sitewide omnivorous-input rule, in the narrow place it
  // matters most.
  // ---------------------------------------------------------------------------

  app.get('/admin/blocks', { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT b.id, b.kind, b.protocol, b.target_key, b.reason, b.blocked_at,
              a.username AS blocked_by_username,
              -- What this block is actually keeping out, so the list is a fact
              -- rather than an intention. Counted against the tables the
              -- predicates read, which is the only way an operator can tell a
              -- live block from a typo.
              (SELECT count(*) FROM external_sources es
                WHERE b.kind = 'source' AND es.protocol = b.protocol
                  AND es.source_uri = b.target_key) AS matched_sources
         FROM platform_blocks b
         LEFT JOIN accounts a ON a.id = b.blocked_by
        ORDER BY b.blocked_at DESC
        LIMIT 500`,
    )
    return reply.status(200).send({
      blocks: rows.map((r: any) => ({
        id: r.id,
        kind: r.kind,
        protocol: r.protocol,
        target: r.target_key,
        reason: r.reason,
        blockedAt: r.blocked_at.toISOString(),
        blockedByUsername: r.blocked_by_username,
        matchedSources: parseInt(r.matched_sources, 10),
      })),
    })
  })

  app.post('/admin/blocks', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = BlockSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const { kind, reason } = parsed.data
    let protocol = parsed.data.protocol ?? null
    let target = parsed.data.target

    if (kind === 'npub') {
      // An npub is bech32 over the same 32 bytes the rest of the schema stores
      // as hex (`external_authors.stable_handle`, a nostr_external source_uri).
      // Decode it here or the block matches nothing, silently — which is the
      // failure direction that matters: a block that does not match reads
      // exactly like a source that has gone quiet.
      if (target.startsWith('npub1')) {
        try {
          const decoded = nip19.decode(target)
          if (decoded.type !== 'npub') throw new Error('not an npub')
          target = decoded.data as string
        } catch {
          return reply.status(400).send({ error: 'invalid_npub' })
        }
      }
      target = target.toLowerCase()
      if (!HEX_PUBKEY_RE.test(target)) {
        return reply.status(400).send({ error: 'invalid_npub' })
      }
      protocol = 'nostr_external'
    } else if (!protocol) {
      return reply.status(400).send({ error: 'protocol_required' })
    }

    const adminId = req.session!.sub
    try {
      if (kind === 'source' && protocol && CANONICALISABLE.has(protocol)) {
        // A SOURCE BLOCK IS STORED IN THE FORM THE ADD PATH COMPARES (§0z
        // item 12). `addSource` canonicalises through `verifySourceLiveness`
        // (acct → actor URI, handle → DID, npub → hex) and asks the block
        // AFTER that, so a block stored as the operator typed it — an
        // `@user@host`, an `npub1…` — matched nothing, silently, which is the
        // failure direction a block must not have. A dead source is still
        // blockable: where the probe cannot resolve it, the string is taken
        // as typed only if we already hold a row under exactly that key.
        const live = await verifySourceLiveness(
          protocol as 'rss' | 'atproto' | 'activitypub' | 'nostr_external',
          target,
        )
        if (live.ok) {
          target = live.sourceUri
        } else if (live.reason === 'malformed') {
          return reply.status(400).send({ error: 'invalid_source', message: live.message })
        } else {
          const { rows: held } = await pool.query(
            `SELECT 1 FROM external_sources WHERE protocol = $1::external_protocol AND source_uri = $2`,
            [protocol, target.trim()],
          )
          if (held.length === 0) {
            return reply.status(422).send({
              error: 'source_unresolvable',
              message:
                'That source could not be resolved to its canonical form and we hold no source under that key. Paste the source URI exactly as shown on its row.',
            })
          }
          target = target.trim()
        }
      }

      // THE WRITE AND ITS EVIDENCE ARE ONE TRANSACTION (§0z item 12; the
      // config_audit rule — an operator act with consequences for people who
      // are not in the room). And a re-block is REFUSED rather than
      // overwriting the first reason, actor and date: the original decision is
      // the record, and the 409 carries it so the operator can read it.
      const written = await withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform_blocks (kind, protocol, target_key, reason, blocked_by)
           VALUES ($1, $2::external_protocol, $3, $4, $5)
           ON CONFLICT (kind, protocol, target_key) DO NOTHING
           RETURNING id`,
          [kind, protocol, target, reason, adminId],
        )
        if (rows.length === 0) return null
        await recordConfigAudit(client, {
          actorAccountId: adminId,
          key: 'platform_block',
          oldValue: null,
          newValue: `${kind}:${protocol}:${target}`,
          reason,
        })
        return rows[0].id
      })
      if (written === null) {
        const { rows: existing } = await pool.query<{
          id: string
          reason: string
          blocked_at: Date
          blocked_by_username: string | null
        }>(
          `SELECT b.id, b.reason, b.blocked_at, a.username AS blocked_by_username
             FROM platform_blocks b LEFT JOIN accounts a ON a.id = b.blocked_by
            WHERE b.kind = $1 AND b.protocol = $2::external_protocol AND b.target_key = $3`,
          [kind, protocol, target],
        )
        return reply.status(409).send({
          error: 'already_blocked',
          block: existing[0]
            ? {
                id: existing[0].id,
                reason: existing[0].reason,
                blockedAt: existing[0].blocked_at.toISOString(),
                blockedByUsername: existing[0].blocked_by_username,
              }
            : null,
        })
      }
      logger.warn({ kind, protocol, target, adminId }, 'Platform block written')
      return reply.status(201).send({ id: written, kind, protocol, target })
    } catch (err) {
      // An unknown protocol is the operator's typo, not our fault — the cast to
      // external_protocol is what refuses it, and a 400 says so rather than
      // letting the funnel answer `internal_error` for a correctable mistake.
      if ((err as { code?: string }).code === '22P02') {
        return reply.status(400).send({ error: 'unknown_protocol' })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>(
    '/admin/blocks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      if (!isUuid(id)) return reply.status(404).send({ error: 'block_not_found' })
      const parsed = BlockLiftSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const adminId = req.session!.sub
      // Lifting is the operator act in the other direction, and leaves the
      // same evidence in the same transaction (§0z item 12): the row is gone,
      // so the audit row is the only record that it ever stood.
      const lifted = await withTransaction(async (client) => {
        const { rows } = await client.query<{ kind: string; protocol: string; target_key: string }>(
          'DELETE FROM platform_blocks WHERE id = $1 RETURNING kind, protocol, target_key',
          [id],
        )
        if (rows.length === 0) return null
        await recordConfigAudit(client, {
          actorAccountId: adminId,
          key: 'platform_block',
          oldValue: `${rows[0].kind}:${rows[0].protocol}:${rows[0].target_key}`,
          newValue: null,
          reason: parsed.data.reason,
        })
        return rows[0]
      })
      if (!lifted) {
        return reply.status(404).send({ error: 'block_not_found' })
      }
      logger.warn(
        { id, kind: lifted.kind, target: lifted.target_key, adminId },
        'Platform block lifted',
      )
      return reply.status(200).send({ ok: true })
    }
  )

}

// =============================================================================
// The 7-day rung's timer (D7 §5)
//
// `suspend_7d` writes `accounts.suspended_until`, and a suspension that only
// lifts when somebody remembers to lift it is an indefinite one wearing a
// shorter name. This is what makes the published figure true.
//
// It is here, in moderation.ts, for the reason stated on the column: this file
// is the one moderation writer of `accounts.status`, and a sweep living beside
// the scheduler would be a second one. The gateway's periodic tick calls it
// under an advisory lock, like every other sweep.
//
// THE PARTIAL-OUTCOME RULE. One UPDATE over the whole set rather than a loop —
// there is no per-member work that can fail — but the NOTICES are a loop, and
// each is caught individually with the shortfall counted, so one member with no
// address on file cannot stop the rest being told their account is open again.
// =============================================================================

export async function sweepExpiredSuspensions(): Promise<{
  lifted: number
  notified: number
  skipped: number
}> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE accounts
        SET status = 'active', suspended_until = NULL, updated_at = now()
      WHERE status = 'suspended'
        AND suspended_until IS NOT NULL
        AND suspended_until <= now()
      RETURNING id`,
  )
  let notified = 0
  let skipped = 0
  for (const row of rows) {
    invalidateAuthCache(row.id)
    const outcome = await sendModerationNoticeEmail(
      row.id,
      'account_reinstated',
      'The 7-day suspension you were told about has ended.',
    )
    notified += outcome.sent
    skipped += outcome.skipped
  }
  if (rows.length > 0) {
    logger.info(
      { lifted: rows.length, notified, skipped },
      'Expired suspensions lifted',
    )
  }
  return { lifted: rows.length, notified, skipped }
}
