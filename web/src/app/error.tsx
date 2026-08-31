'use client'

import { PublicShell } from '../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../components/public/PublicVessel'
import { PublicButton } from '../components/public/Field'

// The error boundary is the one page whose visitor is definitionally having a
// bad time, so it gets the same room as everything else rather than a stub. It
// uses the public chassis regardless of whether the visitor is logged in: a
// member seeing this has, by definition, lost the surface they were on, and a
// half-rendered workspace behind an error is worse than a clean floor.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Something went wrong.</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              That’s on us, not on you. Trying again often works; if it doesn’t,
              the problem is at our end and we can see it.
            </PublicBody>
          </div>
        </PublicCard>
        <PublicCard>
          <PublicButton full onClick={reset}>
            Try again
          </PublicButton>
        </PublicCard>
        {error.digest && (
          <PublicCard>
            {/* The digest is the only thread between a visitor's report and the
                server log, so it is shown rather than swallowed — quietly, in
                the label register, where it reads as a reference number. */}
            <span className="label-ui" style={{ opacity: 0.7 }}>
              Reference {error.digest}
            </span>
          </PublicCard>
        )}
      </PublicVessel>
    </PublicShell>
  )
}
