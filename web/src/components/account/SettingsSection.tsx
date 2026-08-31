'use client'

// =============================================================================
// Settings layout primitives — the single coherent chrome for the account
// settings surface (SettingsPanel). Before this, every section rolled its own
// heading + card: some owned a `bg-glasshouse-well` card, others were bare and
// the parent wrapped them (sometimes nesting a second well), labels drifted
// between grey-600 / grey-400, and rhythm doubled up. These two primitives make
// the structure uniform so the panel reads as one organised surface.
//
//   SettingsGroup — a top-level grouping (Account / Preferences / …): a sans
//                   platform-voice heading over a stack of sections.
//   SettingsSection — one labelled unit: a mono infrastructure-voice label
//                   (+ optional helper) on the pane, then ONE soft
//                   `bg-glasshouse-well/40` grouping card. Text-entry fields
//                   inside the card are the solid `bg-glasshouse-well` (the
//                   canonical pane→card→field layering, CLAUDE.md › Glasshouse).
// =============================================================================

import type { ReactNode } from 'react'

export function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section>
      <h2 className="font-sans text-base font-medium text-black tracking-tight mb-5">
        {title}
      </h2>
      <div className="space-y-6">{children}</div>
    </section>
  )
}

// One labelled control row inside a section card — a black platform-voice title
// (+ optional helper) on the left, its control on the right. Matches the
// notification / reading toggle-row grammar so stacked controls read uniformly.
export function SettingsRow({
  label,
  description,
  dataExplain,
  children,
}: {
  label: string
  description?: string
  // Optional Explain tag (C3) — the ToolbarButton/AppearanceControl pattern.
  dataExplain?: string
  children: ReactNode
}) {
  return (
    <div data-explain={dataExplain} className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0 pr-4">
        <p className="text-ui-sm text-black">{label}</p>
        {description && (
          <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsSection({
  label,
  description,
  tone = 'default',
  dataExplain,
  children,
}: {
  label: string
  description?: string
  tone?: 'default' | 'danger'
  // Optional Explain tag (C3) — covers the label + card as one target.
  dataExplain?: string
  children: ReactNode
}) {
  return (
    <div data-explain={dataExplain}>
      <p
        className={`label-ui mb-2 ${
          tone === 'danger' ? 'text-crimson' : 'text-grey-600'
        }`}
      >
        {label}
      </p>
      {description && (
        <p className="text-ui-xs text-grey-600 mb-3 leading-relaxed">
          {description}
        </p>
      )}
      <div className="bg-glasshouse-well/40 px-5 py-4">{children}</div>
    </div>
  )
}
