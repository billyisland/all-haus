import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { requirePublicationPermission, requirePublicationOwner } from '../../middleware/publication-auth.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { ROLE_DEFAULTS } from './shared.js'

// =============================================================================
// Publication member management + invite acceptance
//
// GET    /publications/:id/members              — List members
// POST   /publications/:id/members/invite       — Invite member
// POST   /publications/:id/members/accept       — Accept invite
// PATCH  /publications/:id/members/:memberId    — Update member
// DELETE /publications/:id/members/:memberId    — Remove member
// POST   /publications/:id/transfer-ownership   — Transfer Owner
// POST   /publications/:id/leave                — Self-remove (non-owner)
// GET    /publications/invites/:token           — Public invite info
// =============================================================================

const InviteMemberSchema = z.object({
  email: z.string().email().optional(),
  accountId: z.string().uuid().optional(),
  role: z.enum(['editor_in_chief', 'editor', 'contributor']).default('contributor'),
  contributorType: z.enum(['permanent', 'one_off']).default('permanent'),
  message: z.string().max(500).optional(),
}).refine(d => d.email || d.accountId, { message: 'email or accountId required' })

const UpdateMemberSchema = z.object({
  role: z.enum(['editor_in_chief', 'editor', 'contributor']).optional(),
  contributorType: z.enum(['permanent', 'one_off']).optional(),
  title: z.string().max(100).nullable().optional(),
  canPublish: z.boolean().optional(),
  canEditOthers: z.boolean().optional(),
  canManageMembers: z.boolean().optional(),
  canManageFinances: z.boolean().optional(),
  canManageSettings: z.boolean().optional(),
})

const TransferOwnershipSchema = z.object({
  newOwnerId: z.string().uuid(),
})

// No privilege escalation (M9): a member with can_manage_members must never
// GRANT a permission they don't themselves hold — otherwise a members-manager
// could invite/patch a colluding account as editor_in_chief (which confers
// can_manage_finances + can_manage_settings) and gain powers above their own.
// The owner is exempt (holds everything). Returns the first offending
// permission, or null when the grant is within the grantor's own powers.
const PERMISSION_KEYS = [
  'can_publish', 'can_edit_others', 'can_manage_members',
  'can_manage_finances', 'can_manage_settings',
] as const

function escalationBeyond(
  grantor: { is_owner: boolean } & Record<(typeof PERMISSION_KEYS)[number], boolean>,
  granted: Partial<Record<(typeof PERMISSION_KEYS)[number], boolean>>,
): string | null {
  if (grantor.is_owner) return null
  for (const key of PERMISSION_KEYS) {
    if (granted[key] === true && grantor[key] !== true) return key
  }
  return null
}

export async function publicationMembersRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /publications/:id/members — List members
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params

      // Members-only: this roster carries revenue_share_bps + the full
      // permission matrix, so it must never be anonymous (the public projection
      // is the masthead route — name/role/title only). Any active member may
      // read it (the UI shows the roster to every member; only management
      // actions are permission-gated client-side).
      const { rowCount } = await pool.query(
        `SELECT 1 FROM publication_members
          WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [id, req.session!.sub]
      )
      if (rowCount === 0) {
        return reply.status(403).send({ error: 'Not a member of this publication' })
      }

      const { rows } = await pool.query(
        `SELECT pm.id, pm.account_id, pm.role, pm.contributor_type, pm.title, pm.is_owner,
                pm.revenue_share_bps, pm.can_publish, pm.can_edit_others,
                pm.can_manage_members, pm.can_manage_finances, pm.can_manage_settings,
                a.username, a.display_name, a.avatar_blossom_url, a.nostr_pubkey
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL
         ORDER BY pm.is_owner DESC, pm.role ASC, a.display_name ASC`,
        [id]
      )

      return reply.send({ members: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/members/invite — Invite a member
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/members/invite',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const parsed = InviteMemberSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const { id } = req.params
      const userId = req.session!.sub
      const { email, accountId, role, contributorType, message } = parsed.data

      // Block granting a role that confers a permission the inviter lacks (M9).
      const offending = escalationBeyond(req.publicationMember!, ROLE_DEFAULTS[role])
      if (offending) {
        return reply.status(403).send({
          error: `Cannot invite as ${role}: it confers ${offending}, which you do not hold`,
        })
      }

      const { rows } = await pool.query<{ id: string; token: string }>(
        `INSERT INTO publication_invites
           (publication_id, invited_by, invited_email, invited_account_id, role, contributor_type, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, token`,
        [id, userId, email || null, accountId || null, role, contributorType, message || null]
      )

      // If inviting an existing user, create a notification
      if (accountId) {
        await pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'pub_invite_received')
           ON CONFLICT DO NOTHING`,
          [accountId, userId]
        )
      }

      logger.info({ publicationId: id, inviteId: rows[0].id, role }, 'Publication invite sent')
      return reply.status(201).send({ inviteId: rows[0].id, token: rows[0].token })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/members/accept — Accept an invite
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/members/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { token } = req.body as { token: string }
      if (!token) {
        return reply.status(400).send({ error: 'Token required' })
      }

      const userId = req.session!.sub

      const { rows: invites } = await pool.query(
        `SELECT * FROM publication_invites
         WHERE token = $1 AND publication_id = $2
           AND accepted_at IS NULL AND declined_at IS NULL
           AND expires_at > now()`,
        [token, req.params.id]
      )

      if (invites.length === 0) {
        return reply.status(404).send({ error: 'Invite not found or expired' })
      }

      const invite = invites[0]

      // Verify the invite is for this user (by email or account ID)
      if (invite.invited_account_id && invite.invited_account_id !== userId) {
        return reply.status(403).send({ error: 'This invite is for another user' })
      }

      // Re-validate the grant at execution time (§0f-16): the M9 escalation
      // guard runs at MINT time, so an invite minted before the guard shipped —
      // or by an inviter demoted since — would still confer its role's full
      // ROLE_DEFAULTS here. An invite is a deferred grant; it is only
      // acceptable while its inviter currently holds every permission the role
      // confers (owner exempt; a departed/removed inviter holds nothing).
      const { rows: inviterRows } = await pool.query(
        `SELECT is_owner, can_publish, can_edit_others, can_manage_members,
                can_manage_finances, can_manage_settings
           FROM publication_members
          WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [invite.publication_id, invite.invited_by]
      )
      const inviteOffending = inviterRows.length === 0
        ? 'a grant from an inviter who is no longer a member'
        : escalationBeyond(
            inviterRows[0],
            ROLE_DEFAULTS[invite.role as keyof typeof ROLE_DEFAULTS],
          )
      if (inviteOffending) {
        return reply.status(403).send({
          error: `This invite can no longer be accepted: it confers ${inviteOffending}, which the inviter does not hold`,
        })
      }

      await withTransaction(async (client) => {
        const perms = ROLE_DEFAULTS[invite.role as keyof typeof ROLE_DEFAULTS]

        // F10 (2026-07-06 audit P1): resurrecting a REMOVED member must zero
        // their old revenue_share_bps — a re-accept previously restored the
        // stale share past every Σ ≤ 10000 guard (removed members are excluded
        // from the sums while removed). A manager re-grants the share
        // deliberately via the payroll routes. An already-active member
        // re-accepting keeps their live share untouched.
        await client.query(
          `INSERT INTO publication_members
             (publication_id, account_id, role, contributor_type, accepted_at,
              can_publish, can_edit_others, can_manage_members, can_manage_finances, can_manage_settings)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9)
           ON CONFLICT (publication_id, account_id) DO UPDATE SET
             role = EXCLUDED.role, contributor_type = EXCLUDED.contributor_type,
             revenue_share_bps = CASE
               WHEN publication_members.removed_at IS NOT NULL THEN 0
               ELSE publication_members.revenue_share_bps
             END,
             removed_at = NULL, accepted_at = now()`,
          [invite.publication_id, userId, invite.role, invite.contributor_type,
           perms.can_publish, perms.can_edit_others, perms.can_manage_members,
           perms.can_manage_finances, perms.can_manage_settings]
        )

        await client.query(
          `UPDATE publication_invites SET accepted_at = now() WHERE id = $1`,
          [invite.id]
        )
      })

      // Notify members with can_manage_members
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         SELECT pm.account_id, $1, 'pub_member_joined'
         FROM publication_members pm
         WHERE pm.publication_id = $2 AND pm.can_manage_members = TRUE
           AND pm.removed_at IS NULL AND pm.account_id != $1
         ON CONFLICT DO NOTHING`,
        [userId, invite.publication_id]
      )

      logger.info({ publicationId: invite.publication_id, userId, role: invite.role }, 'Invite accepted')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/members/:memberId — Update member
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; memberId: string } }>(
    '/publications/:id/members/:memberId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const parsed = UpdateMemberSchema.safeParse(req.body)
      if (!parsed.success) {
        // The shared envelope, never a raw flatten() as `error` — the client
        // renders that field as text and an object arrives as "[object Object]".
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const { id, memberId } = req.params
      const data = parsed.data

      // Cannot modify the Owner
      const { rows: target } = await pool.query(
        `SELECT is_owner FROM publication_members WHERE id = $1 AND publication_id = $2`,
        [memberId, id]
      )
      if (target.length === 0) {
        return reply.status(404).send({ error: 'Member not found' })
      }
      if (target[0].is_owner) {
        return reply.status(403).send({ error: 'Cannot modify the Owner' })
      }

      // Block granting a permission the editor lacks (M9). role is a label here
      // (PATCH doesn't apply ROLE_DEFAULTS to the columns — only the explicit
      // can_* fields change), so guard exactly the permission fields being set.
      const offending = escalationBeyond(req.publicationMember!, {
        can_publish: data.canPublish,
        can_edit_others: data.canEditOthers,
        can_manage_members: data.canManageMembers,
        can_manage_finances: data.canManageFinances,
        can_manage_settings: data.canManageSettings,
      })
      if (offending) {
        return reply.status(403).send({
          error: `Cannot grant ${offending}, which you do not hold`,
        })
      }

      // The role LABEL is itself a capability, not just cosmetics (§0f-16):
      // `editor_in_chief` appears on the masthead as the publication's voice AND
      // gates ownership-transfer eligibility (the transfer route requires the
      // new owner to be an active EiC). So guard it like a grant: setting a
      // role whose ROLE_DEFAULTS confer permissions the editor doesn't hold is
      // the same escalation whether or not the columns move.
      if (data.role !== undefined) {
        const labelOffending = escalationBeyond(
          req.publicationMember!,
          ROLE_DEFAULTS[data.role],
        )
        if (labelOffending) {
          return reply.status(403).send({
            error: `Cannot assign the ${data.role} role: it implies ${labelOffending}, which you do not hold`,
          })
        }
      }

      const setClauses: string[] = []
      const values: any[] = []
      let idx = 1

      const fieldMap: Record<string, string> = {
        role: 'role', contributorType: 'contributor_type', title: 'title',
        canPublish: 'can_publish',
        canEditOthers: 'can_edit_others', canManageMembers: 'can_manage_members',
        canManageFinances: 'can_manage_finances', canManageSettings: 'can_manage_settings',
      }

      for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        const val = (data as any)[jsKey]
        if (val !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`)
          values.push(val)
          idx++
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' })
      }

      // revenue_share_bps is deliberately NOT writable here, and must not be
      // re-added (CONSOLIDATED-TODO §1.15, closed 2026-08-06). This route is
      // gated on can_manage_members; a standing revenue share is FINANCE, not
      // membership, so its sole writer is the can_manage_finances-gated
      // PATCH /publications/:id/payroll — which owns the pub_shares advisory
      // lock and the Σ ≤ 10000 guard that used to be duplicated here. Writing
      // it from a members mandate is a mandate hole the M9 escalation guard
      // cannot see (it guards permission GRANTS, and revenue_share_bps is not
      // a permission), and it would stop a split version's set_by being
      // mandate evidence — PAYMENT-PERIMETER-ADR §3.W5.
      values.push(memberId, id)
      await pool.query(
        `UPDATE publication_members SET ${setClauses.join(', ')}
         WHERE id = $${idx} AND publication_id = $${idx + 1}`,
        values
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id/members/:memberId — Remove member
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string; memberId: string } }>(
    '/publications/:id/members/:memberId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_members')] },
    async (req, reply) => {
      const { id, memberId } = req.params

      // Cannot remove the Owner
      const { rows: target } = await pool.query(
        `SELECT is_owner, account_id FROM publication_members WHERE id = $1 AND publication_id = $2`,
        [memberId, id]
      )
      if (target.length === 0) {
        return reply.status(404).send({ error: 'Member not found' })
      }
      if (target[0].is_owner) {
        return reply.status(403).send({ error: 'Cannot remove the Owner — transfer ownership first' })
      }

      await pool.query(
        `UPDATE publication_members SET removed_at = now() WHERE id = $1`,
        [memberId]
      )

      // Notify members with can_manage_members
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         SELECT pm.account_id, $1, 'pub_member_left'
         FROM publication_members pm
         WHERE pm.publication_id = $2 AND pm.can_manage_members = TRUE
           AND pm.removed_at IS NULL AND pm.account_id != $1
         ON CONFLICT DO NOTHING`,
        [target[0].account_id, id]
      )

      logger.info({ publicationId: id, memberId }, 'Member removed')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/transfer-ownership — Transfer Owner
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/transfer-ownership',
    { preHandler: [requireAuth, requirePublicationOwner()] },
    async (req, reply) => {
      const parsed = TransferOwnershipSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const { id } = req.params
      const currentOwnerId = req.session!.sub
      const { newOwnerId } = parsed.data

      // Verify new owner is an active EiC
      const { rows: newOwner } = await pool.query(
        `SELECT id FROM publication_members
         WHERE publication_id = $1 AND account_id = $2
           AND role = 'editor_in_chief' AND removed_at IS NULL`,
        [id, newOwnerId]
      )
      if (newOwner.length === 0) {
        return reply.status(400).send({ error: 'New owner must be an active Editor-in-Chief' })
      }

      await withTransaction(async (client) => {
        // Remove owner flag from current owner
        await client.query(
          `UPDATE publication_members SET is_owner = FALSE
           WHERE publication_id = $1 AND account_id = $2`,
          [id, currentOwnerId]
        )

        // Set owner flag on new owner
        await client.query(
          `UPDATE publication_members SET is_owner = TRUE
           WHERE publication_id = $1 AND account_id = $2`,
          [id, newOwnerId]
        )
      })

      logger.info({ publicationId: id, from: currentOwnerId, to: newOwnerId }, 'Ownership transferred')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /publications/:id/leave — Self-remove (non-owner)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/publications/:id/leave',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { id } = req.params
      const accountId = req.session!.sub

      const { rows } = await pool.query(
        `SELECT id, is_owner FROM publication_members
         WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [id, accountId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'You are not a member of this publication' })
      }
      if (rows[0].is_owner) {
        return reply.status(403).send({ error: 'The owner cannot leave — transfer ownership first' })
      }

      await pool.query(
        `UPDATE publication_members SET removed_at = now() WHERE id = $1`,
        [rows[0].id]
      )

      // Notify managers
      await pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         SELECT pm.account_id, $1, 'pub_member_left'
         FROM publication_members pm
         WHERE pm.publication_id = $2 AND pm.can_manage_members = TRUE
           AND pm.removed_at IS NULL AND pm.account_id != $1
         ON CONFLICT DO NOTHING`,
        [accountId, id]
      )

      logger.info({ publicationId: id, accountId }, 'Member left publication')
      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/invites/:token — Public invite info
  // ---------------------------------------------------------------------------

  app.get<{ Params: { token: string } }>(
    '/publications/invites/:token',
    async (req, reply) => {
      const { token } = req.params

      const { rows } = await pool.query(
        `SELECT pi.id, pi.role, pi.contributor_type, pi.message, pi.expires_at,
                p.name AS publication_name, p.slug AS publication_slug,
                p.logo_blossom_url AS publication_logo,
                a.display_name AS inviter_name
         FROM publication_invites pi
         JOIN publications p ON p.id = pi.publication_id
         JOIN accounts a ON a.id = pi.invited_by
         WHERE pi.token = $1
           AND pi.accepted_at IS NULL AND pi.declined_at IS NULL
           AND pi.expires_at > now()`,
        [token]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Invite not found or expired' })
      }

      return reply.send(rows[0])
    }
  )
}
