'use client'

import Link from 'next/link'
import type { RenderedObservation } from '../../lib/traffology-templates'

export function FeedItem({ observation }: { observation: RenderedObservation }) {
  const content = (
    <div className="py-3 border-b-2 border-grey-200">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-grey-300 mb-1">
        {observation.anchor}
      </div>
      <div
        className="text-[13.5px] leading-relaxed text-black [&_em]:font-serif [&_em]:not-italic"
        dangerouslySetInnerHTML={{ __html: observation.html }}
      />
    </div>
  )

  if (observation.pieceId) {
    return (
      <Link
        href={`/traffology/piece/${observation.pieceId}`}
        className="block hover:bg-grey-100 transition-colors -mx-2 px-2"
      >
        {content}
      </Link>
    )
  }

  return content
}
