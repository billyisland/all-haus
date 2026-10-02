'use client'

import { useEffect, useState } from 'react'
import { linkedAccounts as linkedAccountsApi, type LinkedAccount } from '../lib/api'
import { useAuth } from '../stores/auth'

// Module-level cache so multiple cards don't refetch.
//
// AN OUTAGE IS NOT AN EMPTY SET OF LINKED ACCOUNTS, and here the swallow was
// worse than a wrong sentence on screen: a failed load used to `publish([])`,
// which BOTH told every consumer the member had linked nothing AND filled the
// cache, so `cachedAccounts === null` was false for the rest of the session and
// nothing ever retried. One blip and the composer silently offered no
// cross-post targets — a member who habitually posts to Bluesky posts to
// all.haus alone, with nothing anywhere saying why — until they reloaded.
//
// So a failure caches NOTHING (the next mount retries) and is reported as its
// own state. `null` from the hook keeps its existing meaning of "not known
// yet"; `useLinkedAccountsFailed()` is the third fact, for the one surface
// where silence would change what the member's action does.
let cachedAccounts: LinkedAccount[] | null = null
let loadFailed = false
let inflight: Promise<LinkedAccount[]> | null = null
const subscribers = new Set<(accounts: LinkedAccount[] | null) => void>()
const failureSubscribers = new Set<(failed: boolean) => void>()

function publish(accounts: LinkedAccount[] | null) {
  cachedAccounts = accounts
  subscribers.forEach(cb => cb(accounts))
}

function publishFailure(failed: boolean) {
  loadFailed = failed
  failureSubscribers.forEach(cb => cb(failed))
}

async function load(): Promise<LinkedAccount[]> {
  if (inflight) return inflight
  inflight = linkedAccountsApi.list()
    .then(({ accounts }) => {
      publishFailure(false)
      publish(accounts)
      return accounts
    })
    .catch(() => {
      publishFailure(true)
      return []
    })
    .finally(() => { inflight = null })
  return inflight
}

export function invalidateLinkedAccounts(): void {
  cachedAccounts = null
  void load()
}

/** True when the last attempt to read the member's linked accounts failed and
 *  we therefore do not know what they have connected. */
export function useLinkedAccountsFailed(): boolean {
  const [failed, setFailed] = useState(loadFailed)
  useEffect(() => {
    const cb = (f: boolean) => setFailed(f)
    failureSubscribers.add(cb)
    setFailed(loadFailed)
    return () => { failureSubscribers.delete(cb) }
  }, [])
  return failed
}

export function useLinkedAccounts(): LinkedAccount[] | null {
  const { user, loading } = useAuth()
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(cachedAccounts)

  useEffect(() => {
    if (loading || !user) return
    const cb = (a: LinkedAccount[] | null) => setAccounts(a)
    subscribers.add(cb)
    if (cachedAccounts === null) void load()
    else setAccounts(cachedAccounts)
    return () => { subscribers.delete(cb) }
  }, [user, loading])

  return user ? accounts : null
}
