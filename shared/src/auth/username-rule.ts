// =============================================================================
// THE username rule — one home, and deliberately a LEAF module.
//
// `POST /auth/change-username` is the authority in practice: it is the only way
// a member ever sets their own handle, so its shape is the set of handles a
// member can hold BY CHOICE. Everything that MINTS a username must land inside
// it, or it mints one the owner could never have chosen and — worse — could not
// retype to keep. Before this was hoisted, three places disagreed: the route
// demanded 3-30 with interior hyphens only, `SignupSchema` allowed 40 characters
// and underscores, and `deriveUsername` could emit a leading hyphen, an
// underscore, the literal `user`, or a 37-character string (a 30-character base
// plus a 7-character collision suffix).
//
// WHY ITS OWN FILE. These are four literals with no dependencies. Living in
// `accounts.ts` they could only be imported by dragging in the account service —
// the DB client, zod schemas, Stripe — which is both wasteful and, in tests,
// actively harmful: the suites that mock `accounts.js` wholesale would have had
// to restate the rule inside the mock, pinning the mock's idea of it rather than
// the real one. A rule that validation and derivation must agree on cannot be
// something a test is free to redefine.
//
// The regex encodes: 3-30 characters, lowercase alphanumeric, hyphens allowed
// only in the interior. Anchored, so it validates whole strings only.
// =============================================================================

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 30
export const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/
export const USERNAME_RULE_MESSAGE =
  'Username must be 3-30 characters, lowercase alphanumeric and hyphens only'
