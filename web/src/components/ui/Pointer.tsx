// =============================================================================
// Pointer — the caret family (web/CLAUDE.md › Pointers)
//
// A solid isosceles triangle drawn from borders, for any affordance meaning
// "there is more THAT way". One home for the direction-to-class mapping, so the
// site converges on a single pointer construction instead of a scatter of typed
// arrow glyphs rendered at whatever weight the surrounding font happened to
// give them.
//
// GEOMETRY IS NOT HERE. It lives in globals.css 1f, including the mobile
// step-up, because PostThread mounts inside the SSR'd /author and /source
// surfaces and a `useIsMobile` branch would paint the desktop pointer on a
// phone and snap after hydration.
//
// COLOUR IS THE CALLER'S. The triangle is `currentColor`, so the button or row
// that holds it sets `color` from its palette field (`palette.cardMeta`) and
// the pointer inherits — which is what makes it invert with the feed variant.
// Never give this component a colour prop; that is how a hard-coded grey gets
// into a dark card.
//
// THE CLASS NAMES ARE A STATIC MAP, NEVER `ah-pointer-${direction}`. Tailwind
// tree-shakes rules written inside `@layer components`, so a class it cannot
// find as a LITERAL in the scanned source is dropped from the built stylesheet.
// The interpolated form compiled, linted, typechecked and passed `next build`
// clean, and shipped four pointers as invisible 0x0 spans — `.ah-pointer` alone
// sets `width/height/border: 0`, so the base class surviving is exactly what
// makes the failure silent. Any future class in that layer whose name is
// assembled at runtime needs this treatment (or a config safelist).
// =============================================================================

export type PointerDirection = "up" | "down" | "left" | "right";

const DIRECTION_CLASS: Record<PointerDirection, string> = {
  up: "ah-pointer-up",
  down: "ah-pointer-down",
  left: "ah-pointer-left",
  right: "ah-pointer-right",
};

export function Pointer({
  direction,
  size = "md",
  className,
}: {
  direction: PointerDirection;
  /**
   * `md`: the RAIL pointer — elongated along its axis of travel, for navigating
   * a long ribbon (the thread gutter). `sm`: squat, inline beside 11px mono-caps
   * label text. They differ in proportion as well as scale, on purpose — see
   * globals.css 1f.
   */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={[
        "ah-pointer",
        DIRECTION_CLASS[direction],
        size === "sm" ? "ah-pointer-sm" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
