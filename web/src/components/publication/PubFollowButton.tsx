'use client'

import { useState } from 'react'
import { publications as pubApi } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'

interface Props {
  publicationId: string
  initialFollowing: boolean
}

export function PubFollowButton({ publicationId, initialFollowing }: Props) {
  const { user } = useAuth()
  const router = useRouter()
  const [following, setFollowing] = useState(initialFollowing)
  const [loading, setLoading] = useState(false)
  const [hovering, setHovering] = useState(false)

  async function handleClick() {
    if (!user) {
      // No `redirect=` — `/auth` has never read one, and it is the exact
      // `returnTo` shape `lib/auth-return.ts` forbids on purpose. Where a
      // return really is wanted, the carrier is `?arrival=<dTag>`, which is an
      // identifier read off our own route rather than a path we navigate to.
      router.push('/auth?mode=login')
      return
    }

    setLoading(true)
    try {
      if (following) {
        await pubApi.unfollow(publicationId)
        setFollowing(false)
      } else {
        await pubApi.follow(publicationId)
        setFollowing(true)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }

  const label = loading
    ? '…'
    : following
      ? hovering ? 'Unfollow' : 'Following'
      : 'Follow'

  return (
    <button
      data-explain="pub.follow"
      onClick={handleClick}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      disabled={loading}
      className={`text-ui-sm transition-colors disabled:opacity-50 ${
        following
          ? `btn-soft py-1.5 px-4${hovering ? ' text-crimson' : ''}`
          : 'btn py-1.5 px-4'
      }`}
    >
      {label}
    </button>
  )
}
