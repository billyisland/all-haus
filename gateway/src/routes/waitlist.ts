import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";

// =============================================================================
// Waitlist Routes — closed-beta waiting list (CLOSED-BETA-ADR Phase 2, D2)
//
// POST /waitlist — capture a prospective user's interest.
//
// AN EMAIL IS THE WHOLE PAYLOAD (2026-07-27). D3's "I'd also like to publish"
// opt-in was removed from the page, this schema, and the two places that
// reported it (the digest email and the admin panel). The answer implied
// nothing about what anyone would be given, and there is no larger interest
// here looking for hints about revenue. Someone joining a waiting list is owed
// a way to be told when it opens, not a survey — so don't reinstate it, and
// don't add another field in its place.
//
// Capture, not a mailto (D2): the stored list is the launch-cohort recruitment
// pipeline. Admitting a waitlister is a manual/next-phase action — this route
// only stores interest.
//
// ENUMERATION-SAFE by construction (D2/D5): the response is a fixed generic
// acknowledgement whether the email is new or already on the list, so the
// waitlist never leaks who is already a member or already waiting — mirroring
// the "if an account exists…" posture on POST /auth/login. The UNIQUE(email)
// constraint (migration 162) turns a repeat into an ON CONFLICT DO NOTHING
// no-op; email is lower-cased before insert so case variants collapse onto one
// row.
//
// Rate-limited like the other unauthenticated auth routes (5/min).
// =============================================================================

export async function waitlistRoutes(app: FastifyInstance) {
  const JoinSchema = z.object({
    // Trim first so a pasted "  you@x.com " passes .email() (Zod validates the
    // raw string) — the route then lower-cases for the unique key.
    // .max(254): the RFC 5321 address ceiling — Zod's .email() doesn't bound
    // length, and this route WRITES the value (a multi-KB "email" would insert
    // a junk row).
    email: z.string().trim().max(254).email(),
    // AN EMAIL IS THE WHOLE PAYLOAD. D3's `publishInterest` was removed
    // 2026-07-27 with the tickbox that set it — see the header note. The schema
    // is not `.strict()`, so a cached client still POSTing the old field is
    // accepted and the field ignored, which is what we want during a rollout;
    // the column simply takes its `false` default.
  });

  app.post(
    "/waitlist",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = JoinSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const email = parsed.data.email.toLowerCase().trim();

      try {
        // Upsert. ON CONFLICT DO NOTHING keeps the endpoint enumeration-safe:
        // a repeat email is a silent no-op and returns the same ack, so a
        // second POST never reveals that the row was already there.
        //
        // `publish_interest` is not written and takes its `false` default. The
        // column is deliberately left in place rather than dropped: the rows
        // that already carry a `true` were answers people actually gave, and
        // deleting an answer is not the same as ceasing to ask. Nothing reads
        // it any more.
        await pool.query(
          `INSERT INTO waitlist (email)
           VALUES ($1)
           ON CONFLICT (email) DO NOTHING`,
          [email],
        );
      } catch (err) {
        // A storage failure must not reveal itself as different from success in
        // a way that aids enumeration, but a 500 here is a genuine fault worth
        // surfacing (the client can retry). Log with a redacted email.
        logger.error(
          { err, email: email.slice(0, 3) + "***" },
          "Waitlist join failed",
        );
        return reply.status(500).send({ error: "Failed to join the list" });
      }

      // Always the same acknowledgement — new or already present.
      return reply.status(200).send({
        ok: true,
        message: "You're on the list. We'll be in touch when we're ready for you.",
      });
    },
  );
}
