'use client'

// =============================================================================
// TypeScaleHydrator — headless. Applies the persisted per-device type-size
// preference to the document root on boot (mirrors PaletteHydrator). Mounted
// once at the app root in LayoutShell; renders nothing.
// =============================================================================

import { useEffect } from 'react'
import { useTypeScale } from '../stores/typeScale'

export function TypeScaleHydrator() {
  const hydrate = useTypeScale((s) => s.hydrate)
  useEffect(() => { hydrate() }, [hydrate])
  return null
}
