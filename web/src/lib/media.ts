// =============================================================================
// Media Client
//
// Blossom image upload and oEmbed proxy fetch functions.
// All requests go through the gateway to protect reader privacy.
// =============================================================================

import { articleEmbed } from './media-embed'
import { request } from './api/client'

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

// A refusal is an `ApiError`; the route's 400s carry a sentence in `error`
// ("We can't use that kind of file …"), which `failureSentence` shows as written.
export function uploadImage(file: File): Promise<UploadResult> {
  const formData = new FormData()
  formData.append('file', file)
  return request<UploadResult>('/media/upload', { method: 'POST', body: formData })
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

export function fetchOEmbed(url: string): Promise<OEmbedResult> {
  return request<OEmbedResult>(`/media/oembed?url=${encodeURIComponent(url)}`)
}

// =============================================================================
// URL Detection
// =============================================================================

/** True exactly when the body renderers turn `url` into a player — see
 *  `articleEmbed` (lib/media-embed.ts), which is the definition. YouTube, Vimeo
 *  and Spotify; Twitter/X is deliberately absent (no embed without a
 *  third-party script, which the CSP does not admit). */
export function isEmbeddableUrl(url: string): boolean {
  return articleEmbed(url) !== null
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
