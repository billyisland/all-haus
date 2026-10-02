// =============================================================================
// Google OAuth — the browser half of the state binding (MIRROR-AUDIT §2.5).
//
// The gateway signs the OAuth `state`, which proves the platform minted it. It
// proved nothing about WHO it was minted for: an attacker could start a flow,
// take the callback URL Google handed back and forward it to a victim, whose
// browser would complete the exchange and end up signed into the attacker's
// account — with any card the victim then added landing on the attacker's tab.
//
// So the browser mints 32 random bytes before it leaves, keeps them in
// `sessionStorage`, and sends only their sha256 to the gateway, which signs the
// DIGEST into the state. At the callback we hand the gateway the raw value back
// and it checks the hash. Only the digest ever crosses Google, so a forwarded
// URL carries a binding the receiving browser has no preimage for.
//
// `sessionStorage`, not a cookie: the whole reason the state moved server-side
// is that Next.js rewrite proxies do not reliably forward `Set-Cookie` in a
// redirect response (see the flow note in `gateway/src/routes/google-auth.ts`),
// and this must not reintroduce that dependency. It survives the Google round
// trip because that is one navigation in the same tab, and it deliberately does
// NOT survive being opened in a different tab or browser — which is the attack.
//
// A FAILURE HERE IS LOUD. If we cannot mint or store the binding there is no
// safe way to continue, so both entry points surface it as an error rather than
// navigating on to a sign-in that would 400 at the far end.
// =============================================================================

const BIND_KEY = 'auth:google_bind'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Mint the binding, stash it, and navigate to the gateway's redirect route.
 * Rejects (without navigating) if the browser cannot do either half —
 * `crypto.subtle` needs a secure context, and `sessionStorage` throws when the
 * browser is set to block site data.
 */
export async function startGoogleAuth(arrival?: string | null): Promise<void> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const bind = toHex(raw)

  // Hash the hex STRING, not the bytes, so both ends agree on one domain: the
  // gateway does `createHash("sha256").update(raw, "utf8")` on exactly what we
  // put in `sessionStorage` and post back.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(bind),
  )

  sessionStorage.setItem(BIND_KEY, bind)

  const qs = new URLSearchParams({ bind: toHex(new Uint8Array(digest)) })
  if (arrival) qs.set('arrival', arrival)
  window.location.href = `/api/v1/auth/google?${qs.toString()}`
}

/**
 * Read the binding back at the callback and clear it — one flow, one use, so a
 * stale value can never bind a later attempt. Returns null when there is none,
 * which the callback treats as a failed sign-in rather than as an unbound one.
 */
export function takeGoogleBind(): string | null {
  try {
    const bind = sessionStorage.getItem(BIND_KEY)
    sessionStorage.removeItem(BIND_KEY)
    return bind
  } catch {
    return null
  }
}
