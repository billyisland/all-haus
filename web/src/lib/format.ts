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
  return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '…'
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

/**
 * Pence → the STICKER PRICE, as a reader reads it: `50p` under a pound,
 * `£3.00` at or over one. Distinct from `formatPence` above on purpose —
 * that one is the money-UI/ledger form and is always `£X.XX` so a column of
 * figures aligns. This one is prose: a price named inside a sentence, where
 * "£0.50 to keep reading" reads as a form field and "50p to keep reading"
 * reads as a price. Use `formatPence` for anything tabular or reconcilable.
 */
export function formatPrice(pence: number): string {
  return pence < 100 ? `${pence}p` : formatPence(pence)
}

/**
 * A `<input type="datetime-local">` value for an instant, in the VIEWER'S OWN
 * time zone.
 *
 * `toISOString().slice(0, 16)` is the shape everyone reaches for and it is
 * wrong in both directions, silently. A `datetime-local` input has no zone: the
 * browser reads whatever it is given as local wall-clock time, and
 * `new Date(value)` on the way back out reads it as local too. So a UTC string
 * put INTO one is displayed as local — an hour early in BST — and confirming it
 * unchanged sends an instant an hour earlier than the one on screen. Reschedule
 * a post twice and it walks backwards. Used as a `min` bound the same slice is
 * an hour adrift the other way east of UTC, where it permits a time in the past.
 *
 * Nothing here converts. It reads the local components the user will actually
 * see, which is the only thing the input's own contract is about.
 */
export function toDateTimeLocalValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * A published date for an SSR'd reading surface — deterministic on both sides.
 *
 * `new Date(…).toLocaleDateString('en-GB', …)` resolves against the RUNTIME's
 * timezone, and on a server-rendered page that runtime is the container (UTC)
 * for the first paint and the reader's own machine for the hydration pass. The
 * two disagree for every reader west of UTC on a piece published in the small
 * hours, and React repairs a text mismatch silently — so the date visibly
 * changes a beat after the page appears, and nothing reports it.
 *
 * Pinning `timeZone: 'UTC'` makes the two passes agree by construction. It is
 * also the right answer on its own terms: a publication date is a fact about
 * the piece, not about where the reader is standing when they open it.
 */
export function formatPublishedDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(unixSeconds * 1000))
}

/**
 * A date the member CHOSE in a native picker, restated in UK long form.
 *
 * WHY THIS EXISTS AT ALL. A `<input type="date">` / `<input
 * type="datetime-local">` draws its own value in the order the BROWSER's
 * locale dictates, and nothing in our markup can change that — not `lang` on
 * the element, not `lang` on `<html>` (probed in Chromium, both ignored). So
 * an en-US browser renders 5 March as `03/05/2026` on a site whose every other
 * date is British, and the reader has no way to tell which number is which.
 * The fix is not to fight the widget: it is to STATE the value beside it, in
 * the one order this site uses. The widget stays because for a date next
 * Tuesday a calendar is the right control; the echo is what makes it
 * unambiguous. (The date of birth is the case where the widget itself is
 * wrong, and there it is replaced outright — `DateOfBirthField`.)
 *
 * PARSED FROM COMPONENTS, NEVER `new Date(value)`. A date-only string is
 * parsed as UTC midnight per spec, so `new Date('2026-03-05')` west of UTC is
 * the 4th — the echo would contradict the very widget it is captioning. The
 * `datetime-local` half has the mirror-image bug the other way, which is what
 * `toDateTimeLocalValue` above is about. Both halves here read the wall-clock
 * components the member is actually looking at and convert nothing.
 *
 * Returns `null` for anything that is not a complete, real value — an empty
 * picker and `2026-02-30` alike — so the caller renders no echo rather than a
 * confident wrong one.
 */
const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/

export function formatDateInputEcho(value: string): string | null {
  const m = DATE_INPUT_RE.exec(value)
  if (m === null) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hasTime = m[4] !== undefined
  const hours = hasTime ? Number(m[4]) : 0
  const mins = hasTime ? Number(m[5]) : 0

  // Out-of-range minutes roll the hour without moving the day, so the
  // round-trip below cannot see them; bound them first.
  if (hours > 23 || mins > 59) return null

  const d = new Date(year, month - 1, day, hours, mins)
  // The round-trip is what refuses `2026-02-30`, which the regex accepts and
  // the constructor rolls forward to 2 March without complaint.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null
  }

  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d)
  if (!hasTime) return date

  // `hourCycle: 'h23'` rather than `hour12: false` — the latter resolves to
  // h24 under some ICU builds, which renders midnight as `24:00`.
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
  // " at ", not a comma: `en-GB` already puts one after the weekday, and
  // "Thu, 5 March 2026, 18:30" makes the reader parse three clauses.
  return `${date} at ${time}`
}
