import { create } from 'zustand'
import { auth, type MeResponse } from '../lib/api'
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
//   anon     — no session (user === null, loading === false)
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
// =============================================================================

interface AuthState {
  user: MeResponse | null
  loading: boolean

  // Actions
  fetchMe: () => Promise<void>
  logout: () => Promise<void>
  setUser: (user: MeResponse) => void
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  fetchMe: async () => {
    try {
      const user = await auth.me()
      // Re-open follow hydration if the session changed identity (or first
      // load), so the followed-id set belongs to the current user.
      if (user.id !== useAuth.getState().user?.id) useFollows.getState().reset()
      set({ user, loading: false })
    } catch {
      useFollows.getState().reset()
      set({ user: null, loading: false })
    }
  },

  logout: async () => {
    try {
      await auth.logout()
    } finally {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('unlocked:')) sessionStorage.removeItem(key)
      }
      useFollows.getState().reset()
      set({ user: null })
    }
  },

  setUser: (user) => {
    set({ user, loading: false })
  },
}))
