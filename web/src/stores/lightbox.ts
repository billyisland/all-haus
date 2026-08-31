import { create } from "zustand";

// =============================================================================
// useLightbox — the global image-enlarge store.
//
// One transient full-screen image viewer, mounted once (LightboxOverlay in
// LayoutShell) so any surface can enlarge an image (profile avatars today) by
// calling useLightbox.getState().open(src). It is NOT a Glasshouse — it's a
// focused modal that floats above every surface (incl. the ForallMenu at z-60),
// dismissed by click / Escape / its floating ✕. No URL sync: enlarging an
// avatar isn't an addressable destination.
// =============================================================================

interface LightboxState {
  isOpen: boolean;
  src: string | null;
  alt: string;
  open: (src: string, alt?: string) => void;
  close: () => void;
}

export const useLightbox = create<LightboxState>((set) => ({
  isOpen: false,
  src: null,
  alt: "",
  open: (src, alt = "") => set({ isOpen: true, src, alt }),
  close: () => set({ isOpen: false, src: null, alt: "" }),
}));
