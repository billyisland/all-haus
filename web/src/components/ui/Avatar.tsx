'use client'

import { useState } from 'react'
import { useLightbox } from '../../stores/lightbox'

interface AvatarProps {
  src?: string | null
  name: string
  size?: number
  lazy?: boolean
  // When true and a real image is present, clicking the avatar opens it in the
  // global lightbox (useLightbox). Off by default — only profile-header avatars
  // opt in, not every byline thumbnail.
  enlargeable?: boolean
}

export function Avatar({ src, name, size = 28, lazy = true, enlargeable = false }: AvatarProps) {
  const initial = (name || '?')[0].toUpperCase()
  const [failed, setFailed] = useState(false)
  const openLightbox = useLightbox((s) => s.open)

  if (!src || failed) {
    return (
      <span
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        className="inline-flex items-center justify-center bg-grey-200 text-grey-400 font-mono uppercase font-medium flex-shrink-0"
      >
        {initial}
      </span>
    )
  }

  const img = (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading={lazy ? 'lazy' : undefined}
      className="object-cover flex-shrink-0"
      onError={() => setFailed(true)}
    />
  )

  if (!enlargeable) return img

  return (
    <button
      type="button"
      onClick={() => openLightbox(src, name)}
      aria-label={`View ${name}'s picture`}
      className="focus-ring flex-shrink-0 cursor-zoom-in"
      style={{ width: size, height: size }}
    >
      {img}
    </button>
  )
}
