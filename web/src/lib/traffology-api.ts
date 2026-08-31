// =============================================================================
// Traffology API Client
//
// Typed fetch wrappers for the Traffology gateway routes.
// Uses the same /api/v1 base and cookie-based auth as the main API client.
// =============================================================================

const API_BASE = '/api/v1'

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Traffology API error ${res.status}`)
  }
  return res.json()
}

// =============================================================================
// Types
// =============================================================================

export interface TraffologyObservation {
  id: string
  piece_id: string | null
  observation_type: string
  priority: number
  values: Record<string, any>
  created_at: string
  piece_title?: string
  article_id?: string
}

export interface FeedResponse {
  observations: TraffologyObservation[]
  nextCursor: string | null
}

export interface SourceWithBuckets {
  source_id: string
  display_name: string
  source_type: string
  is_new_for_writer: boolean
  reader_count: number
  pct_of_total: number
  first_reader_at: string | null
  last_reader_at: string | null
  avg_reading_time_seconds: number
  avg_scroll_depth: number
  bounce_rate: number
  buckets: HalfDayBucket[]
}

export interface HalfDayBucket {
  source_id: string
  bucket_start: string
  is_day: boolean
  reader_count: number
}

export interface PieceDetail {
  piece: {
    id: string
    title: string
    article_id: string
    published_at: string | null
    word_count: number | null
    tags: string[]
    total_readers: number
    readers_today: number
    first_day_readers: number
    unique_countries: number
    avg_reading_time_seconds: number
    avg_scroll_depth: number
    rank_this_year: number | null
    rank_all_time: number | null
    top_source_pct: number | null
    free_conversions: number
    paid_conversions: number
    last_reader_at: string | null
    top_source_name: string | null
  }
  sources: SourceWithBuckets[]
  observations: TraffologyObservation[]
}

export interface OverviewPiece {
  id: string
  title: string
  article_id: string
  published_at: string | null
  tags: string[]
  total_readers: number
  first_day_readers: number
  avg_reading_time_seconds: number
  avg_scroll_depth: number
  rank_this_year: number | null
  rank_all_time: number | null
  top_source_pct: number | null
  free_conversions: number
  paid_conversions: number
  top_source_name: string | null
  buckets: HalfDayBucket[]
}

export interface WriterBaseline {
  writer_id: string
  mean_first_day_readers: number
  stddev_first_day_readers: number
  mean_reading_time: number
  mean_open_rate: number
  mean_piece_lifespan_days: number
  total_free_subscribers: number
  total_paying_subscribers: number
  monthly_revenue: string
}

export interface TopicPerformance {
  writer_id: string
  topic: string
  piece_count: number
  mean_readers: number
  mean_reading_time: number
  mean_search_readers: number
}

export interface OverviewResponse {
  baseline: WriterBaseline | null
  pieces: OverviewPiece[]
  topics: TopicPerformance[]
}

export interface ConcurrentResponse {
  pieceId: string
  count: number
}

// =============================================================================
// API functions
// =============================================================================

export function getFeed(cursor?: string, limit = 20): Promise<FeedResponse> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  params.set('limit', String(limit))
  return request(`/traffology/feed?${params}`)
}

export function getPiece(pieceId: string): Promise<PieceDetail> {
  return request(`/traffology/piece/${pieceId}`)
}

export function getOverview(): Promise<OverviewResponse> {
  return request('/traffology/overview')
}

export function getConcurrent(): Promise<{ pieces: ConcurrentResponse[]; total: number }> {
  return request('/traffology/concurrent')
}
