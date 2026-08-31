'use client'

import {
  useTypeScale,
  TYPE_SCALE_STEPS,
  TYPE_SCALE_LABEL,
} from '../../stores/typeScale'

// =============================================================================
// TypeSizeControl — the global type-size setting. Toggle-chips pick a discrete
// step; the choice scales the root font-size site-wide (every rem-based token)
// and persists per-device. Lives in the Settings panel.
// =============================================================================

export function TypeSizeControl() {
  const step = useTypeScale((s) => s.step)
  const setStep = useTypeScale((s) => s.setStep)

  return (
      <div className="flex flex-wrap">
        {TYPE_SCALE_STEPS.map((s) => (
          <button
            key={s}
            onClick={() => setStep(s)}
            className={`label-ui toggle-chip ${
              step === s ? 'toggle-chip-active' : 'toggle-chip-inactive'
            }`}
          >
            {TYPE_SCALE_LABEL[s]}
          </button>
        ))}
      </div>
  )
}
