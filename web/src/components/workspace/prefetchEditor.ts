/**
 * Warm the article-editor chunk before anything asks to render it.
 *
 * `EditorOverlay` is code-split (LazyOverlays.tsx) and it is the app's heaviest
 * overlay chunk — TipTap and its extensions. The split is a win everywhere
 * except ONE path: the note→article handoff, where the writer is already
 * composing and the click is meant to feel like the same window changing shape.
 * `next/dynamic` renders NOTHING while it fetches, so on that path the fetch
 * lands squarely inside the gesture. Calling this when a compose surface OPENS
 * spends the fetch against the seconds the writer spends typing instead.
 *
 * Its own module rather than an export of LazyOverlays so a compose surface can
 * warm the chunk without statically importing every other overlay's loader.
 *
 * `import()` is idempotent and module-cached, so repeated calls are free, and a
 * failure is deliberately swallowed: this is a warm-up with no user-visible
 * product, and the real render path re-imports — and reports — on its own.
 */
export function prefetchEditorOverlay(): void {
  void import("./EditorOverlay").catch(() => {});
}
