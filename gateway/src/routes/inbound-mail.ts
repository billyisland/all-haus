import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "crypto";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Postmark inbound webhook — receives newsletter emails and enqueues them
// for processing by the feed_ingest_email task.
// =============================================================================

const INBOUND_SECRET = process.env.INBOUND_MAIL_SECRET ?? "";

function secretMatches(candidate: string): boolean {
  if (!INBOUND_SECRET || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(INBOUND_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function inboundMailRoutes(app: FastifyInstance) {
  app.post<{ Params: { secret: string } }>(
    "/inbound-mail/:secret",
    {
      config: { rateLimit: { max: 200, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (!secretMatches(req.params.secret)) {
        return reply.status(200).send({ received: true });
      }

      const payload = req.body as {
        FromFull?: { Email: string; Name: string };
        From?: string;
        ToFull?: Array<{ Email: string; Name: string }>;
        To?: string;
        Subject?: string;
        HtmlBody?: string;
        TextBody?: string;
        MessageID?: string;
        Date?: string;
        Headers?: Array<{ Name: string; Value: string }>;
        Attachments?: Array<{
          Name: string;
          Content: string;
          ContentType: string;
          ContentLength: number;
        }>;
      };

      if (!payload || !payload.MessageID) {
        logger.debug("Inbound mail missing MessageID, discarding");
        return reply.status(200).send({ received: true });
      }

      // Extract all recipient addresses
      const toAddresses: string[] = [];
      if (payload.ToFull && Array.isArray(payload.ToFull)) {
        for (const r of payload.ToFull) {
          if (r.Email) toAddresses.push(r.Email.toLowerCase());
        }
      }
      if (toAddresses.length === 0 && payload.To) {
        const match = payload.To.match(/<([^>]+)>/);
        toAddresses.push((match?.[1] ?? payload.To).toLowerCase());
      }

      if (toAddresses.length === 0) {
        logger.debug("Inbound mail has no recipient addresses, discarding");
        return reply.status(200).send({ received: true });
      }

      // Look up the source by ingest address
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM external_sources
         WHERE ingest_address = ANY($1)
           AND protocol = 'email'
           AND is_active = TRUE
         LIMIT 1`,
        [toAddresses],
      );

      if (rows.length === 0) {
        logger.debug({ to: toAddresses }, "No matching email source");
        return reply.status(200).send({ received: true });
      }

      const sourceId = rows[0].id;

      // Enqueue the email for processing — strip base64 attachment bodies
      // to keep the job payload reasonable.
      const leanPayload = {
        ...payload,
        Attachments: (payload.Attachments ?? []).map((a) => ({
          Name: a.Name,
          ContentType: a.ContentType,
          ContentLength: a.ContentLength,
          Content: "",
        })),
      };

      await pool.query(
        `SELECT graphile_worker.add_job(
          'feed_ingest_email',
          json_build_object('sourceId', $1::text, 'emailPayload', $2::jsonb),
          job_key := 'email_' || $3::text,
          max_attempts := 3
        )`,
        [sourceId, JSON.stringify(leanPayload), payload.MessageID],
      );

      logger.info(
        { sourceId, messageId: payload.MessageID },
        "Email enqueued for ingest",
      );

      return reply.status(200).send({ received: true });
    },
  );
}
