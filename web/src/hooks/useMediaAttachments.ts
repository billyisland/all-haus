import { useState, useCallback, useRef, useEffect } from 'react'
import { uploadImage, isEmbeddableUrl, extractUrls, fetchOEmbed, type OEmbedResult } from '../lib/media'

export interface MediaAttachment {
  url: string
  type: 'image' | 'embed'
  thumbnailUrl?: string
  title?: string
  providerName?: string
}

export function useMediaAttachments() {
  const [attachments, setAttachments] = useState<MediaAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prevEmbedUrls = useRef<Set<string>>(new Set())

  const clearError = useCallback(() => setError(null), [])

  const triggerImageUpload = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/jpeg,image/png,image/gif,image/webp'
    input.multiple = true
    input.onchange = async (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? [])
      if (files.length === 0) return
      setUploading(true)
      setError(null)
      try {
        for (const file of files) {
          const r = await uploadImage(file)
          setAttachments(prev => [...prev, { url: r.url, type: 'image' }])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed')
      } finally {
        setUploading(false)
      }
    }
    input.click()
  }, [])

  const removeAttachment = useCallback((url: string) => {
    setAttachments(prev => prev.filter(a => a.url !== url))
    prevEmbedUrls.current.delete(url)
  }, [])

  /** Call this with the current textarea value to detect newly-pasted embed URLs. */
  const detectEmbeds = useCallback((text: string) => {
    const urls = extractUrls(text)
    const embeds = urls.filter(isEmbeddableUrl)
    for (const url of embeds) {
      if (!prevEmbedUrls.current.has(url)) {
        prevEmbedUrls.current.add(url)
        const attachment: MediaAttachment = { url, type: 'embed' }
        setAttachments(prev => {
          if (prev.some(a => a.url === url)) return prev
          return [...prev, attachment]
        })
        // Enrich with oEmbed asynchronously
        fetchOEmbed(url)
          .then((oembed: OEmbedResult) => {
            setAttachments(prev =>
              prev.map(a =>
                a.url === url
                  ? { ...a, thumbnailUrl: oembed.thumbnailUrl, title: oembed.title, providerName: oembed.providerName }
                  : a
              )
            )
          })
          .catch(() => {}) // silently ignore oEmbed failures
      }
    }
    // Remove embeds that are no longer in the text
    const embedSet = new Set(embeds)
    setAttachments(prev => prev.filter(a => a.type === 'image' || embedSet.has(a.url)))
    for (const url of prevEmbedUrls.current) {
      if (!embedSet.has(url)) prevEmbedUrls.current.delete(url)
    }
  }, [])

  /** Build final content for publishing: text + attachment URLs joined by newlines. */
  const buildContent = useCallback((text: string): string => {
    const imageUrls = attachments.filter(a => a.type === 'image').map(a => a.url)
    const parts = [text.trim(), ...imageUrls].filter(Boolean)
    return parts.join('\n')
  }, [attachments])

  /** Total char count of the content that will be published. */
  const totalCharCount = useCallback((text: string): number => {
    return buildContent(text).length
  }, [buildContent])

  const reset = useCallback(() => {
    setAttachments([])
    setError(null)
    prevEmbedUrls.current = new Set()
  }, [])

  return {
    attachments,
    uploading,
    error,
    clearError,
    triggerImageUpload,
    removeAttachment,
    detectEmbeds,
    buildContent,
    totalCharCount,
    reset,
  }
}
