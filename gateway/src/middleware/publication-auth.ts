import type { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";

// =============================================================================
// Publication Auth Middleware
//
// Checks that the authenticated user is an active member of the requested
// publication with the required permissions. Attaches the member record to
// req.publicationMember for downstream route handlers.
// =============================================================================

interface PublicationMember {
  id: string;
  publication_id: string;
  account_id: string;
  role: string;
  contributor_type: string;
  title: string | null;
  is_owner: boolean;
  revenue_share_bps: number | null;
  can_publish: boolean;
  can_edit_others: boolean;
  can_manage_members: boolean;
  can_manage_finances: boolean;
  can_manage_settings: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    publicationMember?: PublicationMember;
  }
}

type PermissionKey = keyof Pick<
  PublicationMember,
  | "can_publish"
  | "can_edit_others"
  | "can_manage_members"
  | "can_manage_finances"
  | "can_manage_settings"
>;

// Suspension gate for publication routes that CANNOT use the plugin-level hook
// in routes/publications/index.ts — i.e. routes that live inside another
// plugin's encapsulation context, where a hook would darken innocent siblings.
// Three callers: the two /subscriptions/publication/:id routes (siblings of the
// WRITER subscription routes, which are not suspended) and the publication RSS
// feed (sibling of the writer/platform feeds, likewise not suspended).
//
// 404 rather than 403, matching the plugin hook: the surface is invisible, not
// forbidden. Full reason + restore conditions: shared/src/lib/env.ts.
export function requirePublicationsEnabled() {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!publicationsEnabled()) {
      return reply.status(404).send({ error: "Not found" });
    }
  };
}

export function requirePublicationPermission(
  ...requiredPermissions: PermissionKey[]
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session?.sub;
    const params = req.params as { publicationId?: string; id?: string };
    const publicationId = params.publicationId || params.id;

    if (!userId || !publicationId) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { rows } = await pool.query<PublicationMember>(
      `SELECT * FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, userId],
    );

    if (rows.length === 0) {
      return reply
        .status(403)
        .send({ error: "Not a member of this publication" });
    }

    const member = rows[0];

    for (const perm of requiredPermissions) {
      if (!member[perm]) {
        return reply.status(403).send({
          error: `Missing permission: ${perm}`,
        });
      }
    }

    req.publicationMember = member;
  };
}

export function requirePublicationOwner() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session?.sub;
    const params = req.params as { publicationId?: string; id?: string };
    const publicationId = params.publicationId || params.id;

    if (!userId || !publicationId) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { rows } = await pool.query<PublicationMember>(
      `SELECT * FROM publication_members
       WHERE publication_id = $1 AND account_id = $2
         AND is_owner = TRUE AND removed_at IS NULL`,
      [publicationId, userId],
    );

    if (rows.length === 0) {
      return reply.status(403).send({ error: "Owner access required" });
    }

    req.publicationMember = rows[0];
  };
}
