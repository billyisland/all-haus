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

/** The house's profile picture: a CIRCLE, image and initials fallback alike.
 *
 *  A full circle echoes the ∀ disc and is NOT an exception to the square-corner
 *  rule — what that rule forbids is the softened rectangle. (The invite page has
 *  carried the same note about the publication logo since it was written.) Every
 *  pfp on the site is round, so a new one starts here rather than as a sixth
 *  hand-rolled `<img>`; the four that existed were folded in when the shape was
 *  unified, which is how they had come to disagree about the fallback tone too.
 *  The "your own photo" editor (ProfileSection) keeps its blush gradient — a
 *  deliberately different register — but takes the same circle. (Welcome was
 *  the second such editor; it was deleted with the sheet, 2026-09-04.) */
export function Avatar({ src, name, size = 28, lazy = true, enlargeable = false }: AvatarProps) {
  const initial = (name || '?')[0].toUpperCase()
  const [failed, setFailed] = useState(false)
  const openLightbox = useLightbox((s) => s.open)

  if (!src || failed) {
    return (
      <span
        style={{ width: size, height: size, fontSize: size * 0.4 }}
        className="inline-flex items-center justify-center rounded-full bg-grey-200 text-grey-400 font-mono uppercase font-medium flex-shrink-0"
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
      // The BOX is CSS, not the width/height attributes. Tailwind's preflight
      // ships `img,video{max-width:100%;height:auto}`, and an author rule beats
      // a presentational hint — so with the attributes alone the height resolves
      // to `auto` and the box takes the SOURCE's aspect ratio. Square photo, no
      // symptom; a portrait one renders 36×72 and `rounded-full` draws it as a
      // lozenge. It also silently disabled `object-cover`, which only crops when
      // the box disagrees with the image. The attributes stay for the intrinsic
      // hint (no layout shift before decode); the style is what holds the shape.
      style={{ width: size, height: size }}
      loading={lazy ? 'lazy' : undefined}
      className="rounded-full object-cover flex-shrink-0"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )

  if (!enlargeable) return img

  return (
    <button
      type="button"
      onClick={() => openLightbox(src, name)}
      aria-label={`View ${name}'s picture`}
      className="focus-ring flex-shrink-0 cursor-zoom-in rounded-full overflow-hidden"
      style={{ width: size, height: size }}
    >
      {img}
    </button>
  )
}
