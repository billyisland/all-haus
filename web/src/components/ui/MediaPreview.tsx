'use client'

import type { MediaAttachment } from '../../hooks/useMediaAttachments'

interface MediaPreviewProps {
  attachments: MediaAttachment[]
  onRemove: (url: string) => void
  uploading?: boolean
}

export function MediaPreview({ attachments, onRemove, uploading }: MediaPreviewProps) {
  if (attachments.length === 0 && !uploading) return null

  return (
    <div className="flex gap-2 overflow-x-auto py-2">
      {attachments.map(a => (
        <div key={a.url} className="relative flex-shrink-0 group">
          {a.type === 'image' ? (
            <img
              src={a.url}
              alt=""
              className="h-16 w-16 object-cover bg-grey-100"
              loading="lazy"
            />
          ) : (
            <div className="h-16 px-3 flex flex-col justify-center bg-grey-100 max-w-[180px]">
              {a.thumbnailUrl ? (
                <img src={a.thumbnailUrl} alt="" className="h-8 w-auto object-contain mb-0.5" />
              ) : null}
              <p className="text-[10px] font-mono text-grey-600 truncate uppercase tracking-[0.02em]">
                {a.providerName ?? a.title ?? a.url.replace(/^https?:\/\//, '').slice(0, 30)}
              </p>
              {a.title && a.providerName && (
                <p className="text-[10px] font-sans text-grey-400 truncate">{a.title}</p>
              )}
            </div>
          )}
          <button
            onClick={() => onRemove(a.url)}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-black text-white text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Remove"
          >
            &times;
          </button>
        </div>
      ))}
      {uploading && (
        <div className="h-16 w-16 flex-shrink-0 bg-grey-100 animate-pulse" />
      )}
    </div>
  )
}
