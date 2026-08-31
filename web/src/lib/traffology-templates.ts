// =============================================================================
// Traffology Observation Templates
//
// Renders observation records into { anchor, html } pairs.
// All templates follow ADR Section 6: precise, calm, templated voice.
// No language model involved. No emoji. No advice.
// =============================================================================

export interface Observation {
  id: string
  piece_id: string | null
  observation_type: string
  priority: number
  values: Record<string, any>
  created_at: string
  piece_title?: string
  article_id?: string
}

export interface RenderedObservation {
  id: string
  pieceId: string | null
  articleId?: string
  type: string
  priority: number
  anchor: string
  html: string
  createdAt: string
}

export function renderObservation(obs: Observation): RenderedObservation {
  const v = obs.values
  const anchor = formatAnchor(obs.created_at)
  let html: string

  switch (obs.observation_type) {
    case 'FIRST_DAY_SUMMARY':
      html = firstDaySummary(v)
      break
    case 'ANOMALY_HIGH':
    case 'ANOMALY_LOW':
      html = anomaly(v)
      break
    case 'SOURCE_NEW':
      html = sourceNew(v)
      break
    case 'SOURCE_BREAKDOWN':
      html = sourceBreakdown(v)
      break
    case 'SOURCE_SHIFT':
      html = sourceShift(v)
      break
    case 'SOURCE_FAMILIAR':
      html = sourceFamiliar(v)
      break
    case 'MILESTONE_READERS':
      html = milestoneReaders(v)
      break
    case 'MILESTONE_GEO':
      html = milestoneGeo(v)
      break
    case 'MILESTONE_LONGEVITY':
      html = milestoneLongevity(v)
      break
    case 'ANOMALY_LATE_SPIKE':
      html = anomalyLateSpike(v)
      break
    case 'ANOMALY_READING_TIME':
      html = anomalyReadingTime(v)
      break
    case 'ANOMALY_SCROLL_DEPTH':
      html = anomalyScrollDepth(v)
      break
    case 'ARRIVAL_CURRENT':
      html = arrivalCurrent(v)
      break
    case 'ARRIVAL_NONE':
      html = arrivalNone(v)
      break
    case 'SUBSCRIBER_NEW':
      html = subscriberNew(v)
      break
    case 'SUBSCRIBER_LOST':
      html = subscriberLost(v)
      break
    case 'SUBSCRIBER_CONVERSION':
      html = subscriberConversion(v)
      break
    default:
      html = `<span>${escapeHtml(obs.observation_type)}: ${escapeHtml(JSON.stringify(v))}</span>`
  }

  return {
    id: obs.id,
    pieceId: obs.piece_id,
    articleId: obs.article_id,
    type: obs.observation_type,
    priority: obs.priority,
    anchor,
    html,
    createdAt: obs.created_at,
  }
}

// =============================================================================
// Templates
// =============================================================================

function firstDaySummary(v: Record<string, any>): string {
  const readers = fmtNum(v.readers)
  const comparison = v.comparison
    ? `, ${v.comparison} than usual`
    : ''
  const topSource = v.topSource && v.topSourcePct
    ? ` ${v.topSource} sent the most (${v.topSourcePct}%).`
    : ''
  return `${em(v.title)} had ${readers} readers on its first day${comparison}.${topSource}`
}

function anomaly(v: Record<string, any>): string {
  return `${em(v.title)} had ${fmtNum(v.readers)} readers on its first day. Your usual first-day readership is around ${fmtNum(v.baseline)}.`
}

function sourceNew(v: Record<string, any>): string {
  return `A new source appeared \u2014 ${escapeHtml(v.sourceName)} has sent ${fmtNum(v.readers)} readers to ${em(v.title)}.`
}

function sourceBreakdown(v: Record<string, any>): string {
  const parts = (v.breakdown as Array<{ name: string; pct: number }>)
    .map(s => `${escapeHtml(s.name)} (${s.pct}%)`)
  const list = parts.length <= 2
    ? parts.join(' and ')
    : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]
  return `First-day readers of ${em(v.title)} came from: ${list}.`
}

function sourceShift(v: Record<string, any>): string {
  return `The main source of readers for ${em(v.title)} has shifted from ${escapeHtml(v.fromSource)} to ${escapeHtml(v.toSource)}. ${escapeHtml(v.toSource)} now accounts for ${v.pct}% of all readers.`
}

function sourceFamiliar(v: Record<string, any>): string {
  const above = v.aboveUsual ? ' That\u2019s higher than usual from this source.' : ''
  return `${escapeHtml(v.sourceName)} sent ${fmtNum(v.readers)} readers to ${em(v.title)}.${above}`
}

function milestoneReaders(v: Record<string, any>): string {
  const count = fmtNum(v.totalReaders)
  const rank = v.rankClause ? `, which makes it ${v.rankClause}` : ''
  return `${em(v.title)} has now been read ${count} times${rank}.`
}

function milestoneGeo(v: Record<string, any>): string {
  return `${em(v.title)} has been read in ${escapeHtml(v.country)} \u2014 that\u2019s a first for you.`
}

function milestoneLongevity(v: Record<string, any>): string {
  return `${em(v.title)} is still drawing readers ${fmtNum(v.daysAfter)} days after publication \u2014 ${fmtNum(v.weekReaders)} readers in the last week. Most of your pieces go quiet after ${v.typicalLifespan}.`
}

function anomalyLateSpike(v: Record<string, any>): string {
  const source = v.topSource ? `, mostly from ${escapeHtml(v.topSource)}` : ''
  return `${em(v.title)}, published ${fmtNum(v.daysAgo)} days ago, is getting traffic again \u2014 ${fmtNum(v.readers)} readers today${source}.`
}

function anomalyReadingTime(v: Record<string, any>): string {
  const dir = v.direction === 'high' ? 'more' : 'less'
  return `Readers are spending ${dir} time on ${em(v.title)} than usual. Average reading time is ${v.actual} minutes; your usual is around ${v.baseline} minutes.`
}

function anomalyScrollDepth(v: Record<string, any>): string {
  const dir = v.direction === 'high' ? 'further' : 'less far'
  return `Readers are scrolling ${dir} through ${em(v.title)} than usual. Average scroll depth is ${v.actual}%; your usual is around ${v.baseline}%.`
}

function arrivalCurrent(v: Record<string, any>): string {
  if (v.pieceCount && v.pieceCount > 1) {
    const most = v.topTitle
      ? ` Most are reading ${em(v.topTitle)}.`
      : ''
    return `${fmtNum(v.total)} ${v.total === 1 ? 'person' : 'readers'} on your site right now, across ${fmtNum(v.pieceCount)} pieces.${most}`
  }
  return `${fmtNum(v.count)} ${v.count === 1 ? 'person' : 'people'} reading ${em(v.title)} right now.`
}

function arrivalNone(v: Record<string, any>): string {
  const lastReader = v.lastReaderAgo
    ? ` Your last reader was ${v.lastReaderAgo}.`
    : ''
  return `No one reading right now.${lastReader}`
}

function subscriberNew(v: Record<string, any>): string {
  const type = v.tier === 'paying' ? 'paying' : 'free'
  const count = fmtNum(v.count)
  const s = v.count === 1 ? 'subscriber' : 'subscribers'
  const when = v.when ?? 'today'
  const from = v.topPiece ? ` Most signed up from ${em(v.topPiece)}.` : ''
  return `${count} new ${type} ${s} ${when}.${from}`
}

function subscriberLost(v: Record<string, any>): string {
  const count = fmtNum(v.count)
  const s = v.count === 1 ? 'subscriber' : 'subscribers'
  const when = v.when ?? 'today'
  return `${count} paying ${s} cancelled ${when}. You now have ${fmtNum(v.remaining)} paying subscribers.`
}

function subscriberConversion(v: Record<string, any>): string {
  return `${em(v.title)} has been the last free piece read before subscribing for ${fmtNum(v.count)} of your paying subscribers. No other piece has converted more.`
}

// =============================================================================
// Formatting helpers
// =============================================================================

function em(title: string): string {
  return `<em>${escapeHtml(title)}</em>`
}

/** Format number: words below 10, numerals above */
function fmtNum(n: number): string {
  if (n == null) return '0'
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  if (Number.isInteger(n) && n >= 0 && n < 10) return words[n]
  return n.toLocaleString('en-GB')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// =============================================================================
// Temporal anchors
// =============================================================================

function formatAnchor(isoDate: string): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  if (diffHours < 1) return 'Right now'
  if (diffHours < 2) return 'In the last hour'

  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    const hour = date.getHours()
    if (hour < 12) return 'This morning'
    if (hour < 17) return 'This afternoon'
    return 'This evening'
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  if (diffDays < 7) return `${Math.floor(diffDays)} days ago`

  // Same week
  const startOfWeek = new Date(now)
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
  if (date >= startOfWeek) return 'This week'

  const startOfLastWeek = new Date(startOfWeek)
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)
  if (date >= startOfLastWeek) return 'Last week'

  // Fall back to month
  return `In ${date.toLocaleDateString('en-GB', { month: 'long' })}`
}
