import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";

// =============================================================================
// Trust Routes (Phases 1 + 2)
//
// GET    /trust/:userId — Layer 1 signals + Layer 2 dimension scores +
//                         public endorsements + Layer 4 relational data
// POST   /vouches       — create or update a vouch
// DELETE /vouches/:id   — withdraw a vouch (soft-delete)
// GET    /my/vouches    — list vouches by the authenticated user
// =============================================================================

const DIMENSIONS = ["humanity", "encounter", "identity", "integrity"] as const;
const VALUES = ["affirm", "contest"] as const;
const VISIBILITIES = ["public", "aggregate"] as const;

type Dimension = (typeof DIMENSIONS)[number];
type VouchValue = (typeof VALUES)[number];
type Visibility = (typeof VISIBILITIES)[number];


export async function trustRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /trust/:userId — full trust profile
  // ---------------------------------------------------------------------------

  app.get<{ Params: { userId: string } }>(
    "/trust/:userId",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { userId } = req.params;
      const viewerId = req.session?.sub;

      // Layer 1
      const { rows: l1Rows } = await pool.query(
        `SELECT account_age_days, paying_reader_count, article_count,
                payment_verified, nip05_verified, pip_status, computed_at
         FROM trust_layer1
         WHERE user_id = $1`,
        [userId],
      );

      if (l1Rows.length === 0) {
        return reply.status(404).send({ error: "No trust data for this user" });
      }

      const l1 = l1Rows[0];

      // Layer 2 dimension scores (from trust_profiles, populated by Phase 4 cron)
      const { rows: dimRows } = await pool.query(
        `SELECT dimension, score, attestation_count
         FROM trust_profiles
         WHERE user_id = $1`,
        [userId],
      );

      const hasEpochScores = dimRows.length > 0;

      const dimensions: Record<
        string,
        { score: number; attestationCount: number }
      > = {};
      for (const d of DIMENSIONS) {
        const row = dimRows.find((r) => r.dimension === d);
        dimensions[d] = {
          score: row ? parseFloat(row.score) : 0,
          attestationCount: row ? row.attestation_count : 0,
        };
      }

      // Live vouch counts as fallback when epoch aggregation hasn't run yet
      if (!hasEpochScores) {
        const { rows: liveRows } = await pool.query(
          `SELECT dimension,
                  COUNT(*) FILTER (WHERE value = 'affirm') AS affirm_count,
                  COUNT(*) FILTER (WHERE value = 'contest') AS contest_count
           FROM vouches
           WHERE subject_id = $1 AND withdrawn_at IS NULL
           GROUP BY dimension`,
          [userId],
        );
        for (const row of liveRows) {
          if (dimensions[row.dimension]) {
            dimensions[row.dimension].attestationCount =
              parseInt(row.affirm_count, 10) + parseInt(row.contest_count, 10);
          }
        }
      }

      // Slice 18: encounter affirm count — separate from the dimension's
      // mixed affirm+contest `attestationCount`. The pip composer treats
      // encounter as the "hard upgrade path to green" and the panel surfaces
      // the count as a distinct line ("Met by N writers in person").
      // Visibility-agnostic: aggregate-visibility encounters still count toward
      // the in-person tally, even though their attestor identity is hidden.
      const { rows: encounterRows } = await pool.query(
        `SELECT COUNT(*)::int AS affirm_count
         FROM vouches
         WHERE subject_id = $1
           AND dimension = 'encounter'
           AND value = 'affirm'
           AND withdrawn_at IS NULL`,
        [userId],
      );
      const encounterAffirmCount = encounterRows[0]?.affirm_count ?? 0;

      // Public endorsements
      const { rows: endorsements } = await pool.query(
        `SELECT v.id, v.dimension, v.value, v.created_at,
                a.id AS attestor_id, a.username AS attestor_username,
                a.display_name AS attestor_display_name,
                a.avatar_blossom_url AS attestor_avatar
         FROM vouches v
         JOIN accounts a ON a.id = v.attestor_id
         WHERE v.subject_id = $1
           AND v.visibility = 'public'
           AND v.withdrawn_at IS NULL
         ORDER BY v.created_at DESC`,
        [userId],
      );

      const publicEndorsements = endorsements.map((e) => ({
        id: e.id,
        dimension: e.dimension,
        value: e.value,
        createdAt: e.created_at,
        attestor: {
          id: e.attestor_id,
          username: e.attestor_username,
          displayName: e.attestor_display_name,
          avatar: e.attestor_avatar,
        },
      }));

      // Layer 4 relational data (only for authenticated viewers)
      let layer4 = null;
      if (viewerId && viewerId !== userId) {
        // Viewer's valued set: writers they follow or subscribe to
        const { rows: networkEndorsements } = await pool.query(
          `SELECT v.dimension, v.value,
                  a.id AS attestor_id, a.username AS attestor_username,
                  a.display_name AS attestor_display_name,
                  a.avatar_blossom_url AS attestor_avatar
           FROM vouches v
           JOIN accounts a ON a.id = v.attestor_id
           WHERE v.subject_id = $1
             AND v.visibility = 'public'
             AND v.withdrawn_at IS NULL
             AND v.attestor_id IN (
               SELECT followee_id FROM follows WHERE follower_id = $2
               UNION
               SELECT writer_id FROM subscriptions WHERE reader_id = $2 AND status = 'active'
             )`,
          [userId, viewerId],
        );

        if (networkEndorsements.length > 0) {
          const attributed = networkEndorsements.map((e) => ({
            attestor: {
              id: e.attestor_id,
              username: e.attestor_username,
              displayName: e.attestor_display_name,
              avatar: e.attestor_avatar,
            },
            dimension: e.dimension,
            value: e.value,
          }));

          // Generate summary text
          const affirmCount = networkEndorsements.filter(
            (e) => e.value === "affirm",
          ).length;
          const uniqueAttestors = new Set(
            networkEndorsements.map((e) => e.attestor_id),
          ).size;
          const networkSays =
            affirmCount > 0
              ? `${uniqueAttestors} writer${uniqueAttestors !== 1 ? "s" : ""} you follow publicly endorse${uniqueAttestors === 1 ? "s" : ""} this person.`
              : "No one in your network has publicly endorsed this person.";

          layer4 = { networkSays, attributedEndorsements: attributed };
        } else {
          layer4 = {
            networkSays:
              "No one in your network has publicly endorsed this person.",
            attributedEndorsements: [],
          };
        }
      }

      // Viewer's own vouches for this subject (so UI can show existing state)
      let viewerVouches: Array<{
        id: string;
        dimension: string;
        value: string;
        visibility: string;
      }> = [];
      if (viewerId && viewerId !== userId) {
        const { rows } = await pool.query(
          `SELECT id, dimension, value, visibility
           FROM vouches
           WHERE attestor_id = $1 AND subject_id = $2 AND withdrawn_at IS NULL`,
          [viewerId, userId],
        );
        viewerVouches = rows;
      }

      return reply.send({
        userId,
        layer1: {
          accountAgeDays: l1.account_age_days,
          payingReaderCount: l1.paying_reader_count,
          articleCount: l1.article_count,
          paymentVerified: l1.payment_verified,
          nip05Verified: l1.nip05_verified,
          pipStatus: l1.pip_status,
          computedAt: l1.computed_at,
        },
        dimensions,
        encounter: { affirmCount: encounterAffirmCount },
        publicEndorsements,
        layer4,
        viewerVouches,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /vouches — create or update a vouch
  // ---------------------------------------------------------------------------

  app.post<{
    Body: {
      subjectId: string;
      dimension: Dimension;
      value: VouchValue;
      visibility: Visibility;
    };
  }>("/vouches", { preHandler: requireAuth }, async (req, reply) => {
    const attestorId = req.session!.sub;
    const { subjectId, dimension, value, visibility } = req.body ?? ({} as any);

    // Validate inputs
    if (!subjectId || !UUID_RE.test(subjectId)) {
      return reply.status(400).send({ error: "Invalid subjectId" });
    }
    if (!DIMENSIONS.includes(dimension as any)) {
      return reply
        .status(400)
        .send({
          error: `Invalid dimension. Must be one of: ${DIMENSIONS.join(", ")}`,
        });
    }
    if (!VALUES.includes(value as any)) {
      return reply
        .status(400)
        .send({ error: `Invalid value. Must be one of: ${VALUES.join(", ")}` });
    }
    if (!VISIBILITIES.includes(visibility as any)) {
      return reply
        .status(400)
        .send({
          error: `Invalid visibility. Must be one of: ${VISIBILITIES.join(", ")}`,
        });
    }
    if (attestorId === subjectId) {
      return reply.status(400).send({ error: "Cannot vouch for yourself" });
    }
    if (value === "contest" && visibility === "public") {
      return reply
        .status(400)
        .send({ error: "Contests must use aggregate visibility" });
    }

    // Check subject exists
    const { rowCount } = await pool.query(
      "SELECT 1 FROM accounts WHERE id = $1 AND status = 'active'",
      [subjectId],
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: "Subject not found" });
    }

    // Upsert: one vouch per attestor/subject/dimension
    // Reaffirmation resets decay counters (epochs_since_reaffirm, last_reaffirmed_at)
    const { rows } = await pool.query(
      `INSERT INTO vouches (attestor_id, subject_id, dimension, value, visibility)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (attestor_id, subject_id, dimension)
         DO UPDATE SET value = $4, visibility = $5,
                       created_at = now(), withdrawn_at = NULL,
                       last_reaffirmed_at = now(), epochs_since_reaffirm = 0
         RETURNING id, attestor_id, subject_id, dimension, value, visibility, created_at`,
      [attestorId, subjectId, dimension, value, visibility],
    );

    return reply.status(201).send(rows[0]);
  });

  // ---------------------------------------------------------------------------
  // DELETE /vouches/:id — withdraw a vouch (soft-delete)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    "/vouches/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const attestorId = req.session!.sub;
      const { id } = req.params;

      if (!UUID_RE.test(id)) {
        return reply.status(400).send({ error: "Invalid vouch ID" });
      }

      const { rowCount } = await pool.query(
        `UPDATE vouches SET withdrawn_at = now()
         WHERE id = $1 AND attestor_id = $2 AND withdrawn_at IS NULL`,
        [id, attestorId],
      );

      if (rowCount === 0) {
        return reply
          .status(404)
          .send({ error: "Vouch not found or already withdrawn" });
      }

      return reply.status(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /my/vouches — list vouches by the authenticated user
  // ---------------------------------------------------------------------------

  app.get("/my/vouches", { preHandler: requireAuth }, async (req, reply) => {
    const attestorId = req.session!.sub;

    const { rows } = await pool.query(
      `SELECT v.id, v.dimension, v.value, v.visibility, v.created_at,
                a.id AS subject_id, a.username AS subject_username,
                a.display_name AS subject_display_name,
                a.avatar_blossom_url AS subject_avatar
         FROM vouches v
         JOIN accounts a ON a.id = v.subject_id
         WHERE v.attestor_id = $1 AND v.withdrawn_at IS NULL
         ORDER BY v.created_at DESC`,
      [attestorId],
    );

    const vouches = rows.map((r) => ({
      id: r.id,
      dimension: r.dimension,
      value: r.value,
      visibility: r.visibility,
      createdAt: r.created_at,
      subject: {
        id: r.subject_id,
        username: r.subject_username,
        displayName: r.subject_display_name,
        avatar: r.subject_avatar,
      },
    }));

    return reply.send({ vouches });
  });

  // ---------------------------------------------------------------------------
  // Slice 15 — three-question polls (humanity / authenticity / good_faith)
  //
  // GET    /trust/polls/:userId — aggregate yes/no counts per question + the
  //                               viewer's own answer (or null)
  // POST   /trust/polls/:userId — body { question, answer } — upsert
  // DELETE /trust/polls/:userId — body { question } — withdraw
  //
  // Anonymity: the GET response carries only aggregate counts + the viewer's
  // own row. No other respondent's identity ever ships. The full anonymous
  // attestation pipeline (per ADR-OMNIBUS §III.7) replaces this surface when
  // it lands; the route shape is forward-compatible because clients only see
  // counts.
  // ---------------------------------------------------------------------------
  const POLL_QUESTIONS = ["humanity", "authenticity", "good_faith"] as const;
  type PollQuestion = (typeof POLL_QUESTIONS)[number];

  app.get<{ Params: { userId: string } }>(
    "/trust/polls/:userId",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { userId } = req.params;
      if (!UUID_RE.test(userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const viewerId = req.session?.sub ?? null;

      const { rows: subjectRows } = await pool.query(
        `SELECT id FROM accounts WHERE id = $1`,
        [userId],
      );
      if (subjectRows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      const aggResult = await pool.query<{
        question: PollQuestion;
        answer: "yes" | "no";
        count: string;
      }>(
        `SELECT question, answer, COUNT(*)::text AS count
           FROM trust_polls
           WHERE subject_id = $1
           GROUP BY question, answer`,
        [userId],
      );

      const viewerResult = viewerId
        ? await pool.query<{ question: PollQuestion; answer: "yes" | "no" }>(
            `SELECT question, answer
               FROM trust_polls
               WHERE subject_id = $1 AND respondent_id = $2`,
            [userId, viewerId],
          )
        : { rows: [] as { question: PollQuestion; answer: "yes" | "no" }[] };

      const polls: Record<
        PollQuestion,
        { yes: number; no: number; viewerAnswer: "yes" | "no" | null }
      > = {
        humanity: { yes: 0, no: 0, viewerAnswer: null },
        authenticity: { yes: 0, no: 0, viewerAnswer: null },
        good_faith: { yes: 0, no: 0, viewerAnswer: null },
      };

      for (const row of aggResult.rows) {
        if (!POLL_QUESTIONS.includes(row.question)) continue;
        polls[row.question][row.answer] = parseInt(row.count, 10);
      }
      for (const row of viewerResult.rows) {
        if (!POLL_QUESTIONS.includes(row.question)) continue;
        polls[row.question].viewerAnswer = row.answer;
      }

      return reply.send({ subjectId: userId, polls });
    },
  );

  app.post<{ Params: { userId: string }; Body: unknown }>(
    "/trust/polls/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const respondentId = req.session!.sub;
      const { userId } = req.params;
      if (!UUID_RE.test(userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      if (userId === respondentId) {
        return reply.status(400).send({ error: "Cannot poll yourself" });
      }
      const body = (req.body ?? {}) as { question?: string; answer?: string };
      if (
        !body.question ||
        !POLL_QUESTIONS.includes(body.question as PollQuestion)
      ) {
        return reply.status(400).send({ error: "Invalid question" });
      }
      if (!body.answer || (body.answer !== "yes" && body.answer !== "no")) {
        return reply.status(400).send({ error: "Invalid answer" });
      }

      const { rows: subjectRows } = await pool.query(
        `SELECT id FROM accounts WHERE id = $1`,
        [userId],
      );
      if (subjectRows.length === 0) {
        return reply.status(404).send({ error: "User not found" });
      }

      await pool.query(
        `INSERT INTO trust_polls (respondent_id, subject_id, question, answer)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (respondent_id, subject_id, question)
         DO UPDATE SET answer = EXCLUDED.answer, updated_at = now()`,
        [respondentId, userId, body.question, body.answer],
      );
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: { userId: string }; Body: unknown }>(
    "/trust/polls/:userId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const respondentId = req.session!.sub;
      const { userId } = req.params;
      if (!UUID_RE.test(userId)) {
        return reply.status(400).send({ error: "Invalid user id" });
      }
      const body = (req.body ?? {}) as { question?: string };
      if (
        !body.question ||
        !POLL_QUESTIONS.includes(body.question as PollQuestion)
      ) {
        return reply.status(400).send({ error: "Invalid question" });
      }

      await pool.query(
        `DELETE FROM trust_polls
         WHERE respondent_id = $1 AND subject_id = $2 AND question = $3`,
        [respondentId, userId, body.question],
      );
      return reply.status(204).send();
    },
  );
}
