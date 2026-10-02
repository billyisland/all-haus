import { notFound } from 'next/navigation'
import { traffologyEnabled } from '../../lib/featureFlags'
import { TraffologyShell } from './TraffologyShell'

// Traffology is PARKED (featureFlags.ts). A server layout, so a member who
// types the URL meets the same 404 as a suspended publication page rather
// than a working surface over empty tables (walkthrough A15). The gateway's
// /traffology/* routes 404 in lockstep behind TRAFFOLOGY_ENABLED.
export default function TraffologyLayout({ children }: { children: React.ReactNode }) {
  if (!traffologyEnabled()) notFound()
  return <TraffologyShell>{children}</TraffologyShell>
}
