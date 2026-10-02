import { create } from 'zustand'
import { notifications } from '../lib/api'

interface UnreadState {
  dmCount: number
  notificationCount: number
  fetch: () => Promise<void>
  /** Drop the notification badge by `n` at once.
   *
   *  THE BADGE IS THE SAME FACT AS THE ROW, SO IT IS UPDATED AT THE SAME
   *  MOMENT. Marking a notification read updates the row optimistically and
   *  leaves the count to a round-trip (`markRead(...).then(refreshUnread)`) —
   *  which is fine for a badge and not fine for a DECISION. The profile pane's
   *  `restore()` asks "is anything still unread?" to decide whether to put the
   *  inbox back on the way out, and a reader who opens the LAST unread
   *  notification and closes the pane inside that round-trip is handed an
   *  empty inbox they did not ask for. Floors at zero. */
  noteRead: (n?: number) => void
}

// Bumped by every `noteRead` (CA-E12). A poll issued BEFORE a mark-read and
// landing after it carries the count from before the read, and applying it
// restores the stale badge for one round-trip — exactly the window `restore()`
// reads. A fetch that sees the generation moved under it keeps its DM count and
// drops its notification count; the next poll is issued after the read.
let readGeneration = 0

export const useUnreadCounts = create<UnreadState>((set) => ({
  dmCount: 0,
  notificationCount: 0,

  noteRead: (n = 1) => {
    readGeneration++
    set((s) => ({ notificationCount: Math.max(0, s.notificationCount - n) }))
  },

  fetch: async () => {
    const issuedAt = readGeneration
    try {
      const data = await notifications.unreadCounts()
      if (issuedAt !== readGeneration) set({ dmCount: data.dmCount })
      else set({ dmCount: data.dmCount, notificationCount: data.notificationCount })
    } catch {}
  },
}))
