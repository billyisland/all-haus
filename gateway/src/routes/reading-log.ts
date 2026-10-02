import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { FEED_SELECT, FEED_JOINS } from "../lib/feed-sql.js";
import { POST_SELECT, POST_JOINS, feedItemToPost } from "../lib/post-mapper.js";
import { parseLimit, parseOffset } from "../lib/request-inputs.js";
import { readingLogRetentionDays } from "../workers/reading-log-sweep.js";

// =============================================================================
// Recent reading (READING-LOG-AND-LIBRARY-ADR)
//
//   POST   /reading-log   { postId }  — record an open
//   GET    /reading-log               — the reader's own log, newest first
//   DELETE /reading-log               — clear everything (D1)
//
// The log is a RECEIPT OF ATTENTION and its twin, the library (/my/library), is
// a record of possession. Neither is a filter of the other: a piece can be read
// and not acquired (a Path C arrival, a free article), and a piece can be
// acquired and never opened (a subscription read, a fulfilled pledge).
//
// IT IS THE READER'S AND NOBODY ELSE'S (D1). No writer-facing read, nothing in
// the owner dashboard, nothing in an export a third party receives. Every route
// here is `requireAuth` and scoped to `req.session.sub` — there is no route that
// takes a user id.
//
// ONE ROW PER PIECE, AT ITS LATEST OPEN (D3), and that is enforced at the WRITE
// by the primary key rather than at the read by a DISTINCT ON. Re-opening a
// piece moves it up the list; it does not add to it. That is what bounds the
// table by pieces-opened rather than by opens.
// =============================================================================

const POST_ID_RE = /^[0-9a-f]{64}$/;

const RecordSchema = z.object({
  // The unified key (D7/D8). Native readers get it from the article-metadata
  // payload's `postId`; external readers already hold it — it is their URL.
  postId: z.string().regex(POST_ID_RE, "expected a 64-char hex post_id"),
});

const MAX_LIMIT = 100;

export async function readingLogRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /reading-log — record an open.
  //
  // FIRE-AND-FORGET BY CONTRACT, ON THE CALLER'S SIDE AND OURS. A failed log
  // write loses a row; a log write that can fail an open costs the reader the
  // piece. So this never touches the read path, and the client never awaits it
  // before rendering.
  //
  // IT HANGS OFF READER MOUNT, NOT OFF UNLOCK, and that is load-bearing rather
  // than incidental (§8.3). A write hung off the unlock would look identical in
  // every ordinary session and would silently drop the above-cap arrival
  // (PAYWALL-ARRIVAL D4 Path C): a reader who met the paywall, read what sits
  // above it, and by §8.1 has a true row and a tour beat pointing at it.
  // Recent reading is attention; the library is possession; the gate is what
  // separates them, and it separates the two tabs rather than the log from
  // itself.
  //
  // WE DO NOT VERIFY THE post_id RESOLVES. The write is on the reader's hot
  // path and the log is their own; a row that resolves to nothing is skipped at
  // render (D7's corollary) exactly as a deleted piece is. Checking here would
  // buy a foreign-key feeling the schema cannot give us — feed_items.post_id
  // has no unique constraint — at the cost of a join on every open.
  // ---------------------------------------------------------------------------
  app.post("/reading-log", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = RecordSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send(zodValidationError(parsed.error));

    // The D1 switch. Checked here rather than in the client so that switching
    // logging off stops the writes even for a tab that was already open — and
    // so that "stop logging" means the server stops recording, which is the
    // only version of that promise worth making.
    const { rowCount } = await pool.query(
      `INSERT INTO reading_log (user_id, post_id, opened_at)
       SELECT $1, $2, now()
        WHERE EXISTS (
          SELECT 1 FROM accounts
           WHERE id = $1 AND reading_log_enabled AND status <> 'deleted'
        )
       ON CONFLICT (user_id, post_id)
       DO UPDATE SET opened_at = now()`,
      [req.session!.sub, parsed.data.postId],
    );

    return reply.status(200).send({ ok: true, logged: rowCount === 1 });
  });

  // ---------------------------------------------------------------------------
  // GET /reading-log — the reader's own log, newest first.
  //
  // Projects through the same feed_items → Post mapper every other reading
  // surface uses, so a logged piece renders as the card it always was, native
  // or external, with no second shape to keep in step.
  //
  // THREE THINGS ABOUT THE JOIN. It PAGES THE LOG FIRST and joins afterwards, so
  // a page can come back shorter than `limit` when some of its rows no longer
  // resolve — that is D7's corollary working, not an error, and the client
  // pages on what it asked for rather than on what came back. And it is
  // DISTINCT ON the log's post_id, which is not the D3 dedup (the primary key
  // did that at the write): feed_items.post_id carries no unique constraint, so
  // nothing at the type level stops two rows sharing one, and a log page that
  // silently doubled a piece would be a puzzling thing to debug later.
  //
  // AND `hasMore` IS THE SERVER'S ANSWER, COMPUTED FROM THE LOG AND NEVER FROM
  // THE SURVIVORS. That is the same rule as the offset one, applied to the other
  // half of the answer — and it is the half that was missed. The client used to
  // ask for `PAGE_SIZE + 1` and read "there is more" off the count that came
  // BACK; one unresolvable row anywhere in a page makes that count short, so the
  // reader is told their log has ended when it has not. The failure is silent and
  // reassuring in the usual direction: it can only ever hide rows, and a log that
  // stops early is indistinguishable from a log that stopped.
  //
  // It is a SECOND STATEMENT rather than a `COUNT(*) OVER ()` inside `page`,
  // which would count only the window it is computed over — the same mistake one
  // level in. `LIMIT 1 OFFSET (limit + offset)` reads at most one row past the
  // page and answers the only question being asked.
  // ---------------------------------------------------------------------------
  app.get("/reading-log", { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = parseLimit(q.limit, 50, MAX_LIMIT);
    const offset = parseOffset(q.offset);

    const [{ rows }, more] = await Promise.all([
      pool.query<any>(
        `WITH page AS (
         SELECT post_id, opened_at
           FROM reading_log
          WHERE user_id = $1
          ORDER BY opened_at DESC
          LIMIT $2 OFFSET $3
       )
       SELECT DISTINCT ON (page.post_id)
              ${FEED_SELECT}${POST_SELECT},
              EXTRACT(EPOCH FROM page.opened_at)::bigint AS opened_at_epoch
         FROM page
         JOIN feed_items fi
           ON fi.post_id = page.post_id AND fi.deleted_at IS NULL
         ${FEED_JOINS}
         ${POST_JOINS}
        ORDER BY page.post_id, fi.id`,
        [req.session!.sub, limit, offset],
      ),
      pool.query(
        `SELECT 1 FROM reading_log
          WHERE user_id = $1
          ORDER BY opened_at DESC
          LIMIT 1 OFFSET $2`,
        [req.session!.sub, limit + offset],
      ),
    ]);

    // Sorted here rather than in SQL because DISTINCT ON dictates the ORDER BY.
    // The page is at most MAX_LIMIT rows.
    const items = rows
      .sort((a, b) => Number(b.opened_at_epoch) - Number(a.opened_at_epoch))
      .map((r) => ({
        openedAt: new Date(Number(r.opened_at_epoch) * 1000).toISOString(),
        post: feedItemToPost(r),
      }));

    // THE WINDOW IS THE DIAL'S, and it rides the response because the client
    // has a sentence to write with it ("Nothing read in the last seven days").
    // That was a literal, so retuning `reading_log_retention_days` would have
    // left the empty state naming a window nobody uses any more — and this is
    // the one surface whose entire subject IS the window. Same reader as the
    // sweep, so the number the copy names is the number the sweep enforces.
    return reply.status(200).send({
      items,
      hasMore: (more.rowCount ?? 0) > 0,
      retentionDays: await readingLogRetentionDays(),
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /reading-log — D1's "clear everything".
  //
  // Unconditional and immediate. This is the control that makes the on-by-
  // default posture honest, so it deletes rather than hides, and it does not
  // ask twice on the server — the surface asks.
  // ---------------------------------------------------------------------------
  app.delete("/reading-log", { preHandler: requireAuth }, async (req, reply) => {
    const { rowCount } = await pool.query(
      `DELETE FROM reading_log WHERE user_id = $1`,
      [req.session!.sub],
    );
    return reply.status(200).send({ ok: true, deleted: rowCount ?? 0 });
  });
}
