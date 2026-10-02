import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from 'fastify'
import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { sendEmail } from '@platform-pub/shared/lib/email.js'
import { renderEmail } from '@platform-pub/shared/lib/email/layout.js'
import {
  tributeAuthorCopyEmail,
  tributeOfferEmail,
  tributePercent,
} from '@platform-pub/shared/lib/email/templates/tributes.js'
import { requireEnv, tributesEnabled } from '@platform-pub/shared/lib/env.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireAuth, optionalAuth } from '../middleware/auth.js'
import { requireWriter } from '../lib/writer-gate.js'
import { resolveTarget } from './upstream-edges.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { isUuid } from '../lib/request-inputs.js'

// =============================================================================
// Upstream Edges — Phase 2 (tribute authoring + contact)
//
// Spec: docs/adr/UPSTREAM-EDGES-ADR.md, docs/adr/UPSTREAM-EDGES-BUILD-PLAN.md.
//
// A tribute routes a share of a piece's writer-side earnings to a source as a
// co-earner. This phase ships AUTHORING and the CONTACT pipeline — NO money
// moves yet. tribute_accruals stays empty until Phase 3's settlement
// apportionment, which is gated (docs/adr/LEGAL-BRAKES.md), so these routes
// never touch reading_tabs or ledger_entries.
//
//   POST   /tributes                 — author offers a share to an inspirer
//   POST   /tributes/:id/consent     — inspirer accepts (proposed → live)
//   POST   /tributes/:id/decline     — inspirer declines (proposed → declined)
//   POST   /tributes/claim           — external invitee binds their new account
//   DELETE /tributes/:id             — author withdraws a still-proposed tribute
//   GET    /articles/:id/tributes    — tributes on a piece (render line)
//   GET    /tributes/mine            — the viewer's incoming offers (consent surface)
//
// Identify omnivorously (the universal resolver), contact narrowly: an existing
// member gets an in-app offer + comp read; an external person with an email gets
// a sober claim email; an unreachable target's share is held then swept to the
// author. NEVER a social DM. The whole surface ships dark behind TRIBUTES_ENABLED.
// =============================================================================


// 60-day contact window; one reminder at 30 (the lifecycle worker owns both).
const WINDOW_DAYS = 60

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Depth cap (C4) — bounds the recursive settlement walk and stops sub-penny
// dust chains. Mirrored by the depth CHECK backstop in migration 128.
const MAX_CHAIN_DEPTH = 8

const CreateSchema = z.object({
  articleId: z.string().regex(UUID_RE),
  // Share of the piece's writer-side net, in basis points (1–10000). The
  // cross-row ceiling (author keeps >= 10%) is enforced by the DB trigger.
  percentageBps: z.number().int().min(1).max(10000),
  target: z.string().min(1).max(500),
  // Always collected up front (the oracle-close: asking-for-email-only-when-
  // non-member would leak membership). Ignored when the target is a member.
  inviteEmail: z.string().email().max(320).optional(),
  note: z.string().max(2000).optional(),
  // Phase-4 composition seam: a tribute may be offered FROM a specific citation
  // ("I cited X here, and X earns a share"). Records the provenance link; the
  // payee is still the resolved `target` (author-confirmed via the live preview).
  citationEdgeId: z.string().regex(UUID_RE).optional(),
  // Phase-5 tribute chains: a CHILD tribute redirects a share of the PARENT
  // tribute's slice further upstream. NULL/absent = a root tribute (carves the
  // piece's writer-side net). When set, the offerer must be the parent's live
  // beneficiary (C1) and the child rides the parent's article (D1, one piece).
  parentTributeId: z.string().regex(UUID_RE).optional(),
})

const ClaimSchema = z.object({
  token: z.string().min(1).max(200),
})

// The author's article, with the publication flag for the D1 pre-check (the DB
// trigger is the authoritative guard; this just yields a clean 400) and the
// published flag (the inspirer is sent to /article/:dTag to read it before
// deciding, and that route only serves published pieces).
async function loadOwnedArticle(
  articleId: string,
  writerId: string,
): Promise<{ id: string; title: string; publicationId: string | null; published: boolean } | null> {
  const { rows } = await pool.query<{
    id: string
    title: string
    publication_id: string | null
    published_at: Date | null
  }>(
    `SELECT id, title, publication_id, published_at
       FROM articles
      WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL`,
    [articleId, writerId],
  )
  if (rows.length === 0) return null
  return {
    id: rows[0].id,
    title: rows[0].title,
    publicationId: rows[0].publication_id,
    published: rows[0].published_at != null,
  }
}

// The same article fields WITHOUT the owner filter — for a CHILD tribute, the
// offerer (the parent's beneficiary) doesn't own the article; the chain rides
// the parent's piece, and parent ownership is the authorisation (loadLiveParent).
async function loadArticleById(
  articleId: string,
): Promise<{ id: string; title: string; publicationId: string | null; published: boolean } | null> {
  const { rows } = await pool.query<{
    id: string
    title: string
    publication_id: string | null
    published_at: Date | null
  }>(
    `SELECT id, title, publication_id, published_at
       FROM articles
      WHERE id = $1 AND deleted_at IS NULL`,
    [articleId],
  )
  if (rows.length === 0) return null
  return {
    id: rows[0].id,
    title: rows[0].title,
    publicationId: rows[0].publication_id,
    published: rows[0].published_at != null,
  }
}

// Load the parent tribute for a CHILD offer (Phase-5 chains). C1: a child may be
// spawned only by a LIVE tribute, and only by its beneficiary (the
// resolved_account_id) — you accept your share before you may pass part of it
// on. Returns NULL when the parent doesn't exist, isn't live, or the offerer is
// not its beneficiary, so the route 404s without leaking which.
async function loadLiveParent(
  parentTributeId: string,
  offererId: string,
): Promise<{ id: string; depth: number; articleId: string } | null> {
  const { rows } = await pool.query<{ id: string; depth: number; article_id: string }>(
    `SELECT id, depth, article_id
       FROM tributes
      WHERE id = $1
        AND resolved_account_id = $2
        AND status = 'live'
        AND deleted_at IS NULL`,
    [parentTributeId, offererId],
  )
  if (rows.length === 0) return null
  return { id: rows[0].id, depth: rows[0].depth, articleId: rows[0].article_id }
}

export async function tributeRoutes(app: FastifyInstance) {
  // Every route 404s while the feature is dark, so the surface is invisible.
  app.addHook('preHandler', async (_req, reply) => {
    if (!tributesEnabled()) {
      return reply.status(404).send({ error: 'Not found' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /tributes — the author offers a share of the piece's earnings.
  // ---------------------------------------------------------------------------
  app.post('/tributes', { preHandler: [requireAuth, requireWriter] }, async (req, reply) => {
    const writerId = req.session!.sub
    const parsed = CreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const { articleId, percentageBps, target, inviteEmail, note, citationEdgeId, parentTributeId } = parsed.data

    // Root vs child (Phase-5 chains). For a ROOT the offerer must own the
    // article; for a CHILD they must be the live beneficiary of the parent (C1),
    // and the child rides the parent's article (D1 — one piece carries the whole
    // chain). author_account_id is the offerer (req.session.sub) either way: the
    // article author for a root, the parent's beneficiary for a child — both are
    // "whoever is paying this share out of their slice."
    let article: { id: string; title: string; publicationId: string | null; published: boolean } | null
    let resolvedArticleId: string
    let lockKey: string   // article id for roots; parent id for children
    let depth = 0
    let parentTributeIdValue: string | null = null

    if (parentTributeId) {
      const parent = await loadLiveParent(parentTributeId, writerId)
      if (!parent) {
        return reply.status(404).send({
          error: 'That tribute is not one you can pass a share of — it must be live and yours.',
        })
      }
      if (parent.depth + 1 > MAX_CHAIN_DEPTH) {
        return reply.status(400).send({
          error: `This chain is at its maximum depth (${MAX_CHAIN_DEPTH}); it cannot extend further.`,
        })
      }
      depth = parent.depth + 1
      parentTributeIdValue = parent.id
      resolvedArticleId = parent.articleId
      lockKey = parent.id   // parent-scoped serialisation (C3)
      article = await loadArticleById(parent.articleId)
      if (!article) {
        return reply.status(404).send({ error: 'The piece this chain rides is no longer available.' })
      }
    } else {
      article = await loadOwnedArticle(articleId, writerId)
      if (!article) {
        return reply.status(404).send({ error: 'Article not found or not yours' })
      }
      resolvedArticleId = articleId
      lockKey = articleId
    }

    if (!article.published) {
      return reply.status(400).send({
        error: 'Publish the piece before adding a tribute — the inspirer is invited to read it.',
      })
    }
    // D1 (also DB-enforced): a tributed piece may not live in a publication.
    if (article.publicationId) {
      return reply.status(400).send({
        error: 'This piece is in a publication; a tribute and a publication cannot split the same earnings.',
      })
    }
    // Composition link must be a citation on THIS piece (the article owns its
    // citations, so an in-article match implies the author's own edge). Roots
    // only — a child's source-of-funds is its parent's share, not a citation.
    if (citationEdgeId) {
      if (parentTributeIdValue) {
        return reply.status(400).send({ error: 'A chained tribute cannot also be tied to a citation.' })
      }
      const { rows } = await pool.query(
        `SELECT 1 FROM citation_edges
          WHERE id = $1 AND article_id = $2 AND deleted_at IS NULL`,
        [citationEdgeId, resolvedArticleId],
      )
      if (rows.length === 0) {
        return reply.status(400).send({ error: 'That citation is not on this piece.' })
      }
    }

    const t = await resolveTarget(target)
    const isMember = t.accountId != null

    // External-email branch needs a claim token; member/in-app branch does not.
    const rawToken = isMember || !inviteEmail ? null : randomBytes(32).toString('base64url')
    const tokenHash = rawToken ? hashToken(rawToken) : null
    // first_contact_at marks actual delivery (in-app notify or email sent); it
    // stays NULL for an unreachable target. The window runs from creation either
    // way, so even an unreachable share lapses → sweeps to the author.
    const firstContactAt = isMember || inviteEmail ? 'now()' : 'NULL'

    let tributeId: string
    try {
      tributeId = await withTransaction(async (client) => {
        // Serialise concurrent adds under one parent stream so the ceiling
        // trigger can't be raced (two inserts each reading under-ceiling). Roots
        // lock on the article id, children on the parent id (C3).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tributes
             (article_id, author_account_id, percentage_bps,
              target_protocol, target_external_id, target_display_name, resolved_account_id,
              status, invite_email, invite_token_hash,
              first_contact_at, window_expires_at, citation_edge_id,
              parent_tribute_id, depth)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   'proposed', $8, $9,
                   ${firstContactAt}, now() + ($10 || ' days')::interval, $11,
                   $12, $13)
           RETURNING id`,
          [
            resolvedArticleId,
            writerId,
            percentageBps,
            t.protocol,
            t.externalId,
            t.displayName,
            t.accountId,
            inviteEmail ?? null,
            tokenHash,
            String(WINDOW_DAYS),
            citationEdgeId ?? null,
            parentTributeIdValue,
            depth,
          ],
        )
        const id = rows[0].id

        if (isMember) {
          // In-app offer to an existing member + comp read of the piece.
          await deliverInAppOffer(client, {
            inspirerId: t.accountId!,
            authorId: writerId,
            articleId: resolvedArticleId,
          })
        }
        return id
      })
    } catch (err) {
      // The ceiling / D1 triggers raise check_violation (23514).
      if ((err as { code?: string }).code === '23514') {
        return reply.status(400).send({
          error: 'That share would leave the author too little (or the piece is in a publication).',
        })
      }
      throw err
    }

    // Email branches run AFTER the txn commits (no outbound side effect inside a
    // transaction). Failures are logged, not surfaced — the offer still stands.
    if (!isMember && inviteEmail && rawToken) {
      await sendExternalInvite({
        inviteEmail,
        rawToken,
        authorId: writerId,
        articleTitle: article.title,
        percentageBps,
        note: note ?? null,
      }).catch((err) => logger.error({ err, tributeId }, 'Tribute invite email failed'))
    }

    logger.info(
      { tributeId, articleId: resolvedArticleId, writerId, isMember, depth, emailed: !isMember && !!inviteEmail },
      'Tribute created',
    )
    // Uniform response regardless of branch — no account-existence oracle.
    return reply.status(201).send({ id: tributeId, status: 'proposed' })
  })

  // ---------------------------------------------------------------------------
  // POST /tributes/:id/consent — the inspirer accepts. proposed → live.
  //
  // Connect onboarding is NOT gated here (Phase 2 is money-free): Dial A means
  // consent is status-only (proposed → live) and accrual starts forward from
  // here; the Phase-3 inspirer-payout sweep is the one that requires a completed
  // Stripe Connect account before paying.
  //
  // Phase-5 (C1): consenting is also the gate to passing a share UPSTREAM — only
  // a live tribute may spawn children. The response returns enough context
  // (articleId + this tribute's percentage) for the client to open a child-offer
  // composer ("Accept & pass a share upstream"); the child offer is a separate
  // POST /tributes with parentTributeId = this id.
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/tributes/:id/consent',
    { preHandler: requireAuth },
    async (req, reply) => {
      const inspirerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: 'Offer not found or not yours to accept' })
      }
      let result: { articleId: string; percentageBps: number } | null = null
      try {
        await withTransaction(async (client) => {
          const { rows } = await client.query<{ article_id: string; percentage_bps: number }>(
            `UPDATE tributes
                SET status = 'live', consent_at = now()
              WHERE id = $1 AND resolved_account_id = $2
                AND status = 'proposed' AND deleted_at IS NULL
            RETURNING article_id, percentage_bps`,
            [req.params.id, inspirerId],
          )
          if (rows.length === 0) return
          result = { articleId: rows[0].article_id, percentageBps: rows[0].percentage_bps }
          // Dial A: consent is status-only. No accrual exists before consent
          // (accruals are frozen only for a `live` tribute, forward-only from
          // here), so there is no held suspense to release.
        })
      } catch (err) {
        // status='live' fires the validate-write trigger (ceiling/D1/parent-live);
        // a 23514 is a 400, not a 500 (F8). Not reachable today — insert-time
        // enforcement keeps the txn consistent — but mapped for robustness.
        if ((err as { code?: string }).code === '23514') {
          return reply.status(400).send({ error: 'This offer can no longer be accepted.' })
        }
        throw err
      }
      if (!result) {
        return reply.status(404).send({ error: 'Offer not found or not yours to accept' })
      }
      const r = result as { articleId: string; percentageBps: number }
      logger.info({ tributeId: req.params.id, inspirerId }, 'Tribute consented')
      // articleId/percentageBps let the client open the upstream child composer.
      return reply.status(200).send({
        ok: true,
        status: 'live',
        articleId: r.articleId,
        percentageBps: r.percentageBps,
      })
    },
  )

  // ---------------------------------------------------------------------------
  // POST /tributes/:id/decline — the inspirer declines. proposed → declined.
  // The comp read is KEPT (it would be petty to claw back a courtesy read).
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/tributes/:id/decline',
    { preHandler: requireAuth },
    async (req, reply) => {
      const inspirerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: 'Offer not found or not yours to decline' })
      }
      let notFound = false
      try {
        await withTransaction(async (client) => {
          const { rows } = await client.query(
            `UPDATE tributes
                SET status = 'declined'
              WHERE id = $1 AND resolved_account_id = $2
                AND status = 'proposed' AND deleted_at IS NULL
            RETURNING id`,
            [req.params.id, inspirerId],
          )
          if (rows.length === 0) {
            notFound = true
            return
          }
          // Dial A: decline is status-only. A proposed tribute never accrued
          // (accruals are frozen only for a `live` tribute), so there is no held
          // suspense to sweep back to the author.
        })
      } catch (err) {
        // status='declined' early-returns in the validate-write trigger, so a
        // 23514 is not reachable here; mapped to a 400 for symmetry with consent (F8).
        if ((err as { code?: string }).code === '23514') {
          return reply.status(400).send({ error: 'This offer can no longer be declined.' })
        }
        throw err
      }
      if (notFound) {
        return reply.status(404).send({ error: 'Offer not found or not yours to decline' })
      }
      logger.info({ tributeId: req.params.id, inspirerId }, 'Tribute declined')
      return reply.status(200).send({ ok: true, status: 'declined' })
    },
  )

  // ---------------------------------------------------------------------------
  // POST /tributes/claim — an external invitee, now signed up + authenticated,
  // binds their account to the tribute (and gets the comp read). They still
  // consent/decline afterward; binding is not consent.
  // ---------------------------------------------------------------------------
  app.post('/tributes/claim', { preHandler: requireAuth }, async (req, reply) => {
    const accountId = req.session!.sub
    const parsed = ClaimSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const tokenHash = hashToken(parsed.data.token)

    let result: { id: string; articleId: string; dTag: string } | null = null
    try {
      await withTransaction(async (client) => {
        // Claim atomically: consume the token (set NULL) and bind the account. A
        // lapsed/declined tribute has status != 'proposed' so it won't match. The
        // join yields the article's d-tag so the claim page can send them to read it.
        const { rows } = await client.query<{ id: string; article_id: string; nostr_d_tag: string }>(
          `UPDATE tributes t
              SET resolved_account_id = $1,
                  invite_token_hash = NULL,
                  first_contact_at = COALESCE(t.first_contact_at, now())
             FROM articles a
            WHERE t.article_id = a.id
              AND t.invite_token_hash = $2
              AND t.status = 'proposed'
              AND t.resolved_account_id IS NULL
              AND t.deleted_at IS NULL
          RETURNING t.id, t.article_id, a.nostr_d_tag`,
          [accountId, tokenHash],
        )
        if (rows.length === 0) return
        result = { id: rows[0].id, articleId: rows[0].article_id, dTag: rows[0].nostr_d_tag }
        await grantCompRead(client, accountId, rows[0].article_id)
      })
    } catch (err) {
      // The claim UPDATE keeps status='proposed', so it fires the validate-write
      // trigger (ceiling/D1/parent-live). Not reachable today; mapped to 400 (F8).
      if ((err as { code?: string }).code === '23514') {
        return reply.status(400).send({ error: 'This invitation can no longer be claimed.' })
      }
      throw err
    }

    if (!result) {
      return reply.status(404).send({ error: 'This invitation is invalid, already claimed, or expired.' })
    }
    const r = result as { id: string; articleId: string; dTag: string }
    logger.info({ tributeId: r.id, accountId }, 'Tribute invite claimed')
    return reply.status(200).send({ id: r.id, articleId: r.articleId, articleDTag: r.dTag })
  })

  // ---------------------------------------------------------------------------
  // DELETE /tributes/:id — the author withdraws a still-proposed tribute.
  // Restricted to 'proposed' (a 'live' tribute may have accruing money in
  // Phase 3 and would need a sweep — out of scope here).
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/tributes/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: 'Tribute not found, not yours, or no longer withdrawable' })
      }
      const { rows } = await pool.query(
        `UPDATE tributes
            SET deleted_at = now()
          WHERE id = $1 AND author_account_id = $2
            AND status = 'proposed' AND deleted_at IS NULL
        RETURNING id`,
        [req.params.id, writerId],
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Tribute not found, not yours, or no longer withdrawable' })
      }
      logger.info({ tributeId: req.params.id, writerId }, 'Tribute withdrawn')
      return reply.status(200).send({ ok: true })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /articles/:id/tributes — the render line ("X% of this piece's earnings
  // goes to Y", status shown honestly). Public; the invite email is never
  // exposed. The article owner additionally sees whether each is theirs to edit.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/articles/:id/tributes',
    { preHandler: optionalAuth },
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: 'Article not found' })
      }
      const viewerId = req.session?.sub ?? null

      const { rows } = await pool.query<{
        id: string
        percentage_bps: number
        target_protocol: string | null
        target_external_id: string | null
        target_display_name: string | null
        resolved_account_id: string | null
        status: string
        author_account_id: string
        first_contact_at: Date | null
        account_username: string | null
        account_display_name: string | null
        citation_edge_id: string | null
        parent_tribute_id: string | null
        depth: number
        created_at: Date
      }>(
        `SELECT t.id, t.percentage_bps, t.target_protocol, t.target_external_id,
                t.target_display_name, t.resolved_account_id, t.status,
                t.author_account_id, t.first_contact_at, t.created_at,
                t.citation_edge_id, t.parent_tribute_id, t.depth,
                acc.username AS account_username, acc.display_name AS account_display_name
           FROM tributes t
           LEFT JOIN accounts acc ON acc.id = t.resolved_account_id
          WHERE t.article_id = $1 AND t.deleted_at IS NULL
          ORDER BY t.created_at`,
        [req.params.id],
      )

      return reply.status(200).send({
        tributes: rows.map((r) => ({
          id: r.id,
          percentageBps: r.percentage_bps,
          status: r.status,
          // "reachable" distinguishes accruing-and-held (no live payee yet) from
          // an unaddressable target with no contact at all.
          reachable: r.resolved_account_id != null || r.first_contact_at != null,
          target: {
            protocol: r.target_protocol,
            externalId: r.target_external_id,
            displayName: r.account_display_name ?? r.target_display_name,
            accountId: r.resolved_account_id,
            username: r.account_username,
          },
          // Phase-4 composition: the citation this tribute was offered from, if any.
          citationEdgeId: r.citation_edge_id,
          // Phase-5 chains: NULL = root; non-NULL = a child of that tribute. depth
          // is 0 for roots, parent.depth+1 for children — the frontend builds the
          // tree from these two fields.
          parentTributeId: r.parent_tribute_id,
          depth: r.depth,
          mine: viewerId != null && r.author_account_id === viewerId,
          createdAt: r.created_at.toISOString(),
        })),
      })
    },
  )

  // ---------------------------------------------------------------------------
  // GET /tributes/mine — the viewer's incoming, still-pending offers, for the
  // consent surface. (Only ones bound to their account; external invites appear
  // here once claimed.)
  // ---------------------------------------------------------------------------
  app.get('/tributes/mine', { preHandler: requireAuth }, async (req, reply) => {
    const inspirerId = req.session!.sub
    const { rows } = await pool.query<{
      id: string
      percentage_bps: number
      status: string
      article_id: string
      article_title: string
      article_d_tag: string
      author_username: string | null
      author_display_name: string | null
      created_at: Date
    }>(
      `SELECT t.id, t.percentage_bps, t.status, t.article_id,
              a.title AS article_title, a.nostr_d_tag AS article_d_tag,
              auth.username AS author_username, auth.display_name AS author_display_name,
              t.created_at
         FROM tributes t
         JOIN articles a ON a.id = t.article_id
         JOIN accounts auth ON auth.id = t.author_account_id
        WHERE t.resolved_account_id = $1 AND t.status = 'proposed' AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC`,
      [inspirerId],
    )
    return reply.status(200).send({
      offers: rows.map((r) => ({
        id: r.id,
        percentageBps: r.percentage_bps,
        status: r.status,
        articleId: r.article_id,
        articleTitle: r.article_title,
        articleDTag: r.article_d_tag,
        author: {
          username: r.author_username,
          displayName: r.author_display_name,
        },
        createdAt: r.created_at.toISOString(),
      })),
    })
  })
}

// =============================================================================
// Contact pipeline
// =============================================================================

type Client = Parameters<Parameters<typeof withTransaction>[0]>[0]

// Comp read access: any article_unlocks row grants access (checkArticleAccess
// doesn't filter on unlocked_via), so an 'author_grant' row is sufficient. Same
// shape as gift-links. Idempotent on the (reader, article) unique.
async function grantCompRead(client: Client, readerId: string, articleId: string): Promise<void> {
  await client.query(
    `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
     VALUES ($1, $2, 'author_grant')
     ON CONFLICT (reader_id, article_id) DO NOTHING`,
    [readerId, articleId],
  )
}

// In-app offer to an existing member: the notification + the comp read. The
// notification dedups on (recipient, actor, type, article) via the global
// idx_notifications_dedup partial-unique index.
async function deliverInAppOffer(
  client: Client,
  args: { inspirerId: string; authorId: string; articleId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO notifications (recipient_id, actor_id, type, article_id)
     VALUES ($1, $2, 'tribute_offer_received', $3)
     ON CONFLICT DO NOTHING`,
    [args.inspirerId, args.authorId, args.articleId],
  )
  await grantCompRead(client, args.inspirerId, args.articleId)
}

// External invite: a sober claim email to the inspirer carrying the magic link,
// and a token-REDACTED reference copy CC'd to the author (transparency without
// handing them the claim link). Runs post-commit.
async function sendExternalInvite(args: {
  inviteEmail: string
  rawToken: string
  authorId: string
  articleTitle: string
  percentageBps: number
  note: string | null
}): Promise<void> {
  const appUrl = requireEnv('APP_URL')
  const claimUrl = `${appUrl}/tribute/claim?token=${encodeURIComponent(args.rawToken)}`
  const percent = tributePercent(args.percentageBps)

  // Author identity + email for the CC reference copy.
  const { rows } = await pool.query<{ email: string | null; display_name: string | null; username: string | null }>(
    `SELECT email, display_name, username FROM accounts WHERE id = $1`,
    [args.authorId],
  )
  const author = rows[0]
  const authorName = author?.display_name ?? author?.username ?? 'A writer on all.haus'

  // --- The inspirer's offer email (carries the claim link) ---
  await sendEmail({
    to: args.inviteEmail,
    ...renderEmail(
      tributeOfferEmail({
        authorName,
        articleTitle: args.articleTitle,
        percent,
        note: args.note,
        claimUrl,
      }),
    ),
  })

  // --- The author's reference copy (NO token / claim link) ---
  if (author?.email) {
    await sendEmail({
      to: author.email,
      ...renderEmail(
        tributeAuthorCopyEmail({ inviteEmail: args.inviteEmail, articleTitle: args.articleTitle, percent }),
      ),
    })
  }
}
