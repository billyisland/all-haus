import type { ZodError } from 'zod'

// =============================================================================
// Uniform 400 body for zod validation failures.
//
// `error` is a stable string code, the first human-readable issue rides
// `message`, and the full flatten() rides `details`. Never send a raw
// `parsed.error.flatten()` as `error`: clients that string-interpolate
// `body.error` render "[object Object]" (the 2026-07-07 paywall-publish bug).
// =============================================================================

export function zodValidationError(err: ZodError): {
  error: 'validation_failed'
  message: string
  details: ReturnType<ZodError['flatten']>
} {
  const flat = err.flatten()
  const first =
    Object.entries(flat.fieldErrors)
      .map(([field, msgs]) => `${field}: ${((msgs as string[] | undefined) ?? []).join(', ')}`)
      .concat(flat.formErrors)[0] ?? 'Invalid request'
  return { error: 'validation_failed', message: first, details: flat }
}
