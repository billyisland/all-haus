import type { FastifyInstance } from 'fastify'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireSelfServiceAuth } from '../middleware/auth.js'
import { decryptBatch } from '../services/messages.js'
import { accountRateLimitKey } from '../lib/rate-limit-keys.js'
import { exportSecretKey } from '../lib/key-custody-client.js'
import {
  requestStepUpToken,
  claimStepUpToken,
} from '@platform-pub/shared/auth/magic-links.js'
import {
  sendKeyExportStepUpEmail,
  sendKeyExportNoticeEmail,
} from '@platform-pub/shared/lib/email.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { internalSecret } from '@platform-pub/shared/lib/env.js'
import { keyServiceHeaders } from '../lib/key-service-client.js'
import { exportHold, exportHeldBody } from '../lib/email-change-hold.js'

// =============================================================================
// WHAT THE BUNDLE CARRIES AND WHAT IT WITHHOLDS, AS TWO LISTS (§0z item 16).
//
// `schema.sql` has ~70 tables with a foreign key to `accounts`. Every one of
// them is either a family this route exports (named in EXPORTED_TABLES) or a
// table it deliberately leaves out (named in WITHHELD, with the reason the
// member reads in `notice.withheld`). A table in neither is the failure this
// pair exists to catch, and `tests/account-export-coverage.test.ts` reads the
// schema's own FK list to hold the two against it — so a new account-keyed
// table cannot be forgotten silently.
// =============================================================================

/** Tables at least one exported family reads, keyed on the member. */
export const EXPORTED_TABLES = [
  'accounts', 'articles', 'vault_keys', 'article_drafts', 'media_uploads', 'notes', 'comments',
  'direct_messages', 'ledger_entries', 'moderation_reports', 'key_access_log', 'reading_log',
  'reading_positions', 'read_events', 'account_key_exports', 'network_presences',
  'notifications', 'notification_preferences', 'votes', 'follows', 'blocks', 'mutes', 'feeds',
  'feed_sources', 'feed_formulas', 'external_subscriptions', 'follow_imports', 'outbound_posts',
  'external_identity_links', 'subscriptions', 'subscription_offers', 'gift_links', 'reading_tabs',
  'tab_settlements', 'reader_credits', 'writer_payouts', 'article_unlocks',
  'content_key_issuances', 'waitlist', 'external_authors', 'writer_applications',
  'account_email_changes',
] as const

/** Tables keyed on the member that the bundle deliberately does not carry. */
export const WITHHELD: ReadonlyArray<{ table: string; why: string }> = [
  { table: 'conversations', why: 'The conversation record belongs to both parties; your messages in it are exported under `messages`.' },
  { table: 'conversation_members', why: 'Membership of a conversation is the other party’s record as much as yours; your side is `messages`.' },
  { table: 'dm_reactions', why: 'Reactions are part of the conversation record, which is exported as your messages.' },
  { table: 'dm_pricing', why: 'A retired feature with no live rows.' },
  { table: 'feed_items', why: 'A projection of your posts into timelines; the posts themselves are exported as articles, notes and comments.' },
  { table: 'feed_scores', why: 'Derived ranking figures about posts, not a record held about you.' },
  { table: 'feed_engagement', why: 'Derived engagement counters about posts, not a record held about you; your own votes are exported.' },
  { table: 'subscription_events', why: 'The money movements behind your subscriptions, which are in `ledger`.' },
  { table: 'magic_links', why: 'Login tokens: hashes, spent or expired, carrying nothing about you but that a link was sent.' },
  { table: 'atproto_oauth_sessions', why: 'A credential. The identity it belongs to is under `presences`; the secret is not yours to carry out of here.' },
  { table: 'platform_blocks', why: 'The operator’s own refusals; a block names a network identity, not a member.' },
  { table: 'payouts_halted_accounts', why: 'Payout holds and their audit rows are not listed: some holds are ones we are required by law to keep silent (D9 §4.1), and a list showing every class but one would say which it was. Your ledger shows what has been paid.' },
  { table: 'config_audit', why: 'Operator acts, including payout holds — see `payouts_halted_accounts`.' },
  { table: 'credit_edges', why: 'Part of the tribute system, which is suspended and dark.' },
  { table: 'dispute_edges', why: 'Part of the tribute system, which is suspended and dark.' },
  { table: 'tributes', why: 'The tribute system is suspended and dark.' },
  { table: 'tribute_payouts', why: 'The tribute system is suspended and dark.' },
  { table: 'pledge_drives', why: 'Pledges are parked and dark.' },
  { table: 'pledges', why: 'Pledges are parked and dark.' },
  { table: 'publication_article_shares', why: 'Publications are suspended.' },
  { table: 'publication_follows', why: 'Publications are suspended.' },
  { table: 'publication_invites', why: 'Publications are suspended.' },
  { table: 'publication_members', why: 'Publications are suspended.' },
  { table: 'publication_payout_splits', why: 'Publications are suspended.' },
  { table: 'trust_layer1', why: 'The trust graph is parked.' },
  { table: 'trust_polls', why: 'The trust graph is parked.' },
  { table: 'trust_profiles', why: 'The trust graph is parked.' },
  { table: 'vouches', why: 'The trust graph is parked.' },
  { table: 'vote_charges', why: 'Paid voting was removed; no live rows.' },
  { table: 'resolver_async_results', why: 'Transient lookups, swept.' },
]


// =============================================================================
// Author Migration Export
//
// POST /account/export/request — auth required; mails a one-use confirmation
// GET  /account/export?token=… — auth required AND that token
//
// THE STEP-UP IS A CONFIRMATION, NOT A NEW GATE (MIRROR-AUDIT §2.6, migration
// 192). This bundle carries the account's root Nostr secret key, which IS the
// identity and cannot be rotated — so on the ambient cookie alone, any session
// compromise was a permanent one, and the system could not answer "was my key
// taken?" in either direction, because nothing recorded that an export had
// happened. What the export is NOT is optional: NETWORK-CONCIERGE-ADR §4 makes
// it mandatory, so none of this may become a way to withhold a member's own key
// from them. It is a mailed confirmation, a recorded row, and an unconditional
// notice — never a refusal.
//
// Returns a portable bundle of all data a writer needs to leave the platform
// and re-host their content elsewhere:
//
//   account       — Nostr pubkey + secret key (hex + nsec), username, display
//                   name. The secret key is the migration anchor: it lets the
//                   writer re-sign and re-host their identity off-platform
//                   (NETWORK-CONCIERGE-ADR §4 "export-mandatory").
//   articles      — every published article, BODY INCLUDED: the free section as
//                   stored, and for a paywalled piece the vault ciphertext
//                   beside the content key that opens it. The bundle used to
//                   carry the pointers alone and tell the writer to go and
//                   fetch their own events off the relay, which made a data
//                   export a set of instructions — and a relay outage, or our
//                   deleting the platform, an export of nothing.
//   contentKeys   — each paywalled article's content key wrapped with NIP-44
//                   to the writer's own pubkey (decrypt with writer's privkey
//                   to get the raw 32-byte key, then use algorithm to decrypt)
//   receiptWhitelist — per-article list of reader Nostr pubkeys who have paid
//                   (another host can honour these readers without re-charging)
//   notes         — every note the member posted, with its event id
//   comments      — every comment they wrote, with what it was a reply to
//   messages      — their direct messages, DECRYPTED with their own key
//                   through key-custody, which records each disclosure in
//                   `key_access_log` (L6.6) exactly as reading them in the app
//                   does. The counterparty's words are in there too, because a
//                   conversation with half the lines removed is not a copy of
//                   the conversation; it is what the member can already read on
//                   the site, delivered to the same person.
//   ledger        — every `ledger_entries` row naming them, reader side and
//                   writer side. Append-only and never edited (money.md), so
//                   this is the record and not a rendering of one.
//   moderation    — reports they FILED (their own words) and reports they were
//                   the SUBJECT of (the decision, the reason they were sent,
//                   the appeal). Deliberately NOT the reviewer's identity, the
//                   internal `reasoning`, or the snapshot — a data-subject
//                   right is a right to what is about you, and the snapshot of
//                   a report you filed is somebody else's content.
//   keyAccessLog  — every time this platform used their key to open something
//                   already written. This is the half of L6.6 that was named
//                   outstanding on the day it shipped: an access log the
//                   member it is about cannot see is worth more to us than to
//                   them.
//   reading       — the caller's OWN reading log and saved positions
//                   (READING-LOG-AND-LIBRARY-ADR §6). This route is misnamed for
//                   that half and the name is the older thing: it is not only an
//                   author migration bundle, it is the one place a member gets
//                   their own data back. §6 is explicit that the log belongs
//                   here — the export is the reader's data delivered TO the
//                   reader, not a publishing surface, and it already carries
//                   their `read_events` and their nsec. Withholding the log
//                   would be withholding a member's own reading from them,
//                   which is what an earlier draft of that line did.
//
//                   D1's privacy posture is satisfied rather than breached:
//                   every row here is scoped to `req.session.sub` like the rest
//                   of the route, and the log must still never reach the owner
//                   dashboard, a writer-facing analytic, or any export a THIRD
//                   PARTY receives.
//
//                   Rows are exported RAW — `post_id` and timestamps, with no
//                   join to `feed_items`. A resolved title would be prettier and
//                   would also make the export a set of live pointers rather
//                   than a record of what happened (D7): a piece deleted since
//                   it was read would silently vanish from the member's own
//                   history at exactly the moment they asked for a copy of it.
//
// The Nostr events themselves (profile kind 0, follow list kind 3, articles
// kind 30023) are published to the relay and can be fetched by the client
// using the writer's pubkey — they are not duplicated here.
// =============================================================================

// WHICH ACCOUNT STATES MAY TAKE THEIR OWN DATA OUT (L7.1; D8 §7).
//
// `deactivated` is the member's OWN act and reversible by signing back in, so
// refusing them their data is refusing a data-subject right over a state they
// chose — and the case is not hypothetical: deactivating on a phone leaves a
// live cookie on a laptop. `suspended` and `moderated` are the OPERATOR'S and
// stay out: their route is the appeal (D7 §5), and a self-serve bundle carrying
// the root nsec is not a thing to hand out mid-enforcement. `deleted` is out
// because the content is already gone.
//
// One array, spent by both legs and by `requireSelfServiceAuth`'s own set —
// the middleware decides whether the request may run at all, this decides which
// row the query will find, and if those two ever disagree the symptom is a
// member reaching the route and being told their account does not exist.
const EXPORTABLE_STATUSES = ['active', 'deactivated']

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
// Was `process.env.INTERNAL_SECRET ?? ''`: an unset secret became the empty
// string, key-service answered 401, and the gateway reported a member's own key
// export as "Key export failed: 401" — a broken deployment wearing an
// authorisation failure's clothes, on the one route whose whole job is handing a
// member their identity back. `internalSecret()` throws instead, and says which
// variable. See its own note for why it is a call and not a constant.

interface ExportedKey {
  articleId: string
  nostrEventId: string
  dTag: string
  title: string
  algorithm: string
  encryptedKey: string
}

async function fetchExportedKeys(
  writerId: string,
  writerPubkey: string,
): Promise<{ keys: ExportedKey[]; skipped: string[] }> {
  // key-service mounts keyRoutes under /api/v1 (key-service/src/index.ts) —
  // the unprefixed path 404s (§0f-19; every other gateway caller carries it).
  // Bodyless, and its subject — WHOSE keys — is entirely in the two headers, so
  // they are the binding's subject terms (lib/key-service-client.ts). This is
  // the call that exports every vault key a writer holds; a captured request
  // that could be retargeted by editing `x-writer-id` would be the whole finding
  // again with an extra step.
  const path = '/api/v1/writers/export-keys'
  const res = await fetch(`${KEY_SERVICE_URL}${path}`, {
    headers: keyServiceHeaders({
      method: 'GET',
      path,
      identity: { writerId, writerPubkey },
    }),
    // Bounded like every other key-service hop; generous, because this opens
    // every vault key the writer holds in one request.
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(`Key export failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  // `skipped` names the articles whose key could not be opened; an older
  // key-service image omits it, which means none were.
  const body = await res.json() as { keys: ExportedKey[]; skipped?: string[] }
  return { keys: body.keys, skipped: body.skipped ?? [] }
}

// The export bucket, keyed on the authenticated account (lib/rate-limit-keys.ts
// says why an account and not an IP). Shared by BOTH legs on purpose, under one namespace. They are two halves of
// one act, and a separate bucket for the request leg would let a stolen cookie
// mail the owner an unlimited number of confirmation emails — noise designed to
// bury the one notice that matters.
const exportRateLimitKey = accountRateLimitKey('export')

export interface FeedSourceExportRow {
  feed_id: string
  source_type: string
  throughput: unknown
  sampling_mode: string | null
  muted_at: Date | null
  exclude_replies: boolean | null
  tag_name: string | null
  account_username: string | null
  publication_id: string | null
  external_protocol: string | null
  external_uri: string | null
}

/**
 * The member's own posts on their linked networks (CROSS-NETWORK-ROUNDTRIP-ADR
 * D-Q3b, operator 2026-09-27). Rung D attributes these to the member — the
 * byline, their profile log, a report — so they are held ABOUT them and are
 * in the bundle, disclosed or not: the consent governs what other readers are
 * told, and this is the member reading their own record. A copy of what the
 * network published, not the network's own export; a soft-deleted row is out
 * for the reason every deleted post is.
 */
export const EXPORT_POSTS_ELSEWHERE_SQL = `
  SELECT ei.protocol::text AS protocol, ei.source_item_uri, ei.canonical_url,
         ei.content_text, ei.source_reply_uri, ei.source_quote_uri,
         ei.published_at, ei.fetched_at
    FROM feed_items fi
    JOIN external_authors xa ON xa.id = fi.external_author_id
    JOIN external_items ei ON ei.id = fi.external_item_id
   WHERE xa.account_id = $1
     AND fi.deleted_at IS NULL
     AND ei.deleted_at IS NULL
   ORDER BY ei.published_at DESC
   LIMIT $2`

/**
 * THE MEMBER'S FEED SOURCES, CAPPED PER FEED (§0ab item 5c).
 *
 * `$1` is the owner, `$2` the per-feed cap. It was one `LIMIT` over every feed
 * the member owns, sliced afterwards by `.filter(s => s.feed_id === f.id)` —
 * so a member past the cap lost whole LATER feeds' sources, and lost them
 * SILENTLY: every feed still rendered, the tail ones simply empty, which reads
 * as feeds they had never put anything in. `row_number()` takes the cut inside
 * each feed instead, so the bound a member actually meets is the one
 * `notice.capPerList` declares.
 *
 * EXPORTED so its DB test runs this statement rather than a copy — a
 * hand-written query in a test agrees with whatever it was written from, and
 * the claim here is about what Postgres does with a window function.
 */
export const EXPORT_FEED_SOURCES_SQL = `
  SELECT feed_id, source_type, throughput, sampling_mode, muted_at, exclude_replies,
         tag_name, account_username, publication_id, external_protocol, external_uri
    FROM (
      SELECT fs.feed_id, fs.source_type, fs.throughput, fs.sampling_mode, fs.muted_at,
             fs.exclude_replies, fs.tag_name, acc.username AS account_username,
             fs.publication_id, es.protocol::text AS external_protocol,
             es.source_uri AS external_uri, fs.created_at,
             row_number() OVER (PARTITION BY fs.feed_id ORDER BY fs.created_at, fs.id) AS rn
        FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
        LEFT JOIN accounts acc ON acc.id = fs.account_id
        LEFT JOIN external_sources es ON es.id = fs.external_source_id
       WHERE f.owner_id = $1
    ) ranked
   WHERE rn <= $2
   ORDER BY feed_id, created_at`

export async function exportRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /account/export/request — mail the confirmation (MIRROR-AUDIT §2.6)
  //
  // Answers the same way whatever it finds. The caller is authenticated, so
  // there is no email-enumeration question here; what a uniform answer protects
  // is the shape of the account — whether it has an address on file, whether
  // the send succeeded — none of which a stolen session should learn, and none
  // of which changes what the member should do next (look in their inbox).
  // ---------------------------------------------------------------------------
  app.post('/account/export/request', {
    preHandler: requireSelfServiceAuth,
    config: {
      rateLimit: { max: 5, timeWindow: '1 hour', keyGenerator: exportRateLimitKey },
    },
  }, async (req, reply) => {
    const accountId = req.session!.sub

    // An email change moved the channel this confirmation is mailed to, so it
    // waits until the old address has had its chance to undo it
    // (lib/email-change-hold.ts). Said before a token is minted, never after.
    const hold = await exportHold(accountId)
    if (hold) return reply.status(403).send(exportHeldBody(hold))

    // `status = ANY` and not `= 'active'`: a member who deactivated on one
    // device and still holds a cookie on another must be able to ask for their
    // own data (L7.1). `requireSelfServiceAuth` has already made the same
    // judgement one layer up; this is the policy written where the row is read,
    // not a second gate — the two must not be able to drift apart, which is
    // what a bare `WHERE id = $1` here would have allowed.
    const { rows } = await pool.query<{ email: string | null }>(
      `SELECT email FROM accounts WHERE id = $1 AND status = ANY($2)`,
      [accountId, EXPORTABLE_STATUSES]
    )
    const email = rows[0]?.email

    if (email) {
      try {
        const { token, expiresAt } = await requestStepUpToken(accountId, 'key_export')
        await sendKeyExportStepUpEmail(email, token, expiresAt)
      } catch (err) {
        // Logged, never surfaced — see the uniform-answer note above. The
        // member's next move is the same either way, and email health is
        // reported where it is actually read (`/admin/overview`).
        logger.error({ err, accountId }, 'Failed to send key-export step-up email')
      }
    } else {
      logger.warn({ accountId }, 'Key-export step-up requested for an account with no email')
    }

    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // GET /account/export
  //
  // Returns the writer's full migration bundle as a JSON object.
  // The client (or writer's tools) can use this to migrate to another host.
  // ---------------------------------------------------------------------------

  // Tight per-route rate limit: the bundle carries the decrypted root Nostr
  // secret key, so a stolen session cookie must not be able to hammer this
  // path quietly. Legitimate use is a handful of exports, ever. The limiter is
  // NOT the control the audit found missing and it is unchanged — the step-up
  // above is — but it stays exactly as it was reasoned.
  app.get<{ Querystring: { token?: string } }>('/account/export', {
    preHandler: requireSelfServiceAuth,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: exportRateLimitKey,
      },
    },
  }, async (req, reply) => {
    const writerId = req.session!.sub

    // Fetch writer's account
    const accountRow = await pool.query<{
      email: string | null
      nostr_pubkey: string
      username: string | null
      display_name: string | null
      status: string
      created_at: Date
      date_of_birth: Date | string | null
      age_declared_at: Date | null
      reader_terms_version: string | null
      reader_terms_accepted_at: Date | null
      writer_terms_version: string | null
      writer_terms_accepted_at: Date | null
      writer_admitted_at: Date | null
      has_keypair: boolean
    }>(
      `SELECT email, nostr_pubkey, username, display_name, status, created_at,
              date_of_birth, age_declared_at,
              reader_terms_version, reader_terms_accepted_at,
              writer_terms_version, writer_terms_accepted_at, writer_admitted_at,
              nostr_privkey_enc IS NOT NULL AS has_keypair
       FROM accounts
       WHERE id = $1 AND status = ANY($2)`,
      [writerId, EXPORTABLE_STATUSES]
    )

    if (accountRow.rows.length === 0) {
      return reply.status(403).send({ error: "We couldn't find that account." })
    }

    const account = accountRow.rows[0]

    // ---- The step-up, and the record of it ---------------------------------
    //
    // AUTHORISE BEFORE DOING THE WORK, and claim-and-record as ONE transaction:
    // a spent authorisation must always be a recorded one, or the table cannot
    // answer the question it exists for. The two failure directions are not
    // symmetric — an upstream 502 after this point leaves a row for an export
    // that never shipped (the member asks for another link), whereas a key that
    // shipped with no row is precisely the silence being fixed.
    //
    // `typeof` rather than a truthiness check: `?token=a&token=b` arrives as an
    // ARRAY, and an array is not the string the claim is parameterised with —
    // the same trap the OAuth `bind` and `arrival` bounds document.
    // The hold comes before the claim, so a confirmation link pressed during
    // it is not spent (lib/email-change-hold.ts).
    const hold = await exportHold(writerId)
    if (hold) return reply.status(403).send(exportHeldBody(hold))

    const token = req.query.token
    if (typeof token !== 'string' || token.length === 0) {
      return reply.status(403).send({
        error: 'step_up_required',
        message: 'Please ask for a confirmation email first, then press the link in it.',
      })
    }

    let authorised = false
    try {
      await withTransaction(async (client) => {
        authorised = await claimStepUpToken(client, token, writerId, 'key_export')
        if (!authorised) return
        await client.query(
          `INSERT INTO account_key_exports (account_id, ip, user_agent)
           VALUES ($1, $2, $3)`,
          [writerId, req.ip, req.headers['user-agent'] ?? null]
        )
      })
    } catch (err) {
      logger.error({ err, writerId }, 'Key export authorisation failed')
      return reply.status(500).send({ error: "Couldn't export your data. Please try again." })
    }

    if (!authorised) {
      logger.warn({ writerId }, 'Key export refused: step-up token not valid')
      return reply.status(403).send({
        error: 'step_up_invalid',
        message: 'That confirmation link has expired or has already been used.',
      })
    }

    // =========================================================================
    // A FAMILY FAILS ALONE — AND THE FOUR QUERIES BELOW THE LINE WERE NOT
    // FAILING ALONE (§0ab item 5a).
    //
    // Rule (2) of the bundle: one query's failure must not answer 500 on a
    // member's right. Everything under "THE REST OF WHAT WE HOLD" further down
    // has run inside `family()` since §0z item 16 — but `family()` was declared
    // BENEATH those queries, so the four that come first (the articles, the
    // receipt whitelist, the reading log, the reading positions) sat outside
    // it, and a fault in any one of them reached the global error handler and
    // answered `internal_error` for the WHOLE bundle. The helper is declared
    // here instead, ahead of the first query it governs, which is the only
    // arrangement in which "each family fails alone" is a fact about the route
    // rather than about the half of it that happens to come last.
    //
    // THE TWO THINGS THAT STILL FAIL THE WHOLE EXPORT COME BETWEEN THEM, AND
    // THAT IS DELIBERATE: the content keys and the secret key each answer their
    // own 502, because a bundle without them is not the thing the member asked
    // for. A failed SELECT is not in that class and never was.
    // =========================================================================
    const EXPORT_ROW_CAP = 5000

    /** Families that could not be read. Named in the payload, never silent. */
    const incomplete: string[] = []

    /**
     * Families the CAP cut short. Rule (3) says a cap that is not declared is a
     * lie, and `notice.capPerList` alone does not say WHICH lists reached it —
     * a list at exactly its cap and a list that happens to be that long are the
     * same JSON. The cap is passed to `family()` by the caller that wrote the
     * `LIMIT`, so the declaration cannot drift from the bound it declares, and
     * a family added below cannot quietly skip it.
     */
    const truncated: string[] = []

    async function family<T>(
      name: string,
      run: () => Promise<T[]>,
      cap?: number,
    ): Promise<T[]> {
      try {
        const rows = await run()
        if (cap !== undefined && rows.length >= cap) truncated.push(name)
        return rows
      } catch (err) {
        logger.error({ err, writerId, family: name }, 'Account export: family failed')
        incomplete.push(name)
        return []
      }
    }

    // Fetch all published (non-deleted) articles for this writer — WITH THE
    // BODY. `content_free` is the free section as stored; `vault_keys
    // .ciphertext` is the paid one, and it is joined here rather than left to
    // the relay because a bundle that ships the key and not the box is not a
    // copy of anything. Decryptable offline: the nsec above opens the NIP-44
    // `encryptedKey` below, which opens this.
    //
    // LEFT JOIN, not JOIN: a public article has no vault row and an inner join
    // would silently drop every free piece the writer has published — the whole
    // export for most members.
    const articleRows = await family('articles', async () => (await pool.query<{
      id: string
      nostr_event_id: string
      nostr_d_tag: string
      title: string
      summary: string | null
      content_free: string | null
      access_mode: string
      price_pence: number | null
      // NULLABLE, and it has been all along: unpublishing an article NULLs it
      // rather than deleting the row. `a.published_at.toISOString()` on one of
      // those threw, and the throw is not local to the article — it took the
      // WHOLE export down with a 500, on the one route that exists to hand a
      // member their own data back. One unpublished draft and the bundle could
      // not be produced at all.
      published_at: Date | null
      vault_ciphertext: string | null
      vault_algorithm: string | null
    }>(
      `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.summary,
              a.content_free, a.access_mode, a.price_pence, a.published_at,
              v.ciphertext AS vault_ciphertext, v.algorithm AS vault_algorithm
       FROM articles a
       LEFT JOIN vault_keys v ON v.article_id = a.id
       WHERE a.writer_id = $1
         AND a.deleted_at IS NULL
       ORDER BY a.published_at DESC`,
      [writerId]
    )).rows)

    // Fetch receipt whitelist: distinct reader pubkeys per article for this writer
    // Only includes readers where the portable receipt was stored (reader_pubkey IS NOT NULL)
    const whitelistRows = await family('receiptWhitelist', async () => (await pool.query<{
      article_id: string
      reader_pubkeys: string[]
    }>(
      `SELECT article_id, array_agg(DISTINCT reader_pubkey) AS reader_pubkeys
       FROM read_events
       WHERE writer_id = $1
         AND reader_pubkey IS NOT NULL
       GROUP BY article_id`,
      [writerId]
    )).rows)

    const whitelistByArticle = new Map(
      whitelistRows.map(r => [r.article_id, r.reader_pubkeys])
    )

    // Fetch content keys from key-service (wrapped to writer's own pubkey)
    let contentKeys: ExportedKey[] = []
    let contentKeysSkipped: string[] = []
    try {
      const exported = await fetchExportedKeys(writerId, account.nostr_pubkey)
      contentKeys = exported.keys
      contentKeysSkipped = exported.skipped
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to export content keys from key-service')
      return reply.status(502).send({ error: "Couldn't fetch your keys. Please try again." })
    }

    // Fetch the writer's own Nostr secret key (the migration anchor). Fail the
    // whole export rather than ship a keyless "full account export" — the key is
    // the one thing the writer can't recover from anywhere else. An account with
    // no custodial keypair at all (legacy/edge rows: nostr_privkey_enc IS NULL)
    // is a distinct, permanent condition — report it as such rather than as a
    // retryable upstream 502 (key-custody returns an undifferentiated 500 for
    // both, so the precondition is checked here against the shared DB).
    if (!account.has_keypair) {
      logger.warn({ writerId }, 'Export refused: account has no custodial keypair')
      return reply.status(409).send({ error: 'This account has no key for us to export.' })
    }
    let secretKey: { privkeyHex: string; nsec: string }
    try {
      secretKey = await exportSecretKey(writerId, 'account')
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to export secret key from key-custody')
      return reply.status(502).send({ error: "Couldn't fetch your key. Please try again." })
    }

    // The reader half. Scoped to the caller like everything else here, and
    // capped: an unbounded export is a way to ask the database for an
    // arbitrarily large response, and the log is windowed by the retention
    // sweep anyway (`reading_log_retention_days`), so the cap is a backstop
    // rather than a policy. If it is ever hit the export says so rather than
    // silently shipping a truncated history as a complete one.
    const READING_EXPORT_CAP = 10000
    const readingLogRows = await family('readingLog', async () => (await pool.query<{
      post_id: string
      opened_at: Date
    }>(
      `SELECT post_id, opened_at
         FROM reading_log
        WHERE user_id = $1
        ORDER BY opened_at DESC
        LIMIT $2`,
      [writerId, READING_EXPORT_CAP]
    )).rows, READING_EXPORT_CAP)
    const readingPositionRows = await family('readingPositions', async () => (await pool.query<{
      post_id: string
      scroll_ratio: string | number
      updated_at: Date
    }>(
      `SELECT post_id, scroll_ratio, updated_at
         FROM reading_positions
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [writerId, READING_EXPORT_CAP]
    )).rows, READING_EXPORT_CAP)

    // =========================================================================
    // THE REST OF WHAT WE HOLD ABOUT THEM (L7.1; D8 §7)
    //
    // The bundle was an AUTHOR MIGRATION kit that had quietly acquired a
    // reading log. D8 §7 asks for something else — everything we hold about the
    // person asking — and what follows is that: what they wrote, what they
    // said in private, what they were charged, what was decided about them, and
    // every time we used their key.
    //
    // Three rules hold across all of it. **Every query is scoped to the
    // caller**, like everything else on this route. **Every list is capped and
    // says whether it was cut** — a truncated history that reads as a complete
    // one is the same failure as a truncated alert. **A family that fails does
    // not take the export with it**: this is a member's right, and answering a
    // 500 because one list would not load hands them nothing at all. Each
    // family below therefore reports its own shortfall and the bundle names
    // which ones are incomplete, rather than the loop aborting at the first
    // (the partial-outcome rule). The two things that DO fail the whole export
    // are the ones above — the key and the content keys — because a bundle
    // without them is not the thing the member asked for.
    // =========================================================================
    // `family()` itself is declared ABOVE the articles query — see §0ab item 5a
    // there for why it cannot live here.

    // Soft-deleted rows are deliberately OUT of every list here, as they
    // already are from the articles query above: on this platform a delete
    // publishes a kind-5 tombstone, so it is content the member has asked us to
    // withdraw and an archive that hands it back is not honouring the deletion.
    // The bundle says so rather than leaving it to be inferred from a gap.

    const notesRows = await family('notes', async () => {
      const r = await pool.query<{
        id: string
        nostr_event_id: string
        content: string
        published_at: Date
        reply_to_event_id: string | null
        quoted_event_id: string | null
      }>(
        `SELECT id, nostr_event_id, content, published_at,
                reply_to_event_id, quoted_event_id
           FROM notes
          WHERE author_id = $1
          ORDER BY published_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    const commentsRows = await family('comments', async () => {
      const r = await pool.query<{
        id: string
        nostr_event_id: string
        target_event_id: string
        target_kind: number
        parent_comment_id: string | null
        content: string
        published_at: Date
      }>(
        `SELECT id, nostr_event_id, target_event_id, target_kind,
                parent_comment_id, content, published_at
           FROM comments
          WHERE author_id = $1
            AND deleted_at IS NULL
          ORDER BY published_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    // ---- Direct messages ---------------------------------------------------
    //
    // The one family here that costs a key use. Each message is opened with the
    // member's own custodial key through key-custody, which writes a
    // `key_access_log` row per plaintext (L6.6) — the same record reading them
    // in the app leaves, and the member will find those rows further down this
    // same bundle.
    //
    // The counterparty's pubkey is derived HERE rather than taken from a
    // caller, unlike `/dm/decrypt-batch`, which is handed one by the browser:
    // the NIP-44 conversation key is a function of it, so a wrong one yields a
    // failed decrypt and never another conversation. `sender_id = $1 ? the
    // recipient : the sender` — the same expression `loadConversationMessages`
    // uses, for the same reason.
    const DM_EXPORT_CAP = 5000
    const dmRows = await family('messages', async () => {
      const r = await pool.query<{
        id: string
        conversation_id: string
        sender_id: string
        content_enc: string
        counterparty_pubkey: string | null
        counterparty_username: string | null
        created_at: Date
        read_at: Date | null
      }>(
        `SELECT dm.id, dm.conversation_id, dm.sender_id, dm.content_enc,
                CASE WHEN dm.sender_id = $1 THEN ra.nostr_pubkey ELSE sa.nostr_pubkey END
                  AS counterparty_pubkey,
                CASE WHEN dm.sender_id = $1 THEN ra.username ELSE sa.username END
                  AS counterparty_username,
                dm.created_at, dm.read_at
           FROM direct_messages dm
           JOIN accounts sa ON sa.id = dm.sender_id
           JOIN accounts ra ON ra.id = dm.recipient_id
          WHERE dm.sender_id = $1 OR dm.recipient_id = $1
          ORDER BY dm.created_at DESC
          LIMIT $2`,
        [writerId, DM_EXPORT_CAP]
      )
      return r.rows
    }, DM_EXPORT_CAP)

    // A message whose counterparty has no custodial pubkey cannot be opened,
    // and is passed to the decrypter as nothing rather than skipped silently:
    // it comes back with its own failure and stays in the archive as a dated
    // message the member can see we could not read back to them.
    const dmPlaintexts = new Map<string, string | null>()
    let dmUnreadable = 0
    if (dmRows.length > 0) {
      const decrypted = await family('messages', () =>
        decryptBatch(
          writerId,
          dmRows.map(m => ({
            id: m.id,
            counterpartyPubkey: m.counterparty_pubkey ?? '',
            ciphertext: m.content_enc,
          }))
        )
      )
      for (const d of decrypted) dmPlaintexts.set(d.id, d.plaintext)
      dmUnreadable = decrypted.filter(d => d.plaintext === null).length
    }

    // ---- Money -------------------------------------------------------------
    //
    // `amount_pence` is a `bigint` and node-postgres hands one over as a
    // STRING. It is passed through as one, deliberately: this route only
    // carries the number to the member, and `Number()`-ing it here would be a
    // coercion with nothing to gain and the whole bigint trap to lose
    // (money.md). The unit is in the field name.
    const ledgerRows = await family('ledger', async () => {
      const r = await pool.query<{
        id: string
        amount_pence: string
        currency: string
        trigger_type: string
        ref_table: string
        ref_id: string
        counterparty_id: string | null
        created_at: Date
      }>(
        `SELECT id, amount_pence, currency, trigger_type, ref_table, ref_id,
                counterparty_id, created_at
           FROM ledger_entries
          WHERE account_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    // ---- Moderation --------------------------------------------------------
    //
    // TWO QUERIES AND TWO DIFFERENT PROJECTIONS, because they are two different
    // disclosures. What a member FILED is their own words. What they were the
    // SUBJECT of is the decision and the sentence they were sent — and
    // deliberately not `reasoning` (the internal judgement D7 §8 requires us to
    // keep), not `reviewed_by` (a person, not a fact about the subject), and
    // not `snapshot` (on a report they filed it is somebody else's content).
    const reportsFiled = await family('moderationReportsFiled', async () => {
      const r = await pool.query<{
        id: string
        category: string
        notes: string | null
        status: string
        created_at: Date
      }>(
        `SELECT id, category, notes, status, created_at
           FROM moderation_reports
          WHERE reporter_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    // ALL THREE COLUMNS THAT CAN NAME THE MEMBER (§0ab item 5b). `subject_
    // account_id` is stamped at RESOLUTION, so on its own this family answered
    // "nothing" for every report still open — and `target_profile_id` is one of
    // the five target kinds migration 223 added, so a report filed about the
    // member's PROFILE was absent from their own bundle for its whole life and
    // then appeared. The coverage test pins tables by foreign key and cannot
    // see a missing column, which is why this needs saying here.
    const reportsAbout = await family('moderationReportsAbout', async () => {
      const r = await pool.query<{
        id: string
        category: string
        status: string
        action: string | null
        reason: string | null
        created_at: Date
        reviewed_at: Date | null
        appeal_deadline: Date | null
        appealed_at: Date | null
        appeal_text: string | null
        appeal_outcome: string | null
        appeal_decided_at: Date | null
      }>(
        `SELECT id, category, status, action, reason, created_at, reviewed_at,
                appeal_deadline, appealed_at, appeal_text, appeal_outcome,
                appeal_decided_at
           FROM moderation_reports
          WHERE subject_account_id = $1
             OR target_account_id = $1
             OR target_profile_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    // ---- Every time we used their key --------------------------------------
    //
    // L6.6's outstanding half. `actor_account_id` is WHO ASKED, and it is
    // reported as a boolean rather than a uuid: the only two answers are "you"
    // and "somebody here", the second is an operator acting under D7 §4, and an
    // internal staff id is not a fact about the member.
    const keyAccessRows = await family('keyAccessLog', async () => {
      const r = await pool.query<{
        purpose: string
        actor_was_self: boolean
        accessed_at: Date
      }>(
        `SELECT purpose, (actor_account_id = account_id) AS actor_was_self, accessed_at
           FROM key_access_log
          WHERE account_id = $1
          ORDER BY accessed_at DESC
          LIMIT $2`,
        [writerId, EXPORT_ROW_CAP]
      )
      return r.rows
    }, EXPORT_ROW_CAP)

    const contentKeysByArticleId = new Map(contentKeys.map(k => [k.articleId, k]))

    // Build articles list with key info merged in
    const articles = articleRows.map(a => {
      const keyInfo = contentKeysByArticleId.get(a.id)
      const readerPubkeys = whitelistByArticle.get(a.id) ?? []
      return {
        articleId: a.id,
        nostrEventId: a.nostr_event_id,
        dTag: a.nostr_d_tag,
        title: a.title,
        summary: a.summary,
        // The body, both halves. `contentFree` is plaintext markdown;
        // `vaultCiphertext` is the paid section, opened with `encryptedKey`
        // below under `vaultAlgorithm`.
        contentFree: a.content_free,
        ...(a.vault_ciphertext && {
          vaultCiphertext: a.vault_ciphertext,
          vaultAlgorithm: a.vault_algorithm,
        }),
        accessMode: a.access_mode,
        isPaywalled: a.access_mode === 'paywalled',
        pricePence: a.price_pence ?? 0,
        publishedAt: a.published_at?.toISOString() ?? null,
        // Content key info — present only for paywalled articles
        ...(keyInfo && {
          algorithm: keyInfo.algorithm,
          encryptedKey: keyInfo.encryptedKey,  // NIP-44 wrapped to writer's own pubkey
        }),
        // Reader pubkeys who have paid (for receipt whitelisting on another host)
        readerPubkeys,
      }
    })

    // =========================================================================
    // THE REST OF WHAT WE HOLD (§0z item 16). Rule (5) of the bundle claims
    // that what is withheld is withheld on purpose and NAMED; until today the
    // bundle carried eleven families and named none of the ~thirty other
    // account-keyed tables it left out. Every family below is one a member
    // would recognise as theirs; `WITHHELD` at the top of this file names the
    // rest, each with its reason, and `notice.withheld` carries that list.
    // Same discipline as above: scoped to the caller, capped, failing alone.
    // =========================================================================
    const cap = EXPORT_ROW_CAP
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
    const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

    const draftsRows = await family('drafts', async () =>
      (await pool.query<{ id: string; title: string | null; content_raw: string | null; price_pence: number | null; scheduled_at: Date | null; auto_saved_at: Date | null; created_at: Date }>(
        `SELECT id, title, content_raw, price_pence, scheduled_at, auto_saved_at, created_at
           FROM article_drafts WHERE writer_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const mediaRows = await family('media', async () =>
      (await pool.query<{ sha256: string; blossom_url: string; mime_type: string; size_bytes: number; uploaded_at: Date }>(
        `SELECT sha256, blossom_url, mime_type, size_bytes, uploaded_at
           FROM media_uploads WHERE uploader_id = $1 ORDER BY uploaded_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const libraryRows = await family('library', async () =>
      (await pool.query<{ article_id: string; title: string | null; read_at: Date; chargeable_pence: unknown; on_free_allowance: boolean; is_subscription_read: boolean; state: string }>(
        `SELECT re.article_id, a.title, re.read_at, re.chargeable_pence, re.on_free_allowance,
                re.is_subscription_read, re.state
           FROM read_events re LEFT JOIN articles a ON a.id = re.article_id
          WHERE re.reader_id = $1 ORDER BY re.read_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const keyExportRows = await family('keyExports', async () =>
      (await pool.query<{ exported_at: Date; ip: string | null; user_agent: string | null }>(
        `SELECT exported_at, ip, user_agent FROM account_key_exports WHERE account_id = $1 ORDER BY exported_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const emailChangeRows = await family('emailChanges', async () =>
      (await pool.query<{ old_email: string | null; new_email: string; changed_at: Date; undone_at: Date | null }>(
        `SELECT old_email, new_email, changed_at, undone_at FROM account_email_changes WHERE account_id = $1 ORDER BY changed_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const presenceRows = await family('presences', async () =>
      (await pool.query<{ protocol: string; external_id: string | null; handle: string | null; service_url: string | null; provenance: string | null; lifecycle_state: string | null; cross_post_default: boolean | null; show_on_profile: boolean | null; is_valid: boolean | null; created_at: Date }>(
        `SELECT protocol, external_id, handle, service_url, provenance, lifecycle_state,
                cross_post_default, show_on_profile, is_valid, created_at
           FROM network_presences WHERE account_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const notificationRows = await family('notifications', async () =>
      (await pool.query<{ type: string; read: boolean; created_at: Date }>(
        `SELECT type, read, created_at FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const notificationPrefRows = await family('notificationPreferences', async () =>
      (await pool.query<{ category: string; enabled: boolean }>(
        `SELECT category, enabled FROM notification_preferences WHERE user_id = $1 LIMIT $2`, [writerId, cap])).rows, cap)
    const voteRows = await family('votes', async () =>
      (await pool.query<{ target_nostr_event_id: string; direction: string; created_at: Date }>(
        `SELECT target_nostr_event_id, direction, created_at FROM votes WHERE voter_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const followingRows = await family('following', async () =>
      (await pool.query<{ username: string | null; followed_at: Date }>(
        `SELECT a.username, f.followed_at FROM follows f JOIN accounts a ON a.id = f.followee_id
          WHERE f.follower_id = $1 ORDER BY f.followed_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const blockRows = await family('blocks', async () =>
      (await pool.query<{ username: string | null; blocked_at: Date }>(
        `SELECT a.username, b.blocked_at FROM blocks b JOIN accounts a ON a.id = b.blocked_id
          WHERE b.blocker_id = $1 ORDER BY b.blocked_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const muteRows = await family('mutes', async () =>
      (await pool.query<{ username: string | null; muted_at: Date }>(
        `SELECT a.username, m.muted_at FROM mutes m JOIN accounts a ON a.id = m.muted_id
          WHERE m.muter_id = $1 ORDER BY m.muted_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const feedRows = await family('feeds', async () =>
      (await pool.query<{ id: string; name: string | null; created_at: Date; hidden: boolean; origin_label: string | null }>(
        `SELECT id, name, created_at, hidden, origin_label FROM feeds WHERE owner_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    // THE CAP IS PER FEED, BECAUSE THE PARTITION IS (§0ab item 5c) — see
    // `EXPORT_FEED_SOURCES_SQL` at the top of this file.
    const feedSourceRows = await family('feedSources', async () =>
      (await pool.query<FeedSourceExportRow>(EXPORT_FEED_SOURCES_SQL, [writerId, cap])).rows)
    // Its cut is per feed, so `rows.length` is the wrong question — a member
    // with one capped feed among ten is cut, and the sum says nothing.
    {
      const perFeed = new Map<string, number>()
      for (const r of feedSourceRows) perFeed.set(r.feed_id, (perFeed.get(r.feed_id) ?? 0) + 1)
      if ([...perFeed.values()].some(n => n >= cap)) truncated.push('feedSources')
    }
    const formulaRows = await family('formulas', async () =>
      (await pool.query<{ name: string; description: string | null; visibility: string | null; kind: string | null; is_default_seed: boolean; created_at: Date; revoked_at: Date | null }>(
        `SELECT name, description, visibility, kind, is_default_seed, created_at, revoked_at
           FROM feed_formulas WHERE author_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const externalSubRows = await family('externalSubscriptions', async () =>
      (await pool.query<{ protocol: string; source_uri: string; name: string | null; created_at: Date }>(
        `SELECT es.protocol::text AS protocol, es.source_uri, es.display_name AS name, x.created_at
           FROM external_subscriptions x JOIN external_sources es ON es.id = x.source_id
          WHERE x.subscriber_id = $1 ORDER BY x.created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const followImportRows = await family('followImports', async () =>
      (await pool.query<{ protocol: string; origin_identity: string | null; kind: string | null; status: string; total: number | null; imported: number | null; skipped: number | null; failed: number | null; removed: number | null; created_at: Date; finished_at: Date | null }>(
        `SELECT protocol, origin_identity, kind, status, total, imported, skipped, failed, removed, created_at, finished_at
           FROM follow_imports WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const outboundRows = await family('outboundPosts', async () =>
      (await pool.query<{ protocol: string; action_type: string; body_text: string | null; external_post_uri: string | null; status: string; created_at: Date; sent_at: Date | null }>(
        `SELECT protocol, action_type, body_text, external_post_uri, status, created_at, sent_at
           FROM outbound_posts WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const elsewhereRows = await family('postsElsewhere', async () =>
      (await pool.query<{ protocol: string; source_item_uri: string; canonical_url: string | null; content_text: string | null; source_reply_uri: string | null; source_quote_uri: string | null; published_at: Date; fetched_at: Date }>(
        EXPORT_POSTS_ELSEWHERE_SQL, [writerId, cap])).rows, cap)
    const identityLinkRows = await family('identityLinks', async () =>
      (await pool.query<{ link_type: string; confidence: unknown; created_at: Date }>(
        `SELECT link_type, confidence, created_at FROM external_identity_links WHERE owner_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const subsAsReaderRows = await family('subscriptions', async () =>
      (await pool.query<{ writer_username: string | null; publication_name: string | null; price_pence: number; status: string; subscription_period: string | null; started_at: Date | null; current_period_start: Date | null; current_period_end: Date | null; cancelled_at: Date | null; auto_renew: boolean; is_comp: boolean; hidden: boolean; notify_on_publish: boolean }>(
        `SELECT w.username AS writer_username, p.name AS publication_name, s.price_pence, s.status,
                s.subscription_period, s.started_at, s.current_period_start, s.current_period_end,
                s.cancelled_at, s.auto_renew, s.is_comp, s.hidden, s.notify_on_publish
           FROM subscriptions s LEFT JOIN accounts w ON w.id = s.writer_id
           LEFT JOIN publications p ON p.id = s.publication_id
          WHERE s.reader_id = $1 ORDER BY s.created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const subscriberRows = await family('subscribers', async () =>
      // The names the subscribers route already shows the writer (Privacy 3.2
      // names subscribers as the one list a writer sees); a subscription the
      // reader HID stays hidden here too.
      (await pool.query<{ username: string | null; status: string; started_at: Date | null }>(
        `SELECT r.username, s.status, s.started_at FROM subscriptions s JOIN accounts r ON r.id = s.reader_id
          WHERE s.writer_id = $1 AND s.hidden = FALSE ORDER BY s.created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const offerRows = await family('subscriptionOffers', async () =>
      (await pool.query<{ label: string | null; mode: string; discount_pct: number; duration_months: number | null; code: string | null; max_redemptions: number | null; redemption_count: number; expires_at: Date | null; revoked_at: Date | null; created_at: Date; is_comp: boolean }>(
        `SELECT label, mode, discount_pct, duration_months, code, max_redemptions, redemption_count,
                expires_at, revoked_at, created_at, is_comp
           FROM subscription_offers WHERE writer_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const giftLinkRows = await family('giftLinks', async () =>
      (await pool.query<{ article_id: string; max_redemptions: number | null; redemption_count: number; revoked_at: Date | null; expires_at: Date | null; created_at: Date }>(
        `SELECT article_id, max_redemptions, redemption_count, revoked_at, expires_at, created_at
           FROM gift_links WHERE creator_id = $1 ORDER BY created_at LIMIT $2`, [writerId, cap])).rows, cap)
    const tabRows = await family('tab', async () =>
      (await pool.query<{ balance_pence: unknown; last_read_at: Date | null; last_settled_at: Date | null; created_at: Date }>(
        `SELECT balance_pence, last_read_at, last_settled_at, created_at FROM reading_tabs WHERE reader_id = $1`, [writerId])).rows)
    const settlementRows = await family('settlements', async () =>
      (await pool.query<{ id: string; amount_pence: unknown; trigger_type: string; status: string; settled_at: Date; reversed_at: Date | null; reversal_reason: string | null; failure_reason: string | null }>(
        `SELECT id, amount_pence, trigger_type, status, settled_at, reversed_at, reversal_reason, failure_reason
           FROM tab_settlements WHERE reader_id = $1 ORDER BY settled_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const creditRows = await family('credits', async () =>
      (await pool.query<{ amount_pence: unknown; status: string; created_at: Date; resolved_at: Date | null; refund_reserved_at: Date | null; refund_reason: string | null }>(
        `SELECT amount_pence, status, created_at, resolved_at, refund_reserved_at, refund_reason
           FROM reader_credits WHERE reader_id = $1 ORDER BY created_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const payoutRows = await family('payouts', async () =>
      (await pool.query<{ amount_pence: unknown; status: string; triggered_at: Date | null; completed_at: Date | null; failed_reason: string | null }>(
        `SELECT amount_pence, status, triggered_at, completed_at, failed_reason
           FROM writer_payouts WHERE writer_id = $1 ORDER BY triggered_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const unlockRows = await family('unlocks', async () =>
      (await pool.query<{ article_id: string; unlocked_via: string | null; unlocked_at: Date; is_provisional: boolean | null }>(
        `SELECT article_id, unlocked_via, unlocked_at, is_provisional FROM article_unlocks WHERE reader_id = $1 ORDER BY unlocked_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const issuanceRows = await family('keyIssuances', async () =>
      (await pool.query<{ article_id: string; issued_at: Date; is_reissuance: boolean | null }>(
        `SELECT article_id, issued_at, is_reissuance FROM content_key_issuances WHERE reader_id = $1 ORDER BY issued_at DESC LIMIT $2`, [writerId, cap])).rows, cap)
    const waitlistRows = await family('waitlist', async () =>
      (await pool.query<{ email: string; publish_interest: unknown; created_at: Date; admitted_at: Date | null }>(
        `SELECT email, publish_interest, created_at, admitted_at FROM waitlist WHERE admitted_account_id = $1 LIMIT 5`, [writerId])).rows)
    // One row per account (the key), so no cap to state.
    const writerApplicationRows = await family('writerApplication', async () =>
      (await pool.query<{ created_at: Date; admitted_at: Date | null }>(
        `SELECT created_at, admitted_at FROM writer_applications WHERE account_id = $1`, [writerId])).rows)

    logger.info(
      {
        writerId,
        articleCount: articles.length,
        keyCount: contentKeys.length,
        keysSkipped: contentKeysSkipped.length,
        readingLogEntries: readingLogRows.length,
        noteCount: notesRows.length,
        commentCount: commentsRows.length,
        messageCount: dmRows.length,
        ledgerCount: ledgerRows.length,
        incomplete,
      },
      'Account export'
    )

    // TELL THE OWNER, UNCONDITIONALLY, AND ON THE EXPORT — not on the request.
    // An attacker holding the session may hold the inbox too, which is why this
    // is not a control; it is what turns a silent theft into a dated event the
    // member can point at, and it is the part of §2.6 that matters most.
    //
    // Best-effort by design: the row is already committed, so a send that fails
    // costs the notice and not the record — and the export itself must never
    // fail over a notice about it, because the export is a member's right.
    if (account.email) {
      void sendKeyExportNoticeEmail(account.email, new Date()).catch((err: unknown) => {
        logger.error({ err, writerId }, 'Failed to send key-export notice email')
      })
    }

    return reply.status(200).send({
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        nostrPubkey: account.nostr_pubkey,
        nostrPrivkeyHex: secretKey.privkeyHex,
        nostrPrivkeyNsec: secretKey.nsec,
        username: account.username,
        displayName: account.display_name,
        email: account.email,
        status: account.status,
        createdAt: account.created_at.toISOString(),
        // The declaration, not a verification (L6.1). A `date` column comes
        // back as a Date in this driver and as a string in none of the paths
        // that matter, so it is normalised to the ISO day rather than an
        // instant — a birthday is not a moment and a timezone would move it.
        dateOfBirth:
          account.date_of_birth === null
            ? null
            : String(
                account.date_of_birth instanceof Date
                  ? account.date_of_birth.toISOString().slice(0, 10)
                  : account.date_of_birth
              ),
        ageDeclaredAt: account.age_declared_at?.toISOString() ?? null,
        // The two acceptances (migration 204): the text and the day.
        terms: {
          reader: { version: account.reader_terms_version, acceptedAt: iso(account.reader_terms_accepted_at) },
          writer: { version: account.writer_terms_version, acceptedAt: iso(account.writer_terms_accepted_at) },
        },
        // What we held before there was an account: the waiting-list row.
        waitlist: waitlistRows.map(w => ({ email: w.email, publishInterest: w.publish_interest ?? null, joinedAt: iso(w.created_at), admittedAt: iso(w.admitted_at) })),
        // Writer access (READER-WRITER-SPLIT-ADR): when it was granted, and the
        // request to write if they made one. Who granted it is the operator's
        // record, not theirs.
        writerAccess: {
          admittedAt: iso(account.writer_admitted_at),
          application: writerApplicationRows[0]
            ? { appliedAt: iso(writerApplicationRows[0].created_at), admittedAt: iso(writerApplicationRows[0].admitted_at) }
            : null,
        },
      },
      articles,
      drafts: draftsRows.map(d => ({ id: d.id, title: d.title, contentRaw: d.content_raw, pricePence: d.price_pence, scheduledAt: iso(d.scheduled_at), autoSavedAt: iso(d.auto_saved_at), createdAt: iso(d.created_at) })),
      media: mediaRows.map(m => ({ sha256: m.sha256, url: m.blossom_url, mimeType: m.mime_type, sizeBytes: m.size_bytes, uploadedAt: iso(m.uploaded_at) })),
      // Every read a read_event exists for — the all.haus library — as the
      // reader's own record; the money side of each is in `ledger`.
      library: libraryRows.map(r => ({ articleId: r.article_id, title: r.title, readAt: iso(r.read_at), chargeablePence: num(r.chargeable_pence), onFreeAllowance: r.on_free_allowance, viaSubscription: r.is_subscription_read, state: r.state })),
      keyExports: keyExportRows.map(k => ({ at: iso(k.exported_at), ip: k.ip, userAgent: k.user_agent })),
      emailChanges: emailChangeRows.map(c => ({ from: c.old_email, to: c.new_email, at: iso(c.changed_at), undoneAt: iso(c.undone_at) })),
      // Linked networks: the identity and both consents, never the credential.
      presences: presenceRows.map(p => ({ protocol: p.protocol, externalId: p.external_id, handle: p.handle, serviceUrl: p.service_url, provenance: p.provenance, lifecycleState: p.lifecycle_state, crossPostDefault: p.cross_post_default, showOnProfile: p.show_on_profile, isValid: p.is_valid, createdAt: iso(p.created_at) })),
      notifications: notificationRows.map(n => ({ type: n.type, read: n.read, at: iso(n.created_at) })),
      notificationPreferences: notificationPrefRows.map(n => ({ category: n.category, enabled: n.enabled })),
      votes: voteRows.map(v => ({ targetEventId: v.target_nostr_event_id, direction: v.direction, at: iso(v.created_at) })),
      following: followingRows.map(f => ({ username: f.username, since: iso(f.followed_at) })),
      blocks: blockRows.map(b => ({ username: b.username, since: iso(b.blocked_at) })),
      mutes: muteRows.map(m => ({ username: m.username, since: iso(m.muted_at) })),
      feeds: feedRows.map(f => ({
        id: f.id, name: f.name, hidden: f.hidden, originLabel: f.origin_label, createdAt: iso(f.created_at),
        sources: feedSourceRows.filter(s => s.feed_id === f.id).map(s => ({ sourceType: s.source_type, accountUsername: s.account_username, publicationId: s.publication_id, externalProtocol: s.external_protocol, externalUri: s.external_uri, tag: s.tag_name, throughput: num(s.throughput), samplingMode: s.sampling_mode, mutedAt: iso(s.muted_at), excludeReplies: s.exclude_replies })),
      })),
      formulas: formulaRows.map(f => ({ name: f.name, description: f.description, visibility: f.visibility, kind: f.kind, isDefaultSeed: f.is_default_seed, createdAt: iso(f.created_at), revokedAt: iso(f.revoked_at) })),
      externalSubscriptions: externalSubRows.map(x => ({ protocol: x.protocol, sourceUri: x.source_uri, name: x.name, since: iso(x.created_at) })),
      followImports: followImportRows.map(f => ({ protocol: f.protocol, originIdentity: f.origin_identity, kind: f.kind, status: f.status, total: f.total, imported: f.imported, skipped: f.skipped, failed: f.failed, removed: f.removed, startedAt: iso(f.created_at), finishedAt: iso(f.finished_at) })),
      outboundPosts: outboundRows.map(o => ({ protocol: o.protocol, action: o.action_type, body: o.body_text, externalUri: o.external_post_uri, status: o.status, createdAt: iso(o.created_at), sentAt: iso(o.sent_at) })),
      // What you posted on your linked networks that we hold and attribute to
      // you — see EXPORT_POSTS_ELSEWHERE_SQL.
      postsElsewhere: elsewhereRows.map(e => ({ protocol: e.protocol, uri: e.source_item_uri, url: e.canonical_url, text: e.content_text, replyTo: e.source_reply_uri, quotes: e.source_quote_uri, publishedAt: iso(e.published_at), fetchedAt: iso(e.fetched_at) })),
      identityLinks: identityLinkRows.map(l => ({ linkType: l.link_type, confidence: num(l.confidence), at: iso(l.created_at) })),
      subscriptions: {
        asReader: subsAsReaderRows.map(s => ({ writer: s.writer_username, publication: s.publication_name, pricePence: num(s.price_pence), status: s.status, period: s.subscription_period, startedAt: iso(s.started_at), currentPeriodStart: iso(s.current_period_start), currentPeriodEnd: iso(s.current_period_end), cancelledAt: iso(s.cancelled_at), autoRenew: s.auto_renew, isComp: s.is_comp, hiddenFromWriter: s.hidden, notifyOnPublish: s.notify_on_publish })),
        subscribers: subscriberRows.map(s => ({ username: s.username, status: s.status, since: iso(s.started_at) })),
        offers: offerRows.map(o => ({ label: o.label, mode: o.mode, discountPct: o.discount_pct, durationMonths: o.duration_months, code: o.code, maxRedemptions: o.max_redemptions, redemptionCount: o.redemption_count, expiresAt: iso(o.expires_at), revokedAt: iso(o.revoked_at), createdAt: iso(o.created_at), isComp: o.is_comp })),
      },
      giftLinks: giftLinkRows.map(g => ({ articleId: g.article_id, maxRedemptions: g.max_redemptions, redemptionCount: g.redemption_count, revokedAt: iso(g.revoked_at), expiresAt: iso(g.expires_at), createdAt: iso(g.created_at) })),
      money: {
        tab: tabRows[0] ? { balancePence: num(tabRows[0].balance_pence), lastReadAt: iso(tabRows[0].last_read_at), lastSettledAt: iso(tabRows[0].last_settled_at), openedAt: iso(tabRows[0].created_at) } : null,
        settlements: settlementRows.map(s => ({ id: s.id, amountPence: num(s.amount_pence), trigger: s.trigger_type, status: s.status, settledAt: iso(s.settled_at), reversedAt: iso(s.reversed_at), reversalReason: s.reversal_reason, failureReason: s.failure_reason })),
        credits: creditRows.map(c => ({ amountPence: num(c.amount_pence), status: c.status, createdAt: iso(c.created_at), resolvedAt: iso(c.resolved_at), refundReservedAt: iso(c.refund_reserved_at), refundReason: c.refund_reason })),
        payouts: payoutRows.map(p => ({ amountPence: num(p.amount_pence), status: p.status, triggeredAt: iso(p.triggered_at), completedAt: iso(p.completed_at), failedReason: p.failed_reason })),
        unlocks: unlockRows.map(u => ({ articleId: u.article_id, via: u.unlocked_via, at: iso(u.unlocked_at), provisional: u.is_provisional })),
        keyIssuances: issuanceRows.map(k => ({ articleId: k.article_id, at: iso(k.issued_at), reissuance: k.is_reissuance })),
      },
      notes: notesRows.map(n => ({
        id: n.id,
        nostrEventId: n.nostr_event_id,
        content: n.content,
        publishedAt: n.published_at.toISOString(),
        replyToEventId: n.reply_to_event_id,
        quotedEventId: n.quoted_event_id,
      })),
      comments: commentsRows.map(c => ({
        id: c.id,
        nostrEventId: c.nostr_event_id,
        targetEventId: c.target_event_id,
        targetKind: c.target_kind,
        parentCommentId: c.parent_comment_id,
        content: c.content,
        publishedAt: c.published_at.toISOString(),
      })),
      messages: {
        items: dmRows.map(m => ({
          id: m.id,
          conversationId: m.conversation_id,
          direction: m.sender_id === writerId ? 'sent' : 'received',
          counterparty: m.counterparty_username,
          // null means we could not open it, and it says so beside the date
          // rather than arriving as an empty string that reads as a blank
          // message the member sent.
          content: dmPlaintexts.get(m.id) ?? null,
          sentAt: m.created_at.toISOString(),
          readAt: m.read_at?.toISOString() ?? null,
        })),
        unreadable: dmUnreadable,
        truncated: truncated.includes('messages'),
        note: 'Opened with your own key. Each one is recorded in keyAccessLog below.',
      },
      ledger: ledgerRows.map(l => ({
        id: l.id,
        // A STRING, and a bigint's (money.md). Pence, as the name says.
        amountPence: l.amount_pence,
        currency: l.currency,
        triggerType: l.trigger_type,
        refTable: l.ref_table,
        refId: l.ref_id,
        counterpartyId: l.counterparty_id,
        createdAt: l.created_at.toISOString(),
      })),
      moderation: {
        filedByYou: reportsFiled.map(r => ({
          id: r.id,
          category: r.category,
          yourNotes: r.notes,
          status: r.status,
          filedAt: r.created_at.toISOString(),
        })),
        aboutYou: reportsAbout.map(r => ({
          id: r.id,
          category: r.category,
          status: r.status,
          action: r.action,
          reasonSentToYou: r.reason,
          filedAt: r.created_at.toISOString(),
          decidedAt: r.reviewed_at?.toISOString() ?? null,
          appealDeadline: r.appeal_deadline?.toISOString() ?? null,
          appealedAt: r.appealed_at?.toISOString() ?? null,
          yourAppeal: r.appeal_text,
          appealOutcome: r.appeal_outcome,
          appealDecidedAt: r.appeal_decided_at?.toISOString() ?? null,
        })),
      },
      keyAccessLog: keyAccessRows.map(k => ({
        purpose: k.purpose,
        askedByYou: k.actor_was_self,
        at: k.accessed_at.toISOString(),
      })),
      // The reader's own two logs (§6). `post_id` is the unified key spanning
      // both id-spaces, so one list covers native and external alike.
      reading: {
        log: readingLogRows.map(r => ({
          postId: r.post_id,
          openedAt: r.opened_at.toISOString(),
        })),
        positions: readingPositionRows.map(r => ({
          postId: r.post_id,
          scrollRatio: Number(r.scroll_ratio),
          updatedAt: r.updated_at.toISOString(),
        })),
        // Said in the payload rather than left to be inferred from a round
        // number: a capped history that reads as a complete one is the same
        // failure class as a truncated alert payload. Read off the one home
        // rather than recomputed, so this section and `notice.truncated`
        // cannot disagree about the same two lists.
        truncated:
          truncated.includes('readingLog') || truncated.includes('readingPositions'),
        retentionNote:
          'Recent reading is kept for a limited window and swept; this is what remains, not everything ever opened.',
      },
      // Summary counts for quick validation
      summary: {
        totalArticles: articles.length,
        paywallArticles: articles.filter(a => a.isPaywalled).length,
        contentKeysExported: contentKeys.length,
        uniqueReaders: new Set(articles.flatMap(a => a.readerPubkeys)).size,
        readingLogEntries: readingLogRows.length,
        readingPositions: readingPositionRows.length,
        notes: notesRows.length,
        comments: commentsRows.length,
        messages: dmRows.length,
        ledgerEntries: ledgerRows.length,
        moderationReportsFiled: reportsFiled.length,
        moderationReportsAboutYou: reportsAbout.length,
        keyAccessEntries: keyAccessRows.length,
      },
      // WHAT IS NOT IN HERE, SAID OUT LOUD.
      //
      // `incomplete` names any family whose query failed — an empty list and a
      // list we could not read are the same JSON otherwise, and the second one
      // must not read as "you have none of these". The deletion note is the
      // other silent gap: a soft-deleted post has had a kind-5 tombstone
      // published and is deliberately withheld, which is a choice and not an
      // omission.
      notice: {
        incomplete,
        // WHICH lists the cap cut, not just what the cap is. `capPerList`
        // states the bound; this states who met it, which is the half a member
        // reading their own bundle actually needs (§0ab item 5c).
        truncated,
        // Paywalled articles whose content key could not be opened. The
        // article is still in the bundle; its paid half cannot be read without
        // the key, and a missing `encryptedKey` must not read as "free".
        contentKeysUnavailable: contentKeysSkipped,
        deletedContent:
          'Posts you deleted are not included: deleting publishes a withdrawal notice to the network, and this archive is what is still live.',
        capPerList: EXPORT_ROW_CAP,
        // Every account-keyed table this bundle does NOT carry, and why —
        // rule (5)'s own sentence, kept true by
        // `tests/account-export-coverage.test.ts` against schema.sql's own
        // foreign keys.
        withheld: WITHHELD,
      },
    })
  })
}
