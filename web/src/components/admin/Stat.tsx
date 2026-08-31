import type { ReactNode } from 'react'

// =============================================================================
// Owner dashboard stat primitives — labelled plain figures, calm by default,
// crimson reserved for warning states (OWNER-DASHBOARD-SPEC §4.1.4).
// =============================================================================

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">{children}</div>
}

export function StatCard({
  label,
  value,
  detail,
  warn = false,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  warn?: boolean
}) {
  return (
    <div className="bg-glasshouse-well p-4">
      <p className="label-ui text-grey-600 mb-1">{label}</p>
      <p className={`text-[1.25rem] font-sans tabular-nums ${warn ? 'text-crimson' : 'text-black'}`}>
        {value}
      </p>
      {detail !== undefined && <p className="text-ui-xs text-grey-600 mt-1">{detail}</p>}
    </div>
  )
}

export function StatSection({
  label,
  helper,
  children,
}: {
  label: string
  helper?: string
  children: ReactNode
}) {
  return (
    <section className="mb-10">
      <p className="label-ui text-grey-600 mb-1">{label}</p>
      {helper && <p className="text-ui-xs text-grey-600 mb-3">{helper}</p>}
      <div className={helper ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}
