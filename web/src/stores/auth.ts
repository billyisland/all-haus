import { create } from 'zustand'
import { auth, type MeResponse } from '../lib/api'
import { ApiError } from '../lib/api/client'
import { useFollows } from './follows'

// =============================================================================
// Auth Store
//
// Global session state. Hydrated on app load via fetchMe().
// Components use useAuth() to access current user info and auth actions.
//
// States:
//   loading  — initial hydration in progress
//   authed   — user is logged in (user !== null)
//   anon     — no session (user === null, loading === false, outage === false)
//   outage   — the last /auth/me did not ANSWER (outage === true): the
//              member's standing is unknown, and `user` is whatever it was
//
// THE SESSION BREADCRUMB IS GONE (2026-07-25). This store used to mirror auth
// state into a localStorage flag + an `html.ah-session` class, which a blocking
// <head> script re-applied pre-paint so CSS could hide the black topbar before
// a member ever saw it. The httpOnly JWT is invisible to SSR and to client JS
// until fetchMe() round-trips, so nothing else could have stopped that flash.
//
// It existed only to suppress logged-out chrome. There is no logged-out chrome
// left to suppress: every route is chromeless, and the one nav row is the same
// row for members and visitors. The flag, the class, the <head> script and the
// CSS that read them are all deleted. If a pre-paint auth hint is ever needed
// again, note that this one was a HINT, never a credential, and was only ever
// safe because being wrong could hide chrome and nothing else.
//
// "NOT LOGGED IN" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS (CA-A11,
// 2026-09-29). `fetchMe` used to turn EVERY failure into `user: null`, and
// `/auth/me` answers 401 when there is no session while `request()` throws the
// same `ApiError` on a 502, and a plain `TypeError` when the gateway is not
// there at all — so a deploy window, a proxy hiccup or a dropped connection
// presented as every open tab logged out at once, and the workspace bounced
// each of them to the login page. The root rule's shape, verbatim: a normal
// return value ("no session") that also meant "we are broken". Only an answer
// that SAYS there is no session — 401, 403, or the 404 for an account that no
// longer exists — makes the member anonymous. Anything else keeps whatever was
// known, flags `outage`, and asks again shortly: a tab open through a deploy
// comes back by itself when the gateway does.
// =============================================================================

interface AuthState {
  user: MeResponse | null
  loading: boolean
  /** The last `fetchMe` got no answer about the session (network, 5xx, a
   *  malformed body). Surfaces say so and offer a retry; nothing treats it
   *  as logged out. Cleared by the next answer either way. */
  outage: boolean

  // Actions
  fetchMe: () => Promise<void>
  logout: () => Promise<void>
  setUser: (user: MeResponse) => void
}

/** The statuses that are an ANSWER about the session rather than a fault:
 *  no cookie / expired (401), refused (403), and `/auth/me`'s own 404 for a
 *  session whose account row is gone. */
export function isNoSessionError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 401 || err.status === 403 || err.status === 404)
  )
}

/** How long an outage waits before asking again. Long enough not to hammer a
 *  gateway that is restarting, short enough that a tab open through a deploy
 *  is back before its member notices. */
export const OUTAGE_RETRY_MS = 10_000

let outageRetry: ReturnType<typeof setTimeout> | null = null

function scheduleOutageRetry(): void {
  if (outageRetry !== null) return
  outageRetry = setTimeout(() => {
    outageRetry = null
    void useAuth.getState().fetchMe()
  }, OUTAGE_RETRY_MS)
}

function cancelOutageRetry(): void {
  if (outageRetry === null) return
  clearTimeout(outageRetry)
  outageRetry = null
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  outage: false,

  fetchMe: async () => {
    try {
      const user = await auth.me()
      // Re-open follow hydration if the session changed identity (or first
      // load), so the followed-id set belongs to the current user.
      if (user.id !== useAuth.getState().user?.id) useFollows.getState().reset()
      cancelOutageRetry()
      set({ user, loading: false, outage: false })
    } catch (err) {
      if (isNoSessionError(err)) {
        useFollows.getState().reset()
        cancelOutageRetry()
        set({ user: null, loading: false, outage: false })
        return
      }
      // A fault of ours or of the network. The member's standing is UNKNOWN,
      // which is not the same as anonymous: keep what was known, say so, and
      // ask again. `loading` still ends — a first load in an outage renders
      // the outage, never a spinner that waits for a server that is down.
      set({ loading: false, outage: true })
      scheduleOutageRetry()
    }
  },

  // A LOGOUT IS A FULL DOCUMENT LOAD (CA-E11, 2026-09-29). This used to clear
  // the `unlocked:*` session keys and the follows store and set `user: null`,
  // and nothing else — while `useLinkedAccounts`, `useAuthorCard`,
  // `usePostThread` and the unread store each keep a module-level cache that
  // no logout reached, so the NEXT member on the same tab read the previous
  // member's linked accounts for the rest of the session. A registry of every
  // viewer-dependent cache is a list that goes stale the day somebody adds
  // one; a navigation to the public home drops every module by construction.
  // The in-memory clears are kept for the one environment that cannot
  // navigate (tests), and run BEFORE the navigation so nothing races it.
  //
  // A logout the gateway did not hear is not a logout: the cookie is still
  // valid, and presenting the member as signed out would be the same lie the
  // outage state exists to end. On failure the session is left as it is and
  // the fault logged; the member sees they are still in.
  logout: async () => {
    try {
      await auth.logout()
    } catch (err) {
      console.error('Logout did not reach the gateway; session left as it was', err)
      return
    }
    cancelOutageRetry()
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('unlocked:')) sessionStorage.removeItem(key)
    }
    useFollows.getState().reset()
    set({ user: null, outage: false })
    if (typeof window !== 'undefined') window.location.assign('/')
  },

  setUser: (user) => {
    set({ user, loading: false, outage: false })
  },
}))
