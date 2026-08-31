// =============================================================================
// API Client — shared infra
//
// Typed fetch wrapper for the gateway API. All requests include credentials
// (cookies) automatically. Runs client-side only.
//
// The Next.js rewrites in next.config.js proxy /api/* to the gateway,
// so these calls work in both dev and production.
// =============================================================================

const API_BASE = '/api/v1'

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(`API error ${status}: ${JSON.stringify(body)}`)
    this.name = 'ApiError'
  }
}

// Human-readable server message from an ApiError body ({ error, message }),
// when the endpoint sent one (e.g. addSource's liveness verdicts) — null
// otherwise, so callers fall back to their own copy instead of rendering the
// raw "API error 422: {...}" string.
export function apiErrorMessage(err: unknown): string | null {
  if (
    err instanceof ApiError &&
    err.body &&
    typeof err.body.message === 'string' &&
    err.body.message
  ) {
    return err.body.message
  }
  return null
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> }
  if (options.body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers,
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new ApiError(res.status, body)
  }

  return body as T
}
