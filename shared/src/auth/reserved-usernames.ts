// =============================================================================
// Usernames a member may not hold, because the address is already something
// else. A profile lives at `/<username>` (the web app's root `[username]`
// route), and every fixed path in front of it SHADOWS it: a member called
// `settings` or `reader` would have a profile nobody can reach (MODERNHAUS-ADR
// §R2.10). Nothing refused those names until this file.
//
// THE LISTS ARE DERIVED, NEVER HAND-KEPT. They are literals here because the
// gateway image ships neither the web app nor `nginx.conf`, but
// `shared/tests/reserved-usernames.test.ts` reads the three things that take a
// top-level path — `web/src/app`'s segments, `web/next.config.js`'s redirects
// and rewrites, and `nginx.conf`'s locations — and fails on any shadowing path
// missing from here. A new top-level page is a red test until its name is added.
//
// TWO SHAPES, because nginx has two. An exact path (`location = /x`, a Next
// page) shadows one name. A PREFIX location written without a trailing slash
// (`location /rss {`) matches every path that merely STARTS with it, so
// `/rss-weekly` and `/actorjane` go to the gateway or the relay too — the whole
// family is unreachable, and a suffix cannot rescue a derived name.
//
// A LEAF MODULE like `username-rule.ts`, for the same reason: derivation and
// validation must agree, and a test that mocks the account service must not be
// able to redefine the rule.
//
// It governs MINTING — signup's derivation, the Google path's, and
// `POST /auth/change-username`. A member who already holds a reserved name
// keeps it; renaming somebody is not this file's decision.
// =============================================================================

/** Names taken by a fixed top-level path. Sorted; the test says which source adds each. */
export const RESERVED_USERNAMES: readonly string[] = [
  'about',
  'account',
  'admin',
  'api',
  'appeal',
  'article',
  'auth',
  'author',
  'community-guidelines',
  'dashboard',
  'feed',
  'followers',
  'following',
  'history',
  'inbound-mail',
  'invite',
  'ledger',
  'library',
  'messages',
  'modernhaus',
  'network',
  'nginx-health',
  'notifications',
  'preview',
  'privacy',
  'profile',
  'pub',
  'read',
  'reader',
  'reader-terms',
  'reading-history',
  'search',
  'settings',
  'social',
  'source',
  'subscribe',
  'subscriptions',
  'tag',
  'terms',
  'traffology',
  'tribute',
  'waitlist',
  'workspace',
  'write',
  'writer-agreement',
]

/** nginx prefix locations with no trailing slash, which shadow every name that starts with them. */
export const RESERVED_USERNAME_PREFIXES: readonly string[] = ['actor', 'relay', 'rss']

/** True where no suffix can make the name reachable: it starts with a shadowing prefix. */
export function hasReservedUsernamePrefix(name: string): boolean {
  const n = name.toLowerCase()
  return RESERVED_USERNAME_PREFIXES.some((p) => n.startsWith(p))
}

/** True where `/<name>` would open something other than this member's profile. */
export function isReservedUsername(name: string): boolean {
  const n = name.toLowerCase()
  return RESERVED_USERNAMES.includes(n) || hasReservedUsernamePrefix(n)
}

export const USERNAME_RESERVED_MESSAGE =
  'That username is the address of a page on all.haus, so a profile there could not be reached. Choose another.'
