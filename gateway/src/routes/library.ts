import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'

// =============================================================================
// The all.haus library (READING-LOG-AND-LIBRARY-ADR)
//
// GET /my/library?limit=50&offset=0
//   Every piece the reader ACQUIRED through the money system, newest first,
//   with no window. One row per piece, at its earliest acquisition.
//
// WHAT IT HOLDS IS POSSESSION, NOT ATTENTION (D2), and the two are genuinely
// different sets rather than one filtered by the other. A `read_event` is the
// test, whatever it cost:
//
//   - A GIFTED READ COUNTS. The free allowance and the arrival gift are authors
//     letting a new reader over the paywall; the invariant says such a read is
//     charged to nobody and earns nobody, and it does not say the reader did
//     not get the article. If gifts did not count, a new reader's library would
//     be empty on day one — for the reader whose whole introduction to the
//     platform was being given a piece.
//   - A SUBSCRIPTION READ COUNTS (`is_subscription_read`). They paid a
//     subscription and they hold the piece. The test is *acquired*, not
//     *charged for individually*.
//   - AND A PIECE NEED NOT HAVE BEEN OPENED. A fulfilled pledge writes a
//     read_event (drives.ts) without anybody reading anything, so the library is
//     not a subset of Recent reading any more than Recent reading is a subset of
//     it. Recent reading is the other half: /reading-log.
//
// BEHIND AUTH, and the widening-a-gated-read invariant is why it stays there
// (§8.2): a per-reader possession list keyed on the account has no anonymous
// projection — the viewer is not one field of the response, the viewer IS the
// whole content, so a logged-out version is a different page with nothing on it
// rather than a thinner one.
//
// -----------------------------------------------------------------------------
// THIS ROUTE'S PREDECESSOR ANSWERED 500 FOR EVERY CALLER, FOR ITS WHOLE LIFE.
//
// `GET /my/reading-history` ordered by `re.created_at`; the column is and has
// always been `read_at` (`schema.sql` creates it, no migration renames it), so
// every call raised `42703` from the day it was written. The Library's History
// tab had never shown a row.
//
// IT STAYED INVISIBLE BECAUSE EVERY CALLER SWALLOWED IT CORRECTLY. The tab
// renders empty on failure, and the first-session gate that asks "has this
// member read anything?" `.catch(() => false)` by design — a dead gateway must
// not delete a member's one welcome (PAYWALL-ARRIVAL D6). A genuine fault was
// converted into the ordinary negative answer at every call site: the shape the
// root invariant names, "a normal return value must never also mean we are
// broken". Here the swallow was right and the route was wrong, so nothing
// anywhere said so. Found 2026-09-04 by a tour beat that should have fired and
// didn't.
//
// THE LESSON APPLIES TO THIS FILE AND TO /reading-log EQUALLY: both are read by
// gates that swallow failure by design, and D6 still requires that. Neither may
// be believed working because a caller is quiet. Drive them and assert the ROW,
// never the status code.
// =============================================================================

export async function libraryRoutes(app: FastifyInstance) {

  app.get('/my/library', { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub
    const query = req.query as { limit?: string; offset?: string }
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50))
    const offset = Math.max(0, parseInt(query.offset ?? '0', 10) || 0)

    // DISTINCT ON collapses repeat reads of one piece to a single holding, and
    // it takes the EARLIEST — the moment the reader acquired it, which is the
    // fact this tab records. (Recent reading takes the latest, because that tab
    // records attention; the two orderings are the difference between the two
    // surfaces, not an inconsistency.) The outer ORDER BY is newest-acquired
    // first.
    const { rows } = await pool.query<{
      article_id: string
      acquired_at: Date
      title: string | null
      slug: string | null
      nostr_d_tag: string | null
      word_count: number | null
      access_mode: string
      writer_username: string | null
      writer_display_name: string | null
      writer_avatar: string | null
    }>(
      `SELECT *
       FROM (
         SELECT DISTINCT ON (re.article_id)
           re.article_id,
           re.read_at AS acquired_at,
           a.title,
           a.slug,
           a.nostr_d_tag,
           a.word_count,
           a.access_mode,
           w.username          AS writer_username,
           w.display_name      AS writer_display_name,
           w.avatar_blossom_url AS writer_avatar
         FROM read_events re
         JOIN articles a ON a.id = re.article_id AND a.deleted_at IS NULL
         JOIN accounts w ON w.id = a.writer_id
         WHERE re.reader_id = $1
         ORDER BY re.article_id, re.read_at ASC
       ) sub
       ORDER BY acquired_at DESC
       LIMIT $2 OFFSET $3`,
      [readerId, limit, offset]
    )

    const items = rows.map((r) => ({
      articleId: r.article_id,
      acquiredAt: r.acquired_at.toISOString(),
      title: r.title,
      slug: r.slug,
      dTag: r.nostr_d_tag,
      wordCount: r.word_count,
      accessMode: r.access_mode,
      isPaywalled: r.access_mode === 'paywalled',
      writer: {
        username: r.writer_username,
        displayName: r.writer_display_name,
        avatar: r.writer_avatar,
      },
    }))

    return reply.status(200).send({ items })
  })
}
