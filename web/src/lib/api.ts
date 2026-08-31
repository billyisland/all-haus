// =============================================================================
// API facade
//
// Split into api/<module>.ts during §52 refactor. This file is a transitional
// re-export so existing `from '@/lib/api'` imports keep working. Prefer
// importing from the specific module (`from '@/lib/api/auth'`, etc.) in new
// code; this facade can be removed once all call sites are migrated.
// =============================================================================

export * from './api/auth'
export * from './api/account'
export * from './api/articles'
export * from './api/feed'
export * from './api/feeds'
export * from './api/formulas'
export * from './api/notifications'
export * from './api/votes'
export * from './api/messages'
export * from './api/social'
export * from './api/drives'
export * from './api/admin'
export * from './api/admin-dashboard'
export * from './api/publications'
export * from './api/resolver'
export * from './api/linked-accounts'
export * from './api/trust'
export * from './api/writers'
export * from './api/follows'
export * from './api/follow-imports'
export * from './api/search'
export * from './api/upstream-edges'
export * from './api/tributes'
export * from './api/waitlist'
