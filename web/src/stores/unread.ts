import { create } from 'zustand'
import { notifications } from '../lib/api'

interface UnreadState {
  dmCount: number
  notificationCount: number
  fetch: () => Promise<void>
}

export const useUnreadCounts = create<UnreadState>((set) => ({
  dmCount: 0,
  notificationCount: 0,

  fetch: async () => {
    try {
      const data = await notifications.unreadCounts()
      set({ dmCount: data.dmCount, notificationCount: data.notificationCount })
    } catch {}
  },
}))
