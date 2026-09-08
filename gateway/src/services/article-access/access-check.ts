import { pool } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Article Access Checker
//
// Determines whether a reader has free access to a paywalled article.
// Checked before the payment flow in the gate-pass orchestrator.
//
// Free access granted if:
//   1. Reader is the article's author (own content)
//   2. Reader is a member of the article's Publication
//   3. Reader has a permanent unlock (previous purchase or subscription read)
//   4. Reader has an active/valid subscription to the writer/publication
//
// Returns { hasAccess: true, reason: '...' } or { hasAccess: false }
// =============================================================================

interface AccessCheckResult {
  hasAccess: boolean
  reason?: 'own_content' | 'already_unlocked' | 'subscription'
  subscriptionId?: string
}

export async function checkArticleAccess(
  readerId: string,
  articleId: string,
  writerId: string,
  publicationId?: string | null,
): Promise<AccessCheckResult> {

  // 1. Own content — always free
  if (readerId === writerId) {
    return { hasAccess: true, reason: 'own_content' }
  }

  // 2. Publication member — members read their own Publication's content free
  if (publicationId) {
    const memberResult = await pool.query<{ id: string }>(
      `SELECT id FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, readerId]
    )
    if (memberResult.rows.length > 0) {
      return { hasAccess: true, reason: 'own_content' }
    }
  }

  // 3. Permanent unlock — already purchased or read via subscription
  const unlockResult = await pool.query<{ id: string }>(
    `SELECT id FROM article_unlocks
     WHERE reader_id = $1 AND article_id = $2`,
    [readerId, articleId]
  )

  if (unlockResult.rows.length > 0) {
    return { hasAccess: true, reason: 'already_unlocked' }
  }

  // 4. Subscription — check Publication or individual writer
  if (publicationId) {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND publication_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, publicationId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  } else {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND writer_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, writerId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  }

  return { hasAccess: false }
}

// =============================================================================
// The same question, asked about a PAGE of articles at once.
//
// `checkArticleAccess` is 1–3 SEQUENTIAL round-trips, which is fine for the one
// article a gate pass is about and is not fine for a paged log: the profile's
// Replies view pages at 50, so a call per row is up to ~150 sequential queries
// on an anonymous-reachable route. This resolves the whole page in at most four
// queries, whatever its size, and returns the set of article ids the reader CAN
// read.
//
// IT MUST AGREE WITH `checkArticleAccess` ABOVE, CASE FOR CASE — same four
// grants, same subscription branch (a publication article is answered by a
// PUBLICATION subscription and never by a writer one). Two implementations of
// one rule is the hazard here; they are in the same file so that a change to
// either is read beside the other, and `gateway/tests/root-locked-parity.test.ts`
// runs BOTH over the same seeded fixtures and requires them to answer
// identically, article by article. It is DB-backed because the two differ in
// their SQL and not in their TypeScript — `ANY($2::uuid[])` against four separate
// reads, one subscription query with an OR against two branches — so a mocked
// `pool.query` would be TOLD they agree. Collapsing the branch below to a union
// reddens it; before it existed that mutation left all forty tests over these
// surfaces green, both other pins being mocked and neither seeding a publication
// article.
//
// An ANONYMOUS reader (readerId null) can read none of them — no query is run
// at all, which is the whole of the anonymous path's cost.
// ARTICLE-HEADED-CONVERSATIONS-ADR item 8.
// =============================================================================

export interface ArticleAccessSubject {
  id: string
  writerId: string
  publicationId: string | null
}

export async function checkArticleAccessSet(
  readerId: string | null,
  articles: ArticleAccessSubject[],
): Promise<Set<string>> {
  const granted = new Set<string>()
  if (!readerId || articles.length === 0) return granted

  // 1. Own content
  const rest = articles.filter((a) => {
    if (a.writerId === readerId) {
      granted.add(a.id)
      return false
    }
    return true
  })
  if (rest.length === 0) return granted

  const ids = rest.map((a) => a.id)
  const pubIds = [
    ...new Set(rest.map((a) => a.publicationId).filter((p): p is string => !!p)),
  ]
  const writerIds = [...new Set(rest.map((a) => a.writerId))]

  const [members, unlocks, subs] = await Promise.all([
    // 2. Publication member
    pubIds.length
      ? pool.query<{ publication_id: string }>(
          `SELECT publication_id FROM publication_members
           WHERE account_id = $1 AND publication_id = ANY($2::uuid[])
             AND removed_at IS NULL`,
          [readerId, pubIds],
        )
      : Promise.resolve({ rows: [] as { publication_id: string }[] }),
    // 3. Permanent unlock
    pool.query<{ article_id: string }>(
      `SELECT article_id FROM article_unlocks
       WHERE reader_id = $1 AND article_id = ANY($2::uuid[])`,
      [readerId, ids],
    ),
    // 4. Subscription — writer or publication, in ONE read
    pool.query<{ writer_id: string | null; publication_id: string | null }>(
      `SELECT writer_id, publication_id FROM subscriptions
       WHERE reader_id = $1
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()
         AND (writer_id = ANY($2::uuid[]) OR publication_id = ANY($3::uuid[]))`,
      [readerId, writerIds, pubIds],
    ),
  ])

  const memberOf = new Set(members.rows.map((r) => r.publication_id))
  const unlocked = new Set(unlocks.rows.map((r) => r.article_id))
  const subWriters = new Set(
    subs.rows.map((r) => r.writer_id).filter((w): w is string => !!w),
  )
  const subPubs = new Set(
    subs.rows.map((r) => r.publication_id).filter((p): p is string => !!p),
  )

  for (const a of rest) {
    if (a.publicationId && memberOf.has(a.publicationId)) granted.add(a.id)
    else if (unlocked.has(a.id)) granted.add(a.id)
    // The branch, not a union: a publication article is answered by a
    // publication subscription only, exactly as the single-article checker does.
    else if (a.publicationId ? subPubs.has(a.publicationId) : subWriters.has(a.writerId))
      granted.add(a.id)
  }

  return granted
}
