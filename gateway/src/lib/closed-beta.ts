// =============================================================================
// Closed beta — the account-creation gate
//
// CLOSED-BETA-ADR D1: the server refuses to CREATE accounts; it does not merely
// hide the means to ask. Both account-creation paths read this one constant, so
// "is the beta closed?" has a single home and the two paths cannot drift into a
// half-open state:
//
//   • POST /auth/signup                — gateway/src/routes/auth.ts
//   • POST /auth/google/exchange       — gateway/src/routes/google-auth.ts
//                                        (the unknown-email branch)
//
// Magic-link login (POST /auth/login) is deliberately NOT gated: it issues a
// token only for an existing account, so it is members-only by construction and
// is the path existing members — including deactivated ones — log back in by.
//
// Deliberately a code constant, not an env brake. Reopening the beta is a
// product decision that ships alongside copy and UI changes anyway, so it
// should be a reviewed deploy — and the guarantee can never be lost to a
// missing or fat-fingered environment variable.
//
// To reopen: flip this to false. Both call sites fall through to their original
// create paths, which are still intact.
// =============================================================================

/**
 * Typed as `boolean` rather than inferred as the literal `true` so neither
 * branch at the call sites reads as statically dead to the compiler or linter.
 */
export const CLOSED_BETA: boolean = true;

/** The error code both refusal paths return, and the frontend switches on. */
export const CLOSED_BETA_ERROR = "closed_beta";
