'use client'

import {
  useColorScheme,
  COLOR_MODES,
  COLOR_MODE_LABEL,
} from '../../stores/colorScheme'

// =============================================================================
// ColorModeControl — the global appearance setting. Toggle-chips pick Light /
// Dark / System; the choice flips `html.dark` site-wide (globals.css inverts
// the neutral ramp) and persists per-device. Lives in the Settings panel,
// mirroring TypeSizeControl.
// =============================================================================

export function ColorModeControl() {
  const mode = useColorScheme((s) => s.mode)
  const setMode = useColorScheme((s) => s.setMode)

  return (
      <div className="flex flex-wrap">
        {COLOR_MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`label-ui toggle-chip ${
              mode === m ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
          >
            {COLOR_MODE_LABEL[m]}
          </button>
        ))}
      </div>
  )
}
