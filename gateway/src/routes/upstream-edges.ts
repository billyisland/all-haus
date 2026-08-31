import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from 'fastify'
import { randomUUID, createHash } from 'node:crypto'
import { nip19 } from 'nostr-tools'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { applyLedgerDelta } from '@platform-pub/shared/lib/ledger.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import { upstreamEdgesEnabled } from '@platform-pub/shared/lib/env.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { signEvent } from '../lib/key-custody-client.js'
import { resolve as resolveIdentity } from '../lib/resolver.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Upstream Edges — Phase 1 (credit / citation / dispute)
//
// Spec: docs/adr/UPSTREAM-EDGES-ADR.md, docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md.
//
// Three directed edges from a piece to a source, each marking a different kind
// of debt, plus the dispute counter-edge:
//
//   POST   /credits                  — author acknowledges a debt (no money, no consent)
//   POST   /citations                — author pins a faithfulness claim to source bytes
//   POST   /disputes                 — the source rejects a credit (disclaimer) or citation
//   DELETE /disputes/:id             — withdraw a dispute (refunds any stake)
//   GET    /articles/:id/credits     — credits + disclaimers for a piece
//   GET    /articles/:id/citations   — citations + dispute counts for a piece
//
// The ONLY money in Phase 1 is the third-party disputant's refundable stake: a
// −amount debit on their reading_tabs.balance_pence (same shape as a
// vote_charge), refunded as a +amount credit on withdrawal. The cited/credited
// party stakes nothing (is_by_cited_author). Native/Nostr citations + disputes
// are addressable kind events enqueued through the relay outbox in-txn; other
// sources are Postgres-only.
// =============================================================================

const HEX_64 = /^[0-9a-f]{64}$/i

// Addressable (NIP-33) app-specific kinds for the in-house relay. Distinct from
// the pledge-drive kind 30078; corrected in place via the d-tag = edge id.
const CITATION_EVENT_KIND = 30100
const DISPUTE_EVENT_KIND = 30101

// Anti-spam friction for a third-party dispute. Refundable on withdrawal, never
// forfeited (ADR Decision 11). Collected at the disputant's next settlement.
const DISPUTE_STAKE_PENCE = 500

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

// Normalise an npub/nprofile/hex identifier to a 64-char hex pubkey, else null.
export function toHexPubkey(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  if (HEX_64.test(v)) return v.toLowerCase()
  if (v.startsWith('npub1') || v.startsWith('nprofile1')) {
    try {
      const decoded = nip19.decode(v)
      if (decoded.type === 'npub') return decoded.data
      if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey
    } catch {
      return null
    }
  }
  return null
}

// A resolved target, normalised into the edge-table target grammar:
// NULL protocol = native (resolved account or unaddressable display name);
// non-NULL protocol = that external network.
export interface ResolvedTarget {
  protocol: string | null              // external_protocol enum value, or null = native
  externalId: string | null            // hex pubkey / DID / actor URI / feed URL
  displayName: string | null
  accountId: string | null             // native member match
  accountPubkey: string | null         // native member's nostr_pubkey (for citation p-tag)
}

// Resolve an omnivorous identifier (username / npub / DID / handle / URL / …)
// to a target, using only the resolver's synchronous Phase-A matches (no
// initiatorId ⇒ no async network chains). An identifier that resolves to
// nothing concrete becomes an UNADDRESSABLE native target whose display name is
// the raw string — a legitimate credit ("Aristotle", a book, a whole tradition).
export async function resolveTarget(raw: string): Promise<ResolvedTarget> {
  const result = await resolveIdentity(raw, 'general')
  const matches = result.matches ?? []

  // Prefer an exact native account, then an exact external source.
  const native =
    matches.find((m) => m.type === 'native_account' && m.confidence === 'exact') ??
    matches.find((m) => m.type === 'native_account')
  if (native?.account) {
    const { rows } = await pool.query<{ nostr_pubkey: string }>(
      `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
      [native.account.id],
    )
    return {
      protocol: null,
      externalId: null,
      displayName: native.account.displayName ?? null,
      accountId: native.account.id,
      accountPubkey: rows[0]?.nostr_pubkey ?? null,
    }
  }

  const external =
    matches.find((m) => m.type === 'external_source' && m.confidence === 'exact') ??
    matches.find((m) => m.type === 'external_source')
  if (external?.externalSource) {
    return {
      protocol: external.externalSource.protocol,
      externalId: external.externalSource.sourceUri,
      displayName: external.externalSource.displayName ?? null,
      accountId: null,
      accountPubkey: null,
    }
  }

  const rss = matches.find((m) => m.type === 'rss_feed')
  if (rss?.rssFeed) {
    return {
      protocol: 'rss',
      externalId: rss.rssFeed.feedUrl,
      displayName: rss.rssFeed.title ?? null,
      accountId: null,
      accountPubkey: null,
    }
  }

  // Unaddressable: keep the raw string as the display-name label.
  return { protocol: null, externalId: null, displayName: raw.trim(), accountId: null, accountPubkey: null }
}

// Confirm the session user owns the (non-deleted) article and return its Nostr
// coordinate so a signed edge event can reference the citing piece.
async function loadOwnedArticle(
  articleId: string,
  writerId: string,
): Promise<{ nostrDTag: string; writerPubkey: string } | null> {
  const { rows } = await pool.query<{ nostr_d_tag: string; nostr_pubkey: string }>(
    `SELECT a.nostr_d_tag, acc.nostr_pubkey
       FROM articles a
       JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.id = $1 AND a.writer_id = $2 AND a.deleted_at IS NULL`,
    [articleId, writerId],
  )
  if (rows.length === 0) return null
  return { nostrDTag: rows[0].nostr_d_tag, writerPubkey: rows[0].nostr_pubkey }
}

const CreditSchema = z.object({
  articleId: z.string().regex(UUID_RE),
  target: z.string().min(1).max(500),
  note: z.string().max(2000).optional(),
})

const CitationSchema = z.object({
  articleId: z.string().regex(UUID_RE),
  source: z.string().min(1).max(500),
  excerpt: z.string().min(1).max(10000),
  characterisation: z.string().min(1).max(2000),
  charStart: z.number().int().min(0).optional(),
  charEnd: z.number().int().min(0).optional(),
  sourceUri: z.string().max(2000).optional(),
  sourceEventId: z.string().max(200).optional(),
  sourceDTag: z.string().max(500).optional(),
})

const DisputeSchema = z
  .object({
    citationEdgeId: z.string().regex(UUID_RE).optional(),
    creditEdgeId: z.string().regex(UUID_RE).optional(),
    counterCharacterisation: z.string().min(1).max(2000),
    widerExcerpt: z.string().max(10000).optional(),
  })
  .refine((d) => (d.citationEdgeId == null) !== (d.creditEdgeId == null), {
    message: 'Exactly one of citationEdgeId or creditEdgeId is required',
  })

export async function upstreamEdgeRoutes(app: FastifyInstance) {
  // Every route 404s while the apparatus is dark (UPSTREAM_EDGES_ENABLED —
  // suspended 2026-08-25 with the tribute system by operator directive; see
  // env.ts). Same shape as tributeRoutes. The resolveTarget export below is a
  // plain function import (tributes.ts) and is unaffected by this gate.
  app.addHook('preHandler', async (_req, reply) => {
    if (!upstreamEdgesEnabled()) {
      return reply.status(404).send({ error: 'Not found' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /credits — author acknowledges a debt. Piece-level, no money, no consent.
  // ---------------------------------------------------------------------------
  app.post('/credits', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub
    const parsed = CreditSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { articleId, target, note } = parsed.data

    const article = await loadOwnedArticle(articleId, writerId)
    if (!article) {
      return reply.status(404).send({ error: 'Article not found or not yours' })
    }

    const t = await resolveTarget(target)

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO credit_edges
         (article_id, target_protocol, target_external_id, target_display_name,
          resolved_account_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [articleId, t.protocol, t.externalId, t.displayName, t.accountId, note ?? null],
    )

    logger.info({ creditId: rows[0].id, articleId, writerId }, 'Credit edge created')
    return reply.status(201).send({ id: rows[0].id })
  })

  // ---------------------------------------------------------------------------
  // POST /citations — author pins "X argues Y" to source bytes (excerpt + hash).
  // ---------------------------------------------------------------------------
  app.post('/citations', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub
    const parsed = CitationSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const data = parsed.data

    const article = await loadOwnedArticle(data.articleId, writerId)
    if (!article) {
      return reply.status(404).send({ error: 'Article not found or not yours' })
    }

    const t = await resolveTarget(data.source)

    // Map the resolved target onto the citation source columns. NULL protocol
    // with a member match is a native source (synthesise the 30023 coordinate);
    // nostr_external is a relay-free Nostr source; other protocols are web/ingested.
    let sourceProtocol: string | null = t.protocol
    let sourceAuthorPubkey: string | null = null
    let sourceNaddr: string | null = null
    let sourceUri: string | null = data.sourceUri ?? null
    const nostrEventId: string | null = data.sourceEventId ?? null

    if (t.protocol === null && t.accountId) {
      // Native all.haus source.
      sourceProtocol = null
      sourceAuthorPubkey = t.accountPubkey
      if (sourceAuthorPubkey && data.sourceDTag) {
        sourceNaddr = `30023:${sourceAuthorPubkey}:${data.sourceDTag}`
      }
    } else if (t.protocol === 'nostr_external') {
      sourceProtocol = 'nostr_external'
      sourceAuthorPubkey = toHexPubkey(t.externalId)
    } else if (t.protocol) {
      // atproto / activitypub / rss / email — web/ingested source.
      sourceUri = sourceUri ?? t.externalId
    } else {
      // Unaddressable source — carry the URI/label only.
      sourceUri = sourceUri ?? t.externalId
    }

    const citationId = randomUUID()
    const excerptHash = sha256(data.excerpt)

    // Native/Nostr citations are signed addressable events (sign OUTSIDE the
    // txn; the d-tag is the pre-generated edge id), p-tagging the cited author.
    let signed: SignedNostrEvent | null = null
    if (sourceAuthorPubkey) {
      try {
        const tags: string[][] = [
          ['d', citationId],
          ['p', sourceAuthorPubkey],
          ['a', `30023:${article.writerPubkey}:${article.nostrDTag}`],
          ['alt', 'Citation: a faithfulness claim about a quoted source'],
        ]
        if (sourceNaddr) tags.push(['a', sourceNaddr])
        else if (nostrEventId) tags.push(['e', nostrEventId])
        signed = (await signEvent(writerId, {
          kind: CITATION_EVENT_KIND,
          content: data.characterisation,
          tags,
          created_at: Math.floor(Date.now() / 1000),
        })) as SignedNostrEvent
      } catch (err) {
        logger.error({ err, citationId }, 'Failed to sign citation event; storing Postgres-only')
        signed = null
      }
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO citation_edges
           (id, article_id, source_protocol, source_author_pubkey, nostr_event_id,
            nostr_d_tag, source_naddr, source_uri, excerpt, excerpt_sha256,
            char_start, char_end, characterisation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          citationId,
          data.articleId,
          sourceProtocol,
          sourceAuthorPubkey,
          signed?.id ?? nostrEventId,
          data.sourceDTag ?? null,
          sourceNaddr,
          sourceUri,
          data.excerpt,
          excerptHash,
          data.charStart ?? null,
          data.charEnd ?? null,
          data.characterisation,
        ],
      )
      if (signed) {
        await enqueueRelayPublish(client, {
          entityType: 'citation',
          entityId: citationId,
          signedEvent: signed,
        })
      }
    })

    logger.info({ citationId, articleId: data.articleId, writerId, signed: !!signed }, 'Citation edge created')
    return reply.status(201).send({ id: citationId })
  })

  // ---------------------------------------------------------------------------
  // POST /disputes — reject a credit (disclaimer) or citation (dispute).
  //
  // No-stake privilege (is_by_cited_author): the cited/credited party disputes
  // free. Anyone else holds a refundable dispute_stake on their tab.
  // ---------------------------------------------------------------------------
  app.post('/disputes', { preHandler: requireAuth }, async (req, reply) => {
    const disputantId = req.session!.sub
    const parsed = DisputeSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const data = parsed.data

    // The disputant's own pubkey (an account holder is required — ADR Decision 9).
    const disp = await pool.query<{ nostr_pubkey: string }>(
      `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
      [disputantId],
    )
    if (disp.rows.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    const disputantPubkey = disp.rows[0].nostr_pubkey

    // Resolve the target edge and the no-stake privilege.
    let isByCitedAuthor = false
    let targetEventId: string | null = null
    if (data.citationEdgeId) {
      const { rows } = await pool.query<{ source_author_pubkey: string | null; nostr_event_id: string | null }>(
        `SELECT source_author_pubkey, nostr_event_id
           FROM citation_edges WHERE id = $1 AND deleted_at IS NULL`,
        [data.citationEdgeId],
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'Citation not found' })
      // Privilege: the disputant IS the cited author (pubkey match).
      isByCitedAuthor =
        rows[0].source_author_pubkey != null && rows[0].source_author_pubkey === disputantPubkey
      targetEventId = rows[0].nostr_event_id
    } else {
      const { rows } = await pool.query<{
        resolved_account_id: string | null
        target_protocol: string | null
        target_external_id: string | null
      }>(
        `SELECT resolved_account_id, target_protocol, target_external_id
           FROM credit_edges WHERE id = $1 AND deleted_at IS NULL`,
        [data.creditEdgeId],
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'Credit not found' })
      const c = rows[0]
      // Privilege (any qualifies): the disputant is the credited member, OR
      // their root pubkey matches the credited external Nostr identity, OR they
      // hold an active linked presence (Bluesky DID / AP actor / RSS / email)
      // that IS the credited external identity. The third arm is F2: without it,
      // someone credited via a non-Nostr network had to pay £5 to disclaim a
      // credit about themselves, contradicting the ADR ("the cited author …
      // stakes nothing").
      const externalHex = toHexPubkey(c.target_external_id)
      isByCitedAuthor =
        (c.resolved_account_id != null && c.resolved_account_id === disputantId) ||
        ((c.target_protocol === null || c.target_protocol === 'nostr_external') &&
          externalHex != null &&
          externalHex === disputantPubkey)

      if (!isByCitedAuthor && c.target_protocol != null && c.target_external_id != null) {
        const { rows: presence } = await pool.query<{ one: number }>(
          `SELECT 1 AS one
             FROM network_presences
            WHERE account_id = $1
              AND protocol = $2
              AND external_id = $3
              AND lifecycle_state = 'active'
              AND is_valid = true
            LIMIT 1`,
          [disputantId, c.target_protocol, c.target_external_id],
        )
        if (presence.length > 0) isByCitedAuthor = true
      }
    }

    const disputeId = randomUUID()
    const widerHash = data.widerExcerpt ? sha256(data.widerExcerpt) : null

    // Sign the dispute as an addressable event (native/Nostr targets only —
    // i.e. when there is an event to correct). Sign outside the txn.
    let signed: SignedNostrEvent | null = null
    if (targetEventId) {
      try {
        const tags: string[][] = [
          ['d', disputeId],
          ['e', targetEventId],
          ['alt', 'Dispute: a counter-claim against a citation'],
        ]
        signed = (await signEvent(disputantId, {
          kind: DISPUTE_EVENT_KIND,
          content: data.counterCharacterisation,
          tags,
          created_at: Math.floor(Date.now() / 1000),
        })) as SignedNostrEvent
      } catch (err) {
        logger.error({ err, disputeId }, 'Failed to sign dispute event; storing Postgres-only')
        signed = null
      }
    }

    let duplicate = false
    await withTransaction(async (client) => {
      // Insert the dispute first so the stake ledger entry can reference it.
      // F1: one active dispute per (disputant, target edge) — the partial unique
      // indexes (migration 129) make a repeat a no-op here; rowCount===0 means
      // this disputant already has a live dispute on the edge, so we skip the
      // stake + enqueue entirely and surface the existing one as a 409.
      const ins = await client.query(
        `INSERT INTO dispute_edges
           (id, citation_edge_id, credit_edge_id, disputant_account_id, disputant_pubkey,
            is_by_cited_author, nostr_event_id, counter_characterisation,
            wider_excerpt, wider_excerpt_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [
          disputeId,
          data.citationEdgeId ?? null,
          data.creditEdgeId ?? null,
          disputantId,
          disputantPubkey,
          isByCitedAuthor,
          signed?.id ?? null,
          data.counterCharacterisation,
          data.widerExcerpt ?? null,
          widerHash,
        ],
      )
      if (ins.rowCount === 0) {
        duplicate = true
        return
      }

      // Third-party dispute → hold a refundable stake: debit the disputant's tab
      // by +stake (a debt) and post the mirror dispute_stake entry (−stake) as one
      // pair. applyLedgerDelta UPSERTS the tab — the disputant may have none yet
      // (drive-by account) — and returns the ledger id we persist for the refund.
      if (!isByCitedAuthor) {
        const { ledgerId } = await applyLedgerDelta(client, {
          accountId: disputantId,
          counterpartyId: null,
          deltaPence: DISPUTE_STAKE_PENCE,
          triggerType: 'dispute_stake',
          refTable: 'dispute_edges',
          refId: disputeId,
          touch: ['last_read_at'],
        })
        await client.query(
          `UPDATE dispute_edges SET stake_ledger_entry_id = $1 WHERE id = $2`,
          [ledgerId, disputeId],
        )
      }

      if (signed) {
        await enqueueRelayPublish(client, {
          entityType: 'dispute',
          entityId: disputeId,
          signedEvent: signed,
        })
      }
    })

    if (duplicate) {
      // Return the disputant's existing live dispute on this edge so the client
      // can offer Withdraw rather than re-file.
      const targetCol = data.citationEdgeId ? 'citation_edge_id' : 'credit_edge_id'
      const targetId = data.citationEdgeId ?? data.creditEdgeId
      const { rows: existing } = await pool.query<{ id: string; is_by_cited_author: boolean }>(
        `SELECT id, is_by_cited_author
           FROM dispute_edges
          WHERE disputant_account_id = $1 AND ${targetCol} = $2
            AND withdrawn_at IS NULL AND deleted_at IS NULL
          LIMIT 1`,
        [disputantId, targetId],
      )
      const row = existing[0]
      return reply
        .status(409)
        .send({ error: 'Already disputed', id: row?.id ?? null, staked: row ? !row.is_by_cited_author : false })
    }

    logger.info(
      { disputeId, disputantId, isByCitedAuthor, staked: !isByCitedAuthor },
      'Dispute edge created',
    )
    return reply.status(201).send({ id: disputeId, staked: !isByCitedAuthor })
  })

  // ---------------------------------------------------------------------------
  // DELETE /disputes/:id — withdraw a dispute. Refunds the stake if one was held.
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/disputes/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const disputantId = req.session!.sub
      if (!UUID_RE.test(req.params.id)) {
        return reply.status(400).send({ error: 'Invalid id' })
      }

      let notFound = false
      await withTransaction(async (client) => {
        // Claim the withdrawal atomically: only an own, not-yet-withdrawn dispute.
        // Returning the stake id makes the refund idempotent (a second DELETE
        // touches zero rows).
        const { rows } = await client.query<{
          stake_ledger_entry_id: string | null
          nostr_event_id: string | null
        }>(
          `UPDATE dispute_edges
              SET withdrawn_at = now()
            WHERE id = $1 AND disputant_account_id = $2
              AND withdrawn_at IS NULL AND deleted_at IS NULL
          RETURNING stake_ledger_entry_id, nostr_event_id`,
          [req.params.id, disputantId],
        )
        if (rows.length === 0) {
          notFound = true
          return
        }

        // Refund a held stake: credit the tab back DOWN by the same magnitude
        // (deltaPence = −stake) and post the mirror dispute_stake_refund entry
        // (+stake) as one pair. No clamp — the column may go negative.
        if (rows[0].stake_ledger_entry_id) {
          await applyLedgerDelta(client, {
            accountId: disputantId,
            counterpartyId: null,
            deltaPence: -DISPUTE_STAKE_PENCE,
            triggerType: 'dispute_stake_refund',
            refTable: 'dispute_edges',
            refId: req.params.id,
            touch: ['last_read_at'],
          })
        }

        // Retract the public claim from the relay (kind 5) if it was signed.
        if (rows[0].nostr_event_id) {
          try {
            const deletion = (await signEvent(disputantId, {
              kind: 5,
              content: '',
              tags: [['e', rows[0].nostr_event_id]],
              created_at: Math.floor(Date.now() / 1000),
            })) as SignedNostrEvent
            await enqueueRelayPublish(client, {
              entityType: 'dispute',
              entityId: req.params.id,
              signedEvent: deletion,
            })
          } catch (err) {
            logger.error({ err, disputeId: req.params.id }, 'Failed to enqueue dispute retraction')
          }
        }
      })

      if (notFound) {
        return reply.status(404).send({ error: 'Dispute not found or already withdrawn' })
      }
      logger.info({ disputeId: req.params.id, disputantId }, 'Dispute withdrawn')
      return reply.status(200).send({ ok: true })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /articles/:id/credits — credits with any disclaimers.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/articles/:id/credits',
    { preHandler: optionalAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) {
        return reply.status(400).send({ error: 'Invalid id' })
      }
      const viewerId = req.session?.sub ?? null

      const { rows } = await pool.query<{
        id: string
        target_protocol: string | null
        target_external_id: string | null
        target_display_name: string | null
        resolved_account_id: string | null
        account_username: string | null
        account_display_name: string | null
        note: string | null
        created_at: Date
      }>(
        `SELECT ce.id, ce.target_protocol, ce.target_external_id, ce.target_display_name,
                ce.resolved_account_id, ce.note, ce.created_at,
                acc.username AS account_username, acc.display_name AS account_display_name
           FROM credit_edges ce
           LEFT JOIN accounts acc ON acc.id = ce.resolved_account_id
          WHERE ce.article_id = $1 AND ce.deleted_at IS NULL
          ORDER BY ce.created_at`,
        [req.params.id],
      )

      const ids = rows.map((r) => r.id)
      const disclaimersByCredit = new Map<string, Array<Record<string, unknown>>>()
      // The viewer's own (non-withdrawn) dispute against each credit, so the
      // apparatus can offer Withdraw across a reload (the disclaimers list above
      // is public and carries no "whose" marker).
      const mineByCredit = new Map<string, Record<string, unknown>>()
      if (ids.length > 0) {
        const { rows: disc } = await pool.query<{
          id: string
          credit_edge_id: string
          is_by_cited_author: boolean
          counter_characterisation: string
          disputant_account_id: string
          stake_ledger_entry_id: string | null
          created_at: Date
        }>(
          `SELECT id, credit_edge_id, is_by_cited_author, counter_characterisation,
                  disputant_account_id, stake_ledger_entry_id, created_at
             FROM dispute_edges
            WHERE credit_edge_id = ANY($1) AND withdrawn_at IS NULL AND deleted_at IS NULL
            ORDER BY is_by_cited_author DESC, created_at`,
          [ids],
        )
        for (const d of disc) {
          const list = disclaimersByCredit.get(d.credit_edge_id) ?? []
          list.push({
            id: d.id,
            byCreditedParty: d.is_by_cited_author,
            counterCharacterisation: d.counter_characterisation,
            createdAt: d.created_at.toISOString(),
          })
          disclaimersByCredit.set(d.credit_edge_id, list)
          if (viewerId && d.disputant_account_id === viewerId && !mineByCredit.has(d.credit_edge_id)) {
            mineByCredit.set(d.credit_edge_id, {
              id: d.id,
              counterCharacterisation: d.counter_characterisation,
              byCitedAuthor: d.is_by_cited_author,
              staked: d.stake_ledger_entry_id != null,
            })
          }
        }
      }

      return reply.status(200).send({
        credits: rows.map((r) => ({
          id: r.id,
          target: {
            protocol: r.target_protocol,
            externalId: r.target_external_id,
            displayName: r.account_display_name ?? r.target_display_name,
            accountId: r.resolved_account_id,
            username: r.account_username,
          },
          note: r.note,
          createdAt: r.created_at.toISOString(),
          disclaimers: disclaimersByCredit.get(r.id) ?? [],
          mine: mineByCredit.get(r.id) ?? null,
        })),
      })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /articles/:id/citations — citations with dispute counts; cited-author
  // disputes flagged for inline render.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/articles/:id/citations',
    { preHandler: optionalAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) {
        return reply.status(400).send({ error: 'Invalid id' })
      }
      const viewerId = req.session?.sub ?? null

      const { rows } = await pool.query<{
        id: string
        source_protocol: string | null
        source_author_pubkey: string | null
        source_naddr: string | null
        source_uri: string | null
        excerpt: string
        char_start: number | null
        char_end: number | null
        characterisation: string
        created_at: Date
        author_username: string | null
        author_display_name: string | null
      }>(
        `SELECT c.id, c.source_protocol, c.source_author_pubkey, c.source_naddr,
                c.source_uri, c.excerpt, c.char_start, c.char_end, c.characterisation,
                c.created_at,
                acc.username AS author_username, acc.display_name AS author_display_name
           FROM citation_edges c
           LEFT JOIN accounts acc ON acc.nostr_pubkey = c.source_author_pubkey
          WHERE c.article_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.char_start NULLS LAST, c.created_at`,
        [req.params.id],
      )

      const ids = rows.map((r) => r.id)
      const thirdPartyCount = new Map<string, number>()
      const citedAuthorDispute = new Map<string, Record<string, unknown>>()
      // The viewer's own (non-withdrawn) dispute against each citation, so the
      // apparatus can offer Withdraw across a reload (third-party disputes are
      // otherwise a bare count, carrying no id the disputant could act on).
      const mineByCitation = new Map<string, Record<string, unknown>>()
      if (ids.length > 0) {
        const { rows: disc } = await pool.query<{
          id: string
          citation_edge_id: string
          is_by_cited_author: boolean
          counter_characterisation: string
          wider_excerpt: string | null
          disputant_account_id: string
          stake_ledger_entry_id: string | null
          created_at: Date
        }>(
          `SELECT id, citation_edge_id, is_by_cited_author, counter_characterisation,
                  wider_excerpt, disputant_account_id, stake_ledger_entry_id, created_at
             FROM dispute_edges
            WHERE citation_edge_id = ANY($1) AND withdrawn_at IS NULL AND deleted_at IS NULL
            ORDER BY is_by_cited_author DESC, created_at`,
          [ids],
        )
        for (const d of disc) {
          if (d.is_by_cited_author && !citedAuthorDispute.has(d.citation_edge_id)) {
            citedAuthorDispute.set(d.citation_edge_id, {
              id: d.id,
              counterCharacterisation: d.counter_characterisation,
              widerExcerpt: d.wider_excerpt,
              createdAt: d.created_at.toISOString(),
            })
          } else if (!d.is_by_cited_author) {
            thirdPartyCount.set(d.citation_edge_id, (thirdPartyCount.get(d.citation_edge_id) ?? 0) + 1)
          }
          if (viewerId && d.disputant_account_id === viewerId && !mineByCitation.has(d.citation_edge_id)) {
            mineByCitation.set(d.citation_edge_id, {
              id: d.id,
              counterCharacterisation: d.counter_characterisation,
              byCitedAuthor: d.is_by_cited_author,
              staked: d.stake_ledger_entry_id != null,
            })
          }
        }
      }

      return reply.status(200).send({
        citations: rows.map((r) => ({
          id: r.id,
          source: {
            protocol: r.source_protocol,
            authorPubkey: r.source_author_pubkey,
            naddr: r.source_naddr,
            uri: r.source_uri,
            username: r.author_username,
            displayName: r.author_display_name,
          },
          excerpt: r.excerpt,
          charStart: r.char_start,
          charEnd: r.char_end,
          characterisation: r.characterisation,
          createdAt: r.created_at.toISOString(),
          disputes: {
            citedAuthor: citedAuthorDispute.get(r.id) ?? null,
            thirdPartyCount: thirdPartyCount.get(r.id) ?? 0,
            mine: mineByCitation.get(r.id) ?? null,
          },
        })),
      })
    },
  )
}
