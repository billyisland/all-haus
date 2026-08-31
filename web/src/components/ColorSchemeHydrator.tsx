'use client'

// =============================================================================
// ColorSchemeHydrator — headless. Applies the persisted per-device light/dark/
// system preference to the document root on boot (mirrors TypeScaleHydrator),
// and keeps 'system' tracking the OS preference live via a matchMedia listener.
// Mounted once at the app root in LayoutShell; renders nothing. A blocking
// inline script in app/layout.tsx already sets html.dark before paint to avoid
// a white flash — this hydrator reconciles store state + the live listener.
// =============================================================================

import { useEffect } from 'react'
import { useColorScheme } from '../stores/colorScheme'

export function ColorSchemeHydrator() {
  const hydrate = useColorScheme((s) => s.hydrate)
  const refreshSystem = useColorScheme((s) => s.refreshSystem)
  useEffect(() => {
    hydrate()
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => refreshSystem()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [hydrate, refreshSystem])
  return null
}
