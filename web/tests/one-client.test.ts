import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, apiErrorSentence, failureSentence, request } from '../src/lib/api/client'

// =============================================================================
// ONE CLIENT, ONE BASE, ONE WAY TO SAY A FAILED PRESS (CA-J2, 2026-09-30).
//
// Eight lib files and two hooks hand-rolled their own fetch: each re-did the
// ok-check, three spelled the base URL three ways (one of them a build-time
// `NEXT_PUBLIC_GATEWAY_URL` prefix that made the call cross-origin wherever it
// was set), and each built its own error string — "Upload failed: 500",
// "Sign-and-publish failed: 403" — which the surfaces then showed verbatim.
// They go through `request()` now, and a surface words the ApiError it gets
// with `failureSentence`.
// =============================================================================

describe('failureSentence', () => {
  it('shows the route’s `message`', () => {
    expect(failureSentence(new ApiError(409, { error: 'x', message: 'Set a price first.' }), 'F')).toBe('Set a price first.')
  })

  it('shows a SENTENCE the route put in `error` — the upload route’s refusals', () => {
    const err = new ApiError(400, { error: 'We can\'t use that kind of file (application/pdf). Please upload a JPEG, PNG, GIF or WebP image.' })
    expect(failureSentence(err, 'F')).toMatch(/^We can't use that kind of file/)
    expect(apiErrorSentence(err)).toMatch(/^We can't use that kind of file/)
  })

  it('never shows a snake_case code, a bare status or the raw ApiError message', () => {
    expect(failureSentence(new ApiError(402, { error: 'card_required' }), 'F')).toBe('F')
    expect(failureSentence(new ApiError(500, null), 'F')).toBe('F')
    expect(failureSentence(new ApiError(502, '<html>bad gateway</html>'), 'F')).toBe('F')
  })

  it('a dropped connection is house copy, not "Failed to fetch"', () => {
    expect(failureSentence(new TypeError('Failed to fetch'), 'F')).toBe('F')
  })

  it('a sentence WE threw is shown as written (the publish pipeline composes several)', () => {
    expect(failureSentence(new Error('Your article is live — but …'), 'F')).toBe('Your article is live — but …')
    expect(failureSentence('a string', 'F')).toBe('F')
  })
})

describe('request()', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('lets a multipart body set its own Content-Type (the upload), and sets JSON otherwise', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ ...(init.headers as Record<string, string>) })
      return new Response('{}', { status: 200 })
    }))
    const form = new FormData()
    form.append('file', new Blob(['x']), 'x.png')
    await request('/media/upload', { method: 'POST', body: form })
    await request('/notes', { method: 'POST', body: '{}' })
    expect(seen[0]['Content-Type']).toBeUndefined()
    expect(seen[1]['Content-Type']).toBe('application/json')
  })
})

describe('one base URL', () => {
  const SRC = join(__dirname, '../src')
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (statSync(f).isDirectory()) walk(f)
      else if (/\.tsx?$/.test(n)) files.push(f)
    }
  }
  walk(SRC)
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

  it('`/api/v1` is defined once, in the client', () => {
    expect(files.length).toBeGreaterThan(200)
    const defs = files.filter((f) => /\bAPI_BASE\s*=/.test(readFileSync(f, 'utf8')))
    expect(defs.map((f) => f.slice(SRC.length + 1))).toEqual(['lib/api/client.ts'])
  })

  it('nothing reads a browser-side gateway URL', () => {
    const readers = files.filter((f) => /NEXT_PUBLIC_GATEWAY_URL/.test(readFileSync(f, 'utf8')))
    expect(readers).toEqual([])
  })

  it('no surface words a failure with `err.message` (it shows "API error 500: {…}")', () => {
    const shape = /\b(\w+) instanceof Error \? \1\.message\b|\berr\.message \?\?/
    const offenders = files.filter((f) => shape.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })

  it('the files CA-J2 named call no fetch of their own', () => {
    const named = [
      'lib/drafts.ts', 'lib/sign.ts', 'lib/signPublishAndIndex.ts', 'lib/media.ts',
      'lib/publish.ts', 'lib/vault.ts', 'lib/traffology-api.ts',
      'hooks/useWriterName.ts', 'hooks/useAuthorCard.ts',
    ]
    for (const rel of named) {
      const src = read(rel)
      expect(src.length, rel).toBeGreaterThan(200)
      expect(src, rel).not.toMatch(/\bfetch\(/)
      expect(src, rel).toMatch(/\brequest\b/)
    }
  })

  // CA-J2b: the rest of the browser. A client-side `fetch` of `/api/v1/…` re-
  // implements the ok-check and, as often as not, its own reading of a failure
  // — several of these read every failure as "not here". The server components'
  // `${GATEWAY}/api/v1/…` reads are a different thing (a server-to-server call
  // with its own cache policy) and are not matched. What STAYS is named, each
  // for a reason `request()` cannot carry.
  it('no client file hand-rolls a gateway fetch, bar the named blob downloads', () => {
    const STAYS = new Set([
      'components/account/ExportPanel.tsx', // blob download
      'app/account/export/page.tsx', // blob download
      'components/workspace/PipPanel.tsx', // parked, unmounted (CA-I2)
    ])
    const handRolled = /\bfetch\(\s*[`'"]\/api\/v1\//
    const offenders = files
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !STAYS.has(rel) && handRolled.test(read(rel)))
    expect(offenders).toEqual([])
    // The detector is proved on a line it must catch, and each exception is
    // still the shape it is excused for (or the entry is stale).
    expect(handRolled.test("await fetch(`/api/v1/x`, {")).toBe(true)
    for (const rel of STAYS) expect(read(rel), rel).toMatch(handRolled)
  })
})
