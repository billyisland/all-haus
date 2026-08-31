'use client'

import { stripMediaUrls } from '../../lib/media'

interface MediaContentProps {
  content: string
  variant?: 'note' | 'reply' | 'message'
  /** Extra classes for the text paragraph */
  textClassName?: string
}

const IMAGE_MAX_HEIGHT: Record<string, string> = {
  note: 'max-h-80',
  reply: 'max-h-48',
  message: 'max-h-48',
}

export function MediaContent({ content, variant = 'note', textClassName }: MediaContentProps) {
  const { displayText, imageUrls, embedUrls } = stripMediaUrls(content)
  const maxH = IMAGE_MAX_HEIGHT[variant]

  return (
    <>
      {displayText && (
        <p className={textClassName ?? 'whitespace-pre-wrap'}>
          {displayText}
        </p>
      )}

      {imageUrls.length > 0 && (
        <div className="mt-2 space-y-2">
          {imageUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              className={`max-w-full ${maxH} object-cover`}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {embedUrls.length > 0 && (
        <div className="mt-2 space-y-2">
          {embedUrls.map((url, i) => (
            <EmbedPreview key={i} url={url} />
          ))}
        </div>
      )}
    </>
  )
}

function EmbedPreview({ url }: { url: string }) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) {
    return (
      <div className="relative overflow-hidden" style={{ paddingBottom: '56.25%' }}>
        <iframe
          src={`https://www.youtube.com/embed/${yt[1]}`}
          className="absolute inset-0 w-full h-full"
          frameBorder="0"
          allowFullScreen
          loading="lazy"
        />
      </div>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-3 hover:opacity-80 transition-opacity bg-grey-100"
    >
      <p className="text-[11px] font-mono truncate text-grey-600 uppercase tracking-[0.02em]">{url}</p>
    </a>
  )
}
