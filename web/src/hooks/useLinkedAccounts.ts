'use client'

import { useEffect, useState } from 'react'
import { linkedAccounts as linkedAccountsApi, type LinkedAccount } from '../lib/api'
import { useAuth } from '../stores/auth'

// Module-level cache so multiple cards don't refetch.
let cachedAccounts: LinkedAccount[] | null = null
let inflight: Promise<LinkedAccount[]> | null = null
const subscribers = new Set<(accounts: LinkedAccount[] | null) => void>()

function publish(accounts: LinkedAccount[] | null) {
  cachedAccounts = accounts
  subscribers.forEach(cb => cb(accounts))
}

async function load(): Promise<LinkedAccount[]> {
  if (inflight) return inflight
  inflight = linkedAccountsApi.list()
    .then(({ accounts }) => {
      publish(accounts)
      return accounts
    })
    .catch(() => {
      publish([])
      return []
    })
    .finally(() => { inflight = null })
  return inflight
}

export function invalidateLinkedAccounts(): void {
  cachedAccounts = null
  void load()
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
