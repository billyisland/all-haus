// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// =============================================================================
// THE WEB RACES TAIL (CA-E10, CA-E12; slice 25, 2026-09-30).
//
// E12 — a poll issued BEFORE a mark-read and landing after it carried the count
// from before the read, and restored the stale badge for one round-trip — the
// window the profile pane's `restore()` reads. The case drives the real store
// with the poll held open across a `noteRead`, and asserts the COUNT.
//
// E10 — a failed load left the notification settings as `{}`, and the Off
// chip's guard (`=== false`) passed on `undefined`, so the press wrote ON; the
// On chip's guard (`!prefs[k]`) meanwhile refused to turn a category back on.
// The cases render the real panel and assert what was WRITTEN.
// =============================================================================

const unreadCounts = vi.hoisted(() => vi.fn())
const getPreferences = vi.hoisted(() => vi.fn())
const setPreference = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  notifications: {
    unreadCounts: () => unreadCounts(),
    getPreferences: () => getPreferences(),
    setPreference: (...a: unknown[]) => setPreference(...a),
  },
}))

import { useUnreadCounts } from '@/stores/unread'
import { NotificationPreferences } from '@/components/social/NotificationPreferences'
import { NOTIFICATION_PREFS_LOAD_FAILED, SETTINGS_ON, SETTINGS_OFF } from '@/content/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CA-E12 — a poll that straddles a mark-read does not restore the badge', () => {
  beforeEach(() => {
    useUnreadCounts.setState({ dmCount: 0, notificationCount: 0 })
  })

  it('keeps the optimistic decrement when the poll was issued before it', async () => {
    unreadCounts.mockResolvedValueOnce({ dmCount: 0, notificationCount: 1 })
    await useUnreadCounts.getState().fetch()
    expect(useUnreadCounts.getState().notificationCount).toBe(1)

    let answer!: (v: { dmCount: number; notificationCount: number }) => void
    unreadCounts.mockReturnValueOnce(new Promise((r) => { answer = r }))
    const inFlight = useUnreadCounts.getState().fetch()
    useUnreadCounts.getState().noteRead()
    answer({ dmCount: 2, notificationCount: 1 })
    await inFlight

    expect(useUnreadCounts.getState().notificationCount).toBe(0)
    // The DM half is not about the read, and still lands.
    expect(useUnreadCounts.getState().dmCount).toBe(2)
  })

  it('a poll issued after the read applies in full', async () => {
    useUnreadCounts.getState().noteRead()
    unreadCounts.mockResolvedValueOnce({ dmCount: 0, notificationCount: 3 })
    await useUnreadCounts.getState().fetch()
    expect(useUnreadCounts.getState().notificationCount).toBe(3)
  })
})

describe('CA-E10 — notification settings that failed to load assert nothing', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    getPreferences.mockReset()
    setPreference.mockReset()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  async function mount() {
    await act(async () => { root.render(<NotificationPreferences />) })
    await act(async () => {})
  }
  const chips = (label: string) =>
    [...host.querySelectorAll('button')].filter((b) => b.textContent === label)

  it('says it could not load, disables every chip, and writes nothing on a press', async () => {
    getPreferences.mockRejectedValueOnce(new Error('502'))
    await mount()
    expect(host.textContent).toContain(NOTIFICATION_PREFS_LOAD_FAILED)
    const off = chips(SETTINGS_OFF)
    expect(off.length).toBeGreaterThan(0)
    expect(off.every((b) => b.disabled)).toBe(true)
    await act(async () => { off[0].click() })
    expect(setPreference).not.toHaveBeenCalled()
  })

  it('Off writes false and On writes true — both directions work', async () => {
    getPreferences.mockResolvedValueOnce({ preferences: { new_follower: false, new_reply: true } })
    setPreference.mockResolvedValue(undefined)
    await mount()
    // Row order is NOTIFICATION_CATEGORIES: new_follower first, new_reply second.
    await act(async () => { chips(SETTINGS_ON)[0].click() })
    expect(setPreference).toHaveBeenLastCalledWith('new_follower', true)
    await act(async () => { chips(SETTINGS_OFF)[1].click() })
    expect(setPreference).toHaveBeenLastCalledWith('new_reply', false)
    // Pressing the value already on screen writes nothing.
    setPreference.mockClear()
    await act(async () => { chips(SETTINGS_ON)[0].click() })
    expect(setPreference).not.toHaveBeenCalled()
  })
})
