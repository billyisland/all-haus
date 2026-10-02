/**
 * Warm the profile-overlay chunk before anything asks to render it.
 *
 * `ProfileOverlay` is code-split (LazyOverlays.tsx), and `next/dynamic` renders
 * NOTHING while it fetches. That is free everywhere a profile opens over the
 * bare floor — there is no outgoing pane to lose — but it is not free on a
 * HANDOFF, where the profile takes another Glasshouse's place and the pane it is
 * replacing holds the screen until this chunk lands. Calling this when a surface
 * full of profile links OPENS spends the fetch against the seconds somebody
 * spends reading the list.
 *
 * Its own module for the reason `prefetchEditor.ts` is one: a surface can warm
 * the chunk it will hand off to without statically importing every other
 * overlay's loader.
 *
 * `import()` is idempotent and module-cached, so repeated calls are free, and a
 * failure is deliberately swallowed: this is a warm-up with no user-visible
 * product, and the real render path re-imports — and reports — on its own.
 */
export function prefetchProfileOverlay(): void {
  void import("./ProfileOverlay").catch(() => {});
}
