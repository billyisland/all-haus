import { create } from "zustand";

// =============================================================================
// useTypeScale — the global type-size preference. A per-device display setting
// (accessibility), persisted to localStorage and applied by scaling the root
// `html` font-size: every rem-based design token (text-ui-*, .label-ui, .btn,
// the prose scale, …) scales proportionally. Hardcoded px arbitrary values
// don't scale — that's existing token-debt, not the contract.
//
// Per-device by design (localStorage, not the account): you might want larger
// text on a laptop than on a big monitor. Applied on boot by the headless
// TypeScaleHydrator (mirrors PaletteHydrator), and immediately on change here.
// =============================================================================

export type TypeScaleStep = "small" | "default" | "large" | "xlarge";

// Multipliers against the browser's default root size (100% ≈ 16px). The
// root font-size is otherwise unset, so 'default' restores the browser value.
export const TYPE_SCALE_MULTIPLIER: Record<TypeScaleStep, number> = {
  small: 0.9,
  default: 1.0,
  large: 1.1,
  xlarge: 1.2,
};

export const TYPE_SCALE_LABEL: Record<TypeScaleStep, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
  xlarge: "Larger",
};

export const TYPE_SCALE_STEPS: TypeScaleStep[] = [
  "small",
  "default",
  "large",
  "xlarge",
];

const STORAGE_KEY = "ah:type-scale";

function isStep(v: string | null): v is TypeScaleStep {
  return v === "small" || v === "default" || v === "large" || v === "xlarge";
}

/** Apply a step to the document root. Called on change and on boot. */
export function applyTypeScale(step: TypeScaleStep): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${TYPE_SCALE_MULTIPLIER[step] * 100}%`;
}

/** Read the persisted step (defaults to 'default'). */
function readPersisted(): TypeScaleStep {
  if (typeof window === "undefined") return "default";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isStep(raw) ? raw : "default";
  } catch {
    return "default";
  }
}

interface TypeScaleState {
  step: TypeScaleStep;
  /** Set, persist, and apply to the document root. */
  setStep: (step: TypeScaleStep) => void;
  /** Boot: read the persisted value into state + apply it. */
  hydrate: () => void;
}

export const useTypeScale = create<TypeScaleState>((set) => ({
  step: "default",
  setStep: (step) => {
    set({ step });
    applyTypeScale(step);
    try {
      window.localStorage.setItem(STORAGE_KEY, step);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  },
  hydrate: () => {
    const step = readPersisted();
    set({ step });
    applyTypeScale(step);
  },
}));
