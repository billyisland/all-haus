import { request } from './client'

// Closed-beta waiting list (CLOSED-BETA-ADR Phase 2). The endpoint is
// enumeration-safe — it returns the same generic acknowledgement whether the
// email is new or already on the list — so the UI treats every 2xx the same.
//
// AN EMAIL IS THE WHOLE PAYLOAD. The `publishInterest` flag went with the
// tickbox that set it (2026-07-27) — see the note on the page.
export const waitlist = {
  join: (input: { email: string }) =>
    request<{ ok: boolean; message: string }>('/waitlist', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
}
