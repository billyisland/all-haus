import { describe, it, expect } from 'vitest'
import { isEmbeddableUrl, isImageUrl, extractUrls, stripMediaUrls } from '../src/lib/media'

describe('isEmbeddableUrl', () => {
  it('matches YouTube watch URLs', () => {
    expect(isEmbeddableUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isEmbeddableUrl('https://youtube.com/watch?v=abc123')).toBe(true)
  })

  it('matches youtu.be short URLs', () => {
    expect(isEmbeddableUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })

  it('matches Vimeo URLs', () => {
    expect(isEmbeddableUrl('https://vimeo.com/123456789')).toBe(true)
    expect(isEmbeddableUrl('https://www.vimeo.com/123456789')).toBe(true)
  })

  it('matches Twitter/X status URLs', () => {
    expect(isEmbeddableUrl('https://twitter.com/user/status/123')).toBe(true)
    expect(isEmbeddableUrl('https://x.com/user/status/123')).toBe(true)
  })

  it('matches Spotify URLs', () => {
    expect(isEmbeddableUrl('https://open.spotify.com/track/abc')).toBe(true)
  })

  it('rejects non-embeddable URLs', () => {
    expect(isEmbeddableUrl('https://example.com')).toBe(false)
    expect(isEmbeddableUrl('https://github.com/user/repo')).toBe(false)
    expect(isEmbeddableUrl('not a url')).toBe(false)
  })
})

describe('isImageUrl', () => {
  it('matches common image extensions', () => {
    expect(isImageUrl('https://example.com/photo.jpg')).toBe(true)
    expect(isImageUrl('https://example.com/photo.jpeg')).toBe(true)
    expect(isImageUrl('https://example.com/photo.png')).toBe(true)
    expect(isImageUrl('https://example.com/photo.gif')).toBe(true)
    expect(isImageUrl('https://example.com/photo.webp')).toBe(true)
  })

  it('matches image URLs with query params', () => {
    expect(isImageUrl('https://example.com/photo.jpg?width=800')).toBe(true)
  })

  it('matches Blossom hash URLs (64 hex chars)', () => {
    const hash = 'a'.repeat(64)
    expect(isImageUrl(`https://blossom.example.com/${hash}`)).toBe(true)
  })

  it('rejects non-image URLs', () => {
    expect(isImageUrl('https://example.com/page.html')).toBe(false)
    expect(isImageUrl('https://example.com/doc.pdf')).toBe(false)
  })
})

describe('extractUrls', () => {
  it('extracts URLs from text', () => {
    const text = 'Check out https://example.com and https://other.com/page for more info'
    const urls = extractUrls(text)
    expect(urls).toEqual(['https://example.com', 'https://other.com/page'])
  })

  it('returns empty array for text with no URLs', () => {
    expect(extractUrls('just some plain text')).toEqual([])
  })

  it('handles http and https', () => {
    const urls = extractUrls('http://insecure.com and https://secure.com')
    expect(urls).toHaveLength(2)
  })
})

describe('stripMediaUrls', () => {
  it('strips image URLs from text', () => {
    const result = stripMediaUrls('Hello https://example.com/photo.jpg world')
    expect(result.displayText).toBe('Hello  world')
    expect(result.imageUrls).toEqual(['https://example.com/photo.jpg'])
    expect(result.embedUrls).toEqual([])
  })

  it('strips embed URLs from text', () => {
    const result = stripMediaUrls('Watch https://youtube.com/watch?v=abc here')
    expect(result.displayText).toBe('Watch  here')
    expect(result.embedUrls).toEqual(['https://youtube.com/watch?v=abc'])
    expect(result.imageUrls).toEqual([])
  })

  it('strips nostr event references', () => {
    const result = stripMediaUrls('Check nostr:nevent1abc123 this out')
    expect(result.displayText).toBe('Check  this out')
  })

  it('handles text with no media URLs', () => {
    const result = stripMediaUrls('just plain text')
    expect(result.displayText).toBe('just plain text')
    expect(result.imageUrls).toEqual([])
    expect(result.embedUrls).toEqual([])
  })

  it('handles multiple media URLs', () => {
    const result = stripMediaUrls(
      'Look https://example.com/a.jpg and https://example.com/b.png done'
    )
    expect(result.imageUrls).toHaveLength(2)
    expect(result.displayText).toBe('Look  and  done')
  })
})
