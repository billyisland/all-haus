'use client'

import { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { Avatar } from '../ui/Avatar'
import { formatDateFromISO } from '../../lib/format'

interface Follower {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  followedAt: string
  subscriptionStatus?: string
}

export function FollowersTab({ username, isOwnProfile }: { username: string; isOwnProfile: boolean }) {
  const [followers, setFollowers] = useState<Follower[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const res = await fetch(`/api/v1/writers/${username}/followers?limit=30`, { credentials: 'include' })
        if (res.ok) {
          const data = await res.json()
          setFollowers(data.followers ?? [])
          setTotal(data.total ?? 0)
        }
      } catch { /* silently fail */ }
      finally { setLoading(false) }
    }
    void load()
  }, [username])

  async function loadMore() {
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/v1/writers/${username}/followers?limit=30&offset=${followers.length}`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setFollowers(prev => [...prev, ...(data.followers ?? [])])
      }
    } catch { /* silently fail */ }
    finally { setLoadingMore(false) }
  }

  if (loading) {
    return <div className="py-10 text-center text-ui-sm text-grey-600">Loading followers...</div>
  }

  if (followers.length === 0) {
    return <p className="text-ui-sm text-grey-600 py-10">No followers yet.</p>
  }

  return (
    <div>
      <div className="space-y-1">
        {followers.map(f => (
          <ProfileLink
            key={f.id}
            href={`/${f.username}`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-grey-100 transition-colors"
          >
            <Avatar src={f.avatar} name={f.displayName ?? f.username} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-ui-sm font-sans text-black truncate">
                  {f.displayName ?? f.username}
                </p>
                {isOwnProfile && f.subscriptionStatus === 'active' && (
                  <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-mono text-accent leading-none flex-shrink-0">
                    Subscriber
                  </span>
                )}
              </div>
              <p className="text-ui-xs text-grey-600">@{f.username}</p>
            </div>
            <time className="text-ui-xs text-grey-600 flex-shrink-0">
              {formatDateFromISO(f.followedAt)}
            </time>
          </ProfileLink>
        ))}
      </div>

      {followers.length < total && (
        <div className="mt-6 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : `Load more (${total - followers.length} remaining)`}
          </button>
        </div>
      )}
    </div>
  )
}
