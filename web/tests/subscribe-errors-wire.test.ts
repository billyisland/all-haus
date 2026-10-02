import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mapSubscribeError } from '../src/lib/subscribe-errors'
import { ApiError } from '../src/lib/api/client'

// The codes the mapper branches on are the gateway's — a TYPE IS NOT A
// CONTRACT, so each is read out of the route that sends it and the match is
// asserted FOUND. A renamed code would otherwise fall through to the generic
// line and a declined card-holder would be told "try again", for ever.
const WRITER_ROUTE = join(__dirname, '../../gateway/src/routes/subscriptions/writer.ts')

describe('subscribe refusal codes are the route’s own', () => {
  const route = readFileSync(WRITER_ROUTE, 'utf8')
  for (const code of ['card_required', 'card_action_required', 'not_for_sale']) {
    it(`the writer subscribe route sends ${code}`, () => {
      expect(route).toMatch(new RegExp(`error: '${code}'`))
    })
  }
})

describe('mapSubscribeError', () => {
  it('a declined card is not told to add one', () => {
    const v = mapSubscribeError(new ApiError(402, { error: 'card_action_required' }))
    expect(v.message).toMatch(/declined/)
    expect(v.message).not.toMatch(/Add a payment card/)
    expect(v.needsTerms).toBe(false)
  })

  it('no card on file is told to add one', () => {
    const v = mapSubscribeError(new ApiError(402, { error: 'card_required' }))
    expect(v.message).toMatch(/Add a payment card/)
  })

  it('the Reader Terms refusal asks for the consent', () => {
    const v = mapSubscribeError(new ApiError(403, { error: 'reader_terms_required', message: 'Accept.' }))
    expect(v.needsTerms).toBe(true)
  })

  it('not_for_sale carries the route’s sentence', () => {
    const v = mapSubscribeError(new ApiError(403, { error: 'not_for_sale', message: 'Not on sale.' }))
    expect(v.message).toBe('Not on sale.')
  })

  it('a sentence in `error` is shown; a code or a raw ApiError string is not', () => {
    expect(mapSubscribeError(new ApiError(409, { error: 'Already subscribed' })).message).toBe('Already subscribed')
    expect(mapSubscribeError(new ApiError(500, { error: 'internal_error' })).message).not.toMatch(/internal_error/)
    expect(mapSubscribeError(new TypeError('Failed to fetch')).message).toMatch(/nothing has been charged/i)
  })
})

// ONE CLIENT (CA-J3). Every surface that checks, starts or cancels a
// subscription goes through `lib/api/subscriptions.ts`, so its refusals reach
// the mapper as ApiErrors. A hand-rolled fetch is how the paywall came to read
// only the status (CA-E6), so the pin is a grep over web/src.
describe('the subscriptions client is the only door', () => {
  const SRC = join(__dirname, '../src')
  const CLIENT = join(SRC, 'lib/api/subscriptions.ts')
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (statSync(f).isDirectory()) walk(f)
      else if (/\.tsx?$/.test(n)) files.push(f)
    }
  }
  walk(SRC)

  it('no web surface fetches /api/v1/subscriptions by hand', () => {
    expect(files.length).toBeGreaterThan(200)
    const offenders = files.filter(
      (f) => f !== CLIENT && /api\/v1\/subscriptions\//.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('the paywall Subscribe goes through the client AND the mapper', () => {
    const reader = readFileSync(join(SRC, 'components/article/ArticleReader.tsx'), 'utf8')
    expect(reader).toMatch(/subscriptionsApi\.subscribe\(writerId\)/)
    expect(reader).toMatch(/mapSubscribeError\(err\)/)
  })

  it('the client’s three paths are the route’s own', () => {
    const route = readFileSync(WRITER_ROUTE, 'utf8')
    const client = readFileSync(CLIENT, 'utf8')
    expect(route).toMatch(/app\.get<[^>]*>\(\s*'\/subscriptions\/check\/:writerId'/)
    expect(route).toMatch(/app\.post<[^>]*>\(\s*'\/subscriptions\/:writerId'/)
    expect(route).toMatch(/app\.delete<[^>]*>\(\s*'\/subscriptions\/:writerId'/)
    expect(client).toMatch(/`\/subscriptions\/check\/\$\{encodeURIComponent\(writerId\)\}`/)
    expect(client.match(/`\/subscriptions\/\$\{encodeURIComponent\(writerId\)\}`/g)).toHaveLength(2)
    expect(client).toMatch(/method: 'POST'/)
    expect(client).toMatch(/method: 'DELETE'/)
  })
})
