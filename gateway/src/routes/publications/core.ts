import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { requirePublicationPermission, requirePublicationOwner } from '../../middleware/publication-auth.js'
import { generateKeypair } from '../../lib/key-custody-client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { ROLE_DEFAULTS } from './shared.js'

// =============================================================================
// Publication CRUD + caller memberships
//
// POST   /publications                 — Create
// GET    /publications/:slug           — Public profile
// PATCH  /publications/:id             — Update settings
// DELETE /publications/:id             — Archive (Owner only)
// GET    /my/publications              — Caller's memberships
// =============================================================================

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/

const CreatePublicationSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Slug must be 3-50 chars, lowercase alphanumeric/hyphens'),
  name: z.string().min(1).max(100),
  tagline: z.string().max(200).optional(),
  about: z.string().max(10000).optional(),
})

const UpdatePublicationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  tagline: z.string().max(200).nullable().optional(),
  about: z.string().max(10000).nullable().optional(),
  logo_blossom_url: z.string().url().nullable().optional(),
  cover_blossom_url: z.string().url().nullable().optional(),
  subscription_price_pence: z.number().int().min(0).optional(),
  annual_discount_pct: z.number().int().min(0).max(100).optional(),
  default_article_price_pence: z.number().int().min(0).optional(),
  homepage_layout: z.enum(['blog', 'magazine', 'minimal']).optional(),
})

export async function publicationCoreRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /publications — Create a new publication
  // ---------------------------------------------------------------------------

  app.post('/publications', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreatePublicationSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const userId = req.session!.sub
    const { slug, name, tagline, about } = parsed.data

    // Check slug uniqueness
    const existing = await pool.query('SELECT id FROM publications WHERE slug = $1', [slug])
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: 'Slug already taken' })
    }

    // Generate custodial Nostr keypair
    const keypair = await generateKeypair()

    const publicationId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO publications (slug, name, tagline, about, nostr_pubkey, nostr_privkey_enc)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [slug, name, tagline || null, about || null, keypair.pubkeyHex, keypair.privkeyEncrypted]
      )
      const id = rows[0].id

      // Creator becomes Owner + EiC with all permissions
      const perms = ROLE_DEFAULTS.editor_in_chief
      await client.query(
        `INSERT INTO publication_members
           (publication_id, account_id, role, is_owner, accepted_at,
            can_publish, can_edit_others, can_manage_members, can_manage_finances, can_manage_settings)
         VALUES ($1, $2, 'editor_in_chief', TRUE, now(), $3, $4, $5, $6, $7)`,
        [id, userId, perms.can_publish, perms.can_edit_others,
         perms.can_manage_members, perms.can_manage_finances, perms.can_manage_settings]
      )

      return id
    })

    logger.info({ publicationId, slug, userId }, 'Publication created')
    return reply.status(201).send({ id: publicationId, slug })
  })

  // ---------------------------------------------------------------------------
  // GET /publications/:slug — Public profile
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>('/publications/:slug', async (req, reply) => {
    const { slug } = req.params

    const { rows } = await pool.query(
      `SELECT id, slug, name, tagline, about, logo_blossom_url, cover_blossom_url,
              nostr_pubkey, subscription_price_pence, annual_discount_pct,
              default_article_price_pence, homepage_layout, status, founded_at
       FROM publications
       WHERE slug = $1 AND status = 'active'`,
      [slug]
    )

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Publication not found' })
    }

    return reply.send(rows[0])
  })

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id — Update settings
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_settings')] },
    async (req, reply) => {
      const parsed = UpdatePublicationSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { id } = req.params
      const data = parsed.data

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      // Column names cannot be parameterised, so they are interpolated — and an
      // interpolated identifier must come from a fixed list in THIS file, never
      // from request-derived keys. Zod already bounds `data` to the schema's
      // keys, so this is defence in depth rather than a live hole: it stops a
      // future `.passthrough()`, `.catchall()`, or a merged schema from turning
      // a parse into an injection point, and it fails closed (an unlisted key is
      // dropped, never interpolated).
      const UPDATABLE_COLUMNS = [
        'name',
        'tagline',
        'about',
        'logo_blossom_url',
        'cover_blossom_url',
        'subscription_price_pence',
        'annual_discount_pct',
        'default_article_price_pence',
        'homepage_layout',
      ] as const satisfies readonly (keyof typeof data)[]

      // `satisfies` only proves each listed key is valid, not that every schema
      // key is listed — so a field added to UpdatePublicationSchema would
      // silently stop being updatable. This makes that a compile error.
      type UnlistedColumn = Exclude<
        keyof typeof data,
        (typeof UPDATABLE_COLUMNS)[number]
      >
      const _allColumnsListed: UnlistedColumn extends never ? true : never = true
      void _allColumnsListed

      for (const key of UPDATABLE_COLUMNS) {
        const value = data[key]
        if (value !== undefined) {
          setClauses.push(`${key} = $${idx}`)
          values.push(value)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      setClauses.push(`updated_at = now()`)
      values.push(id)
      await pool.query(
        `UPDATE publications SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        values
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id — Archive (Owner only)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/publications/:id',
    { preHandler: [requireAuth, requirePublicationOwner()] },
    async (req, reply) => {
      const { id } = req.params

      await pool.query(
        `UPDATE publications SET status = 'archived' WHERE id = $1`,
        [id]
      )

      logger.info({ publicationId: id }, 'Publication archived')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /my/publications — Caller's publication memberships
  // ---------------------------------------------------------------------------

  app.get('/my/publications', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub

    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.name, p.logo_blossom_url,
              pm.role, pm.is_owner, pm.can_publish, pm.can_edit_others,
              pm.can_manage_members, pm.can_manage_finances, pm.can_manage_settings
       FROM publication_members pm
       JOIN publications p ON p.id = pm.publication_id
       WHERE pm.account_id = $1 AND pm.removed_at IS NULL AND p.status = 'active'
       ORDER BY p.name ASC`,
      [userId]
    )

    return reply.send({ publications: rows })
  })
}
