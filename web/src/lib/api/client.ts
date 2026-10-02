// =============================================================================
// API Client — shared infra
//
// Typed fetch wrapper for the gateway API, and the ONE base URL: every browser
// call to the gateway goes through `request()` (CA-J2), same-origin via the
// Next.js /api rewrite. All requests include credentials
// (cookies) automatically. Runs client-side only.
//
// The Next.js rewrites in next.config.js proxy /api/* to the gateway,
// so these calls work in both dev and production.
// =============================================================================

export const API_BASE = '/api/v1'

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

// The route's own sentence, wherever it put one: `message`, or an `error` that
// is a sentence rather than a snake_case code (the upload route's "We can't
// use that kind of file …", the index routes' refusals). A code is never shown. Null when
// neither is there — a bare status, an HTML error page, a dropped connection.
export function apiErrorSentence(err: unknown): string | null {
  const message = apiErrorMessage(err)
  if (message) return message
  if (err instanceof ApiError && typeof err.body?.error === 'string' && /\s/.test(err.body.error)) {
    return err.body.error
  }
  return null
}

// What a failed press SAYS (CA-J2). The route's sentence when it sent one; a
// sentence WE threw (a plain Error from our own code — the publish pipeline
// composes several) as written; and the caller's house copy for everything
// else: a bare status, a dropped connection (fetch's TypeError). Never the raw
// `API error 500: {...}`, and never "Upload failed: 500".
export function failureSentence(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return apiErrorSentence(err) ?? fallback
  if (err instanceof TypeError) return fallback
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> }
  // A multipart body sets its own Content-Type, boundary and all.
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'

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
