'use client'

// =============================================================================
// BarGround — a public page telling the fixed nav bar what colour it is
// standing on.
//
// `PublicNavBar` has no divider by design: its bottom edge is invisible because
// the bar and the floor under it are the same colour. That is a claim about two
// things agreeing, and nothing was enforcing it — the bar was painted a fixed
// `--ah-bone` while three different chassis painted three different floors. It
// held on the scrolling `PublicPage` default and nowhere else:
//
//   • the reader routes paint `--ah-white` (ArticleReader owns its ground), so
//     the bar sat as a griege slab on the reading paper and drew the very edge
//     it exists not to have — in dark, bone 20/19/17 under white's 30/29/26;
//   • the fitted `PublicShell` pages paint `palette.interior`, which IS bone in
//     light and `--ah-ink-925` (26 26 24) in dark — six points from bone, the
//     same gap PublicShell's own header calls "enough to read as a panel edge".
//
// So the ground is `--ah-bar-ground` and the page states it. The bar keeps
// `--ah-bone` as its fallback, so a page that says nothing renders exactly as
// it did.
//
// WHY A `<style>` AND NOT A PROP OR AN EFFECT. The bar is a FIXED SIBLING of
// `main` — LayoutShell mounts it after these children — so nothing declared on
// a page is inheritable by it, and there is no component boundary to pass a
// prop across. Writing `:root` from a rule inside the page is the one channel
// that reaches it. It has to be a `<style>` rather than an effect on
// `documentElement` because these pages are SSR'd: the rule ships in the
// streamed HTML, ahead of the bar in document order, so the correct ground is
// painted on the first frame. An effect would paint bone first and snap after
// hydration (globals.css §1c's reason, again).
//
// AND IT IS A COLOUR THE PAGE STATES, NEVER A ROUTE TEST IN THE BAR. The page
// is the only thing that knows what it paints. A path list in the bar is a
// hand-maintained set that goes wrong the first time a route is added — and
// silently, because a mismatched ground renders as a faint seam, not an error.
//
// The value is always a `var(--ah-*)` reference or a palette field holding one,
// so it inverts with the global toggle on its own; never a literal colour (the
// canonical-registry rule).
// =============================================================================

export function BarGround({ value }: { value: string }) {
  return <style>{`:root{--ah-bar-ground:${value}}`}</style>
}
