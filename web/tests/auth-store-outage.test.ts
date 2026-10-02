// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// =============================================================================
// "NOT LOGGED IN" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS (CA-A11/A12/E11,
// 2026-09-29).
//
// `fetchMe` turned every failure into `user: null`, and `/auth/me` answers 401
// for no session while `request()` throws the same `ApiError` on a 502 and a
// plain `TypeError` when the gateway is not there at all — so a deploy window
// logged out every open tab, and the workspace bounced each one to the login
// page. Only an answer that SAYS there is no session makes the member
// anonymous; anything else keeps what was known, flags `outage`, and retries.
//
// The cases drive the real store against a mocked `auth.me` that throws the
// real `ApiError`, and assert the STATE — `user`, `outage` — not the call.
// Reverting the catch to `set({ user: null })` fails the 502, the network and
// the malformed-body cases; dropping the retry fails the timer case.
// =============================================================================

const me = vi.hoisted(() => vi.fn())
const logoutApi = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/lib/api', () => ({ auth: { me: (...a: unknown[]) => me(...a), logout: () => logoutApi() } }))
vi.mock('@/stores/follows', () => ({ useFollows: { getState: () => ({ reset: vi.fn() }) } }))

import { ApiError } from '@/lib/api/client'
import { useAuth, OUTAGE_RETRY_MS } from '@/stores/auth'

const MEMBER = { id: 'member-1', pubkey: 'a'.repeat(64), username: 'ada' } as never

async function signedIn() {
  me.mockResolvedValueOnce(MEMBER)
  await useAuth.getState().fetchMe()
  expect(useAuth.getState().user).toEqual(MEMBER)
}

beforeEach(() => {
  vi.useFakeTimers()
  me.mockReset()
  logoutApi.mockClear()
  useAuth.setState({ user: null, loading: true, outage: false })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('fetchMe tells an absent session from a fault', () => {
  it('a 401 is anonymous: user null, no outage', async () => {
    await signedIn()
    me.mockRejectedValueOnce(new ApiError(401, { error: 'unauthenticated' }))
    await useAuth.getState().fetchMe()
    expect(useAuth.getState()).toMatchObject({ user: null, loading: false, outage: false })
  })

  it('the 404 for a session whose account is gone is anonymous too', async () => {
    await signedIn()
    me.mockRejectedValueOnce(new ApiError(404, { error: "We couldn't find that account." }))
    await useAuth.getState().fetchMe()
    expect(useAuth.getState()).toMatchObject({ user: null, outage: false })
  })

  it('a 502 keeps the member signed in and flags the outage', async () => {
    await signedIn()
    me.mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'))
    await useAuth.getState().fetchMe()
    expect(useAuth.getState()).toMatchObject({ user: MEMBER, loading: false, outage: true })
  })

  it('a network failure (no ApiError at all) keeps the member signed in', async () => {
    await signedIn()
    me.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await useAuth.getState().fetchMe()
    expect(useAuth.getState()).toMatchObject({ user: MEMBER, outage: true })
  })

  it('a first load in an outage ends loading without a member and without a bounce', async () => {
    me.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await useAuth.getState().fetchMe()
    // `loading` ended (no spinner for a server that is down); `outage` is what
    // stops the workspace treating `!user` as "log in again".
    expect(useAuth.getState()).toMatchObject({ user: null, loading: false, outage: true })
  })

  it('an outage asks again by itself, and the answer clears it', async () => {
    await signedIn()
    me.mockRejectedValueOnce(new ApiError(503, 'restarting'))
    await useAuth.getState().fetchMe()
    expect(useAuth.getState().outage).toBe(true)

    me.mockResolvedValueOnce(MEMBER)
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_MS)
    expect(me).toHaveBeenCalledTimes(3)
    expect(useAuth.getState()).toMatchObject({ user: MEMBER, outage: false })
  })

  it('a second failure while a retry is pending schedules no second timer', async () => {
    await signedIn()
    me.mockRejectedValue(new ApiError(503, 'restarting'))
    await useAuth.getState().fetchMe()
    await useAuth.getState().fetchMe()
    const before = me.mock.calls.length
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_MS)
    expect(me.mock.calls.length).toBe(before + 1)
  })
})

describe('logout is a full document load (CA-E11)', () => {
  it('ends the session and loads the public home, so every module cache is dropped', async () => {
    await signedIn()
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign }, writable: true, configurable: true })
    try {
      await useAuth.getState().logout()
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
    }
    expect(logoutApi).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
    expect(useAuth.getState().user).toBeNull()
  })

  it('a logout the gateway did not hear leaves the session as it was', async () => {
    await signedIn()
    logoutApi.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign }, writable: true, configurable: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await useAuth.getState().logout()
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true })
      err.mockRestore()
    }
    expect(assign).not.toHaveBeenCalled()
    expect(useAuth.getState().user).toEqual(MEMBER)
  })
})

describe('the workspace is keyed on the member, not the user object (CA-A12)', () => {
  // A structural pin, because a render count through the whole floor is not
  // worth a harness: every effect that used to list `user` in its deps now
  // lists `user?.id`, so a re-fetched object (after an unlock, a card connect,
  // a profile edit) cannot re-run the bootstrap and unmount every vessel.
  const src = readFileSync(path.resolve(__dirname, '../src/components/workspace/WorkspaceView.tsx'), 'utf8')

  it('no effect depends on the `user` object', () => {
    expect(src).not.toMatch(/\}, \[user\]\);/)
    expect(src).not.toMatch(/\}, \[user, hydrate\]\);/)
    expect(src).not.toMatch(/\}, \[user, hydrated, loadVesselItems\]\);/)
    expect(src).not.toMatch(/\}, \[user, loading, isMobile/)
  })

  it('the bootstrap and the hydrations are keyed on the id', () => {
    expect(src).toMatch(/\}, \[user\?\.id, hydrated, loadVesselItems\]\);/)
    expect(src).toMatch(/\}, \[user\?\.id, hydrate\]\);/)
    expect(src).toMatch(/\}, \[user\?\.id\]\);/)
  })

  it('the login bounce is gated on the outage', () => {
    expect(src).toMatch(/if \(!loading && !user && !outage\) router\.push\("\/auth\?mode=login"\);/)
  })
})
