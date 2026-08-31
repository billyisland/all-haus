import { request } from './client'

export interface ResolverMatch {
  type: 'native_account' | 'external_source' | 'rss_feed'
  confidence: 'exact' | 'probable' | 'speculative'
  account?: {
    id: string
    username: string
    displayName: string
    avatar?: string
  }
  externalSource?: {
    protocol: string
    sourceUri: string
    displayName?: string
    avatar?: string
    description?: string
    relayUrls?: string[]
  }
  rssFeed?: {
    feedUrl: string
    title?: string
    description?: string
  }
}

export interface ResolverResult {
  inputType: string
  matches: ResolverMatch[]
  status?: 'pending' | 'complete'
  error?: string
  requestId?: string
  pendingResolutions?: string[]
}

export const resolver = {
  // discover=true opts into the §V.5.8 discovery fallback (external candidate
  // search for names the exact chains miss). Pass it only on explicit submit,
  // never on the debounced-keystroke typeahead path.
  resolve: (
    query: string,
    context?: 'subscribe' | 'invite' | 'dm' | 'import' | 'general',
    discover?: boolean,
  ) =>
    request<ResolverResult>('/resolve', {
      method: 'POST',
      body: JSON.stringify({ query, context, discover }),
    }),

  poll: (requestId: string) =>
    request<ResolverResult>(`/resolve/${requestId}`),
}
