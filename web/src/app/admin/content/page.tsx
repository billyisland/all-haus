'use client'

import { useEffect, useState } from 'react'
import { adminDashboard, type AdminContent } from '../../../lib/api'
import { formatPence, timeAgo } from '../../../lib/format'
import { AdminShell } from '../../../components/admin/AdminShell'
import { StatCard, StatGrid, StatSection } from '../../../components/admin/Stat'

export default function AdminContentPage() {
  const [data, setData] = useState<AdminContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminDashboard
      .content()
      .then(setData)
      .catch(() => setError('Failed to load content metrics.'))
  }, [])

  const stale =
    data?.health.feedScoresStalenessMinutes !== null &&
    data !== null &&
    data.health.feedScoresStalenessMinutes! > 10

  return (
    <AdminShell title="Site owner">
      {error && <div className="bg-glasshouse-well px-4 py-3 text-ui-xs text-black mb-8">{error}</div>}
      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      )}
      {data && (
        <>
          <StatSection label="Articles">
            <StatGrid>
              <StatCard label="Published" value={data.articles.totalPublished} />
              <StatCard label="Last 7 days" value={data.articles.publishedLast7d} />
              <StatCard label="Last 30 days" value={data.articles.publishedLast30d} />
              <StatCard label="Paywalled" value={data.articles.paywalledCount} />
              <StatCard label="Free" value={data.articles.freeCount} />
              <StatCard
                label="Avg price"
                value={
                  data.articles.avgPricePence === null ? '—' : formatPence(data.articles.avgPricePence)
                }
              />
            </StatGrid>
          </StatSection>

          <StatSection label="Notes">
            <StatGrid>
              <StatCard label="Total" value={data.notes.total} />
              <StatCard label="Last 7 days" value={data.notes.last7d} />
              <StatCard label="Last 30 days" value={data.notes.last30d} />
            </StatGrid>
          </StatSection>

          <StatSection label="Engagement">
            <StatGrid>
              <StatCard label="Reads" value={data.engagement.totalReadEvents} />
              <StatCard label="Reads, 7 days" value={data.engagement.readEventsLast7d} />
              <StatCard label="Comments" value={data.engagement.totalComments} />
              <StatCard label="Comments, 7 days" value={data.engagement.commentsLast7d} />
              <StatCard label="Votes" value={data.engagement.totalVotes} />
              <StatCard label="Votes, 7 days" value={data.engagement.votesLast7d} />
            </StatGrid>
          </StatSection>

          <StatSection
            label="Pledge drives"
            helper="Parked feature (PLEDGES_ENABLED off) — shown so parked money is never invisible."
          >
            <StatGrid>
              <StatCard label="Open" value={data.drives.openCount} />
              <StatCard label="Funded" value={data.drives.fundedCount} />
              <StatCard label="Fulfilled" value={data.drives.fulfilledCount} />
              <StatCard
                label="Active pledged"
                value={formatPence(data.drives.activePledgedPence)}
                warn={data.drives.activePledgedPence > 0}
              />
            </StatGrid>
          </StatSection>

          <StatSection label="System health">
            <StatGrid>
              <StatCard
                label="Feed scorer"
                value={
                  data.health.feedScoresRefreshedAt === null
                    ? 'never ran'
                    : stale
                      ? `stale ${data.health.feedScoresStalenessMinutes}m`
                      : timeAgo(data.health.feedScoresRefreshedAt)
                }
                warn={stale || data.health.feedScoresRefreshedAt === null}
                detail="Refreshes every 5 minutes when healthy"
              />
              <StatCard
                label="Jetstream"
                value={
                  data.health.jetstreamHealthy === null
                    ? 'unknown'
                    : data.health.jetstreamHealthy
                      ? 'healthy'
                      : 'down'
                }
                warn={data.health.jetstreamHealthy === false}
              />
              <StatCard
                label="Relay outbox pending"
                value={data.health.relayOutboxPending}
                detail={
                  data.health.relayOutboxOldestPendingAt
                    ? `oldest ${timeAgo(data.health.relayOutboxOldestPendingAt)}`
                    : undefined
                }
                warn={
                  data.health.relayOutboxOldestPendingAt !== null &&
                  Date.now() - new Date(data.health.relayOutboxOldestPendingAt).getTime() >
                    3_600_000
                }
              />
              <StatCard
                label="Outbox failed"
                value={data.health.relayOutboxFailed}
                warn={data.health.relayOutboxFailed > 0}
              />
            </StatGrid>
          </StatSection>
        </>
      )}
    </AdminShell>
  )
}
