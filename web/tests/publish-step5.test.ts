import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// The paywalled pipeline's step-5 failure — the one failure in `publishArticle`
// where the article IS ALREADY LIVE.
//
// v2 carries the payload tag and has reached the relay before step 5 runs, so
// a step-5 failure is the opposite of a step-3/4 one: step 3/4 leaves nothing
// live and says so, step 5 leaves the piece live with a stale index row. The
// defect this pins is the two being told apart — a writer told "nothing went
// live" republishes, and a fresh d-tag mints a SECOND live copy.
//
// WHY THERE IS A STEP-3/4 CONTROL: the fix is a message, and a suite whose only
// case is the step-5 one passes just as well against a pipeline that tells
// EVERY failure the article is live — which would be the same defect pointing
// the other way. The control is what makes the assertion about step 5.
//
// The other two assertions are about what did NOT happen: no soft-delete (the
// row is serving a live article) and no second index attempt (the index route
// fires the subscriber broadcast post-commit and marks `email_sent_at` without
// reading it, so a retry after a lost response re-broadcasts to the whole list).
// A message assertion alone passes against a pipeline that retries.
// =============================================================================

const h = vi.hoisted(() => ({
  signAndPublish: vi.fn(),
  signViaGateway: vi.fn(),
  index: vi.fn(),
  remove: vi.fn(),
  setForArticle: vi.fn(),
}))

vi.mock('../src/lib/sign', () => ({
  signAndPublish: h.signAndPublish,
  signViaGateway: h.signViaGateway,
}))

vi.mock('../src/lib/api', () => ({
  articles: { index: h.index, remove: h.remove },
  publications: {},
  tags: { setForArticle: h.setForArticle },
}))

import { publishArticle } from '../src/lib/publish'

const paywalled = {
  title: 'A piece with a gate',
  dek: '',
  content: 'free\n\npaid',
  freeContent: 'free',
  paywallContent: 'paid',
  isPaywalled: true,
  pricePence: 200,
  gatePositionPct: 40,
  commentsEnabled: true,
  showOnWriterProfile: true,
  sendEmail: true,
  tags: [],
  draftId: 'draft-1',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

/** The vault call (step 3) is a bare `fetch`, not one of the mocked modules. */
function vaultSucceeds() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ ciphertext: 'CIPHER', algorithm: 'xchacha20' }),
  })))
}

function vaultFails() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: 'key service down' }),
  })))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.signViaGateway.mockResolvedValue({ id: 'V1-EVENT-ID', created_at: 1_700_000_000 })
  h.signAndPublish.mockResolvedValue({ id: 'V2-EVENT-ID', created_at: 1_700_000_001 })
  h.index.mockResolvedValue({ articleId: 'article-uuid', isNew: true })
  h.remove.mockResolvedValue(undefined)
  vaultSucceeds()
})

describe('paywalled publish — step 5 (the re-index with v2)', () => {
  it('publishes v2 to the relay before step 5 runs, so a step-5 failure is a LIVE article', async () => {
    // Step 2 succeeds, step 5 rejects.
    h.index
      .mockResolvedValueOnce({ articleId: 'article-uuid', isNew: true })
      .mockRejectedValueOnce(new Error('Indexing failed'))

    await expect(publishArticle(paywalled, 'writer-pubkey')).rejects.toThrow()

    // v2 reached the relay — this is what makes the article live.
    expect(h.signAndPublish).toHaveBeenCalledTimes(1)
    const v2 = h.signAndPublish.mock.calls[0][0]
    expect(v2.tags).toContainEqual(['payload', 'CIPHER', 'xchacha20'])
  })

  it('tells the writer the article IS live, and does not borrow step 3/4 words', async () => {
    h.index
      .mockResolvedValueOnce({ articleId: 'article-uuid', isNew: true })
      .mockRejectedValueOnce(new Error('Indexing failed'))

    const err = await publishArticle(paywalled, 'writer-pubkey').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/is live/i)
    // The step-3/4 claim, which is FALSE here and is the defect.
    expect(err.message).not.toMatch(/nothing broken went live/i)
    // It must steer away from a republish, which would mint a second copy.
    expect(err.message).toMatch(/edit/i)
  })

  it('does not soft-delete the row and does not retry the index', async () => {
    h.index
      .mockResolvedValueOnce({ articleId: 'article-uuid', isNew: true })
      .mockRejectedValueOnce(new Error('Indexing failed'))

    await expect(publishArticle(paywalled, 'writer-pubkey')).rejects.toThrow()

    // The row is serving a live article — removing it would unpublish it.
    expect(h.remove).not.toHaveBeenCalled()
    // Exactly two index calls: step 2 and the one step-5 attempt. A third is a
    // retry, and the far end re-broadcasts to every subscriber on one.
    expect(h.index).toHaveBeenCalledTimes(2)
  })

  it('CONTROL — a step-3/4 failure still reports that nothing went live', async () => {
    vaultFails()

    const err = await publishArticle(paywalled, 'writer-pubkey').catch((e) => e)

    expect(err.message).toMatch(/nothing broken went live/i)
    expect(err.message).not.toMatch(/is live/i)
    // Nothing reached the relay, and the new article's row is soft-deleted.
    expect(h.signAndPublish).not.toHaveBeenCalled()
    expect(h.remove).toHaveBeenCalledWith('article-uuid')
  })

  it('CONTROL — a clean paywalled publish re-indexes with v2 and throws nothing', async () => {
    const result = await publishArticle(paywalled, 'writer-pubkey')

    expect(result.articleEventId).toBe('V2-EVENT-ID')
    expect(h.index).toHaveBeenCalledTimes(2)
    // Step 5 is the call that carries the draft and the subscriber email.
    expect(h.index.mock.calls[1][0]).toMatchObject({
      nostrEventId: 'V2-EVENT-ID',
      draftId: 'draft-1',
      sendEmail: true,
    })
    // Step 2 carries neither — a vault failure must not email about a piece
    // that soft-deletes.
    expect(h.index.mock.calls[0][0]).toMatchObject({
      nostrEventId: 'V1-EVENT-ID',
      draftId: undefined,
      sendEmail: false,
    })
  })
})
