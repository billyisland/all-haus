import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "crypto";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Postmark inbound webhook — receives newsletter emails and enqueues them
// for processing by the feed_ingest_email task.
//
// A SECRET IN A URL IS A SECRET IN EVERY LOG (MIRROR-AUDIT §3 *Security*, S15).
// The shared secret was a path segment, and Fastify's default request log
// records `req.url` on every request — so `INBOUND_MAIL_SECRET` was written to
// the gateway's log, in plaintext, several times a day, for the life of the
// route. Anything that reads logs read the credential: an operator tailing
// output, a log shipper, a screenshot in a bug report. It is also in nginx's
// access log and in Postmark's own dashboard, neither of which we control.
//
// Two changes, and the first is the one that does not need the operator.
//
//   * `logLevel: "warn"` on the legacy route suppresses Fastify's own
//     request/response lines for it, which is where the disclosure was. The
//     handler's own `logger.info` still fires and carries no secret. This takes
//     effect on deploy with no Postmark reconfiguration, so the leak stops
//     whether or not anybody gets to the second half.
//   * `POST /inbound-mail` reads the same secret out of HTTP basic auth, where
//     credentials belong and where nothing logs them. Postmark supports basic
//     auth on an inbound URL, so this is a one-field change in its dashboard:
//     `https://user:<INBOUND_MAIL_SECRET>@<host>/inbound-mail`.
//
// AND UNTIL 2026-09-10 NEITHER FORM WAS REACHABLE AT ALL. The route is
// registered with no `/api/v1` prefix, and `nginx.conf` had no `location` for
// it — so every delivery fell through to `location /` and Next.js answered a
// 404, which is not a shape anybody would read as "the webhook is misconfigured".
// Email newsletter ingest had therefore never once worked, and the "secret in
// every request log" finding above was only ever true of nginx's access log and
// Postmark's dashboard: nothing reached the gateway to be logged by it. Found
// while writing the operator instructions for repointing Postmark, which is the
// reason to write them out rather than assume the far end is fine. `/rss` had
// the identical gap and was fixed with it; `gateway/tests/nginx-reachability.test.ts`
// is what stops the next one.
//
// Both routes are live and share one handler. The legacy one stays because
// retiring it is the operator's move to make, not a deploy's — a gateway that
// dropped it before Postmark was repointed would silently discard every
// newsletter, and "silently" is the whole problem with this route: it answers
// 200 to everything, by design, so Postmark never retries and a misconfiguration
// looks exactly like a quiet day. Retire it once the basic-auth URL is live and
// the legacy route's counter stops moving.
// =============================================================================

// Read at CALL time, never captured as a module constant with a `?? ""`
// (security.md: the empty string is a well-formed credential every peer
// rejects, and a constant hides whether the variable was ever set). Not a
// `requireEnv` either: the dev gateway carries no INBOUND_MAIL_SECRET, and a
// webhook nobody has configured must not crash-loop the service that also
// serves every page. An unset secret refuses every delivery — and says so.
function inboundSecret(): string | null {
  const raw = process.env.INBOUND_MAIL_SECRET;
  return raw ? raw : null;
}

function secretMatches(secret: string, candidate: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// A REFUSAL ANSWERS 200 (Postmark must not retry a discard), so without a log
// line the only witness to a wrong or missing secret is Postmark's dashboard —
// exactly the silence a rotated secret or a half-done repoint produces. The
// route allows 200/min, so the line is throttled to one per window and carries
// the COUNT of refusals since the last one: a trickle of scanner noise and a
// Postmark that has been refused all morning are then different numbers.
const REFUSAL_LOG_WINDOW_MS = 60_000;
let refusedSinceLog = 0;
let lastRefusalLogAt = 0;

/** @internal exported for tests */
export function _resetRefusalLog(): void {
  refusedSinceLog = 0;
  lastRefusalLogAt = 0;
}

function noteRefusal(reason: "secret_unset" | "credential_mismatch"): void {
  refusedSinceLog += 1;
  const now = Date.now();
  if (now - lastRefusalLogAt < REFUSAL_LOG_WINDOW_MS) return;
  logger.warn(
    { reason, refused: refusedSinceLog },
    reason === "secret_unset"
      ? "Inbound mail refused: INBOUND_MAIL_SECRET is not set, so every delivery is discarded"
      : "Inbound mail refused: the presented credential does not match INBOUND_MAIL_SECRET — check Postmark's inbound URL",
  );
  refusedSinceLog = 0;
  lastRefusalLogAt = now;
}

/** The password half of `Authorization: Basic`. The username is ignored —
 *  Postmark's UI wants both fields filled, and only one of them is the secret. */
function basicAuthSecret(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return "";
  const [scheme, encoded] = raw.split(" ");
  if (!encoded || scheme.toLowerCase() !== "basic") return "";
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? "" : decoded.slice(colon + 1);
}

export async function inboundMailRoutes(app: FastifyInstance) {
  // One handler, two ways in. `presented` is whichever credential the route it
  // arrived on carries; everything below this line is identical either way.
  const handler = async (
    req: FastifyRequest,
    reply: FastifyReply,
    presented: string,
  ) => {
      const secret = inboundSecret();
      if (!secret || !secretMatches(secret, presented)) {
        noteRefusal(secret ? "credential_mismatch" : "secret_unset");
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
  };

  const routeConfig = { rateLimit: { max: 200, timeWindow: "1 minute" } };

  // Fastify's default `bodyLimit` is 1 MiB and Postmark inlines attachments as
  // base64 in the JSON, with its own inbound ceiling at 35 MB — so any
  // newsletter carrying a photo was over the limit before this. Per-route, not
  // global: nothing else on the gateway has any business accepting 40 MB of
  // JSON. It is the twin of `client_max_body_size 40m` in BOTH `/inbound-mail`
  // locations in nginx.conf, and raising either alone only moves which layer
  // 413s the message. The handler strips the base64 bodies before enqueueing, so
  // the size is paid once, on the way in, and never lands in a job payload.
  //
  // AND IT IS A TRIO, NOT A TWIN: the origin sits behind Cloudflare, whose own
  // request-body cap is 100 MB. It binds nothing — largest of the three, and
  // above Postmark's 35 — but it is in the path, and it took a probe request's
  // `remoteAddress` to notice it was there at all (2026-09-10). Count what is in
  // front of the handler rather than the layers you happen to have edited.
  const BODY_LIMIT_BYTES = 40 * 1024 * 1024;

  // The durable form: the secret rides `Authorization`, which nothing logs.
  app.post(
    "/inbound-mail",
    { config: routeConfig, bodyLimit: BODY_LIMIT_BYTES },
    async (req, reply) =>
      handler(req, reply, basicAuthSecret(req.headers.authorization)),
  );

  // The legacy form, kept live until Postmark is repointed. `logLevel: "warn"`
  // is the fix that does not wait for that: it silences Fastify's own
  // request/response lines, which are where the path secret was being written.
  app.post<{ Params: { secret: string } }>(
    "/inbound-mail/:secret",
    { config: routeConfig, bodyLimit: BODY_LIMIT_BYTES, logLevel: "warn" },
    async (req, reply) => handler(req, reply, req.params.secret),
  );
}
