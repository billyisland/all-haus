// =============================================================================
// Shared formatting utilities
//
// Consolidated from ArticleCard, NoteCard, [username]/page.
// =============================================================================

/**
 * Relative date for article/note timestamps (unix seconds).
 * Used in feed cards and metadata lines.
 */
export function formatDateRelative(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const ms = now.getTime() - d.getTime()
  const mins = Math.floor(ms / 60000)
  const hrs = Math.floor(ms / 3600000)
  const days = Math.floor(ms / 86400000)

  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  if (hrs < 24) return `${hrs}h`
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

/**
 * Relative date from an ISO string (used in profile pages).
 */
export function formatDateFromISO(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

/**
 * Coarse relative time from an ISO string, for notification / message / report
 * timestamps: "just now", "5m ago", "3h ago", "2d ago".
 *
 * Pass `{ compact: true }` for the space-tight variant used in the conversation
 * list ("now", "5m", "3h", "2d" — no "ago" suffix). Both forms were previously
 * hand-copied as private `timeAgo`s in NotificationsPanel / ReportCard (long) and
 * ConversationList (compact); this is their single definition.
 */
export function timeAgo(iso: string, opts?: { compact?: boolean }): string {
  const compact = opts?.compact ?? false
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return compact ? 'now' : 'just now'
  if (mins < 60) return compact ? `${mins}m` : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return compact ? `${hrs}h` : `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return compact ? `${days}d` : `${days}d ago`
}

/**
 * Truncate text at a word boundary.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '...'
}

/**
 * Strip markdown formatting to plain text (for excerpts).
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/!\[.*?\]\(.+?\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

/**
 * Pence → pounds, with locale grouping over £1,000 (owner dashboard & money UI).
 */
export function formatPence(pence: number): string {
  const pounds = pence / 100
  return `£${pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
