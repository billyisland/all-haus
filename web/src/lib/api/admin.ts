import { request } from './client'

export interface Report {
  id: string
  reporterUsername: string
  reporterDisplayName: string | null
  targetType: 'article' | 'note' | 'comment' | 'account'
  targetId: string
  reason: string
  contentPreview: string | null
  status: 'pending' | 'resolved'
  resolution: string | null
  createdAt: string
  resolvedAt: string | null
}

export const admin = {
  listReports: (status?: string) =>
    request<{ reports: Report[] }>(`/admin/reports${status ? `?status=${status}` : ''}`),

  resolveReport: (reportId: string, action: 'remove' | 'suspend' | 'dismiss') =>
    request<{ ok: boolean }>(`/admin/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    }),

  suspendAccount: (accountId: string) =>
    request<{ ok: boolean }>(`/admin/suspend/${accountId}`, { method: 'POST' }),
}
