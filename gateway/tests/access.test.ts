import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the pool before importing the module under test
const mockQuery = vi.fn()
vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
}))

import { checkArticleAccess } from '../src/services/article-access/access-check.js'

describe('checkArticleAccess', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  const readerId = 'reader-1'
  const articleId = 'article-1'
  const writerId = 'writer-1'

  it('grants access when reader is the writer (own content)', async () => {
    const result = await checkArticleAccess(writerId, articleId, writerId)
    expect(result).toEqual({ hasAccess: true, reason: 'own_content' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('grants access when reader is a publication member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'member-1' }] }) // publication_members

    const result = await checkArticleAccess(readerId, articleId, writerId, 'pub-1')
    expect(result).toEqual({ hasAccess: true, reason: 'own_content' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('continues past publication check when reader is not a member', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // publication_members — not a member
      .mockResolvedValueOnce({ rows: [{ id: 'unlock-1' }] }) // article_unlocks — has unlock

    const result = await checkArticleAccess(readerId, articleId, writerId, 'pub-1')
    expect(result).toEqual({ hasAccess: true, reason: 'already_unlocked' })
  })

  it('grants access for a permanent unlock (previous purchase)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'unlock-1' }] }) // article_unlocks

    const result = await checkArticleAccess(readerId, articleId, writerId)
    expect(result).toEqual({ hasAccess: true, reason: 'already_unlocked' })
  })

  it('grants access via publication subscription', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // publication_members — not a member
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks — no unlock
      .mockResolvedValueOnce({ rows: [{ id: 'sub-1' }] }) // subscriptions (publication)

    const result = await checkArticleAccess(readerId, articleId, writerId, 'pub-1')
    expect(result).toEqual({
      hasAccess: true,
      reason: 'subscription',
      subscriptionId: 'sub-1',
    })
  })

  it('grants access via individual writer subscription', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks — no unlock
      .mockResolvedValueOnce({ rows: [{ id: 'sub-2' }] }) // subscriptions (writer)

    const result = await checkArticleAccess(readerId, articleId, writerId)
    expect(result).toEqual({
      hasAccess: true,
      reason: 'subscription',
      subscriptionId: 'sub-2',
    })
  })

  it('denies access when no conditions are met', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks
      .mockResolvedValueOnce({ rows: [] }) // subscriptions

    const result = await checkArticleAccess(readerId, articleId, writerId)
    expect(result).toEqual({ hasAccess: false })
  })

  it('denies access when all publication paths fail', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // publication_members
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks
      .mockResolvedValueOnce({ rows: [] }) // subscriptions (publication)

    const result = await checkArticleAccess(readerId, articleId, writerId, 'pub-1')
    expect(result).toEqual({ hasAccess: false })
  })

  it('checks publication subscription (not writer) when publicationId is set', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // publication_members
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks
      .mockResolvedValueOnce({ rows: [] }) // subscriptions

    await checkArticleAccess(readerId, articleId, writerId, 'pub-1')

    // The 3rd query should be for publication subscription, not writer
    const subQuery = mockQuery.mock.calls[2]
    expect(subQuery[1]).toEqual([readerId, 'pub-1']) // publication_id, not writer_id
  })

  it('checks writer subscription when no publicationId', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // article_unlocks
      .mockResolvedValueOnce({ rows: [] }) // subscriptions

    await checkArticleAccess(readerId, articleId, writerId)

    // The 2nd query should be for writer subscription
    const subQuery = mockQuery.mock.calls[1]
    expect(subQuery[1]).toEqual([readerId, writerId])
  })
})
