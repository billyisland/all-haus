// =============================================================================
// Media Client
//
// Blossom image upload and oEmbed proxy fetch functions.
// All requests go through the gateway to protect reader privacy.
// =============================================================================

const API_BASE = '/api/v1'

// =============================================================================
// Image Upload
// =============================================================================

export interface UploadResult {
  url: string
  sha256: string
  mimeType?: string
  size?: number
  duplicate?: boolean
}

export async function uploadImage(file: File): Promise<UploadResult> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${API_BASE}/media/upload`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Upload failed: ${res.status}`)
  }

  return res.json()
}

// =============================================================================
// oEmbed
// =============================================================================

export interface OEmbedResult {
  type: string
  title?: string
  authorName?: string
  authorUrl?: string
  providerName?: string
  providerUrl?: string
  thumbnailUrl?: string
  thumbnailWidth?: number
  thumbnailHeight?: number
  html?: string
  width?: number
  height?: number
}

export async function fetchOEmbed(url: string): Promise<OEmbedResult> {
  const res = await fetch(
    `${API_BASE}/media/oembed?url=${encodeURIComponent(url)}`,
    { credentials: 'include' }
  )

  if (!res.ok) {
    throw new Error(`oEmbed lookup failed: ${res.status}`)
  }

  return res.json()
}

// =============================================================================
// URL Detection
// =============================================================================

const EMBEDDABLE_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch/,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/(www\.)?vimeo\.com\/\d+/,
  /^https?:\/\/(www\.)?(twitter|x)\.com\/\w+\/status\//,
  /^https?:\/\/open\.spotify\.com\//,
]

export function isEmbeddableUrl(url: string): boolean {
  return EMBEDDABLE_PATTERNS.some(pattern => pattern.test(url))
}

const IMAGE_URL_PATTERN = /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i
const BLOSSOM_PATTERN = /^https?:\/\/.*\/[a-f0-9]{64}$/i

export function isImageUrl(url: string): boolean {
  return IMAGE_URL_PATTERN.test(url) || BLOSSOM_PATTERN.test(url)
}

/**
 * Extract URLs from text content.
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
  return text.match(urlRegex) ?? []
}

/**
 * Strip image and embeddable URLs from text, returning the cleaned text
 * and the extracted URLs grouped by type.
 */
export function stripMediaUrls(text: string): {
  displayText: string
  imageUrls: string[]
  embedUrls: string[]
} {
  const urls = extractUrls(text)
  const imageUrls = urls.filter(isImageUrl)
  const embedUrls = urls.filter(isEmbeddableUrl)
  let displayText = text
  // Also strip nostr event references
  displayText = displayText.replace(/nostr:nevent1[a-z0-9]+/gi, '').trim()
  for (const url of [...imageUrls, ...embedUrls]) {
    displayText = displayText.replace(url, '').trim()
  }
  return { displayText, imageUrls, embedUrls }
}

/**
 * Slice 23 — pull image URLs out of note content, shaped like the
 * external_items.media JSONB the gateway emits, so a single MediaBlock can
 * render notes + externals through one path.
 */
export interface ExtractedMedia {
  type: 'image' | 'video' | 'audio' | 'link'
  url: string
  thumbnail?: string
  alt?: string
}

export function extractNoteMedia(content: string): ExtractedMedia[] {
  if (!content) return []
  return extractUrls(content)
    .filter(isImageUrl)
    .map((url) => ({ type: 'image' as const, url }))
}
