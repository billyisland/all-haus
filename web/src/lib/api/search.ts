import { request } from './client'

export interface SearchArticleResult {
  id: string
  nostrEventId: string
  dTag: string
  title: string
  summary: string | null
  wordCount: number | null
  accessMode: string
  isPaywalled: boolean
  publishedAt: string
  writer: { username: string; displayName: string | null }
  relevance: number
}

export interface SearchWriterResult {
  id: string
  username: string
  displayName: string | null
  bio: string | null
  avatar: string | null
  pubkey: string
  articleCount: number
}

export interface SearchPublicationResult {
  type: 'publication'
  id: string
  slug: string
  name: string
  tagline: string | null
  logo: string | null
  articleCount: number
  memberCount: number
  relevance: number
}

export const search = {
  articles: (q: string, limit = 10, signal?: AbortSignal) =>
    request<{ query: string; type: 'articles'; results: SearchArticleResult[]; limit: number; offset: number }>(
      `/search?q=${encodeURIComponent(q)}&type=articles&limit=${limit}`,
      { signal },
    ),

  writers: (q: string, limit = 10, signal?: AbortSignal) =>
    request<{ query: string; type: 'writers'; results: SearchWriterResult[]; limit: number; offset: number }>(
      `/search?q=${encodeURIComponent(q)}&type=writers&limit=${limit}`,
      { signal },
    ),

  publications: (q: string, limit = 10, signal?: AbortSignal) =>
    request<{ query: string; type: 'publications'; results: SearchPublicationResult[]; limit: number; offset: number }>(
      `/search?q=${encodeURIComponent(q)}&type=publications&limit=${limit}`,
      { signal },
    ),
}
